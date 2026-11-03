// The headfirst dive: Spider-Man's freefall as a procedural animation layer. This module is pure: it reads the per-frame state the controller already hands to the rig (vertical and
// horizontal speed, the time to impact, the traversal state) and answers with a TARGET POSE (angles and directions in the model frame: +Y up the body, +Z the chest, +X the character's
// left) and weights in 0..1. It never moves the body and has no physics of its own; spider-anim.js blends the pose into the air pose, spider-clips.js into the clip pose, and the
// controller stays the only movement authority.
//
// The pose: the whole body pitched forward about the chest so that the head leads and the chest faces the ground (pitch = 90 degrees + the dive angle, the angle of the body
// below the horizon, 26..45 degrees, following the velocity); the spine extended with a slight chest inclination; the head following the body axis with small corrections; both arms swept
// back along the torso towards the feet, elbows slightly bent (the forearm less far back than the upper arm), hands near the hips; the legs extended behind the pelvis, a modest
// separation, knees slightly bent, toes pointed along the airflow; the fingers slightly curled.
//
// Phases (one progress value u in 0..1, moved by dt, so the timing is the same at any frame rate):
//   entry    0.38 .. 0.62 s (faster the faster the fall): the head turns first, then the chest and pelvis, then the arms, last the legs
//   sustain  a deterministic, smooth drift (sums of sines of the accumulated time) in the shoulders, elbows, ankles, torso, head and fingers: active control of the body in the airflow,
//            damped the faster the fall; the pose tightens with speed
//   exit     when the landing is close, a web is attached, a wall is touched, a second jump starts, the body rises or anything else takes the body over: 0.1 .. 0.3 s, the legs let go first
// A pose is only a target: the rig blends from whatever pose it has at that moment (the clip, the air pose), so nothing snaps, and nothing here is accumulated (the output is a function
// of the state and the clock only), so nothing drifts and everything is restored when the layer ends.

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const smooth = (cur, target, dt, rate) => cur + (target - cur) * (1 - Math.exp(-dt * rate));
const TAU = Math.PI * 2;

const FREEFALL = {
  enterVy: -9,          // m/s downwards before the dive starts (a drop of ~14 m or more: it needs time to be seen)
  exitVy: -5,           // ... and it ends when the body is slower than this (hysteresis)
  enterDebounce: 0.08,  // s the fall has to stay fast before the dive starts
  minAirTime: 0.3,     // s in the air (not on the ground, a web or a wall) before the dive may start
  enterLandIn: 0.75,    // s to impact needed to start a dive
  exitLandIn: 0.55,     // s to impact at which the dive is let go for the landing
  entryTime: [0.62, 0.38], // s of the entry at a slow (enterVy) / fast (-30 m/s) fall
  exitTimes: { landing: 0.3, swing: 0.2, wall: 0.18, jump: 0.2, slow: 0.3, ground: 0.1, other: 0.25 },
  jumpBlock: 0.85,      // s after a second jump begins during which no dive starts (the somersault of the double jump owns the body)
  angle: [0.5, 0.78],   // the body's angle below the horizon (rad): from a fast run-out to a vertical drop
  fastFrom: 10, fastTo: 36 // m/s of the fall over which the pose tightens
};

/** The ease of every phase: zero slope at both ends. */
const ease = (u) => { u = clamp(u, 0, 1); return u * u * (3 - 2 * u); };

/** Deterministic smooth drift in -1..1: two sines with unrelated frequencies (Hz) and a phase; a function of the clock only. */
const drift = (t, f1, f2, ph) => 0.62 * Math.sin(TAU * f1 * t + ph) + 0.38 * Math.sin(TAU * f2 * t + 1.7 * ph + 0.9);

// ---- small quaternion helpers [x, y, z, w] (used by the rig for the fingers and the wrist, and by the tests to check that nothing drifts)
const qAxisAngle = (ax, ay, az, angle, out = [0, 0, 0, 1]) => { const m = Math.hypot(ax, ay, az) || 1, s = Math.sin(angle / 2) / m; out[0] = ax * s; out[1] = ay * s; out[2] = az * s; out[3] = Math.cos(angle / 2); return out; };
const qMul = (a, b, out = [0, 0, 0, 1]) => {
  const x = a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1], y = a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0], z = a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3], w = a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2];
  out[0] = x; out[1] = y; out[2] = z; out[3] = w; return out;
};
const qNormalize = (q) => { const m = Math.hypot(q[0], q[1], q[2], q[3]) || 1; q[0] /= m; q[1] /= m; q[2] /= m; q[3] /= m; return q; };

/** The fresh state of the layer. */
function createFreefall(cfg = FREEFALL) {
  const S = {
    active: false, phase: 'idle', u: 0, w: 0, wHead: 0, wBody: 0, wArms: 0, wLegs: 0, // weights: w = the master, the others lead / lag it
    t: 0, air: 0, fastT: 0, entryT: cfg.entryTime[0], exitT: cfg.exitTimes.other, reason: '', lastJump: 99,
    e: cfg.angle[0], tight: 0, twist: 0, prevHeading: 0, yawRate: 0, init: false
  };

  /**
   * One frame. `st`: the rig state (grounded, swinging, cling, wallRun, vy, speed, speed3, landIn, airJumpT, heading). `block`: something else owns the body (the flip of a
   * released swing). Returns S.
   */
  function update(dt, st, block = false) {
    dt = clamp(dt, 1e-4, 0.1);
    S.t += dt;
    const vy = st.vy ?? 0, hs = st.speed ?? 0;
    if (!S.init) { S.init = true; S.prevHeading = st.heading ?? 0; }
    let dh = (st.heading ?? S.prevHeading) - S.prevHeading; dh = Math.atan2(Math.sin(dh), Math.cos(dh)); S.prevHeading = st.heading ?? S.prevHeading;
    S.yawRate = smooth(S.yawRate, clamp(dh / dt, -12, 12), dt, 10);

    const flying = !st.grounded && !st.swinging && !st.cling && !st.wallRun;
    S.air = flying ? S.air + dt : 0;
    const jt = st.airJumpT ?? -1;
    S.lastJump = jt >= 0 ? jt : S.lastJump + dt; // the second jump's own clock, then time since
    const jumping = jt >= 0 && jt < cfg.jumpBlock;
    const landIn = st.landIn ?? 9;
    const fast = vy < cfg.enterVy;
    S.fastT = fast ? S.fastT + dt : 0;

    let want = S.active;
    let reason = '';
    if (!S.active) {
      want = flying && !block && !jumping && S.air >= cfg.minAirTime && S.fastT >= cfg.enterDebounce && landIn > cfg.enterLandIn;
      if (want) { S.entryT = lerp(cfg.entryTime[0], cfg.entryTime[1], smoothstep(-cfg.enterVy, 30, -vy)); S.reason = ''; } // a faster fall dives in faster
    } else {
      if (!flying) reason = st.swinging ? 'swing' : st.cling || st.wallRun ? 'wall' : 'ground';
      else if (block) reason = 'other';
      else if (jumping) reason = 'jump';
      else if (vy > cfg.exitVy) reason = 'slow';
      else if (landIn < cfg.exitLandIn) reason = 'landing';
      if (reason) { want = false; S.reason = reason; /* a landing: done before the touch-down */ S.exitT = reason === 'landing' ? clamp(landIn - 0.04, cfg.exitTimes.ground, cfg.exitTimes.landing) : cfg.exitTimes[reason] ?? cfg.exitTimes.other; }
    }
    S.active = want;

    // progress: up over the entry time, down over the exit time (a dive let go and caught again continues from where it is)
    S.u = clamp(S.u + (S.active ? dt / S.entryT : -dt / S.exitT), 0, 1);
    S.w = S.wBody = ease(S.u * 1.08);
    S.wHead = ease(S.u * 1.4);
    S.wArms = ease((S.u - 0.1) / 0.9);
    S.wLegs = ease((S.u - 0.2) / 0.8);
    S.phase = S.active ? (S.u < 1 ? 'entry' : 'sustain') : S.u > 0 ? 'exit' : 'idle';

    // the pose follows the velocity: tighter the faster, the body angle below the horizon follows the direction of travel (bounded, so the chest keeps facing the ground)
    S.tight = smooth(S.tight, smoothstep(cfg.fastFrom, cfg.fastTo, -vy), dt, 3);
    S.e = smooth(S.e, clamp(Math.atan2(-vy, Math.max(hs, 1.5)), cfg.angle[0], cfg.angle[1]), dt, 3.5);
    S.twist = smooth(S.twist, clamp(-S.yawRate * hs / 26 * 0.7, -0.3, 0.3), dt, 5);
    return S;
  }

  return { state: S, update };
}

/**
 * The target pose of the dive for the state S (createFreefall). Everything in the model frame; fills and returns `out`:
 *   bodyPitch                          the pitch of the whole body about the chest (rad, forward positive)
 *   pelvis, spine, head: [yaw, roll, pitch]   (yaw about the body's long axis, roll about the chest axis, pitch forward positive); the head's is its own, relative to the model frame
 *   hipsY                              the pelvis offset
 *   arm[side]: { u: [x, y, z], f: [x, y, z] }   unit directions of the upper arm and the forearm, side 0 = left (+X), 1 = right
 *   foot[side]: { x, reach, z, pitch }  the ankle target: sideways x, `reach` = the fraction of the leg's length below the thigh joint, z behind / ahead of the pelvis
 *   poleX                              the knees point forward and out by this much
 *   curl, curlMicro[side]              the fingers: 0..1 curl and its small drift
 *   hand                               how far the wrists follow the forearms (0..1)
 */
function diveTargets(S, out = {}) {
  const t = S.t, k = S.tight, calm = 1 - 0.5 * k, hsw = S.twist;
  out.bodyPitch = Math.PI / 2 + S.e;
  // torso: extended, a slight forward chest inclination (never an arch), a twist about the long axis into turns, a little drift
  const pel = out.pelvis || (out.pelvis = [0, 0, 0]), sp = out.spine || (out.spine = [0, 0, 0]), hd = out.head || (out.head = [0, 0, 0]);
  pel[0] = hsw * 0.4 + 0.012 * calm * drift(t, 0.31, 0.77, 0.4); pel[1] = 0.012 * calm * drift(t, 0.27, 0.61, 2.1); pel[2] = 0.04 + 0.02 * k;
  sp[0] = hsw * 0.8 + 0.018 * calm * drift(t, 0.29, 0.83, 1.3); sp[1] = 0.016 * calm * drift(t, 0.23, 0.71, 0.2); sp[2] = 0.10 + 0.03 * k + 0.012 * calm * drift(t, 0.37, 0.93, 3.0);
  // head: along the body axis (the chest inclination taken out, a little lifted to look where it goes), small corrections
  hd[0] = -0.5 * sp[0] + 0.035 * calm * drift(t, 0.43, 1.09, 0.9); hd[1] = 0.022 * calm * drift(t, 0.33, 0.87, 2.6); hd[2] = -(pel[2] + sp[2]) * 0.9 - 0.04 + 0.02 * calm * drift(t, 0.39, 0.97, 4.2);
  out.hipsY = -0.02;
  // arms: swept back along the torso towards the feet; the upper arm leaves the body by `open` and goes back by `back`, the forearm less back (the elbow is slightly bent, pointing back)
  const open = lerp(0.30, 0.16, k), back = lerp(0.20, 0.30, k), flex = lerp(0.12, 0.07, k);
  const arms = out.arm || (out.arm = [{ u: [0, -1, 0], f: [0, -1, 0] }, { u: [0, -1, 0], f: [0, -1, 0] }]);
  for (let s = 0; s < 2; s++) {
    const side = s === 0 ? 1 : -1, ph = s === 0 ? 0 : 2.4, asym = s === 0 ? 0 : 0.02;
    const o = open + 0.03 * calm * drift(t, 0.51, 1.17, ph) + (s ? 0.01 : 0), b = back + asym + 0.03 * calm * drift(t, 0.47, 1.31, ph + 1.1), fl = flex + 0.025 * calm * drift(t, 0.59, 1.23, ph + 2.2);
    const u = arms[s].u, f = arms[s].f;
    let m = Math.hypot(side * o, 1, b); u[0] = side * o / m; u[1] = -1 / m; u[2] = -b / m;
    const fo = o * 0.7, fb = Math.max(0, b - fl); m = Math.hypot(fo, 1, fb); f[0] = side * fo / m; f[1] = -1 / m; f[2] = -fb / m;
  }
  // legs: extended behind the pelvis, a modest separation (narrower when fast), the knees slightly bent, the toes pointed along the airflow
  const feet = out.foot || (out.foot = [{}, {}]);
  for (let s = 0; s < 2; s++) {
    const ph = s === 0 ? 0.7 : 3.3, f = feet[s];
    f.x = lerp(0.17, 0.10, k) + 0.012 * calm * drift(t, 0.36, 0.89, ph); f.reach = lerp(0.962, 0.985, k) + 0.006 * calm * drift(t, 0.44, 1.07, ph + 0.5);
    f.z = -0.06 - 0.04 * k + 0.02 * calm * drift(t, 0.41, 0.99, ph + 1.4); f.pitch = 0.92 + 0.07 * calm * drift(t, 0.53, 1.19, ph + 2.0);
  }
  out.poleX = 0.2;
  // fingers: slightly curled and relaxed, never open and never a fist; a drift per hand
  out.curl = 0.32 + 0.04 * k;
  const cm = out.curlMicro || (out.curlMicro = [0, 0]);
  cm[0] = 0.07 * calm * drift(t, 0.61, 1.37, 0.3); cm[1] = 0.07 * calm * drift(t, 0.57, 1.29, 2.9);
  out.hand = 0.8;
  return out;
}

/**
 * Curl of one phalanx (rad) for the finger `index` (0 thumb, 1 index, 2 middle, 3 ring, 4 pinky) and the joint `joint` (0 base .. 2 tip), from the hand's curl 0..1 and its drift.
 * The thumb curls less, the little finger more; the tip joints curl more than the bases.
 */
function phalanxCurl(curl, micro, index, joint) {
  const finger = [0.55, 0.9, 1.0, 1.06, 1.12][clamp(index, 0, 4)], joints = [0.45, 0.8, 0.6][clamp(joint, 0, 2)];
  return clamp((curl + micro * (1 + 0.15 * index)) * finger * joints * 1.5, 0, 1.4);
}

export { FREEFALL, createFreefall, diveTargets, phalanxCurl, qAxisAngle, qMul, qNormalize, ease, drift };
