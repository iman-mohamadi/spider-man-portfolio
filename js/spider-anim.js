import * as THREE from 'three/webgpu';
import { clamp, lerp, smoothstep, gaitParams, footTrajectory, twoBoneIK } from './spider-gait.js';

// Procedural animation for the Spider-Man rig (the glTF has no clips and its bone axes are irregular, so a clip would need a full
// retarget first). Bones are never rotated by Euler angles: each limb segment is AIMED in model space (+Y up, +Z forward, +X the
// character's left) by rotating its bind-pose direction onto a target direction, and the result is converted back into the bone's
// local rotation. That is independent of the bone roll and keeps the corrective `_adj_` child bones following their parents.
//
// What drives the pose (all continuous, so states blend without pops):
//  * legs   - foot paths (spider-gait.js: planted stance at exactly the ground speed, lifted swing) solved with a two-bone IK;
//  * torso  - pelvis and spine twist, roll and lean from the gait phase, forward acceleration and turning;
//  * arms   - counter-swing in the torso's frame, elbows flexed with speed;
//  * air    - pose from vertical speed (rise / float / fall) with the whole body tilted along the velocity;
//  * swing  - the web arm points at the anchor, the body hangs from the rope and banks into steering, rope tension stretches the pose.

const smooth = (cur, target, dt, rate) => cur + (target - cur) * (1 - Math.exp(-dt * rate));
const angleDiff = (a, b) => { let d = (b - a) % (Math.PI * 2); if (d > Math.PI) d -= Math.PI * 2; if (d <= -Math.PI) d += Math.PI * 2; return d; };

function findBones(root) {
  const names = new Map();
  root.traverse((o) => { if (o.isBone) names.set(o.name, o); });
  const find = (re) => { for (const [n, b] of names) if (re.test(n)) return b; return null; };
  const limb = (s) => ({
    thigh: find(new RegExp(`^leg_${s}_thigh_\\d+$`)), knee: find(new RegExp(`^leg_${s}_knee_\\d+$`)), ankle: find(new RegExp(`^leg_${s}_ankle_\\d+$`)),
    upper: find(new RegExp(`^arm_${s}_shoulder_2_\\d+$`)), fore: find(new RegExp(`^arm_${s}_elbow_\\d+$`)), hand: find(new RegExp(`^arm_${s}_wrist_\\d+$`))
  });
  const rig = { L: limb('left'), R: limb('right'), hips: find(/^root_hips_\d+$/), head: find(/^head_neck_upper_\d+$/), spine: [] };
  for (let i = 1; i <= 7; i++) rig.spine.push(find(new RegExp(`^spine_${i}_\\d+$`)));
  const all = [rig.hips, rig.head, ...rig.spine, ...Object.values(rig.L), ...Object.values(rig.R)];
  rig.complete = all.every(Boolean);
  rig.missing = all.length - all.filter(Boolean).length;
  return rig;
}

// ---- pose vector layout (one Float32Array per pose, blended linearly, then arms / up are re-normalised)
const FOOT = 0, POLE = 6, FPITCH = 12, ARM = 14; // foot targets (L, R xyz), knee poles, foot pitch (L, R), arms: upperL foreL upperR foreR (xyz, torso frame)
const PELVIS = 26, SPINE = 29, HEAD = 32, HIPS = 35, BODY = 38, UP = 40, NP = 43; // (yaw, roll, pitch) triples, hips offset, body (pitch, roll), up vector
const newPose = () => new Float32Array(NP);
const setV = (P, i, x, y, z) => { P[i] = x; P[i + 1] = y; P[i + 2] = z; };
const setUnit = (P, i, x, y, z) => { const m = Math.hypot(x, y, z) || 1; P[i] = x / m; P[i + 1] = y / m; P[i + 2] = z / m; };
// Directions are blended on the sphere. Averaging two unit vectors linearly passes through (almost) zero when they point opposite ways,
// and normalising that makes the result spin: exactly the pop that shows when an arm goes from "reaching for the web" to "falling".
function slerpInto(out, o, b, t) { // out[o..o+2] (unit) towards b[o..o+2] by t
  const a = out, ax = a[o], ay = a[o + 1], az = a[o + 2], bx = b[o], by = b[o + 1], bz = b[o + 2];
  const dot = Math.max(-1, Math.min(1, ax * bx + ay * by + az * bz));
  let px, py, pz;
  if (dot > 0.9995) { out[o] = ax + (bx - ax) * t; out[o + 1] = ay + (by - ay) * t; out[o + 2] = az + (bz - az) * t; setUnit(out, o, out[o], out[o + 1], out[o + 2]); return; }
  if (dot < -0.9995) { px = -az; py = 0; pz = ax; if (Math.hypot(px, pz) < 1e-3) { px = 0; py = az; pz = -ay; } } // exactly opposite: any perpendicular axis
  else { px = bx - ax * dot; py = by - ay * dot; pz = bz - az * dot; }
  const pm = Math.hypot(px, py, pz) || 1; px /= pm; py /= pm; pz /= pm;
  const th = Math.acos(dot < -0.9995 ? -1 : dot) * t, c = Math.cos(th), sn = Math.sin(th);
  out[o] = ax * c + px * sn; out[o + 1] = ay * c + py * sn; out[o + 2] = az * c + pz * sn;
  setUnit(out, o, out[o], out[o + 1], out[o + 2]);
}
// arm in the torso frame: upper arm swung forward by psi (0 = hanging), forearm flexed forward by eps, both opened outwards by `open`
const armSwing = (P, side, psi, eps, open) => {
  const o = ARM + (side > 0 ? 0 : 6);
  setUnit(P, o, side * open, -Math.cos(psi), Math.sin(psi));
  setUnit(P, o + 3, side * open * 0.6, -Math.cos(psi + eps), Math.sin(psi + eps));
};

function createSpiderRig({ root, visual }) {
  const rig = findBones(root);
  if (!rig.complete) {
    console.warn(`[spider] rig incomplete (${rig.missing} bones missing): procedural animation disabled`);
    return { enabled: false, update() {}, rig };
  }
  const Q = THREE.Quaternion, V3 = THREE.Vector3;
  const bindQ = new Map(), bindPos = new Map(), bindDir = new Map(), bindLocalPos = rig.hips.position.clone();
  const bones = [rig.hips, rig.head, ...rig.spine, ...Object.values(rig.L), ...Object.values(rig.R)];
  root.updateMatrixWorld(true);
  const wpos = new V3();
  for (const b of bones) { bindQ.set(b, b.getWorldQuaternion(new Q())); bindPos.set(b, b.getWorldPosition(new V3())); }
  const dirTo = (b, child) => child.getWorldPosition(wpos).sub(bindPos.get(b)).normalize().clone();
  for (const s of [rig.L, rig.R]) {
    bindDir.set(s.thigh, dirTo(s.thigh, s.knee)); bindDir.set(s.knee, dirTo(s.knee, s.ankle));
    bindDir.set(s.upper, dirTo(s.upper, s.fore)); bindDir.set(s.fore, dirTo(s.fore, s.hand));
  }
  // measured proportions: segment lengths, ankle height and the hip centre
  const dist = (p, q) => p.distanceTo(q);
  const legs = [rig.L, rig.R];
  const thighLen = (dist(bindPos.get(rig.L.thigh), bindPos.get(rig.L.knee)) + dist(bindPos.get(rig.R.thigh), bindPos.get(rig.R.knee))) / 2;
  const shankLen = (dist(bindPos.get(rig.L.knee), bindPos.get(rig.L.ankle)) + dist(bindPos.get(rig.R.knee), bindPos.get(rig.R.ankle))) / 2;
  const ankleH = (bindPos.get(rig.L.ankle).y + bindPos.get(rig.R.ankle).y) / 2, footZ0 = (bindPos.get(rig.L.ankle).z + bindPos.get(rig.R.ankle).z) / 2;
  const hip0 = bindPos.get(rig.hips).clone(), thigh0 = legs.map((l) => bindPos.get(l.thigh).clone());
  const standHip = thigh0[0].y - ankleH, reach = (thighLen + shankLen) * 0.985;
  const lengths = { thigh: thighLen, shank: shankLen, ankleH, standHip };

  const memo = new Map();
  const qa = new Q(), qb = new Q(), qc = new Q(), tv = new V3(), target = new V3();
  const worldQ = (o) => {
    if (o === root || !o) return new Q();
    let q = memo.get(o);
    if (!q) { q = worldQ(o.parent).clone().multiply(o.quaternion); memo.set(o, q); } // clone: the parent's memoised value must not change
    return q;
  };
  const setWorld = (bone, q) => { bone.quaternion.copy(worldQ(bone.parent)).invert().multiply(q); memo.set(bone, q.clone()); };
  const aim = (bone, x, y, z) => { target.set(x, y, z); setWorld(bone, qa.setFromUnitVectors(bindDir.get(bone), target).multiply(bindQ.get(bone))); };
  const euler = new THREE.Euler();
  const yrp = (out, yaw, roll, pitch) => out.setFromEuler(euler.set(pitch, yaw, roll, 'YZX')); // R = Ry * Rz * Rx (pitch positive = leaning forward)

  const G = newPose(), A = newPose(), W = newPose(), P = newPose(); // ground (idle + gait), air, swing, blended
  const gp = {}, trL = {}, trR = {};
  const S = {
    wG: 1, wA: 0, wS: 0, wGait: 0, phase: 0, crouch: 0, airSide: 1, webSide: 1, wasGrounded: true, init: false,
    prevHeading: 0, prevSpeed: 0, yawRate: 0, accel: 0, fall: 0, rise: 0, tension: 0.6, steer: 0, upk: 0, webDir: new V3(0, 1, 0), hasWebDir: false, airVy: 0, airHs: 0
  };
  const Y = new V3(0, 1, 0), pivot = new V3(0, 1.0, 0), off = new V3(), anchorS = new V3(), upV = new V3(), qTarget = new Q(), qAlign = new Q(), qInv = new Q();
  const qPelvis = new Q(), qTorso = new Q(), qSwingT = new Q(), hv = new V3(), fv = new V3(), pv = new V3(), dirT = new V3(), ik = {};
  const X = new V3(1, 0, 0), Z = new V3(0, 0, 1);

  // ---------------------------------------------------------------- ground: idle stance blended into the run cycle
  function poseGround(st, dt) {
    const speed = st.speed, t = st.time, crouch = S.crouch;
    gaitParams(speed, gp);
    const u = gp.u, v = gp.v, wg = S.wGait;
    // idle: a relaxed, slightly crouched ready stance with weight shifting, breathing and head movement (never the same twice in a row)
    const sway = 0.5 * Math.sin(t * 0.55) + 0.5 * Math.sin(t * 0.23 + 1.3), breath = Math.sin(t * 1.9);
    const idleSpine = 0.1 + 0.012 * breath + crouch * 0.45;
    const idleHipsY = -0.045 - crouch * 0.27;
    const wide = 0.15 + crouch * 0.06;
    // gait
    footTrajectory(S.phase, gp, trL); footTrajectory(S.phase + 0.5, gp, trR);
    const half = gp.span * 0.5 + 0.02;
    const drop = Math.max(0, standHip - Math.sqrt(Math.max(0.3, reach * reach - half * half))); // how far the hips must sink to reach the contact points
    const runK = smoothstep(2.5, 5.5, speed);
    const kk = (Math.cos(4 * Math.PI * (S.phase - gp.duty * 0.5)) + 1) * 0.5; // 1 at mid-stance of either foot
    const bob = -drop + (1 - runK) * drop * 0.85 * kk - runK * (0.03 + 0.025 * v) * kk;
    const side = Math.cos(2 * Math.PI * (S.phase - gp.duty * 0.5)); // +1 left foot mid-stance, -1 right
    const fwdAvg = (trL.fwd - trR.fwd) * 0.5; // +1 left foot forward
    const twistP = 0.06 + 0.09 * u + 0.05 * v, twistS = 0.10 + 0.17 * u + 0.09 * v;
    const lean = 0.04 + 0.15 * u + 0.2 * v + clamp(S.accel * 0.009, -0.12, 0.22);
    const turn = -clamp(S.yawRate * speed / 26 * 0.8, -0.3, 0.3);
    // feet
    const gx = 0.115 - 0.015 * u, gz = footZ0 + 0.03 * u;
    const lift = (tr) => 0.10 * Math.max(0, Math.sin(tr.pitch));
    setV(G, FOOT, lerp(wide, gx, wg), lerp(ankleH, ankleH + trL.y + lift(trL), wg), lerp(footZ0 + 0.07, gz + trL.z, wg));
    setV(G, FOOT + 3, -lerp(wide, gx, wg), lerp(ankleH, ankleH + trR.y + lift(trR), wg), lerp(footZ0 - 0.05, gz + trR.z, wg));
    setV(G, POLE, 0.08, 0, 1); setV(G, POLE + 3, -0.08, 0, 1);
    G[FPITCH] = lerp(0, trL.pitch, wg); G[FPITCH + 1] = lerp(0, trR.pitch, wg);
    // hips
    const lat = (0.010 + 0.012 * u) * side;
    G[HIPS] = lerp(sway * 0.012, lat, wg);
    G[HIPS + 1] = lerp(idleHipsY, bob, wg) - crouch * 0.27 * wg;
    G[HIPS + 2] = 0.01 + 0.015 * u * wg;
    // pelvis / spine / head
    G[PELVIS] = lerp(sway * 0.03, -twistP * fwdAvg, wg);
    G[PELVIS + 1] = lerp(sway * 0.02, 0.035 * (1 - 0.3 * v) * side + turn * 0.4, wg);
    G[PELVIS + 2] = 0.05 + 0.1 * u * wg + 0.08 * v * wg + crouch * 0.2;
    G[SPINE] = lerp(-sway * 0.02, twistS * fwdAvg, wg);
    G[SPINE + 1] = lerp(-sway * 0.02, turn - 0.5 * 0.035 * side, wg);
    G[SPINE + 2] = lerp(idleSpine, lean + crouch * 0.45, wg);
    G[HEAD + 2] = -0.6 * G[SPINE + 2] + 0.04 + 0.03 * Math.sin(t * 0.4) * (1 - wg);
    G[HEAD] = (Math.sin(t * 0.37) * 0.12 + Math.sin(t * 0.91) * 0.05) * (1 - wg) - 0.5 * G[SPINE];
    G[HEAD + 1] = -0.6 * G[SPINE + 1];
    // arms: ready guard at rest, counter-swing when moving, flung out for balance after a hard landing
    const armAmp = 0.10 + 0.5 * u + 0.3 * v;
    const psiL = -armAmp * trL.fwd * (trL.fwd < 0 ? 1 : 0.85), psiR = -armAmp * trR.fwd * (trR.fwd < 0 ? 1 : 0.85);
    const eps = lerp(0.45, 1.3, u) + 0.2 * v, open = 0.2 + 0.1 * (1 - u);
    armSwing(G, 1, lerp(0.35 + 0.02 * breath + crouch * 0.15, psiL, wg), lerp(0.95 - crouch * 0.25, eps + 0.2 * Math.max(0, psiL), wg), lerp(0.36 + crouch * 0.24, open, wg));
    armSwing(G, -1, lerp(0.28 + crouch * 0.2, psiR, wg), lerp(1.0 - crouch * 0.3, eps + 0.2 * Math.max(0, psiR), wg), lerp(0.36 + crouch * 0.24, open, wg));
    G[BODY] = 0; G[BODY + 1] = 0; setV(G, UP, 0, 1, 0);
  }

  // ---------------------------------------------------------------- air: rising, floating, falling; the body is tilted along the velocity
  function poseAir(st) {
    const vy = S.airVy, hs = S.airHs, lead = S.airSide; // frozen at touch-down: the controller zeroes vy on landing, which must not jump the fading air pose
    const rise = smoothstep(1, 6, vy), fall = smoothstep(2, 12, -vy), hsK = clamp(hs / 12, 0, 1);
    S.rise = rise; S.fall = fall;
    const mid = 1 - Math.max(rise, fall);
    // feet relative to the hip centre: lead leg drives the knee up, trailing leg extends back; they straighten and brace when falling
    const hy = hip0.y, fz = hip0.z;
    const f = (side, rr, mm, ff) => {
      const isLead = side === lead;
      const rx = isLead ? 0.11 : 0.11, ry = isLead ? -0.46 : -0.66, rz = isLead ? 0.40 : -0.34;
      const mx = 0.13, my = isLead ? -0.62 : -0.68, mz = isLead ? 0.14 : -0.10;
      const fx = 0.16 * (1 + 0.5 * fall), fy = -0.78, fzz = isLead ? 0.20 : 0.06;
      return { x: side * (rr * rx + mm * mx + ff * fx), y: rr * ry + mm * my + ff * fy, z: rr * rz + mm * mz + ff * fzz };
    };
    const hipsY = -0.05 - 0.04 * rise;
    for (const side of [1, -1]) {
      const o = side > 0 ? 0 : 3, p = f(side, rise, mid, fall);
      setV(A, FOOT + o, p.x, hy + hipsY - 0.072 + p.y, fz + p.z); // p.y is measured from the thigh joint, which sits 0.072 below the hip centre
      setV(A, POLE + o, side * 0.25, 0, 1);
      A[FPITCH + (side > 0 ? 0 : 1)] = 0.45 - 0.5 * fall + 0.2 * rise; // toes point down while rising, flatten for the landing
    }
    // arms: opposite to the leading leg when rising, out to the sides while floating, up and out when falling fast
    for (const side of [1, -1]) {
      const o = ARM + (side > 0 ? 0 : 6), isLead = side === lead;
      const rp = isLead ? -0.55 : 0.75, re = isLead ? 0.9 : 1.1;
      const psi = rise * rp + mid * 0.35 + fall * 0.15, eps = rise * re + mid * 0.5 + fall * 0.3, open = rise * 0.28 + mid * 0.75 + fall * 0.9;
      armSwing(A, side, psi, eps, open);
      // blend in the overhead flail when falling fast
      const up = fall * smoothstep(0.4, 1, fall);
      A[o] = lerp(A[o], side * 0.75, up); A[o + 1] = lerp(A[o + 1], 0.35, up); A[o + 2] = lerp(A[o + 2], 0.15, up);
      A[o + 3] = lerp(A[o + 3], side * 0.85, up); A[o + 4] = lerp(A[o + 4], 0.5, up); A[o + 5] = lerp(A[o + 5], 0.1, up);
      setUnit(A, o, A[o], A[o + 1], A[o + 2]); setUnit(A, o + 3, A[o + 3], A[o + 4], A[o + 5]);
    }
    const turn = -clamp(S.yawRate * hs / 26 * 0.8, -0.3, 0.3);
    A[HIPS] = 0; A[HIPS + 1] = hipsY; A[HIPS + 2] = 0;
    A[PELVIS] = 0; A[PELVIS + 1] = turn * 0.4; A[PELVIS + 2] = 0.05;
    A[SPINE] = 0; A[SPINE + 1] = turn; A[SPINE + 2] = 0.12 + 0.2 * hsK - 0.1 * fall;
    A[HEAD] = 0; A[HEAD + 1] = -0.6 * turn; A[HEAD + 2] = -0.55 * A[SPINE + 2];
    // whole-body tilt: head leads the motion, bounded so a vertical fall stays upright
    const e = Math.atan2(vy, Math.max(hs, 0.001));
    A[BODY] = hsK * clamp((Math.PI / 2 - e) * 0.3, -0.15, 0.55); A[BODY + 1] = turn * 0.6; setV(A, UP, 0, 1, 0);
  }

  // ---------------------------------------------------------------- swing: hanging from the rope
  function poseSwing(st) {
    const tn = clamp(S.tension, 0, 1.2), side = S.webSide, sp = clamp((st.speed3 ?? st.speed) / 30, 0, 1), steer = S.steer;
    const hy = hip0.y, fz = hip0.z, free = -side;
    const hipsY = -0.02;
    // body: partly aligned with the rope, head-leading with speed, banking into the steering input
    const k = clamp(0.25 + 0.3 * sp, 0, 0.55);
    const al = st.anchorLocal;
    if (al) setUnit(W, UP, al.x * k, (1 - k) + al.y * k, al.z * k); else setV(W, UP, 0, 1, 0);
    W[BODY] = 0.08 + 0.22 * sp; W[BODY + 1] = steer * 0.32 * sp + side * 0.1;
    // legs: the free-side leg bends forward, the web-side leg trails behind; they stretch back with speed and rope tension
    const trail = 0.15 + 0.35 * sp + 0.1 * clamp(tn, 0, 1);
    setV(W, FOOT + (free > 0 ? 0 : 3), free * 0.12, hy + hipsY - 0.072 - 0.52 - 0.1 * (1 - tn), fz + 0.2 + 0.1 * (1 - tn));
    setV(W, FOOT + (side > 0 ? 0 : 3), side * 0.11, hy + hipsY - 0.072 - 0.7, fz - trail);
    setV(W, POLE, 0.1, 0, 1); setV(W, POLE + 3, -0.1, 0, 1);
    W[FPITCH] = 0.5; W[FPITCH + 1] = 0.5;
    W[HIPS] = 0; W[HIPS + 1] = hipsY; W[HIPS + 2] = 0;
    W[PELVIS] = side * 0.08; W[PELVIS + 1] = side * 0.04 - steer * 0.1; W[PELVIS + 2] = 0.05;
    W[SPINE] = -side * 0.18; W[SPINE + 1] = -steer * 0.12 + side * 0.06; W[SPINE + 2] = 0.12 + 0.2 * (1 - clamp(tn, 0, 1));
    W[HEAD + 2] = -0.6 * (W[BODY] + W[SPINE + 2]); W[HEAD] = -0.4 * W[SPINE]; W[HEAD + 1] = 0;
    // web arm: straight at the anchor (given in the torso frame); free arm trails behind the motion
    yrp(qSwingT, W[SPINE], W[SPINE + 1], W[SPINE + 2]);
    if (al) {
      dirT.copy(anchorS).applyQuaternion(qInv.copy(qSwingT).invert());
      S.webDir.copy(dirT); S.hasWebDir = true;
    }
    if (S.hasWebDir) {
      dirT.copy(S.webDir);
      const o = ARM + (side > 0 ? 0 : 6), bend = (1 - clamp(tn, 0, 1)) * 0.25;
      setUnit(W, o, dirT.x, dirT.y, dirT.z);
      setUnit(W, o + 3, dirT.x - side * bend * 0.5, dirT.y - bend * 0.4, dirT.z);
    } else armSwing(W, side, 2.6, 0.1, 0.2);
    const fo = ARM + (free > 0 ? 0 : 6);
    setUnit(W, fo, free * 0.35, -0.55, -0.1 - 0.6 * sp);
    setUnit(W, fo + 3, free * 0.3, -0.65, -0.2 - 0.75 * sp);
  }

  // ---------------------------------------------------------------- per-frame update
  function update(dt, st) {
    dt = clamp(dt, 1e-4, 0.1);
    memo.clear();
    if (st.anchorLocal) anchorS.copy(st.anchorLocal).applyQuaternion(qInv.copy(visual.quaternion).invert()).normalize(); // anchor direction in model space (before this frame's tilt)
    const speed = st.speed, grounded = st.grounded && !st.swinging, swinging = st.swinging;
    if (!S.init) { S.init = true; S.prevHeading = st.heading ?? 0; S.prevSpeed = speed; }
    S.yawRate = smooth(S.yawRate, clamp(angleDiff(S.prevHeading, st.heading ?? S.prevHeading) / dt, -12, 12), dt, 12);
    S.accel = smooth(S.accel, clamp((speed - S.prevSpeed) / dt, -60, 60), dt, 8);
    S.prevHeading = st.heading ?? S.prevHeading; S.prevSpeed = speed;
    S.tension = smooth(S.tension, st.tension ?? 0.6, dt, 10);
    S.steer = smooth(S.steer, st.steer ?? 0, dt, 9);
    S.webSide = st.webSide || S.webSide;

    // state weights (smoothed in time, so an attach, a release or a landing blends instead of snapping)
    const tG = grounded ? 1 : 0, tS = swinging ? 1 : 0, tA = grounded || swinging ? 0 : 1;
    S.wG = smooth(S.wG, tG, dt, 10); S.wA = smooth(S.wA, tA, dt, 8); S.wS = smooth(S.wS, tS, dt, S.wS > tS ? 6 : 10);
    S.crouch = smooth(S.crouch, st.crouch || 0, dt, 18);
    S.wGait = smooth(S.wGait, smoothstep(0.1, 0.9, speed), dt, 16);
    gaitParams(speed, gp);
    if (grounded && S.wGait > 0.02) S.phase += dt * gp.freq; else if (S.wGait < 0.02) S.phase = 0.12;
    S.phase -= Math.floor(S.phase);
    if (S.wasGrounded && !grounded && !swinging) S.airSide = trL.stance ? -1 : 1; // the foot that was swinging leads into the air
    S.wasGrounded = grounded;

    // ----- poses
    if (!grounded) { S.airVy = st.vy; S.airHs = speed; }
    poseGround(st, dt); poseAir(st); poseSwing(st);
    const sum = S.wG + S.wA + S.wS || 1, wG = S.wG / sum, wA = S.wA / sum, wS = S.wS / sum;
    for (let i = 0; i < NP; i++) P[i] = G[i] * wG + A[i] * wA + W[i] * wS;
    // arm directions and the up vector: spherical blend of the three poses (ground first, then air, then swing)
    for (const o of [ARM, ARM + 3, ARM + 6, ARM + 9, UP]) {
      P[o] = G[o]; P[o + 1] = G[o + 1]; P[o + 2] = G[o + 2];
      let acc = wG;
      if (wA > 1e-4) { slerpInto(P, o, A, wA / (acc + wA)); acc += wA; }
      if (wS > 1e-4) { slerpInto(P, o, W, wS / (acc + wS)); acc += wS; }
    }
    for (const o of [POLE, POLE + 3]) setUnit(P, o, P[o], P[o + 1], P[o + 2]);

    // ----- whole-body orientation (about the chest): hangs towards the anchor, leans along the velocity, banks into turns
    qAlign.setFromUnitVectors(Y, upV.set(P[UP], P[UP + 1], P[UP + 2]));
    qTarget.copy(qAlign).multiply(qb.setFromAxisAngle(Z, P[BODY + 1])).multiply(qc.setFromAxisAngle(X, P[BODY]));
    visual.quaternion.slerp(qTarget, 1 - Math.exp(-dt * (swinging ? 7 : grounded ? 14 : 9)));
    off.copy(pivot).applyQuaternion(visual.quaternion); visual.position.copy(pivot).sub(off);

    // ----- apply (parents before children)
    off.set(P[HIPS], P[HIPS + 1], P[HIPS + 2]);
    const hipsLocal = hv.copy(off).applyQuaternion(worldQ(rig.hips.parent).clone().invert());
    rig.hips.position.copy(bindLocalPos).add(hipsLocal);
    yrp(qPelvis, P[PELVIS], P[PELVIS + 1], P[PELVIS + 2]);
    setWorld(rig.hips, qa.copy(qPelvis).multiply(bindQ.get(rig.hips)));
    for (let i = 0; i < 7; i++) {
      const f = (i + 1) / 7;
      yrp(qTorso, lerp(P[PELVIS], P[SPINE], f), lerp(P[PELVIS + 1], P[SPINE + 1], f), lerp(P[PELVIS + 2], P[SPINE + 2], f));
      setWorld(rig.spine[i], qa.copy(qTorso).multiply(bindQ.get(rig.spine[i])));
    } // qTorso now holds the top of the spine: the arms' frame
    setWorld(rig.head, qa.copy(yrp(qb, P[HEAD], P[HEAD + 1], P[HEAD + 2])).multiply(bindQ.get(rig.head))); // head orientation is relative to the world, not the torso

    // legs: two-bone IK from the (moved, rotated) hip joints to the foot targets
    for (let s = 0; s < 2; s++) {
      const leg = legs[s], o = s * 3;
      hv.copy(thigh0[s]).sub(hip0).applyQuaternion(qPelvis).add(hip0).add(off);
      fv.set(P[FOOT + o], P[FOOT + o + 1], P[FOOT + o + 2]);
      pv.set(P[POLE + o], P[POLE + o + 1], P[POLE + o + 2]);
      twoBoneIK(hv, fv, thighLen, shankLen, pv, ik);
      aim(leg.thigh, ik.thigh.x, ik.thigh.y, ik.thigh.z);
      aim(leg.knee, ik.shank.x, ik.shank.y, ik.shank.z);
      setWorld(leg.ankle, qa.setFromAxisAngle(X, P[FPITCH + s]).multiply(bindQ.get(leg.ankle)));
    }
    // arms: torso-frame directions carried into model space
    const arm = (bone, o) => { tv.set(P[ARM + o], P[ARM + o + 1], P[ARM + o + 2]).applyQuaternion(qTorso); aim(bone, tv.x, tv.y, tv.z); };
    arm(rig.L.upper, 0); arm(rig.L.fore, 3); arm(rig.R.upper, 6); arm(rig.R.fore, 9);
  }

  return { enabled: true, update, rig, state: S, pose: P, lengths };
}

export { createSpiderRig, findBones };
