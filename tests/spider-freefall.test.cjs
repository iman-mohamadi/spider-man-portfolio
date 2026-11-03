const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');

const read = (f) => readFileSync(join(__dirname, '..', f), 'utf8');
const F = loadModule(read('js/spider-freefall.js'));
const gait = loadModule(read('js/spider-gait.js'));
// spider-anim.js only touches three.js inside createSpiderRig, so findBones (the rig mapping) can be loaded and run on plain objects
const anim = loadModule(read('js/spider-anim.js'), { imports: { 'three/webgpu': {}, './spider-gait.js': gait, './spider-freefall.js': F } });

const G = 26; // the controller's gravity: only used here to make a physically sensible fall
const calm = { grounded: false, swinging: false, cling: false, wallRun: false, vy: 0, speed: 3, speed3: 3, landIn: 9, airJumpT: -1, heading: 0 };

/** A fall from height h0 (m) with initial vertical speed vy0, stepped at `fps`; calls fn(ff, st, t, y) every frame; stops at the ground. */
function fall({ h0 = 80, vy0 = 0, fps = 60, hs = 3, ff = F.createFreefall(), fn = () => {}, over = () => ({}), tMax = 10 } = {}) {
  let y = h0, vy = vy0, t = 0; const dt = 1 / fps;
  while (t < tMax) {
    vy -= G * dt; y += vy * dt; t += dt;
    const landIn = (vy + Math.sqrt(vy * vy + 2 * G * Math.max(0, y))) / G, ground = y <= 0;
    const st = { ...calm, grounded: ground, vy: ground ? 0 : vy, speed: hs, speed3: Math.hypot(hs, vy), landIn: ground ? 9 : landIn, ...over(t, y, vy) };
    ff.update(dt, st); fn(ff.state, st, t, y);
    if (ground) break;
  }
  return ff;
}

test('freefall starts only in a fast, long fall and ends before the landing: not in a small drop, a jump, or a rise', () => {
  // a 60 m drop: the dive starts after the body is fast and has been in the air a while, with plenty of time to impact
  let start = null, end = null, minLandAtStart = null;
  fall({ h0: 60, fn: (S, st, t) => { if (!start && S.active) { start = { t, vy: st.vy, landIn: st.landIn }; } if (start && !end && !S.active) end = { t, landIn: st.landIn, vy: st.vy }; } });
  assert.ok(start && start.vy < -9 && start.t >= 0.3 && start.landIn > 0.75, JSON.stringify(start));
  assert.ok(end && end.landIn < 0.56 && end.landIn > 0.4, 'let go when the landing is about half a second away: ' + JSON.stringify(end));
  // a 3 m step: never
  let any = false; fall({ h0: 3, fn: (S) => { if (S.active || S.w > 0) any = true; } }); assert.equal(any, false, 'a small drop is not a dive');
  // a jump up and down from the ground: never
  any = false; fall({ h0: 0.2, vy0: 10.5, fn: (S) => { if (S.w > 0) any = true; } }); assert.equal(any, false);
  // slow falling at 6 m/s (a parachute-like descent): never; and a rise: never
  const ff = F.createFreefall(); for (let i = 0; i < 300; i++) ff.update(1 / 60, { ...calm, vy: -6, speed3: 6, landIn: 5 }); assert.equal(ff.state.w, 0);
  for (let i = 0; i < 300; i++) ff.update(1 / 60, { ...calm, vy: 8, speed3: 9, landIn: 5 }); assert.equal(ff.state.w, 0);
  // no dive while another layer owns the body (the flip of a released swing), nor during the somersault of a double jump
  const blocked = F.createFreefall(); for (let i = 0; i < 300; i++) blocked.update(1 / 60, { ...calm, vy: -20, speed3: 20, landIn: 5 }, true); assert.equal(blocked.state.w, 0);
  const sw = F.createFreefall(); for (let i = 0; i < 300; i++) sw.update(1 / 60, { ...calm, vy: -20, speed3: 20, landIn: 5, airJumpT: 0.3 }); assert.equal(sw.state.w, 0, 'the somersault owns the body');
  // hysteresis: at -7 m/s (between the thresholds) a dive that has begun stays
  const h = F.createFreefall(); for (let i = 0; i < 90; i++) h.update(1 / 60, { ...calm, vy: -15, speed3: 15, landIn: 5 }); assert.ok(h.state.active);
  for (let i = 0; i < 90; i++) h.update(1 / 60, { ...calm, vy: -7, speed3: 7, landIn: 5 }); assert.ok(h.state.active, 'no flicker around the threshold');
  for (let i = 0; i < 90; i++) h.update(1 / 60, { ...calm, vy: -2, speed3: 3, landIn: 5 }); assert.equal(h.state.active, false); assert.equal(h.state.w, 0, 'and it ends when the body is slow');
});

test('entry: 0.35-0.65 s, continuous, the head turns first, then the chest and pelvis, then the arms, the legs last', () => {
  for (const fps of [30, 60, 144]) {
    let t0 = null, tFull = null, prev = 0, maxStep = 0, order = [];
    const stamp = (S, t) => { for (const k of ['wHead', 'wBody', 'wArms', 'wLegs']) if (S[k] > 0.5 && !order.find((o) => o[0] === k)) order.push([k, t]); };
    fall({ h0: 120, fps, fn: (S, st, t) => { if (S.active && t0 === null) t0 = t; if (S.u >= 1 && tFull === null) tFull = t; maxStep = Math.max(maxStep, Math.abs(S.w - prev)); prev = S.w; stamp(S, t); } });
    const dur = tFull - t0; assert.ok(dur >= 0.35 && dur <= 0.66, `${fps} fps: entry ${dur.toFixed(3)} s`);
    assert.ok(maxStep < 0.12 / (fps / 60) + 0.02, `${fps} fps: weight step ${maxStep.toFixed(3)}`);
    assert.deepEqual(order.map((o) => o[0]), ['wHead', 'wBody', 'wArms', 'wLegs']);
  }
  // a faster fall dives in faster
  const entry = (vy0) => { let t0 = null, t1 = null; fall({ h0: 400, vy0, fn: (S, st, t) => { if (S.active && t0 === null) t0 = t; if (S.u >= 1 && t1 === null) t1 = t; } }); return t1 - t0; };
  assert.ok(entry(-30) < entry(0) - 0.05);
});

test('exit: into a landing, a web, a wall, a second jump or a slow-down: smooth, never abrupt, and done before the touch-down', () => {
  const exits = {};
  const run = (name, over, check) => {
    const ff = F.createFreefall(); for (let i = 0; i < 150; i++) ff.update(1 / 60, { ...calm, vy: -25, speed3: 25, landIn: 5 }); assert.equal(ff.state.phase, 'sustain', name);
    let prev = ff.state.w, maxDrop = 0, frames = 0, phases = new Set();
    while (ff.state.w > 0 && frames < 120) { ff.update(1 / 60, { ...calm, vy: -25, speed3: 25, landIn: 5, ...over }); maxDrop = Math.max(maxDrop, prev - ff.state.w); prev = ff.state.w; frames++; phases.add(ff.state.phase); }
    exits[name] = frames / 60; assert.ok(phases.has('exit') || frames <= 2, name); assert.ok(ff.state.w === 0, name + ' reaches zero'); if (check) check(ff.state, maxDrop);
    return ff;
  };
  run('swing', { swinging: true, grounded: false }); assert.ok(Math.abs(exits.swing - 0.2) < 0.04);
  run('wall', { wallRun: true, grounded: true }, (S) => assert.equal(S.reason, 'wall')); assert.ok(Math.abs(exits.wall - 0.18) < 0.04);
  run('cling', { cling: true }); run('jump', { airJumpT: 0.0 }); assert.ok(exits.jump > 0.15 && exits.jump < 0.26);
  run('slow', { vy: -1, speed3: 2 }); assert.ok(exits.slow > 0.25 && exits.slow < 0.36);
  run('landing', { landIn: 0.5 }, (S, maxDrop) => { assert.equal(S.reason, 'landing'); assert.ok(maxDrop < 0.2, 'no abrupt step'); });
  assert.ok(exits.landing <= 0.5 - 0.04 + 0.02, 'the dive is over before the impact (' + exits.landing.toFixed(2) + ' s of 0.5)');
  run('ground', { grounded: true }); assert.ok(exits.ground <= 0.14);
  // the legs let go first on the way out, the head last
  const ff = F.createFreefall(); for (let i = 0; i < 150; i++) ff.update(1 / 60, { ...calm, vy: -25, speed3: 25, landIn: 5 });
  for (let i = 0; i < 10; i++) ff.update(1 / 60, { ...calm, vy: -25, speed3: 25, landIn: 0.5 });
  assert.ok(ff.state.wLegs < ff.state.wArms && ff.state.wArms <= ff.state.wBody && ff.state.wBody <= ff.state.wHead);
  // a dive let go and caught again continues from where it is: no jump of the weight
  const re = F.createFreefall(); for (let i = 0; i < 150; i++) re.update(1 / 60, { ...calm, vy: -25, speed3: 25, landIn: 5 });
  for (let i = 0; i < 6; i++) re.update(1 / 60, { ...calm, vy: -25, speed3: 25, landIn: 0.4 });
  const mid = re.state.u; assert.ok(mid > 0 && mid < 1); re.update(1 / 60, { ...calm, vy: -25, speed3: 25, landIn: 5 });
  assert.ok(Math.abs(re.state.u - mid) < 0.15);
});

test('the pose: head down, chest to the ground, arms swept back along the torso with bent elbows, legs behind with a modest gap, fingers slightly curled', () => {
  const S = F.createFreefall().state; S.t = 1.234; S.e = 0.62; S.tight = 0.4; S.twist = 0;
  const T = F.diveTargets(S, {});
  const cosP = Math.cos(T.bodyPitch), sinP = Math.sin(T.bodyPitch);
  assert.ok(cosP < -0.4, 'the head (+Y of the body) points below the horizon: ' + cosP.toFixed(2)); assert.ok(-sinP < -0.6, 'the chest (+Z of the body) faces the ground: ' + (-sinP).toFixed(2));
  assert.ok(T.bodyPitch > Math.PI / 2 + 0.45 && T.bodyPitch < Math.PI / 2 + 0.8);
  for (let s = 0; s < 2; s++) {
    const side = s === 0 ? 1 : -1, a = T.arm[s], u = a.u, f = a.f;
    for (const v of [u, f]) assert.ok(Math.abs(Math.hypot(v[0], v[1], v[2]) - 1) < 1e-9);
    assert.ok(u[1] < -0.85, 'toward the feet, not a T-pose: ' + u[1].toFixed(2)); assert.ok(u[2] < -0.1, 'swept back'); assert.ok(side * u[0] > 0.1 && side * u[0] < 0.4, 'a little away from the torso, never far');
    const bend = Math.acos(clamp(u[0] * f[0] + u[1] * f[1] + u[2] * f[2], -1, 1)) * 180 / Math.PI;
    assert.ok(bend > 2 && bend < 25, 'the elbow is slightly bent, not locked: ' + bend.toFixed(1) + ' deg'); assert.ok(f[2] > u[2] - 1e-9, 'the forearm folds forward, the elbow points back');
    const foot = T.foot[s]; assert.ok(foot.reach > 0.94 && foot.reach < 1, 'the knee is slightly bent'); assert.ok(foot.x > 0.08 && foot.x < 0.22, 'a modest separation'); assert.ok(foot.z < 0, 'behind the pelvis'); assert.ok(foot.pitch > 0.7, 'toes pointed');
  }
  assert.ok(Math.abs(T.arm[0].u[1] - T.arm[1].u[1]) < 0.03 && T.arm[0].u[0] * T.arm[1].u[0] < 0, 'the arms are symmetric, with small differences');
  assert.notDeepEqual(T.arm[0].u.map((v) => Math.abs(v)), T.arm[1].u.map((v) => Math.abs(v)), 'but not identical');
  assert.ok(T.spine[2] > 0.05 && T.spine[2] < 0.2 && T.pelvis[2] >= 0 && T.pelvis[2] < 0.1, 'a slight forward chest inclination, no arch'); assert.ok(Math.abs(T.head[2]) < 0.25 && Math.abs(T.head[0]) < 0.2, 'the head follows the body axis without extreme rotation');
  assert.ok(T.curl > 0.2 && T.curl < 0.5, 'slightly curled: neither an open palm nor a fist');
  for (let i = 0; i < 3; i++) for (let finger = 0; finger < 5; finger++) { const c = F.phalanxCurl(T.curl, 0, finger, i); assert.ok(c > 0.05 && c < 0.8, `finger ${finger} joint ${i}: ${c}`); }
});

test('the pose responds to the velocity: tighter and steeper the faster it falls, the dive angle follows the direction of travel, turns twist the torso', () => {
  const settle = (st, frames = 400) => { const ff = F.createFreefall(); for (let i = 0; i < frames; i++) ff.update(1 / 60, { ...calm, landIn: 9, ...st }); return F.diveTargets(ff.state, {}); };
  const slow = settle({ vy: -10, speed: 2, speed3: 10 }), fast = settle({ vy: -40, speed: 2, speed3: 40 });
  assert.ok(fast.arm[0].u[0] < slow.arm[0].u[0] - 0.05, 'the arms close in when fast'); assert.ok(fast.arm[0].u[2] < slow.arm[0].u[2], 'and sweep further back');
  assert.ok(fast.foot[0].x < slow.foot[0].x - 0.03, 'the legs come together'); assert.ok(fast.foot[0].reach > slow.foot[0].reach, 'and straighten');
  assert.ok(fast.spine[2] > slow.spine[2]);
  const steep = settle({ vy: -30, speed: 1, speed3: 30 }), shallow = settle({ vy: -12, speed: 25, speed3: 28 });
  assert.ok(steep.bodyPitch > shallow.bodyPitch + 0.15, 'a steeper path, a steeper body'); assert.ok(shallow.bodyPitch >= Math.PI / 2 + 0.5 - 1e-6 && steep.bodyPitch <= Math.PI / 2 + 0.78 + 1e-6, 'bounded: the chest keeps facing the ground');
  // a turn twists the body about its long axis, smoothly
  const ff = F.createFreefall(); let h = 0, prev = 0, maxStep = 0;
  for (let i = 0; i < 240; i++) { h += (i > 60 ? 2.0 : 0) / 60; ff.update(1 / 60, { ...calm, vy: -25, speed: 8, speed3: 26, landIn: 9, heading: h }); const T = F.diveTargets(ff.state, {}); if (i > 0) maxStep = Math.max(maxStep, Math.abs(T.spine[0] - prev)); prev = T.spine[0]; }
  assert.ok(Math.abs(prev) > 0.1, 'the torso twists into the turn'); assert.ok(maxStep < 0.02, 'without a sudden rotation: ' + maxStep.toFixed(4));
  // the heading wraps around at +-pi without a jump
  const w = F.createFreefall(); w.update(1 / 60, { ...calm, vy: -25, heading: 3.13 }); w.update(1 / 60, { ...calm, vy: -25, heading: -3.13 }); assert.ok(Math.abs(w.state.yawRate) < 12);
});

test('the sustained motion is deterministic, smooth, bounded and the same at every frame rate', () => {
  const pose = (fps, seconds) => { const ff = F.createFreefall(); const dt = 1 / fps, n = Math.round(seconds * fps); for (let i = 0; i < n; i++) ff.update(dt, { ...calm, vy: -26, speed: 4, speed3: 26, landIn: 9 }); return { S: ff.state, T: F.diveTargets(ff.state, {}) }; };
  const a = pose(60, 8), b = pose(60, 8); assert.deepEqual(JSON.parse(JSON.stringify(a.T)), JSON.parse(JSON.stringify(b.T)), 'no randomness');
  for (const fps of [30, 144]) { const c = pose(fps, 8), d = a; for (let s = 0; s < 2; s++) { for (let k = 0; k < 3; k++) assert.ok(Math.abs(c.T.arm[s].u[k] - d.T.arm[s].u[k]) < 0.01, `${fps} fps arm`); assert.ok(Math.abs(c.T.foot[s].x - d.T.foot[s].x) < 0.01); } assert.ok(Math.abs(c.T.bodyPitch - d.T.bodyPitch) < 0.01); }
  // it moves (it is not a statue) but only a little, and smoothly: per-frame changes are tiny
  const ff = F.createFreefall(); let lo = Infinity, hi = -Infinity, maxStep = 0, prev = null;
  for (let i = 0; i < 60 * 60; i++) {
    ff.update(1 / 60, { ...calm, vy: -26, speed: 4, speed3: 26, landIn: 9 }); const T = F.diveTargets(ff.state, {});
    const v = T.arm[0].u[0] + T.foot[0].pitch + T.head[0] + T.spine[1]; if (i > 120) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    if (prev !== null) maxStep = Math.max(maxStep, Math.abs(v - prev)); prev = v;
    for (const x of [...T.arm[0].u, ...T.arm[1].f, T.foot[1].x, T.foot[1].pitch, T.curl, ...T.pelvis, ...T.spine, ...T.head, T.bodyPitch]) assert.ok(Number.isFinite(x));
  }
  assert.ok(hi - lo > 0.05, 'there is motion in the airflow'); assert.ok(hi - lo < 0.45, 'but small'); assert.ok(maxStep < 0.01, 'and smooth: ' + maxStep.toFixed(5));
});

test('quaternions stay unit and nothing accumulates over a ten-minute simulation, and leaving the dive restores the previous pose exactly', () => {
  // every rotation the layer asks for is built from the pose, never integrated: 36000 frames later the answer is the same as a fresh evaluation at the same clock
  const ff = F.createFreefall(); const q0 = [0.14, 0.011, 0.024, 0.99]; F.qNormalize(q0);
  let worst = 0;
  for (let i = 0; i < 36000; i++) {
    ff.update(1 / 60, { ...calm, vy: -26 - 8 * Math.sin(i / 400), speed: 4, speed3: 27, landIn: 9, heading: 0.3 * Math.sin(i / 900) });
    if (i % 97 === 0) { const T = F.diveTargets(ff.state, {}); for (let j = 0; j < 3; j++) { const q = F.qNormalize(F.qMul(F.qAxisAngle(0.3, 0.9, -0.2, F.phalanxCurl(T.curl, T.curlMicro[0], 2, j)), q0)); worst = Math.max(worst, Math.abs(Math.hypot(...q) - 1)); } }
  }
  assert.ok(worst < 1e-12, 'unit quaternions: ' + worst);
  assert.ok(Math.abs(ff.state.t - 600) < 1e-6, 'the clock is the sum of the frames');
  const fresh = F.createFreefall().state; Object.assign(fresh, { t: ff.state.t, tight: ff.state.tight, e: ff.state.e, twist: ff.state.twist }); const A = F.diveTargets(ff.state, {}), B = F.diveTargets(fresh, {});
  assert.deepEqual(JSON.parse(JSON.stringify(A)), JSON.parse(JSON.stringify(B)), 'a function of the state and the clock only: no accumulated drift');
  // leaving the dive: the weights are exactly zero (the rig then writes nothing), and a new dive starts clean
  for (let i = 0; i < 90; i++) ff.update(1 / 60, { ...calm, grounded: true, vy: 0, speed: 0, speed3: 0 });
  assert.equal(ff.state.w, 0); assert.equal(ff.state.wHead, 0); assert.equal(ff.state.wArms, 0); assert.equal(ff.state.wLegs, 0); assert.equal(ff.state.phase, 'idle');
  const n = 2; // quaternion helpers: a long chain of tiny rotations renormalised each step stays unit
  let q = [0, 0, 0, 1]; for (let i = 0; i < 100000 * n; i++) q = F.qNormalize(F.qMul(F.qAxisAngle(0.2, 1, 0.4, 0.001), q)); assert.ok(Math.abs(Math.hypot(...q) - 1) < 1e-12);
});

test('both rig mappings: Mixamo and the original PS4 skeleton are found, a dive pose needs nothing else, and missing finger bones are fine', () => {
  const mk = (names) => { const bones = names.map((n) => ({ isBone: true, name: n })); return { traverse(fn) { for (const b of bones) fn(b); } }; };
  const mixamo = ['mixamorigHips', 'mixamorigHead', 'mixamorigSpine', 'mixamorigSpine1', 'mixamorigSpine2'];
  for (const S of ['Left', 'Right']) mixamo.push(`mixamorig${S}UpLeg`, `mixamorig${S}Leg`, `mixamorig${S}Foot`, `mixamorig${S}Arm`, `mixamorig${S}ForeArm`, `mixamorig${S}Hand`);
  const withFingers = [...mixamo, 'mixamorigLeftHandIndex1', 'mixamorigLeftHandIndex2'];
  const legacy = ['root_hips_06', 'head_neck_upper_0106'];
  for (let i = 1; i <= 7; i++) legacy.push(`spine_${i}_09${i}`);
  for (const s of ['left', 'right']) legacy.push(`leg_${s}_thigh_08`, `leg_${s}_knee_09`, `leg_${s}_ankle_010`, `arm_${s}_shoulder_2_0135`, `arm_${s}_elbow_0136`, `arm_${s}_wrist_0137`, `arm_${s}_finger_4_0138`);
  const keys = ['thigh', 'knee', 'ankle', 'upper', 'fore', 'hand'];
  const m = anim.findBones(mk(mixamo)), mf = anim.findBones(mk(withFingers)), l = anim.findBones(mk(legacy));
  assert.equal(m.kind, 'mixamo'); assert.ok(m.complete); assert.equal(m.spine.length, 3); assert.ok(mf.complete, 'finger bones are optional: a rig with or without them maps the same');
  assert.equal(l.kind, 'legacy'); assert.ok(l.complete); assert.equal(l.spine.length, 7);
  for (const r of [m, l]) { for (const k of keys) { assert.ok(r.L[k] && r.R[k], `${r.kind} ${k}`); } assert.ok(r.hips && r.head); }
  // a rig that is not recognised has no rig at all (the procedural layer and the dive stay off)
  assert.equal(anim.findBones(mk(['a', 'b'])).complete, false);
  // the pose is in the torso frame and says nothing about the number of spine bones or the bone names: the rig spreads it over whatever spine it has
  const T = F.diveTargets(F.createFreefall().state, {}); assert.ok(T.pelvis.length === 3 && T.spine.length === 3 && T.head.length === 3);
  // finger handling is guarded: no fingers -> no work; the phalanx index and joint are clamped
  const src = read('js/spider-anim.js');
  assert.match(src, /const fingers = \[\];[\s\S]*?for \(const root of s\.hand\.children\)/, 'fingers are searched under the wrist only');
  assert.match(src, /for \(const F of H\.fingers\)/, 'an empty list does nothing'); assert.match(src, /adj\|_end\$\|End/, 'the corrective and end bones are left alone');
  assert.ok(Number.isFinite(F.phalanxCurl(0.3, 0.05, 9, 9)) && Number.isFinite(F.phalanxCurl(0.3, 0.05, -3, -3)));
});

test('integration: the layer feeds both rigs and nothing else, the controller stays the only movement authority', () => {
  const ff = read('js/spider-freefall.js'), anim = read('js/spider-anim.js'), clips = read('js/spider-clips.js');
  const code = ff.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, ''); // the code without its comments
  assert.doesNotMatch(ff, /^import /m, 'a pure module'); assert.doesNotMatch(code, /controller|physics|\bworld\b|\.vel\b|\.pos\b|position\.set|gravity/i, 'no movement, no physics');
  assert.match(anim, /import \{ createFreefall, diveTargets, phalanxCurl \} from '\.\/spider-freefall\.js'/);
  assert.match(anim, /function update\(dt, st\) \{ ff\.update\(dt, st\); updatePose\(dt, st\);/, 'the procedural-only rig (PS4) advances the layer every frame');
  assert.match(anim, /if \(ff\.state\.wBody > 1e-4\) blendDive\(ff\.state\);/, 'the dive is blended into the air pose');
  assert.match(anim, /A\[i\] = lerp\(A\[i\], D\[i\], fs\.wLegs\)/, 'blended from the pose that is there, not replaced');
  assert.match(anim, /slerpInto\(A, o, D, fs\.wArms\)/, 'directions blend on the sphere');
  assert.match(anim, /A\[BODY\] = lerp\(A\[BODY\], DV\.bodyPitch, fs\.wBody\)/, 'the whole-body pitch goes through the body quaternion slerp');
  assert.match(clips, /proc\.freefall\.update\(dt, st, !!S\.rel\.flip\)/, 'the clip rig advances it once per frame and keeps off the flip of a released swing');
  assert.match(clips, /diveShare\(s\.kind\)/, 'the clip pose is blended per bone group');
  assert.match(clips, /proc\.handPose\(S\.wCling, S\.wWeb, st\.webSide, dive\)/);
  // the layer never writes outside the bones' own rotations: no persistent change of the rest pose (bind data is only read)
  assert.doesNotMatch(anim.slice(anim.indexOf('function blendDive'), anim.indexOf('// ---------------------------------------------------------------- swing')), /bindQ\.set|bindPos\.set|bindDir\.set/);
});

function clamp(x, a, b) { return x < a ? a : x > b ? b : x; }
