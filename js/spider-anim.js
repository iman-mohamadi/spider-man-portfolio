import * as THREE from 'three/webgpu';
import { clamp, lerp, smoothstep, gaitParams, footTrajectory, twoBoneIK, GAIT } from './spider-gait.js';
import { createFreefall, diveTargets, phalanxCurl } from './spider-freefall.js';

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
//  * dive   - the headfirst freefall (spider-freefall.js): a state machine and a target pose, blended into the air pose (see blendDive) and, for the fingers, applied by handPose.
//  * swing  - the web arm points at the anchor, the body hangs from the rope and banks into steering, rope tension stretches the pose.
//  * cling  - climbing a wall or a ceiling: all four limbs on the surface. The body's own frame is the usual one (+Z = the chest, which faces the surface); the body-frame group below
//    turns it onto the surface. Feet and hands are placed ON the surface plane (the distance is st.clingOffset) with a diagonal gait (left hand + right foot, then the other pair) along
//    the head direction, at a rate set by the crawl speed; at rest every limb is planted. The arms are solved with two-bone IK to the hand targets, the legs by the usual leg IK.
//  * body frame - a group between `visual` and the model that carries what is bigger than a pose: the somersault of the double jump (a full turn about the chest, pitch only) and
//    the alignment with a wall while wall running (the body's up turns towards the wall normal, its forward follows the travel). It is smoothed on its own, so the existing tilt and
//    every clip / pose underneath it are untouched; with nothing active it is the identity.

const smooth = (cur, target, dt, rate) => cur + (target - cur) * (1 - Math.exp(-dt * rate));
const angleDiff = (a, b) => { let d = (b - a) % (Math.PI * 2); if (d > Math.PI) d -= Math.PI * 2; if (d <= -Math.PI) d += Math.PI * 2; return d; };

function findBones(root) {
  const names = new Map();
  root.traverse((o) => { if (o.isBone) names.set(o.name, o); });
  const find = (re) => { for (const [n, b] of names) if (re.test(n)) return b; return null; };
  // the original PS4 model: spine_1..7, leg_left_thigh ...
  const legacy = (s) => ({
    thigh: find(new RegExp(`^leg_${s}_thigh_\\d+$`)), knee: find(new RegExp(`^leg_${s}_knee_\\d+$`)), ankle: find(new RegExp(`^leg_${s}_ankle_\\d+$`)),
    upper: find(new RegExp(`^arm_${s}_shoulder_2_\\d+$`)), fore: find(new RegExp(`^arm_${s}_elbow_\\d+$`)), hand: find(new RegExp(`^arm_${s}_wrist_\\d+$`))
  });
  // Mixamo skeleton (the Raimi model): mixamorigLeftUpLeg ... mixamorigHead
  const mixamo = (S) => ({
    thigh: find(new RegExp(`^mixamorig:?${S}UpLeg$`)), knee: find(new RegExp(`^mixamorig:?${S}Leg$`)), ankle: find(new RegExp(`^mixamorig:?${S}Foot$`)),
    upper: find(new RegExp(`^mixamorig:?${S}Arm$`)), fore: find(new RegExp(`^mixamorig:?${S}ForeArm$`)), hand: find(new RegExp(`^mixamorig:?${S}Hand$`))
  });
  const build = (kind) => {
    const rig = kind === 'mixamo'
      ? { kind, L: mixamo('Left'), R: mixamo('Right'), hips: find(/^mixamorig:?Hips$/), head: find(/^mixamorig:?Head$/), spine: [find(/^mixamorig:?Spine$/), find(/^mixamorig:?Spine1$/), find(/^mixamorig:?Spine2$/)] }
      : { kind, L: legacy('left'), R: legacy('right'), hips: find(/^root_hips_\d+$/), head: find(/^head_neck_upper_\d+$/), spine: [] };
    if (kind !== 'mixamo') for (let i = 1; i <= 7; i++) rig.spine.push(find(new RegExp(`^spine_${i}_\\d+$`)));
    const all = [rig.hips, rig.head, ...rig.spine, ...Object.values(rig.L), ...Object.values(rig.R)];
    rig.complete = all.every(Boolean);
    rig.missing = all.length - all.filter(Boolean).length;
    return rig;
  };
  const m = build('mixamo');
  return m.complete ? m : build('legacy');
}

// ---- pose vector layout (one Float32Array per pose, blended linearly, then arms / up are re-normalised)
const FOOT = 0, POLE = 6, FPITCH = 12, ARM = 14; // foot targets (L, R xyz), knee poles, foot pitch (L, R), arms: upperL foreL upperR foreR (xyz, torso frame)
const PELVIS = 26, SPINE = 29, HEAD = 32, HIPS = 35, BODY = 38, UP = 40, HAND = 43, NP = 49; // HAND: hand targets (L, R xyz) of the climbing pose; (yaw, roll, pitch) triples, hips offset, body (pitch, roll), up vector
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
  const hipDrop = hip0.y - thigh0[0].y; // the thigh joint sits this far below the hip centre (0.072 m in the original model)
  const lengths = { thigh: thighLen, shank: shankLen, ankleH, standHip };
  const shoulder0 = [bindPos.get(rig.L.upper).clone(), bindPos.get(rig.R.upper).clone()];
  const upperLen = (dist(bindPos.get(rig.L.upper), bindPos.get(rig.L.fore)) + dist(bindPos.get(rig.R.upper), bindPos.get(rig.R.fore))) / 2;
  const foreLen = (dist(bindPos.get(rig.L.fore), bindPos.get(rig.L.hand)) + dist(bindPos.get(rig.R.fore), bindPos.get(rig.R.hand))) / 2;
  lengths.upperArm = upperLen; lengths.foreArm = foreLen;
  const flipper = new THREE.Group(); // the body frame (see the header): visual -> flipper -> model root
  flipper.name = 'BodyFrame';
  if (root.parent) { root.parent.add(flipper); flipper.add(root); }

  // the hips' local position is in the units of its parent: metres in the original model, centimetres under a scaled root in the Mixamo one
  const localPerMetre = 1 / (rig.hips.parent ? rig.hips.parent.getWorldScale(new V3()).x : 1);
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

  const G = newPose(), A = newPose(), W = newPose(), Cp = newPose(), P = newPose(), D = newPose(); // ground (idle + gait), air, swing, cling, blended; D: the dive target
  const ff = createFreefall(), DV = {}; // the freefall layer (state machine) and the latest target pose it asked for
  const gp = {}, trL = {}, trR = {};
  const S = {
    wG: 1, wA: 0, wS: 0, wGait: 0, phase: 0, crouch: 0, airSide: 1, webSide: 1, wasGrounded: true, init: false,
    prevHeading: 0, prevSpeed: 0, yawRate: 0, accel: 0, fall: 0, rise: 0, tension: 0.6, steer: 0, upk: 0, webDir: new V3(0, 1, 0), hasWebDir: false, airVy: 0, airHs: 0, short: [0, 0], px: 0, pz: 0, h: 0, lockOn: false,
    airTime: 0, jumped: false, landIn: 9, cameFromSwing: false, sinceRelease: 0, wasSwinging: false, swingVy: 0, relSoon: 0,
    airJumpId: undefined, wq: new THREE.Quaternion(), wFlip: 0, haveWall: false, wC: 0, cph: 0, cmove: 0
  };
  // Foot locking: while a foot is in stance its ankle is pinned to a WORLD position (set at touch-down). The foot target in model space is then
  // recomputed from the body's current position and heading every frame, so turning, braking or accelerating cannot drag a planted foot.
  const feet = [0, 1].map(() => ({ planted: false, wx: 0, wz: 0, lastX: 0, lastZ: 0, offX: 0, offZ: 0 }));
  const Y = new V3(0, 1, 0), pivot = new V3(0, 1.0, 0), off = new V3(), anchorS = new V3(), upV = new V3(), qTarget = new Q(), qAlign = new Q(), qInv = new Q();
  const qPelvis = new Q(), qTorso = new Q(), qSwingT = new Q(), hv = new V3(), fv = new V3(), pv = new V3(), dirT = new V3(), ik = {};
  const X = new V3(1, 0, 0), Z = new V3(0, 0, 1);
  const shv = new V3(), armIK = [{}, {}]; // the shoulder, and the arm IK results (the 'thigh' / 'shank' of twoBoneIK are the upper arm and the forearm)

  // model-space ankle target (x, z) for foot k from its gait trajectory, with the stance part locked in the world (see `feet`)
  const ft = { x: 0, z: 0 };
  function footTarget(k, tr, gx, gz, p) {
    const F = feet[k];
    let mx = (k === 0 ? 1 : -1) * gx, mz = gz + tr.z;
    if (!S.lockOn) { F.planted = false; ft.x = mx; ft.z = mz; return ft; }
    const c = Math.cos(S.h), sn = Math.sin(S.h);
    if (tr.stance) {
      if (!F.planted) { F.planted = true; F.wx = S.px + mx * c + mz * sn; F.wz = S.pz - mx * sn + mz * c; } // touch-down: pin the foot where the gait puts it
      const dx = F.wx - S.px, dz = F.wz - S.pz;
      mx = dx * c - dz * sn; mz = dx * sn + dz * c;
      F.lastX = mx; F.lastZ = mz;
    } else {
      if (F.planted) { F.planted = false; F.offX = F.lastX - mx; F.offZ = F.lastZ - mz; } // lift-off: remember where the locked foot was, then blend onto the swing path
      const k2 = 1 - smoothstep(0, 0.55, p);
      mx += F.offX * k2; mz += F.offZ * k2;
    }
    ft.x = mx; ft.z = mz;
    return ft;
  }

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
    const lean = (0.04 + 0.15 * u + 0.2 * v + clamp(S.accel * 0.009, -0.12, 0.22)) * GAIT.lean;
    const turn = -clamp(S.yawRate * speed / 26 * 0.8, -0.3, 0.3);
    // feet
    const gx = 0.115 - 0.015 * u, gz = footZ0 + 0.03 * u;
    const lift = (tr) => 0.10 * Math.max(0, Math.sin(tr.pitch));
    const swingP = (ph) => { const f = ph - Math.floor(ph); return f < gp.duty ? 0 : (f - gp.duty) / (1 - gp.duty); };
    const tL = footTarget(0, trL, gx, gz, swingP(S.phase)); const tLx = tL.x, tLz = tL.z;
    const tR = footTarget(1, trR, gx, gz, swingP(S.phase + 0.5)); const tRx = tR.x, tRz = tR.z;
    setV(G, FOOT, lerp(wide, tLx, wg), lerp(ankleH, ankleH + trL.y + lift(trL), wg), lerp(footZ0 + 0.07, tLz, wg));
    setV(G, FOOT + 3, lerp(-wide, tRx, wg), lerp(ankleH, ankleH + trR.y + lift(trR), wg), lerp(footZ0 - 0.05, tRz, wg));
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
    const armAmp = (0.10 + 0.5 * u + 0.3 * v) * GAIT.armSwing;
    const psiL = -armAmp * trL.fwd * (trL.fwd < 0 ? 1 : 0.85), psiR = -armAmp * trR.fwd * (trR.fwd < 0 ? 1 : 0.85);
    const eps = lerp(0.45, 1.3, u) + 0.2 * v, open = 0.2 + 0.1 * (1 - u);
    const crossL = open - 0.14 * u * Math.max(0, psiL / (armAmp || 1)), crossR = open - 0.14 * u * Math.max(0, psiR / (armAmp || 1)); // the forward-swinging arm crosses towards the midline, as seen from behind
    armSwing(G, 1, lerp(0.35 + 0.02 * breath + crouch * 0.15, psiL, wg), lerp(0.95 - crouch * 0.25, eps + 0.2 * Math.max(0, psiL), wg), lerp(0.36 + crouch * 0.24, crossL, wg));
    armSwing(G, -1, lerp(0.28 + crouch * 0.2, psiR, wg), lerp(1.0 - crouch * 0.3, eps + 0.2 * Math.max(0, psiR), wg), lerp(0.36 + crouch * 0.24, crossR, wg));
    G[BODY] = 0; G[BODY + 1] = 0; setV(G, UP, 0, 1, 0);
  }

  // ---------------------------------------------------------------- air: a small state machine blended by weights
  // States (each a full pose: feet relative to the thigh joint, arms, spine, hips): TAKEOFF (the push-off of a jump), RISE (lead knee up,
  // counter-swinging arms), APEX (tucked, arms out), FALL (legs reaching down and apart, arms up and out when fast), PREP (landing
  // preparation: legs reach forward and straighten, arms come down, chosen from the predicted time to impact), LAUNCH (right after letting
  // go of a web: stretched out, arms forward-up). The weights come from the vertical speed, the time since take-off / release and the
  // time to impact, so a pose never appears or disappears at one instant.
  // lf / tf: lead and trailing foot (x outward, y from the thigh joint, z forward); lp / tp: their foot pitch; la / ta: the arm on the
  // lead leg's side and the other arm as [swing forward, elbow flex, opening]; spine / pelvis pitch; hipsY.
  const AIR = {
    takeoff: { lf: [0.10, -0.60, 0.12], tf: [0.10, -0.80, -0.22], lp: 0.35, tp: 0.95, la: [1.15, 0.35, 0.22], ta: [1.25, 0.30, 0.22], spine: 0.20, pelvis: 0.06, hipsY: -0.05 },
    rise:    { lf: [0.11, -0.46, 0.40], tf: [0.11, -0.66, -0.34], lp: 0.65, tp: 0.65, la: [-0.55, 0.9, 0.28], ta: [0.75, 1.1, 0.28], spine: 0.15, pelvis: 0.05, hipsY: -0.09 },
    apex:    { lf: [0.13, -0.56, 0.18], tf: [0.13, -0.52, 0.02], lp: 0.40, tp: 0.40, la: [0.25, 0.7, 0.75], ta: [0.25, 0.7, 0.75], spine: 0.12, pelvis: 0.04, hipsY: -0.07 },
    fall:    { lf: [0.17, -0.78, 0.20], tf: [0.17, -0.78, 0.06], lp: -0.05, tp: -0.05, la: [0.15, 0.3, 0.9], ta: [0.15, 0.3, 0.9], spine: 0.10, pelvis: 0.04, hipsY: -0.05 },
    prep:    { lf: [0.18, -0.80, 0.24], tf: [0.15, -0.80, 0.10], lp: -0.15, tp: -0.15, la: [0.45, 0.35, 0.5], ta: [0.40, 0.35, 0.5], spine: 0.12, pelvis: 0.08, hipsY: -0.03 },
    launch:  { lf: [0.10, -0.78, -0.15], tf: [0.10, -0.80, -0.30], lp: 0.80, tp: 0.80, la: [2.5, 0.12, 0.18], ta: [2.5, 0.12, 0.18], spine: 0.25, pelvis: 0.05, hipsY: -0.03 }
  };
  const AIR_KEYS = ['takeoff', 'rise', 'apex', 'fall', 'prep', 'launch'];
  const aw = { takeoff: 0, rise: 0, apex: 0, fall: 0, prep: 0, launch: 0 };

  function poseAir(st) {
    const vy = S.airVy, hs = S.airHs, lead = S.airSide; // frozen at touch-down: the controller zeroes vy on landing, which must not jump the fading air pose
    const hsK = clamp(hs / 12, 0, 1);
    // ----- weights
    const wT = S.jumped ? 1 - smoothstep(0, 0.17, S.airTime) : 0;
    const wL = S.cameFromSwing ? (1 - smoothstep(0.05, 0.5, S.sinceRelease)) * (1 - wT) : 0;
    const rest = 1 - wT - wL;
    const prepRaw = vy < -1 ? (1 - smoothstep(0.1, 0.34, S.landIn)) * smoothstep(1, 3, -vy) : 0;
    const wP = prepRaw * rest, rest2 = rest - wP;
    const rise = smoothstep(1, 6, vy), fall = smoothstep(2, 12, -vy);
    const wR = rise * rest2, wF = fall * (1 - rise) * rest2, wA = Math.max(0, rest2 - wR - wF);
    aw.takeoff = wT; aw.launch = wL; aw.prep = wP; aw.rise = wR; aw.fall = wF; aw.apex = wA;
    S.rise = rise; S.fall = fall;
    // ----- blend the state tables
    const mixV = (key, i) => { let v = 0; for (const k of AIR_KEYS) v += aw[k] * AIR[k][key][i]; return v; };
    const mixS = (key) => { let v = 0; for (const k of AIR_KEYS) v += aw[k] * AIR[k][key]; return v; };
    const hy = hip0.y, fz = hip0.z;
    const hipsY = mixS('hipsY');
    const spineExtra = 0.2 * hsK * (1 - wP * 0.5) - 0.1 * wF;
    for (const side of [1, -1]) {
      const o = side > 0 ? 0 : 3, isLead = side === lead, fk = isLead ? 'lf' : 'tf', pk = isLead ? 'lp' : 'tp';
      const widen = 1 + 0.5 * wF; // legs spread a little when falling fast
      setV(A, FOOT + o, side * mixV(fk, 0) * widen, hy + hipsY - hipDrop + mixV(fk, 1), fz + mixV(fk, 2) + 0.12 * hsK * (wP + wF));
      setV(A, POLE + o, side * 0.25, 0, 1);
      A[FPITCH + (side > 0 ? 0 : 1)] = mixS(pk);
    }
    const flail = wF * smoothstep(10, 28, -vy); // arms thrown overhead in a long fall
    for (const side of [1, -1]) {
      const o = ARM + (side > 0 ? 0 : 6), ak = side === lead ? 'la' : 'ta';
      armSwing(A, side, mixV(ak, 0), mixV(ak, 1), mixV(ak, 2));
      A[o] = lerp(A[o], side * 0.75, flail); A[o + 1] = lerp(A[o + 1], 0.35, flail); A[o + 2] = lerp(A[o + 2], 0.15, flail);
      A[o + 3] = lerp(A[o + 3], side * 0.85, flail); A[o + 4] = lerp(A[o + 4], 0.5, flail); A[o + 5] = lerp(A[o + 5], 0.1, flail);
      setUnit(A, o, A[o], A[o + 1], A[o + 2]); setUnit(A, o + 3, A[o + 3], A[o + 4], A[o + 5]);
    }
    const turn = -clamp(S.yawRate * hs / 26 * 0.8, -0.3, 0.3);
    A[HIPS] = 0; A[HIPS + 1] = hipsY; A[HIPS + 2] = 0;
    A[PELVIS] = 0; A[PELVIS + 1] = turn * 0.4; A[PELVIS + 2] = mixS('pelvis');
    A[SPINE] = 0; A[SPINE + 1] = turn; A[SPINE + 2] = mixS('spine') + spineExtra;
    A[HEAD] = 0; A[HEAD + 1] = -0.6 * turn; A[HEAD + 2] = -0.55 * A[SPINE + 2] - 0.15 * wP; // looks at where it will land
    // whole-body tilt: head leads the motion, bounded so a vertical fall stays upright, relaxed again for the landing
    const e = Math.atan2(vy, Math.max(hs, 0.001));
    A[BODY] = hsK * clamp((Math.PI / 2 - e) * 0.3, -0.15, 0.55) * (1 - 0.7 * wP) + 0.12 * wT; A[BODY + 1] = turn * 0.6; setV(A, UP, 0, 1, 0);
    if (ff.state.wBody > 1e-4) blendDive(ff.state);
  }

  // ---------------------------------------------------------------- dive: the target pose of spider-freefall.js blended into the air pose, part by part (the head first, then the chest and
  // pelvis, the arms, the legs last on the way in; the reverse on the way out). Directions are blended on the sphere, angles linearly; the body's pitch goes through the body
  // quaternion's slerp in updatePose, so no Euler angle is ever interpolated through a large rotation.
  function blendDive(fs) {
    diveTargets(fs, DV);
    const legLen = thighLen + shankLen, hy = hip0.y, fz = hip0.z;
    for (let s = 0; s < 2; s++) {
      const side = s === 0 ? 1 : -1, o = s * 3, f = DV.foot[s], a = DV.arm[s], ao = ARM + (s === 0 ? 0 : 6);
      setV(D, FOOT + o, side * f.x, hy + DV.hipsY - hipDrop - f.reach * legLen, fz + f.z); // behind the pelvis, along the body axis, the knee slightly bent
      setUnit(D, POLE + o, side * DV.poleX, 0, 1); D[FPITCH + s] = f.pitch;
      setUnit(D, ao, a.u[0], a.u[1], a.u[2]); setUnit(D, ao + 3, a.f[0], a.f[1], a.f[2]);
    }
    for (let i = FOOT; i < FOOT + 6; i++) A[i] = lerp(A[i], D[i], fs.wLegs);
    A[FPITCH] = lerp(A[FPITCH], D[FPITCH], fs.wLegs); A[FPITCH + 1] = lerp(A[FPITCH + 1], D[FPITCH + 1], fs.wLegs);
    slerpInto(A, POLE, D, fs.wLegs); slerpInto(A, POLE + 3, D, fs.wLegs);
    for (const o of [ARM, ARM + 3, ARM + 6, ARM + 9]) slerpInto(A, o, D, fs.wArms);
    const set3 = (i, a, b, c, w) => { A[i] = lerp(A[i], a, w); A[i + 1] = lerp(A[i + 1], b, w); A[i + 2] = lerp(A[i + 2], c, w); };
    set3(PELVIS, DV.pelvis[0], DV.pelvis[1], DV.pelvis[2], fs.wBody); set3(SPINE, DV.spine[0], DV.spine[1], DV.spine[2], fs.wBody);
    set3(HEAD, DV.head[0], DV.head[1], DV.head[2], fs.wHead); set3(HIPS, 0, DV.hipsY, 0, fs.wBody);
    A[BODY] = lerp(A[BODY], DV.bodyPitch, fs.wBody); A[BODY + 1] = lerp(A[BODY + 1], 0, fs.wBody);
  }

  // ---------------------------------------------------------------- swing: hanging from the rope like a pendulum
  // The body follows the pendulum: leaning forward and head-first on the way down, kicking the legs forward as it rises, banking into
  // steering, stretched by rope tension, and coiling (knees up, web arm pulled in) as the end of the swing approaches.
  function poseSwing(st) {
    const tn = clamp(S.tension, 0, 1.2), side = S.webSide, sp = clamp((st.speed3 ?? st.speed) / 30, 0, 1), steer = S.steer;
    const hy = hip0.y, fz = hip0.z, free = -side;
    const vyK = S.swingVy, down = Math.max(0, -vyK), kick = Math.max(0, vyK), coil = S.relSoon;
    const hipsY = -0.02 - 0.05 * coil;
    // body: partly aligned with the rope, head-leading with speed and on the way down, banking into the steering and the turn
    const k = clamp(0.25 + 0.3 * sp, 0, 0.55);
    const al = st.anchorLocal;
    if (al) setUnit(W, UP, al.x * k, (1 - k) + al.y * k, al.z * k); else setV(W, UP, 0, 1, 0);
    const turnRoll = -clamp(S.yawRate * (st.speed3 ?? st.speed) / 26 * 0.8, -0.35, 0.35);
    W[BODY] = 0.08 + 0.22 * sp + 0.12 * down - 0.10 * kick + 0.14 * coil;
    W[BODY + 1] = steer * 0.32 * sp + side * 0.1 + turnRoll * 0.7;
    // legs: the free-side leg bends forward and the web-side leg trails behind; going up they kick forward, tension stretches them back,
    // and before the end of the swing both tuck up
    const trail = ((0.15 + 0.35 * sp + 0.1 * clamp(tn, 0, 1)) * (1 - 1.3 * kick) - 0.05 * kick) * (1 - coil) - 0.28 * coil;
    setV(W, FOOT + (free > 0 ? 0 : 3), free * 0.12, hy + hipsY - hipDrop - 0.52 - 0.1 * (1 - tn) + 0.12 * coil + 0.06 * kick, fz + 0.2 + 0.1 * (1 - tn) + 0.12 * kick + 0.18 * coil);
    setV(W, FOOT + (side > 0 ? 0 : 3), side * 0.11, hy + hipsY - hipDrop - 0.7 + 0.2 * coil + 0.08 * kick, fz - trail);
    setV(W, POLE, 0.1, 0, 1); setV(W, POLE + 3, -0.1, 0, 1);
    W[FPITCH] = 0.5; W[FPITCH + 1] = 0.5;
    W[HIPS] = 0; W[HIPS + 1] = hipsY; W[HIPS + 2] = 0;
    W[PELVIS] = side * 0.08; W[PELVIS + 1] = side * 0.04 - steer * 0.1; W[PELVIS + 2] = 0.05 + 0.1 * coil;
    W[SPINE] = -side * 0.18; W[SPINE + 1] = -steer * 0.12 + side * 0.06; W[SPINE + 2] = 0.12 + 0.2 * (1 - clamp(tn, 0, 1)) + 0.2 * coil;
    W[HEAD + 2] = -0.6 * (W[BODY] + W[SPINE + 2]); W[HEAD] = -0.4 * W[SPINE]; W[HEAD + 1] = 0;
    // web arm: straight at the anchor (given in the torso frame) and pulled in as the release nears; free arm trails, then swings forward
    yrp(qSwingT, W[SPINE], W[SPINE + 1], W[SPINE + 2]);
    if (al) {
      dirT.copy(anchorS).applyQuaternion(qInv.copy(qSwingT).invert());
      S.webDir.copy(dirT); S.hasWebDir = true;
    }
    if (S.hasWebDir) {
      dirT.copy(S.webDir);
      const o = ARM + (side > 0 ? 0 : 6), bend = (1 - clamp(tn, 0, 1)) * 0.25 + 0.5 * coil;
      setUnit(W, o, dirT.x, dirT.y - 0.35 * coil, dirT.z);
      setUnit(W, o + 3, dirT.x - side * bend * 0.5, dirT.y - bend * 0.4 - 0.4 * coil, dirT.z - 0.3 * coil);
    } else armSwing(W, side, 2.6, 0.1, 0.2);
    const fo = ARM + (free > 0 ? 0 : 6);
    setUnit(W, fo, free * 0.35, -0.55 + 0.7 * coil, -0.1 - 0.6 * sp * (1 - coil) + 0.5 * coil);
    setUnit(W, fo + 3, free * 0.3, -0.65 + 0.9 * coil, -0.2 - 0.75 * sp * (1 - coil) + 0.7 * coil);
  }

  // ---------------------------------------------------------------- cling: climbing with all four limbs on the surface
  const STEP_H = 0.21, STEP_F = 0.2; // half strides of the hands and the feet (m along the head direction)
  const lm = { a: 0, lift: 0 };
  function limb(ph, amp) { // along-the-head offset and lift off the surface of a limb at gait phase ph: swing (reaching ahead, lifted) for the first half, then stance (moving back at the speed of the body)
    const u = ph - Math.floor(ph);
    if (u < 0.5) { const t = u / 0.5, e = t * t * (3 - 2 * t); lm.a = -amp + 2 * amp * e; lm.lift = Math.sin(Math.PI * t); }
    else { const t = (u - 0.5) / 0.5; lm.a = amp - 2 * amp * t; lm.lift = 0; }
    return lm;
  }
  function poseCling(st, dt) {
    const off = st.clingOffset ?? 0.5, sp = st.speed || 0;
    S.cmove = smooth(S.cmove, smoothstep(0.1, 0.6, sp), dt, 10);
    // the gait rate follows the crawl speed (planted at rest); past 3.2 steps a second the stride gets longer instead (up to the reach of the arms and legs), so the planted hands and feet slide less
    const stride = clamp(sp / (4 * 3.2), STEP_F, 1.6 * STEP_F), sA = stride / STEP_F;
    if (sp > 0.12) S.cph = (S.cph + dt * Math.min(3.2, sp / (4 * stride))) % 1;
    const k = S.cmove, hipsY = -0.10, hy = hip0.y + hipsY - hipDrop; // hy = height of the thigh joints
    // the climb over a roof edge (st.mantle: progress 0..1 of the whole climb, split at st.mantleSplit): first the hands go up to the edge, then the body goes over it
    const mu = st.mantle ?? -1, sp1 = st.mantleSplit || 0.5, m1 = mu < 0 ? 0 : clamp(mu / sp1, 0, 1), m2 = mu < 0 ? 0 : clamp((mu - sp1) / (1 - sp1), 0, 1);
    const sh = Math.abs(shoulder0[0].x) + 0.14, shY = shoulder0[0].y + hipsY + 0.32 + 0.30 * m1 - 0.55 * m2; // the hands reach up and apart, not boxing in front of the chest
    for (let side = 1; side >= -1; side -= 2) {
      const L = side > 0, o = L ? 0 : 3;
      // diagonal gait: left hand with the right foot
      const h = limb(S.cph + (L ? 0 : 0.5), STEP_H * sA), ha = h.a * k * (1 - m1), hl = h.lift * k * (1 - m1);
      setV(Cp, HAND + o, side * sh, shY + ha, off - 0.03 - 0.12 * hl + 0.45 * m2); // mantle: the hands come down onto the roof, beyond the wall plane
      const f = limb(S.cph + (L ? 0.5 : 0), STEP_F * sA), fa = f.a * k * (1 - m1), fl = f.lift * k * (1 - m1);
      setV(Cp, FOOT + o, side * 0.2, hy - 0.58 + fa + 0.03 * fl + 0.40 * m2, off - 0.12 - 0.08 * fl + 0.22 * m2); // ... and the knees come up onto it
      setV(Cp, POLE + o, side * 0.45, 0, 1); // the knees go forward and out
      Cp[FPITCH + (L ? 0 : 1)] = -1.35 + 0.12 * fl; // the soles flat on the surface (toes up)
      armSwing(Cp, side, 2.5, 0.4, 0.3); // the fallback direction of the arms (the hand IK replaces it)
    }
    const ph = S.cph * Math.PI * 2, sway = Math.sin(ph) * k;
    const lean = clamp(S.accel * 0.004, -0.15, 0.15); // the chest leans into a start and back into a stop (weight transfer)
    Cp[HIPS] = 0.02 * sway; Cp[HIPS + 1] = hipsY; Cp[HIPS + 2] = 0.07 + 0.2 * m2;
    Cp[PELVIS] = 0.06 * sway; Cp[PELVIS + 1] = 0.03 * Math.cos(ph) * k; Cp[PELVIS + 2] = 0.2 + 0.25 * m2;
    Cp[SPINE] = -0.09 * sway; Cp[SPINE + 1] = -0.03 * Math.cos(ph) * k; Cp[SPINE + 2] = 0.3 + lean + 0.45 * m2;
    Cp[HEAD] = 0.05 * sway; Cp[HEAD + 1] = 0; Cp[HEAD + 2] = -0.55; // looks up the surface
    Cp[BODY] = 0; Cp[BODY + 1] = 0; setV(Cp, UP, 0, 1, 0);
  }

  // ---------------------------------------------------------------- body frame: somersault and wall alignment
  const FLIP_TIME = 0.6; // s for the full turn of the double jump
  const pivotF = new V3(0, 1.0, 0), offF = new V3(), uW = new V3(), fW = new V3(), xW = new V3(), qMesh = new Q(), qWorld = new Q(), qLoc = new Q(), qFlipQ = new Q(), qId = new Q(), basis = new THREE.Matrix4();
  function bodyFrame(dt, st) {
    dt = clamp(dt, 1e-4, 0.1);
    const wall = (st.wallRun || st.cling) && st.wall && st.wall.active !== false ? st.wall : null;
    // the wall alignment: the target is the body frame (up away from the wall, forward along the travel) expressed relative to the mesh and the tilt group; smoothed, never snapped
    if (wall) {
      uW.set(wall.ux, wall.uy, wall.uz); fW.set(wall.fx, wall.fy, wall.fz); xW.crossVectors(uW, fW).normalize();
      basis.makeBasis(xW, uW, fW); qWorld.setFromRotationMatrix(basis);
      qMesh.setFromAxisAngle(Y, st.heading ?? 0).multiply(visual.quaternion);
      qLoc.copy(qMesh).invert().multiply(qWorld);
      if (!S.haveWall) { S.wq.identity(); S.haveWall = true; }
    }
    S.wq.slerp(wall ? qLoc : qId.identity(), 1 - Math.exp(-dt * (wall ? (wall.rate || 12) : 7)));
    // the somersault of a second jump: pitch only, forward, a smooth full turn; it is scaled away quickly when the body lands before it ends
    const t = st.airJumpT ?? -1, flying = !st.grounded && !st.swinging && !st.wallRun && !st.cling;
    S.wFlip += ((t >= 0 && flying ? 1 : 0) - S.wFlip) * (1 - Math.exp(-dt * ((t >= 0 && flying) ? 40 : 16)));
    const u = clamp(t / FLIP_TIME, 0, 1), angle = t >= 0 ? Math.PI * 2 * u * u * (3 - 2 * u) * S.wFlip : 0;
    qFlipQ.setFromAxisAngle(X, angle);
    flipper.quaternion.copy(S.wq).multiply(qFlipQ);
    offF.copy(pivotF).applyQuaternion(flipper.quaternion); flipper.position.copy(pivotF).sub(offF); // turns about the chest
  }

  // ---------------------------------------------------------------- per-frame update
  function updatePose(dt, st) {
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
    const tG = grounded ? 1 : 0, tS = swinging ? 1 : 0, tC = st.cling ? 1 : 0, tA = grounded || swinging || st.cling ? 0 : 1;
    const diving = ff.state.wBody > 0.001; // the air pose (with the dive in it) takes over from the ground pose at once: the clip rig only runs this layer while something needs it
    S.wG = smooth(S.wG, tG, dt, tG > S.wG ? 7 : diving ? 40 : 10); S.wA = smooth(S.wA, tA, dt, diving && tA > S.wA ? 30 : 8); S.wS = smooth(S.wS, tS, dt, S.wS > tS ? 6 : 10); S.wC = smooth(S.wC, tC, dt, tC > S.wC ? 9 : 7);
    S.crouch = smooth(S.crouch, st.crouch || 0, dt, 18);
    S.wGait = smooth(S.wGait, smoothstep(0.1, 0.9, speed), dt, 16);
    gaitParams(speed, gp);
    if (grounded && S.wGait > 0.02) S.phase += dt * gp.freq; else if (S.wGait < 0.02) S.phase = 0.12;
    S.phase -= Math.floor(S.phase);
    if (st.airJumpId !== undefined) {
      if (S.airJumpId === undefined) S.airJumpId = st.airJumpId;
      else if (st.airJumpId !== S.airJumpId) { S.airJumpId = st.airJumpId; S.jumped = true; S.airTime = 0; S.cameFromSwing = false; S.sinceRelease = 0; S.airSide = -S.airSide; } // the second jump: the push-off pose again, the other leg leads
    }
    if (S.wasGrounded && !grounded && !swinging) { // leaving the ground: the foot that was swinging leads; a jump (not a walk-off) gets the push-off pose
      S.airSide = trL.stance ? -1 : 1; S.jumped = st.vy > 3; S.airTime = 0; S.cameFromSwing = false; S.sinceRelease = 0;
    }
    S.wasGrounded = grounded;
    // timers for the air states. They are NOT reset on touch-down: the air pose is still fading out for a moment, and snapping its inputs
    // (time to impact, take-off, release) would change the fading pose in a single frame. They restart when the next flight begins.
    if (swinging) { S.airTime = 0; S.jumped = false; S.cameFromSwing = false; S.sinceRelease = 0; }
    else if (!grounded) { S.airTime += dt; if (S.wasSwinging) { S.cameFromSwing = true; S.sinceRelease = 0; } else S.sinceRelease += dt; S.landIn = st.landIn ?? 9; }
    S.wasSwinging = swinging;
    S.swingVy = smooth(S.swingVy, swinging ? clamp(st.vy / 18, -1, 1) : 0, dt, 6);
    S.relSoon = smooth(S.relSoon, swinging ? (st.releaseSoon ?? 0) : 0, dt, swinging ? 7 : 12);

    // ----- poses
    S.px = st.px ?? 0; S.pz = st.pz ?? 0; S.h = st.heading ?? 0;
    S.lockOn = st.px !== undefined && grounded && !st.wallRun && S.wGait > 0.05; // foot locking needs the body's world position (and a floor: not on a wall)
    if (!grounded) { S.airVy = st.vy; S.airHs = speed; }
    poseGround(st, dt); poseAir(st); poseSwing(st); poseCling(st, dt);
    const sum = S.wG + S.wA + S.wS + S.wC || 1, wG = S.wG / sum, wA = S.wA / sum, wS = S.wS / sum, wC = S.wC / sum;
    for (let i = 0; i < NP; i++) P[i] = G[i] * wG + A[i] * wA + W[i] * wS + Cp[i] * wC;
    // arm directions and the up vector: spherical blend of the three poses (ground first, then air, then swing)
    for (const o of [ARM, ARM + 3, ARM + 6, ARM + 9, UP]) {
      P[o] = G[o]; P[o + 1] = G[o + 1]; P[o + 2] = G[o + 2];
      let acc = wG;
      if (wA > 1e-4) { slerpInto(P, o, A, wA / (acc + wA)); acc += wA; }
      if (wS > 1e-4) { slerpInto(P, o, W, wS / (acc + wS)); acc += wS; }
      if (wC > 1e-4) { slerpInto(P, o, Cp, wC / (acc + wC)); acc += wC; }
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
    rig.hips.position.copy(bindLocalPos).add(hipsLocal.multiplyScalar(localPerMetre)); // local units per metre: 1 for the original model, ~114 for the centimetre Mixamo skeleton
    yrp(qPelvis, P[PELVIS], P[PELVIS + 1], P[PELVIS + 2]);
    setWorld(rig.hips, qa.copy(qPelvis).multiply(bindQ.get(rig.hips)));
    const nSpine = rig.spine.length;
    for (let i = 0; i < nSpine; i++) {
      const f = (i + 1) / nSpine;
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
      S.short[s] = Math.max(0, hv.distanceTo(fv) - (thighLen + shankLen - 0.004)); // how far the foot target was out of reach (the foot is dragged by this much)
      if (S.lockOn && feet[s].planted && S.short[s] > 0.001) { // the pinned foot is out of reach: let it slide to the nearest reachable point instead of stretching the leg
        const ax = ik.knee.x + ik.shank.x * shankLen, az = ik.knee.z + ik.shank.z * shankLen, c = Math.cos(S.h), sn = Math.sin(S.h);
        feet[s].wx = S.px + ax * c + az * sn; feet[s].wz = S.pz - ax * sn + az * c;
      }
      aim(leg.thigh, ik.thigh.x, ik.thigh.y, ik.thigh.z);
      aim(leg.knee, ik.shank.x, ik.shank.y, ik.shank.z);
      setWorld(leg.ankle, qa.setFromAxisAngle(X, P[FPITCH + s]).multiply(bindQ.get(leg.ankle)));
    }
    // arms: torso-frame directions carried into model space
    // climbing: the hands are on the surface, found by two-bone IK from the shoulders (their place follows the pelvis and the spine); blended in with the cling weight
    const wCn = wC;
    if (wCn > 0.01) {
      for (let s2 = 0; s2 < 2; s2++) {
        shv.copy(shoulder0[s2]).sub(hip0).applyQuaternion(qTorso).add(hip0).add(off);
        fv.set(Cp[HAND + 3 * s2], Cp[HAND + 3 * s2 + 1], Cp[HAND + 3 * s2 + 2]);
        pv.set(s2 === 0 ? 1 : -1, -0.5, -0.7); // the elbows go out and down, back from the wall
        twoBoneIK(shv, fv, upperLen, foreLen, pv, armIK[s2]);
      }
    }
    const arm = (bone, o, s2, which) => {
      tv.set(P[ARM + o], P[ARM + o + 1], P[ARM + o + 2]).applyQuaternion(qTorso);
      if (wCn > 0.01) { const d = armIK[s2][which]; tv.x += (d.x - tv.x) * wCn; tv.y += (d.y - tv.y) * wCn; tv.z += (d.z - tv.z) * wCn; tv.normalize(); }
      aim(bone, tv.x, tv.y, tv.z);
    };
    arm(rig.L.upper, 0, 0, 'thigh'); arm(rig.L.fore, 3, 0, 'shank'); arm(rig.R.upper, 6, 1, 'thigh'); arm(rig.R.fore, 9, 1, 'shank');
  }

  // ---------------------------------------------------------------- hands and fingers
  // The clips and the arm IK never aim the wrists or the fingers, so they keep whatever the underlying clip left there: curled claws on the wall, a twisted wrist on the web arm.
  // handPose() runs after everything else: it turns the wrist so the palm lies on the climbing surface with the fingers up the surface (spread slightly), and relaxes the
  // fingers towards the bind pose (an open hand), the web hand of a swing included. Weights are 0..1.
  const hands = [rig.L, rig.R].map((s, i) => {
    const kids = []; s.hand.traverse((o) => { if (o !== s.hand && o.isBone) kids.push({ b: o, q: o.quaternion.clone() }); });
    const mid = kids.find((k) => /middle1?$/i.test(k.b.name) && k.b.parent === s.hand) || kids.find((k) => k.b.parent === s.hand);
    // the bind frame of the hand: fingers = from the wrist to the knuckles, palm = down in the bind pose (the Mixamo T-pose)
    const f = mid ? mid.b.getWorldPosition(new V3()).sub(bindPos.get(s.hand)).normalize() : new V3(i ? -1 : 1, 0, 0);
    const n = new V3(0, -1, 0); n.addScaledVector(f, -n.dot(f)).normalize();
    const Mb = new THREE.Matrix4().makeBasis(f, n, new V3().crossVectors(f, n));
    // the fingers (optional: a rig without finger bones simply has none): chains of up to three phalanxes under the wrist, the corrective `_adj_` and `_end` bones left alone; each curls about
    // the axis (finger direction x palm normal) given in the frame of the phalanx's parent, from the bind pose
    const fingers = [];
    for (const root of s.hand.children) {
      if (!root.isBone || /adj|_end$|End/i.test(root.name)) continue;
      const chain = [root]; for (let b = root; chain.length < 3;) { const nx = b.children.find((c) => c.isBone && !/adj|_end$|End/i.test(c.name)); if (!nx) break; chain.push(nx); b = nx; }
      const nxt = chain[1] || root.children.find((c) => c.isBone); if (!nxt) continue;
      const d = nxt.getWorldPosition(new V3()).sub(root.getWorldPosition(new V3())).normalize(), axisW = new V3().crossVectors(d, n).normalize();
      if (!(axisW.lengthSq() > 0.5)) continue;
      fingers.push({ index: /thumb/i.test(root.name) ? 0 : fingers.length + 1, bones: chain.map((b) => ({ bone: b, q0: b.quaternion.clone(), axis: axisW.clone().applyQuaternion(b.parent.getWorldQuaternion(new Q()).invert()) })) });
    }
    return { bone: s.hand, kids, Mb, side: i ? -1 : 1, q0: s.hand.quaternion.clone(), fingers };
  });
  const Mt = new THREE.Matrix4(), Rm = new THREE.Matrix4(), qHand = new Q(), qPar = new Q(), fT = new V3(), nT = new V3(0, 0, 1);
  const relQ = (o, out) => { out.identity(); for (let p = o; p && p !== root; p = p.parent) out.premultiply(p.quaternion); return out; }; // rotation of o relative to the model root
  const qCurl = new Q();
  function handPose(wCling, wWeb, webSide, fs = null) {
    for (let i = 0; i < 2; i++) {
      const H = hands[i], web = (webSide > 0) === (i === 0), wFing = Math.max(wCling * 0.9, web ? wWeb * 0.75 : 0);
      if (wCling > 0.01) {
        fT.set(-H.side * 0.28, 1, 0).normalize(); // up the surface, a little towards the middle (the fingers of the left hand lean right)
        Mt.makeBasis(fT, nT, new V3().crossVectors(fT, nT));
        Rm.copy(H.Mb).invert().premultiply(Mt); // Mt * Mb^-1
        qHand.setFromRotationMatrix(Rm).multiply(bindQ.get(H.bone));
        relQ(H.bone.parent, qPar);
        qHand.premultiply(qPar.invert());
        H.bone.quaternion.slerp(qHand, wCling);
      }
      if (wFing > 0.01) for (const k of H.kids) k.b.quaternion.slerp(k.q, wFing);
      if (fs && fs.wArms > 0.01 && DV.curlMicro) { // the dive: the wrist follows the forearm, the fingers curl a little (blended from the pose they have this frame)
        H.bone.quaternion.slerp(H.q0, DV.hand * fs.wArms);
        for (const F of H.fingers) F.bones.forEach((fb, j) => { qCurl.setFromAxisAngle(fb.axis, phalanxCurl(DV.curl, DV.curlMicro[i], F.index, j)).multiply(fb.q0); fb.bone.quaternion.slerp(qCurl, fs.wArms * 0.9); });
      }
    }
  }

  /** The pose and the body frame: what the procedural-only rig runs every frame. (The clip rig calls updatePose when it needs the procedural layer, and bodyFrame every frame.) */
  function update(dt, st) { ff.update(dt, st); updatePose(dt, st); bodyFrame(dt, st); handPose(S.wC, S.wS, st.webSide, ff.state); }

  return { enabled: true, update, updatePose, bodyFrame, handPose, freefall: ff, flipper, rig, state: S, pose: P, lengths, gait: gp, airWeights: aw };
}

export { createSpiderRig, findBones };
