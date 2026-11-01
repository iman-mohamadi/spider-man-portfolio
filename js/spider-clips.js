import * as THREE from 'three/webgpu';

// Clip-driven animation for the Mixamo-skeleton Spider-Man. Real Mixamo clips are played with a Three.js AnimationMixer; the procedural rig (spider-anim.js)
// stays as a LAYER on top for what clips cannot know: hanging from the web, reaching for the anchor, the air poses when no jump/fall clip exists, the
// foot locking, and body lean from acceleration and turning.
//
//  bakeRetarget  a Mixamo clip made for another skeleton -> a clip baked for THIS skeleton (world-space retarget, see its comment): bone axes and roll
//                 may differ, the hips follow the source scaled to this character's legs; the travel is removed (the controller moves the body).
//  analyseClip    measures, on this skeleton, how fast the ground moves under a planted foot and when the left foot lands. clipEvents/clipMeta: contact and flight times.
//  ClipAnimator   "slots": every clip is an action whose time the caller sets each frame; weights are smoothed and normalised here.
//  createClipRig  the state machine: ground locomotion (idle/walk/run/sprint on ONE shared gait phase advanced at ground speed / stride, so planted feet do not
//                 slide), jump scrubbed by vertical speed, landings, the swing start/loop scrubbed by the pendulum, the swing-to-landing flip scrubbed by the
//                 time to impact; the procedural pose is mixed in per bone (always on the web arm while swinging, so the hand stays on the anchor).

const TMP = { v: new THREE.Vector3(), q: new THREE.Quaternion(), q2: new THREE.Quaternion(), q3: new THREE.Quaternion() };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const HIPS = /^mixamorig:?Hips$/;

function findBone(root, re) { let r = null; root.traverse((o) => { if (!r && o.isBone && re.test(o.name)) r = o; }); return r; }
const boneName = (n) => n.replace(/^mixamorig:/, 'mixamorig'); // FBX exports can carry a colon

/**
 * { hipsHeight (m), unit (metres per local unit of the hips' parent), parentQuat } in the pose the skeleton is in right now. parentQuat is the world
 * rotation of the hips' parent: a Blender-made armature is rotated (Z up) while a Mixamo one is not (Y up), and the hips track is expressed in that
 * parent's frame. A GLB whose parent node is scaled 0.01 (the Three.js Xbot) is already in metres at the world level; an FBX loaded without scaling
 * is in centimetres.
 */
function skeletonMeta(root) {
  root.updateMatrixWorld(true);
  const hips = findBone(root, HIPS);
  const h = hips.getWorldPosition(new THREE.Vector3()).y;
  const scale = hips.parent ? hips.parent.getWorldScale(new THREE.Vector3()).x : 1;
  const q = hips.parent ? hips.parent.getWorldQuaternion(new THREE.Quaternion()) : new THREE.Quaternion();
  const parentQuat = [q.x, q.y, q.z, q.w];
  return scale === 1 && h > 20 ? { hipsHeight: h * 0.01, unit: 0.01, parentQuat } : { hipsHeight: h, unit: scale, parentQuat };
}

/**
 * World-space retarget: plays `srcClip` on the source skeleton `srcRoot` and BAKES a clip for `dstRoot` (this character). Per bone, the world rotation the
 * source moves away from its own rest pose is applied to this skeleton's own rest pose, so differences in bone axes and roll (a Blender-made rig is
 * not a stock Mixamo rig: copying local rotations flips the legs) do not matter; only the rest poses must be alike (both T-poses). The hips follow the
 * source hips scaled to this character's leg length, with the travel removed (the controller moves the body). Both characters must face +Z, Y up.
 * `dstRoot` must be in its rest pose and `srcRoot` in its rest pose when called.
 */
const swapLR = (n) => n.replace(/Left/g, '\u0000').replace(/Right/g, 'Left').replace(/\u0000/g, 'Right');
const mirrorQ = (q) => { q.set(q.x, -q.y, -q.z, q.w); return q; }; // reflection across the YZ plane (x -> -x) of a world rotation

/**
 * Options: mirror (left becomes right: the motion of every bone pair is swapped and reflected, so a clip made for a left-hand swing serves the right hand);
 * hips 'full' keeps the clip's hips height, 'crouchOnly' keeps only the part BELOW standing height (the game's physics provides the height of the body, so a jump or
 * swing clip must not lift it again; a crouch for the landing still counts); rootXZ 'detrend' removes the travel but keeps the sway, 'strip' removes both.
 * armRest 'align': the Mixamo clips start from a T-pose (arms horizontal) but the Raimi model is modelled in an A-pose (upper arms 42 degrees down), so the "same world
 * rotation from the rest pose" puts every arm 42 degrees too far in (hanging arms end up crossing in front of the pelvis). With 'align' the arm chain (arm, forearm,
 * hand, fingers) of each side is first turned, as one rigid piece, so its rest direction equals the source's (the model's T-pose equivalent), then the clip is applied.
 * armSpread (degrees): turns the whole arm chain outwards about the shoulder, for the clips whose elbows would otherwise graze this model's broader chest.
 * Legs, spine and clavicles already agree with the source rest pose and are left alone. 'none' (the default) keeps the clips exactly as they were baked before.
 */
function bakeRetarget(srcClip, srcRoot, dstRoot, { name = srcClip.name, fps = 30, mirror = false, hips = 'full', rootXZ = 'detrend', standing = 0.934, armRest = 'none', armSpread = 0, report = null } = {}) {
  const Q = THREE.Quaternion, V = THREE.Vector3;
  srcRoot.updateMatrixWorld(true); dstRoot.updateMatrixWorld(true);
  const srcBones = new Map(), dstBones = [];
  srcRoot.traverse((o) => { if (o.isBone) srcBones.set(boneName(o.name), o); });
  dstRoot.traverse((o) => { if (o.isBone) dstBones.push(o); });
  const restS = new Map(), restD = new Map();
  for (const [n, b] of srcBones) restS.set(n, b.getWorldQuaternion(new Q()));
  for (const b of dstBones) restD.set(b, b.getWorldQuaternion(new Q()));
  const srcOf = (b) => srcBones.get(mirror ? swapLR(b.name) : b.name);
  const driven = dstBones.filter((b) => srcOf(b)); // parents come before children in traverse order
  const srcHips = srcBones.get('mixamorigHips'), dstHips = dstBones.find((b) => HIPS.test(b.name));
  const srcH = srcHips.getWorldPosition(new V()), dstH = dstHips.getWorldPosition(new V());
  const srcScaleToM = srcH.y > 20 ? 0.01 : 1; // an FBX in centimetres
  const ratio = dstH.y / (srcH.y * srcScaleToM);
  const armK = new Map(); // dst arm-chain bone -> world rotation that brings its A-pose rest direction onto the source's T-pose one
  if (armRest === 'align') {
    const dstByName = new Map(dstBones.map((b) => [boneName(b.name), b])), va = new V(), vb = new V();
    const dir = (a, b2, out) => out.copy(b2.getWorldPosition(vb)).sub(a.getWorldPosition(va)).normalize();
    // each segment gets its own correction (the model's forearm also points a little forward of its upper arm, which the source's straight T-pose arm does not)
    const chain = [['Arm', 'ForeArm', /^Arm$/], ['ForeArm', 'Hand', /^ForeArm$/], ['Hand', 'HandMiddle1', /^Hand/]];
    for (const side of ['Left', 'Right']) {
      const srcSide = mirror ? (side === 'Left' ? 'Right' : 'Left') : side;
      for (const [from, to, rx] of chain) {
        const dA = dstByName.get(`mixamorig${side}${from}`), dB = dstByName.get(`mixamorig${side}${to}`), sA = srcBones.get(`mixamorig${srcSide}${from}`), sB = srcBones.get(`mixamorig${srcSide}${to}`);
        if (!dA || !dB || !sA || !sB) continue;
        const ud = dir(dA, dB, new V()), us = dir(sA, sB, new V()); if (mirror) us.x = -us.x;
        const K = new Q().setFromUnitVectors(ud, us);
        for (const b of dstBones) { const m = new RegExp(`^mixamorig${side}(.*)$`).exec(boneName(b.name)); if (m && (rx.test(m[1]) )) armK.set(b, K); }
      }
    }
  }
  const spreadQ = { Left: new Q().setFromAxisAngle(new V(0, 0, 1), armSpread * Math.PI / 180), Right: new Q().setFromAxisAngle(new V(0, 0, 1), -armSpread * Math.PI / 180) }; // about +Z: the model's left (+X) arm swings out
  const parentInv = dstHips.parent ? dstHips.parent.matrixWorld.clone().invert() : new THREE.Matrix4();
  const mixer = new THREE.AnimationMixer(srcRoot), action = mixer.clipAction(srcClip); action.play();
  const n = Math.max(2, Math.round(srcClip.duration * fps) + 1), times = [], q = new Map(), hipsPos = [];
  for (const b of driven) q.set(b, []);
  const worldD = new Map(), tmpA = new Q(), tmpB = new Q(), v = new V();
  const animWorld = (bone) => { // animated world rotation of any destination node (driven ones were computed this frame; helpers keep their rest relation)
    if (worldD.has(bone)) return worldD.get(bone);
    const par = bone.parent;
    let w;
    if (!par || !par.isBone) w = bone.parent ? bone.parent.getWorldQuaternion(new Q()) : new Q();
    else w = animWorld(par).clone().multiply(restD.get(par).clone().invert()).multiply(restD.get(bone) || bone.getWorldQuaternion(new Q()));
    if (!par || !par.isBone) { /* the armature above the skeleton: constant */ }
    worldD.set(bone, w); return w;
  };
  for (let k = 0; k < n; k++) {
    const t = Math.min(srcClip.duration, k / fps); times.push(t);
    action.time = k === n - 1 ? srcClip.duration : t; mixer.update(0); srcRoot.updateMatrixWorld(true);
    worldD.clear();
    for (const b of driven) {
      const sb = srcOf(b);
      const D = sb.getWorldQuaternion(tmpA).multiply(restS.get(boneName(sb.name)).clone().invert()); // world rotation away from the source's rest pose
      if (mirror) mirrorQ(D);
      const Wd = D.clone().multiply(armK.has(b) ? armK.get(b).clone().multiply(restD.get(b)) : restD.get(b)); // the same movement on this skeleton's rest pose
      if (armSpread && armK.has(b)) Wd.premultiply(boneName(b.name).startsWith('mixamorigLeft') ? spreadQ.Left : spreadQ.Right);
      worldD.set(b, Wd);
      const P = b.parent && b.parent.isBone ? animWorld(b.parent) : (b.parent ? b.parent.getWorldQuaternion(tmpB) : new Q());
      q.get(b).push(P.clone().invert().multiply(Wd));
    }
    srcHips.getWorldPosition(v); v.multiplyScalar(srcScaleToM).multiplyScalar(ratio);
    if (mirror) v.x = -v.x;
    hipsPos.push(v.clone());
  }
  mixer.stopAllAction(); mixer.uncacheRoot(srcRoot);
  // hips: remove the travel (x, z trend), keep the vertical motion and the sway; then into the armature's frame and local units
  const T = times[n - 1] || 1;
  if (report) report.rootSpeed = Math.hypot(hipsPos[n - 1].x - hipsPos[0].x, hipsPos[n - 1].z - hipsPos[0].z) / T; // the clip's own ground speed in m/s, as made for THIS character's size
  for (const axis of ['x', 'z']) {
    const first = hipsPos[0][axis], last = hipsPos[n - 1][axis];
    for (let i = 0; i < n; i++) hipsPos[i][axis] = rootXZ === 'strip' ? dstH[axis] : dstH[axis] + (hipsPos[i][axis] - first) - (last - first) * (times[i] / T);
  }
  if (hips === 'crouchOnly') for (const hp of hipsPos) hp.y = standing + Math.min(0, hp.y - standing);
  const posVals = [];
  for (const hp of hipsPos) { hp.applyMatrix4(parentInv); posVals.push(hp.x, hp.y, hp.z); }
  const tracks = [new THREE.VectorKeyframeTrack(`${dstHips.name}.position`, times, posVals)];
  for (const b of driven) {
    const vals = []; for (const qq of q.get(b)) vals.push(qq.x, qq.y, qq.z, qq.w);
    for (let i = 1; i < n; i++) { // keep neighbouring quaternions in the same hemisphere (no 360-degree interpolation flips)
      const a = i * 4, p = (i - 1) * 4; if (vals[a] * vals[p] + vals[a + 1] * vals[p + 1] + vals[a + 2] * vals[p + 2] + vals[a + 3] * vals[p + 3] < 0) for (let c = 0; c < 4; c++) vals[a + c] = -vals[a + c];
    }
    tracks.push(new THREE.QuaternionKeyframeTrack(`${b.name}.quaternion`, times, vals));
  }
  return new THREE.AnimationClip(name, srcClip.duration, tracks);
}

/**
 * Plays the clip in place on `root` and measures, in metres per second, the ground speed implied by the planted feet and the phase (0..1) at which the
 * left foot lands. The skeleton is restored to the pose it had.
 */
function analyseClip(clip, root, samples = 72) {
  const lf = findBone(root, /^mixamorig:?LeftFoot$/), rf = findBone(root, /^mixamorig:?RightFoot$/);
  const saved = []; root.traverse((o) => { if (o.isBone) saved.push([o, o.position.clone(), o.quaternion.clone(), o.scale.clone()]); });
  const mixer = new THREE.AnimationMixer(root), action = mixer.clipAction(clip); action.play();
  const dur = clip.duration, dt = dur / samples, series = { L: [], R: [] };
  for (let i = 0; i <= samples; i++) {
    action.time = (i % samples) * dt; mixer.update(0); root.updateMatrixWorld(true);
    lf.getWorldPosition(TMP.v); series.L.push([TMP.v.y, TMP.v.z]);
    rf.getWorldPosition(TMP.v); series.R.push([TMP.v.y, TMP.v.z]);
  }
  mixer.stopAllAction(); mixer.uncacheRoot(root);
  for (const [o, p, q, s] of saved) { o.position.copy(p); o.quaternion.copy(q); o.scale.copy(s); }
  root.updateMatrixWorld(true);
  // ground speed = the plateau of the foot's backward velocity during stance (the dominant value in a histogram of velocities, not a mean that heel/toe
  // roll and the swing would pull around); the two feet are averaged
  const plateau = (side) => {
    const z = series[side].map((p) => p[1]), vel = [];
    for (let i = 0; i < samples; i++) vel.push(-(z[i + 1] - z[i]) / dt);
    const bins = new Map(); // 0.2 m/s wide
    for (const v of vel) if (v > 0.3) { const k = Math.round(v / 0.2); bins.set(k, (bins.get(k) || 0) + 1); }
    let best = 0, bk = 0; for (const [k, c] of bins) { const c3 = c + (bins.get(k - 1) || 0) + (bins.get(k + 1) || 0); if (c3 > best) { best = c3; bk = k; } }
    let sum = 0, cnt = 0; for (const v of vel) if (Math.abs(v - bk * 0.2) < 0.35) { sum += v; cnt++; }
    return cnt ? sum / cnt : 0;
  };
  const speed = (plateau('L') + plateau('R')) / 2;
  const n = 1;
  // left foot contact: first sample of the longest run of low-ankle samples
  let contact = 0;
  const L = series.L, minL = Math.min(...L.map((q) => q[0])), low = L.slice(0, samples).map((q) => q[0] < minL + 0.05);
  for (let i = 0; i < samples; i++) if (low[i] && !low[(i + samples - 1) % samples]) { contact = i / samples; break; }
  return { duration: dur, speed: Math.max(0, speed), contact, stride: Math.max(0, speed) * dur, stanceSamples: n };
}

const MAX_CADENCE = 2.1; // x the natural cycle rate of a locomotion clip: past that the feet slide a little instead of the legs becoming a cartoon

/** Contact and flight events of a clip, from the toes' height (sampled at 60 Hz on `root`, which is restored afterwards). */
function clipEvents(clip, root) {
  const lt = findBone(root, /^mixamorig:?LeftToeBase$/), rt = findBone(root, /^mixamorig:?RightToeBase$/);
  const saved = []; root.traverse((o) => { if (o.isBone) saved.push([o, o.position.clone(), o.quaternion.clone(), o.scale.clone()]); });
  const mixer = new THREE.AnimationMixer(root), a = mixer.clipAction(clip); a.play();
  const n = Math.max(2, Math.round(clip.duration * 60)), L = [], R = [];
  for (let i = 0; i <= n; i++) { a.time = clip.duration * i / n; mixer.update(0); root.updateMatrixWorld(true); lt.getWorldPosition(TMP.v); L.push(TMP.v.y); rt.getWorldPosition(TMP.v); R.push(TMP.v.y); }
  mixer.stopAllAction(); mixer.uncacheRoot(root);
  for (const [o, p, q, s] of saved) { o.position.copy(p); o.quaternion.copy(q); o.scale.copy(s); }
  root.updateMatrixWorld(true);
  const ref = Math.min(...L, ...R), LOW = ref + 0.035, HIGH = ref + 0.09; // toe heights relative to the lowest the toes ever get in the clip (the floor)
  let firstContact = null, segs = [], start = null;
  for (let i = 0; i <= n; i++) {
    const lo = Math.min(L[i], R[i]), hi = Math.max(L[i], R[i]), t = clip.duration * i / n;
    if (firstContact === null && lo < LOW) firstContact = t;
    if (start === null && lo > HIGH) start = i === 0 ? 0 : t; // both feet off the ground
    else if (start !== null && lo < LOW) { segs.push([start, t]); start = null; }
  }
  if (start !== null) segs.push([start, clip.duration]);
  const best = segs.sort((x, y) => (y[1] - y[0]) - (x[1] - x[0]))[0] || null;
  return { firstContact: firstContact ?? 0, airStart: best ? best[0] : null, airEnd: best ? best[1] : null, airSegments: segs.length };
}

/** Everything the runtime needs to know about a baked clip. `rootSpeed` is the clip's true ground speed (its root motion, scaled to this character) where it has one. */
function clipMeta(clip, root, { rootSpeed = 0 } = {}) {
  const foot = analyseClip(clip, root), ev = clipEvents(clip, root);
  return { duration: +clip.duration.toFixed(4), rootSpeed: +rootSpeed.toFixed(3), footSpeed: +foot.speed.toFixed(3), contact: +foot.contact.toFixed(3), ...Object.fromEntries(Object.entries(ev).map(([k, v]) => [k, v === null ? null : +(+v).toFixed(4)])) };
}
const groundSpeedOf = (e) => (e.meta.rootSpeed > 0.3 ? e.meta.rootSpeed : e.meta.footSpeed);

/** Slots: every clip is an action whose time is set by the caller each frame (timeScale 0); weights are smoothed here and normalised to sum to 1. */
class ClipAnimator {
  constructor(root, set) {
    this.root = root; this.set = set;
    this.mixer = new THREE.AnimationMixer(root);
    this.actions = {}; this.w = {}; this.req = {};
    for (const [k, v] of Object.entries(set)) {
      const a = this.mixer.clipAction(v.clip); a.setLoop(THREE.LoopRepeat, Infinity); a.clampWhenFinished = false;
      a.play(); a.timeScale = 0; a.time = 0; a.setEffectiveWeight(0);
      this.actions[k] = a; this.w[k] = 0;
    }
  }
  has(n) { return !!this.set[n]; }
  /** Wants clip `name` at `time` seconds with weight `weight` this frame; `rate` is how fast its weight follows (per second). */
  request(name, time, weight, rate = 12) { if (this.actions[name]) this.req[name] = { time, weight, rate }; }
  /** Applies the requests, smooths the weights, normalises and evaluates the mixer. Returns the normalised weights. */
  flush(dt, fadeRate = 14) {
    let sum = 0;
    for (const n of Object.keys(this.actions)) {
      const r = this.req[n], target = r ? r.weight : 0, rate = r ? r.rate : fadeRate;
      this.w[n] += (target - this.w[n]) * (1 - Math.exp(-rate * dt));
      if (this.w[n] < 0.0005 && target === 0) this.w[n] = 0;
      if (r) this.actions[n].time = clamp(r.time, 0, this.set[n].clip.duration - 1e-4);
      sum += this.w[n];
    }
    const k = sum > 1e-4 ? 1 / sum : 0;
    for (const n of Object.keys(this.actions)) this.actions[n].setEffectiveWeight(this.w[n] * k);
    this.req = {};
    this.mixer.update(0);
    return this.w;
  }
}

// bone weights for the procedural layer while hanging from the web: the clip leads the body (legs, torso), the procedural pose owns the web arm
const SWING_BONES = { hips: 0.35, spine: 0.35, head: 0.5, leg: 0.2, webArm: 1.0, freeArm: 0.3 };
const CLIP_STATES = ['idle', 'walk', 'run', 'sprint'];

/**
 * Wraps the procedural rig `proc` (createSpiderRig's result: it also tilts the body `visual`, foot-locks and holds the swing pose). The clips drive the
 * base layer; the procedural pose is blended in per bone: fully on the web arm while swinging, partly on the body, as a launch pose right after a release,
 * and for any state that has no clips. Cfg (optional): sprintFrom/sprintTo = speeds (m/s) over which Sprint takes over from Running.
 */
function createClipRig({ root, visual, proc, set, cfg = {} }) {
  const animator = new ClipAnimator(root, set);
  const C = { sprintFrom: 9, sprintTo: 13, runStopFrom: 4.5, runJumpFrom: 5, ...cfg };
  const R = proc.rig;
  const driven = [R.hips, R.head, ...R.spine, ...Object.values(R.L).filter((b) => b !== R.L.hand), ...Object.values(R.R).filter((b) => b !== R.R.hand)];
  const boneKind = (b) => b === R.hips ? 'hips' : R.spine.includes(b) ? 'spine' : b === R.head ? 'head' : [R.L.upper, R.L.fore, R.R.upper, R.R.fore].includes(b) ? 'arm' : 'leg';
  const snap = driven.map((b) => ({ b, kind: boneKind(b), left: Object.values(R.L).includes(b), q: new THREE.Quaternion(), p: new THREE.Vector3() }));
  const AX = { right: new THREE.Vector3(), fwd: new THREE.Vector3(), up: new THREE.Vector3(0, 1, 0) };
  const hasLoco = animator.has('idle') || animator.has('walk') || animator.has('run');
  const hasAir = animator.has('fall') || animator.has('jump');
  const hasSwing = animator.has('swingLoop');
  const S = {
    mode: 'ground', wSwing: 0, wWeb: 0, wLaunch: 0, wAirProc: 0, lean: 0, bank: 0, twist: 0, prevSpeed: 0, accel: 0, yawRate: 0, prevHeading: 0, init: false,
    phase: 0, peakV: 0, webW: [new THREE.Quaternion(), new THREE.Quaternion()], idleT: 0, fallT: 0, wasGrounded: true, wasSwinging: false, lastAirVy: 0, lastSpeed: 0,
    air: { jumped: false, vyUp: 10, t: 0, clip: 'jump' }, shot: null, sw: { t: 0 }, rel: { t: 99, flip: false, scrub: 0 }, vyK: 0, scrubT: 0.1, slots: {}
  };

  function rotateBoneWorld(bone, axis, angle) {
    bone.updateWorldMatrix(true, false);
    bone.getWorldQuaternion(TMP.q); TMP.q2.setFromAxisAngle(axis, angle).multiply(TMP.q);
    if (bone.parent) { bone.parent.getWorldQuaternion(TMP.q3); bone.quaternion.copy(TMP.q3.invert()).multiply(TMP.q2); } else bone.quaternion.copy(TMP.q2);
  }
  const e = (name) => animator.set[name];
  const ev = (name) => (e(name) ? e(name).meta : null);
  // swing clips come in two hands: `meta.hand` says which hand reaches for the web in the original, `<name>M` is the mirror image; webSide > 0 = the left hand holds the web
  const variant = (base, st) => { const m = ev(base); if (!m || !m.hand || m.hand === (st.webSide > 0 ? 'L' : 'R')) return base; return animator.has(base + 'M') ? base + 'M' : base; };

  /** Starts a one-shot (landing, stop): it plays from `from` at `rate` and fades in/out; the locomotion layer keeps running under it. */
  function startShot(name, from, rate, { fadeIn = 0.05, fadeOut = 0.3, end = null, cancelSpeed = Infinity, maxW = 1 } = {}) {
    if (!animator.has(name)) return;
    const dur = e(name).clip.duration;
    S.shot = { name, t: from, rate, end: end ?? dur * 0.9, fadeIn, fadeOut, cancelSpeed, maxW, age: 0 };
  }

  function update(dt, st) {
    dt = clamp(dt, 1e-4, 0.1);
    const swinging = !!st.swinging, grounded = !!st.grounded && !swinging, hs = st.speed;
    if (!S.init) { S.init = true; S.prevSpeed = hs; S.prevHeading = st.heading ?? 0; S.lastSpeed = hs; }
    S.accel += (clamp((hs - S.prevSpeed) / dt, -80, 60) - S.accel) * (1 - Math.exp(-dt * 8));
    let dh = (st.heading ?? 0) - S.prevHeading; dh = Math.atan2(Math.sin(dh), Math.cos(dh)); S.prevHeading = st.heading ?? 0;
    S.yawRate += (clamp(dh / dt, -12, 12) - S.yawRate) * (1 - Math.exp(-dt * 12));

    // ------------------------------------------------------------ transitions
    if (S.wasGrounded && !grounded && !swinging) { // a jump or a step off an edge; a jump taken at running speed uses the running jump, which starts in a stride
      S.air = { jumped: st.vy > 4, vyUp: Math.max(st.vy, 4), t: 0, clip: S.lastSpeed >= C.runJumpFrom && animator.has('runJump') ? 'runJump' : 'jump' }; S.shot = null; S.rel.flip = false;
    }
    if (!S.wasGrounded && !S.wasSwinging && grounded) { // touch-down
      const impact = -S.lastAirVy, flipLand = S.rel.flip && animator.has(variant('swingLand', st));
      S.rel.flip = false;
      // the swing-to-land clip ends in its crouch: play all of it, then hold the last pose a moment before the fade
      if (flipLand) { const n = variant('swingLand', st); startShot(n, ev(n).airEnd ?? 1.3, 1.0, { fadeIn: 0.04, fadeOut: 0.4, end: e(n).clip.duration + 0.2, cancelSpeed: 6.5 }); }
      else if (impact > 14 && animator.has('hardLand')) startShot('hardLand', ev('hardLand').firstContact, 1.35, { fadeOut: 0.4, end: e('hardLand').clip.duration * 0.62, cancelSpeed: 5 });
      else if (S.air.clip === 'runJump' && S.air.jumped && hs > 3 && animator.has('runJump')) startShot('runJump', ev('runJump').airEnd ?? 0.6, 1.0, { fadeIn: 0.05, fadeOut: 0.22, end: e('runJump').clip.duration }); // lands in a stride: the clip carries on into the run
      else if (animator.has('jump') && (S.air.jumped || impact > 6)) startShot('jump', ev('jump').airEnd ?? 1.1, 1.4, { fadeIn: 0.04, fadeOut: 0.3, end: e('jump').clip.duration * 0.85, cancelSpeed: 4 });
    }
    if (!S.wasSwinging && swinging) { S.sw = { t: 0 }; S.shot = null; S.rel.flip = false; }
    if (S.wasSwinging && !swinging) { // let go of the web
      S.rel = { t: 0, flip: false, scrub: 0 };
      S.air = { jumped: st.vy > 3, vyUp: Math.max(st.vy, 4), t: 0, clip: 'jump' }; // flung upwards: the jump clip's rise; otherwise the falling clip
      const n = variant('swingLand', st);
      if (animator.has(n) && st.landIn > 0.8 && st.landIn < 2.4 && hs > 5) S.rel.flip = true; // enough air for the flip, and moving
    }
    if (!grounded && !swinging) S.lastAirVy = st.vy;
    if (!grounded) S.peakV = 0;
    if (!swinging) S.rel.t += dt;
    // run to a standstill: the stop clip settles the body (it plays in place; the body is already still)
    S.peakV = Math.max(hs, S.peakV * Math.exp(-dt * 3)); // the game brakes from a sprint to a standstill in a quarter of a second: remember the speed we came from
    if (grounded && !S.shot && S.peakV > C.runStopFrom && hs < 1.2 && animator.has('runStop')) { S.peakV = 0; startShot('runStop', 0.12, 1.5, { fadeIn: 0.05, fadeOut: 0.25, end: e('runStop').clip.duration * 0.7, cancelSpeed: 1.8 }); }
    S.wasGrounded = grounded; S.wasSwinging = swinging; S.lastSpeed = hs;

    // ------------------------------------------------------------ slot requests
    const slots = S.slots; for (const k in slots) delete slots[k];
    // a one-shot (landing / stop) in progress: weight envelope, ends when the clip window ends or the body is running again
    let wShot = 0;
    if (S.shot) {
      const sh = S.shot; sh.age += dt;
      const running = hs > sh.cancelSpeed ? clamp((hs - sh.cancelSpeed) / 1.8, 0, 1) : 0;
      sh.t += dt * sh.rate * (1 + 1.2 * running); // a body that is already running again gets the crouch over with sooner
      const left = sh.end - sh.t;
      wShot = sh.maxW * smoothstep(0, sh.fadeIn, sh.age) * smoothstep(0, sh.fadeOut, left) * (1 - 0.65 * running);
      if (left <= 0 || !grounded) S.shot = null;
      else animator.request(sh.name, sh.t, wShot, 22);
    }
    S.mode = swinging ? 'swing' : grounded ? 'ground' : 'air';

    if (grounded) {
      // ground locomotion: idle <-> walk <-> run <-> sprint, one shared phase advanced at (ground speed / blended stride)
      const idleE = e('idle'), walkE = e('walk'), runE = e('run'), spE = e('sprint');
      const vW = walkE ? groundSpeedOf(walkE) : 1.7, vR = runE ? groundSpeedOf(runE) : 5.7;
      const w = { idle: 0, walk: 0, run: 0, sprint: 0 };
      const mv = smoothstep(0.1, Math.max(0.6, vW * 0.7), hs); // 0 standing .. 1 moving
      w.idle = idleE ? 1 - mv : 0;
      let g = { walk: 0, run: 0, sprint: 0 };
      if (walkE && runE) { const k = smoothstep(vW * 0.85, vR * 0.9, hs); g.walk = 1 - k; g.run = k; }
      else if (runE) g.run = 1; else if (walkE) g.walk = 1;
      if (spE && g.run > 0) { const s2 = smoothstep(C.sprintFrom, C.sprintTo, hs); g.sprint = g.run * s2; g.run *= 1 - s2; }
      if (!idleE) { w.idle = 0; }
      const moving = mv * (g.walk + g.run + g.sprint);
      let stride = 0, dur = 0, norm = g.walk + g.run + g.sprint;
      for (const nme of ['walk', 'run', 'sprint']) if (g[nme] > 0) { const en = e(nme); stride += g[nme] / norm * groundSpeedOf(en) * en.clip.duration; dur += g[nme] / norm * en.clip.duration; }
      if (stride > 0.1 && hs > 0.15) {
        const rate = Math.min(hs / stride, MAX_CADENCE / Math.max(0.2, dur)); // cycles per second keeping planted feet still, capped
        S.phase = (S.phase + dt * rate) % 1;
      }
      S.idleT = idleE ? (S.idleT + dt) % idleE.clip.duration : 0;
      const free = 1 - wShot; // a landing / stop clip owns the body while it plays (blending a little of a standing pose into a far-away pose would bend the shortest-path interpolation)
      if (idleE) animator.request('idle', S.idleT, w.idle * free, 12);
      for (const nme of ['walk', 'run', 'sprint']) if (e(nme)) animator.request(nme, ((S.phase + e(nme).meta.contact) % 1) * e(nme).clip.duration, mv * g[nme] * free, 12);
      if (!hasLoco) { /* nothing to play: the procedural rig has the ground */ }
    } else if (swinging && hasSwing) {
      const sA = variant('swingStart', st), lA = variant('swingLoop', st);
      S.sw.t += dt;
      // start: reach and pull (0.15 .. ~0.9 s of the clip), handing over to the loop which is scrubbed by the pendulum (rising = legs forward and leaning back)
      const tStart = 0.15 + S.sw.t, startDur = animator.has(sA) ? Math.min(1.0, e(sA).clip.duration - 0.05) : 0;
      const wStart = animator.has(sA) ? 1 - smoothstep(startDur - 0.35 - 0.15, startDur - 0.15, tStart) : 0;
      const vyK = clamp(st.vy / 16, -1, 1); S.vyK += (vyK - S.vyK) * (1 - Math.exp(-dt * 6));
      const dL = e(lA).clip.duration, tgt = lerp(0.02, 0.47, smoothstep(-0.6, 0.8, S.vyK)) * dL;
      S.scrubT += (tgt - S.scrubT) * (1 - Math.exp(-dt * 10));
      if (animator.has(sA) && wStart > 0.01) animator.request(sA, tStart, wStart, 16);
      animator.request(lA, S.scrubT, 1 - wStart, 16);
      if (animator.has('idle')) animator.request('idle', (S.idleT = (S.idleT + dt) % e('idle').clip.duration), 0.04, 8); // fingers and neck stay alive
    } else if (!swinging && hasAir) {
      const flipName = variant('swingLand', st);
      if (S.rel.flip && animator.has(flipName)) {
        // the swing-to-landing flip: scrubbed so that it touches down exactly when the body does (it waits at its first pose until the time to impact fits)
        const tT = ev(flipName).airEnd ?? 1.3, want = clamp(tT - st.landIn, 0, tT - 0.02);
        S.rel.scrub += clamp(want - S.rel.scrub, -dt * 3.2, dt * 3.2); // never faster than 3.2x real time, whatever the landing prediction does
        animator.request(flipName, S.rel.scrub, 1, 14);
      } else {
        const A = S.air, vy = st.vy;
        let wJump = 0;
        const jn = animator.has(A.clip) ? A.clip : 'jump';
        if (A.jumped && animator.has(jn)) {
          const phi = (A.vyUp - vy) / (2 * A.vyUp), m = ev(jn);
          const tj = lerp(m.airStart ?? 0.54, m.airEnd ?? 1.1, clamp(phi, 0, 1));
          wJump = 1 - smoothstep(0.95, 1.3, phi);
          animator.request(jn, tj, wJump, 18);
        }
        if (animator.has('fall')) { S.fallT = (S.fallT + dt) % e('fall').clip.duration; animator.request('fall', S.fallT, 1 - wJump, 14); }
        if (animator.has('idle')) animator.request('idle', (S.idleT = (S.idleT + dt) % e('idle').clip.duration), 0.02, 8);
      }
    } else if (animator.has('idle')) animator.request('idle', (S.idleT = (S.idleT + dt) % e('idle').clip.duration), 1, 10);

    animator.flush(dt, S.rel.flip || (S.shot && S.shot.name.startsWith('swingLand')) ? 30 : 14); // a flip rotates the whole body: the clips it replaces must be gone before the body is upside down

    // ------------------------------------------------------------ procedural layer, per bone
    // per-bone share of the procedural swing pose (scaled by the smoothed wSwing, so it fades out with the release instead of switching): the web arm stays fully procedural
    const isWeb = (b) => b.kind === 'arm' && b.left === (st.webSide > 0);
    const swingShare = (b) => (!hasSwing ? S.wSwing : isWeb(b) ? S.wWeb * SWING_BONES.webArm : S.wSwing * (b.kind === 'arm' ? SWING_BONES.freeArm : SWING_BONES[b.kind]));
    const alwaysProc = !swinging && (grounded ? !hasLoco : !hasAir) ? 1 : 0; // nothing to play for this state: the procedural pose owns it
    const launch = !swinging && !grounded && S.rel.t < 0.55 && !S.rel.flip ? 0.8 * (1 - smoothstep(0.05, 0.5, S.rel.t)) : 0; // the stretched launch pose just after a release
    S.wLaunch += (launch - S.wLaunch) * (1 - Math.exp(-dt * 12));
    S.wSwing += ((swinging ? 1 : 0) - S.wSwing) * (1 - Math.exp(-dt * (swinging ? 14 : 8)));
    S.wWeb += ((swinging ? 1 : 0) - S.wWeb) * (1 - Math.exp(-dt * (swinging ? 20 : 8))); // the web arm reaches for the anchor within about a tenth of a second
    S.wAirProc += (alwaysProc - S.wAirProc) * (1 - Math.exp(-dt * (alwaysProc > S.wAirProc ? 12 : 8)));
    let any = S.wLaunch;
    const bw = snap.map((s) => { const t = Math.max(S.wLaunch, swingShare(s), S.wAirProc); any = Math.max(any, t); return Math.min(1, t); });
    if (any > 0.002) {
      for (const s of snap) { s.q.copy(s.b.quaternion); s.p.copy(s.b.position); }
      proc.update(dt, st); // the procedural pose (also tilts `visual`, locks feet, holds the web arm on the anchor)
      // the web arm aims at the anchor in WORLD space; remember that aim, because blending the torso with the clip would turn the arm away with it
      const wa = st.webSide > 0 ? [R.L.upper, R.L.fore] : [R.R.upper, R.R.fore], hold = hasSwing ? S.wWeb * SWING_BONES.webArm : S.wSwing;
      if (hold > 0.002) for (let i = 0; i < 2; i++) wa[i].getWorldQuaternion(S.webW[i]);
      for (let i = 0; i < snap.length; i++) {
        const s = snap[i], w = bw[i];
        TMP.q.copy(s.b.quaternion); s.b.quaternion.copy(s.q).slerp(TMP.q, w);
        TMP.v.copy(s.b.position); s.b.position.copy(s.p).lerp(TMP.v, w);
      }
      if (hold > 0.002) for (let i = 0; i < 2; i++) { // put the web arm back on the procedural world aim
        wa[i].parent.getWorldQuaternion(TMP.q3); TMP.q.copy(TMP.q3).invert().multiply(S.webW[i]);
        wa[i].quaternion.slerp(TMP.q, hold);
        wa[i].updateMatrix(); wa[i].updateMatrixWorld(true);
      }
    } else {
      visual.quaternion.slerp(TMP.q.identity(), 1 - Math.exp(-dt * 10)); // back upright
      visual.position.set(0, 0, 0);
    }
    // lean from acceleration (braking leans back) and from speed (the faster, the more the body leans into it), a bank into turns, and the chest leading into a turn, all on top
    // of the clip (not while the procedural pose owns the body). The axes are the CHARACTER'S (its right and its up, turned by the heading): the body is not facing +Z in the world.
    const wClip = grounded ? 1 - clamp(any, 0, 1) : 0;
    if (wClip > 0.01) {
      const h = st.heading ?? 0; AX.right.set(1, 0, 0).applyAxisAngle(AX.up, h); AX.fwd.set(0, 0, 1).applyAxisAngle(AX.up, h);
      const targetLean = clamp(S.accel * 0.006, -0.3, 0.2) + clamp(0.025 * (hs - 6), 0, 0.22);
      const targetBank = -clamp(S.yawRate * hs / 26 * 0.7, -0.3, 0.3), targetTwist = clamp(S.yawRate * 0.045, -0.3, 0.3) * smoothstep(1, 6, hs);
      S.lean += (targetLean - S.lean) * (1 - Math.exp(-dt * 8)); S.bank += (targetBank - S.bank) * (1 - Math.exp(-dt * 8)); S.twist += (targetTwist - S.twist) * (1 - Math.exp(-dt * 9));
      const top = R.spine;
      for (let i = 0; i < top.length; i++) {
        rotateBoneWorld(top[i], AX.right, S.lean * wClip / top.length); rotateBoneWorld(top[i], AX.fwd, S.bank * wClip / top.length); rotateBoneWorld(top[i], AX.up, S.twist * wClip / top.length);
      }
      rotateBoneWorld(R.head, AX.up, S.twist * 0.5 * wClip); // the head looks into the turn first
    }
  }

  return { ...proc, enabled: true, update, animator, clipState: S, usesClips: true, clipConfig: C };
}


// ------------------------------------------------------------------ FBX sources (tools only: the game itself never loads an FBX)
// Seven of the 22 Mixamo files in the Action Adventure Pack are valid FBX, but their footer is a byte longer than the 176 bytes FBXLoader allows when it decides
// where the node list ends, so it parses footer bytes as a node ("Unknown property type"). If the normal parse fails that way, the file is parsed again from an
// in-memory copy cut right after the last top-level node's NULL record plus 100 bytes of footer. Source files are never touched.
async function loadFbxTolerant(url) {
  const { FBXLoader } = await import('three/addons/loaders/FBXLoader.js');
  const buf = await (await fetch(url)).arrayBuffer();
  const base = url.slice(0, url.lastIndexOf('/') + 1);
  try { return { group: new FBXLoader().parse(buf, base), trimmed: false }; } catch (e) {
    if (!/Unknown property type/.test(e.message)) throw e;
    const dv = new DataView(buf); let p = 27; // header: 23 bytes of magic + 4 of version; version >= 7500 has 64-bit node offsets
    while (true) { const end = Number(dv.getBigUint64(p, true)); if (end === 0) break; p = end; }
    return { group: new FBXLoader().parse(buf.slice(0, p + 25 + 100), base), trimmed: true };
  }
}

/** Loads a Mixamo FBX clip and bakes it for `dstRoot`. Options of bakeRetarget plus { rootMotion: 'strip' | 'keep' }. */
async function bakeFbxClip(url, dstRoot, opts = {}) {
  const { group } = await loadFbxTolerant(url);
  const clip = group.animations[0];
  if (!clip) throw new Error('no animation in ' + url);
  return { clip: bakeRetarget(clip, group, dstRoot, opts), source: clip, group };
}

// ------------------------------------------------------------------ loading
/**
 * Production: content/spider-raimi/anims/manifest.json. Version 2: { version: 2, clips: { name: { file, meta } } }. Version 1 (plain name -> file) still loads.
 * Each file is { baked: true, clip: AnimationClip JSON } made by tools/model-lab.html (lab.convertAnims). Clips are named for the state machine in createClipRig:
 * idle walk run sprint jump fall hardLand runStop swingStart swingLoop swingLand (+ M for the mirror image of the swing ones).
 */
async function loadClipSet(dstRoot, { source = 'manifest', manifestUrl } = {}) {
  const set = {};
  const register = (name, clip, meta) => {
    const m = meta && meta.duration ? meta : clipMeta(clip, dstRoot, { rootSpeed: meta?.rootSpeed || 0 });
    set[name] = { clip, meta: m, info: { speed: m.footSpeed, stride: m.footSpeed * m.duration, contact: m.contact } };
  };
  if (source === 'xbot') { // development only: the Mixamo "Xbot" shipped with the Three.js examples, loaded at run time (nothing is saved)
    const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
    const g = await new GLTFLoader().loadAsync('https://cdn.jsdelivr.net/gh/mrdoob/three.js@b3396270682287470d161658ac01084d25e8dba6/examples/models/gltf/Xbot.glb');
    for (const name of ['idle', 'walk', 'run']) { const c = g.animations.find((a) => a.name === name); if (c) register(name, bakeRetarget(c, g.scene, dstRoot, { name })); }
    return { set, source: 'xbot' };
  }
  const base = manifestUrl || new URL('../content/spider-raimi/anims/', import.meta.url).href;
  let manifest = null;
  try { const r = await fetch(base + 'manifest.json'); if (r.ok) manifest = await r.json(); } catch { /* none */ }
  if (!manifest) return null;
  const entries = manifest.version === 2 ? Object.entries(manifest.clips).map(([k, v]) => [k, v.file, v.meta]) : Object.entries(manifest).map(([k, f]) => [k, f, null]);
  await Promise.all(entries.map(async ([name, file, meta]) => {
    try { const r = await fetch(base + file); const j = await r.json(); register(name, THREE.AnimationClip.parse(j.clip), meta); } catch (e) { console.warn('[spider] clip', name, 'skipped', e); }
  }));
  return Object.keys(set).length ? { set, source: 'manifest', version: manifest.version || 1 } : null;
}

export { bakeRetarget, analyseClip, clipEvents, clipMeta, ClipAnimator, createClipRig, loadClipSet, loadFbxTolerant, bakeFbxClip };
