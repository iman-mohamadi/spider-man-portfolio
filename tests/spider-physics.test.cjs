const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');

const P = loadModule(readFileSync(join(__dirname, '../js/spider-physics.js'), 'utf8'));
const { SPIDER } = P;
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} should be within ${eps} of ${b}`);

test('angle helpers wrap and turn the short way round', () => {
  near(P.angleDiff(0.1, -0.1), -0.2);
  near(P.angleDiff(3.0, -3.0), (Math.PI * 2) - 6.0);
  near(P.turnToward(0, Math.PI * 0.5, 0.25), 0.25);
  near(P.turnToward(0, 0.1, 0.25), 0.1);
  assert.ok(P.turnToward(3.0, -3.0, 0.1) > 3.0, 'turns through +PI, not the long way');
});

test('ground velocity accelerates gradually to run and sprint speed and brakes without overshoot', () => {
  const vel = { x: 0, z: 0 };
  P.groundVelocity(vel, 0, 1, false, 0.05);
  assert.ok(vel.z > 0 && vel.z < SPIDER.run, 'one frame is not instant');
  for (let i = 0; i < 120; i++) P.groundVelocity(vel, 0, 1, false, 1 / 60);
  near(vel.z, SPIDER.run, 1e-6);
  for (let i = 0; i < 120; i++) P.groundVelocity(vel, 0, 1, true, 1 / 60);
  near(vel.z, SPIDER.sprint, 1e-6);
  for (let i = 0; i < 120; i++) P.groundVelocity(vel, 0, 0, false, 1 / 60);
  assert.equal(vel.z, 0);
  assert.ok(Math.abs(vel.x) < 1e-9);
});

test('ground velocity bends momentum smoothly when the wish direction reverses', () => {
  const vel = { x: 0, z: SPIDER.run };
  P.groundVelocity(vel, 0, -1, false, 1 / 120);
  assert.ok(vel.z < SPIDER.run && vel.z > 0, 'it slows first instead of flipping instantly');
});

test('analog wish below 1 scales the target speed', () => {
  const vel = { x: 0, z: 0 };
  for (let i = 0; i < 240; i++) P.groundVelocity(vel, 0.5, 0, false, 1 / 60);
  near(vel.x, SPIDER.run * 0.5, 1e-6);
});

test('air control steers and adds speed up to airMax, but never speeds up beyond the speed it already had', () => {
  const vel = { x: 0, z: 10 };
  P.airVelocity(vel, 1, 0, 0.5);
  assert.ok(vel.x > 0, 'steers sideways');
  assert.ok(Math.hypot(vel.x, vel.z) <= SPIDER.airMax + 1e-9);
  const fast = { x: 0, z: 30 };
  P.airVelocity(fast, 0, 1, 1);
  near(Math.hypot(fast.x, fast.z), 30, 1e-9);
  const steer = { x: 0, z: 30 };
  P.airVelocity(steer, 1, 0, 0.3);
  near(Math.hypot(steer.x, steer.z), 30, 1e-9);
  assert.ok(steer.x > 0);
});

test('rope projection keeps the body on the sphere and removes only outward velocity', () => {
  const anchor = { x: 0, y: 30, z: 0 };
  const pos = { x: 12, y: 18, z: 0 };
  const length = 10;
  const vel = { x: 8, y: -3, z: 5 };
  const correction = P.projectRope(pos, anchor, length, vel);
  assert.ok(correction > 0);
  near(Math.hypot(pos.x - anchor.x, pos.y - anchor.y, pos.z - anchor.z), length, 1e-9);
  const n = { x: (pos.x - anchor.x) / length, y: (pos.y - anchor.y) / length, z: (pos.z - anchor.z) / length };
  near(vel.x * n.x + vel.y * n.y + vel.z * n.z, 0, 1e-9);
  assert.ok(Math.abs(vel.z - 5) < 1e-9, 'velocity along z (tangent) is untouched');
});

test('a slack rope does nothing and an inward velocity is not cancelled', () => {
  const anchor = { x: 0, y: 30, z: 0 };
  const pos = { x: 1, y: 25, z: 0 }, vel = { x: 1, y: 1, z: 0 };
  assert.equal(P.projectRope(pos, anchor, 20, vel), 0);
  assert.deepEqual([pos.x, pos.y, pos.z, vel.x, vel.y, vel.z], [1, 25, 0, 1, 1, 0]);
  const taut = { x: 0, y: 20, z: 0 }, inward = { x: 0, y: 4, z: 0 };
  P.projectRope(taut, anchor, 10, inward);
  assert.equal(inward.y, 4, 'moving towards the anchor is allowed');
});

test('a pendulum released from rest conserves energy within 2% over 10 seconds (120 Hz)', () => {
  const anchor = { x: 0, y: 40, z: 0 }, length = 25, g = SPIDER.swingGravity, h = 1 / 120;
  const pos = { x: 17.677, y: 40 - 17.677, z: 0 }; // 45 degrees, exactly on the circle
  const vel = { x: 0, y: 0, z: 0 };
  const energy = () => 0.5 * (vel.x ** 2 + vel.y ** 2 + vel.z ** 2) + g * pos.y;
  const e0 = energy();
  let lowest = Infinity;
  for (let i = 0; i < 1200; i++) {
    for (let s = 0; s < 4; s++) { // 4 constraint sub-steps per 120 Hz tick, leapfrog order (the controller does the same)
      const hh = h / 4;
      vel.y -= g * hh * 0.5;
      pos.x += vel.x * hh; pos.y += vel.y * hh; pos.z += vel.z * hh;
      P.projectRope(pos, anchor, length, vel);
      vel.y -= g * hh * 0.5;
    }
    lowest = Math.min(lowest, pos.y);
    assert.ok(Number.isFinite(pos.x + pos.y + pos.z));
    const d = Math.hypot(pos.x - anchor.x, pos.y - anchor.y, pos.z - anchor.z);
    assert.ok(d <= length + 1e-6, 'never beyond the rope length');
  }
  assert.ok(Math.abs(energy() - e0) / Math.abs(e0) < 0.02, `energy drift ${(Math.abs(energy() - e0) / Math.abs(e0) * 100).toFixed(2)}%`);
  assert.ok(lowest < 40 - length * 0.97, 'it swung through the bottom');
});

test('swing forces pump along the tangent, steer sideways, drag a little and cap the speed', () => {
  const anchor = { x: 0, y: 30, z: 0 };
  const pos = { x: 0, y: 10, z: 0 }; // hanging straight down
  const vel = { x: 0, y: 0, z: 5 };
  P.swingForces(vel, pos, anchor, { x: 0, y: 0, z: 1 }, { x: -1, y: 0, z: 0 }, 1, 1, 0.1);
  assert.ok(vel.z > 5 - 0.5, 'pumps forward');
  assert.ok(vel.x < 0, 'steers to the right vector');
  const fast = { x: 0, y: 0, z: 200 };
  P.swingForces(fast, pos, anchor, { x: 0, y: 0, z: 1 }, { x: 1, y: 0, z: 0 }, 0, 0, 0.01);
  near(Math.hypot(fast.x, fast.y, fast.z), SPIDER.swingMax, 1e-9);
});

test('release keeps momentum, boosts a little and lifts only when moving up', () => {
  const up = { x: 5, y: 8, z: 0 }, level = { x: 5, y: -2, z: 0 };
  P.releaseVelocity(up); P.releaseVelocity(level);
  assert.ok(up.x > 5 && up.y > 8 + SPIDER.releaseLift - 1e-9);
  assert.ok(level.x > 5 && level.y < -2, 'downward velocity gets no lift');
});

test('swing steering: strafing turns the velocity without adding speed; the turn rate grows with speed', () => {
  const anchor = { x: 0, y: 40, z: 0 }, pos = { x: 0, y: 10, z: 0 };
  const turn = (speed) => {
    const vel = { x: 0, y: 0, z: speed };
    const before = Math.hypot(vel.x, vel.y, vel.z);
    for (let i = 0; i < 12; i++) P.swingForces(vel, pos, anchor, { x: 0, y: 0, z: 1 }, { x: -1, y: 0, z: 0 }, 0, 1, 1 / 120);
    return { angle: Math.atan2(-vel.x, vel.z), gain: Math.hypot(vel.x, vel.y, vel.z) - before * (1 - SPIDER.swingDrag * 12 / 120) };
  };
  const slow = turn(8), fast = turn(32);
  assert.ok(slow.angle > 0.05 && fast.angle > 0.05, 'turned towards the right vector');
  assert.ok(Math.abs(fast.gain) < 0.25 && Math.abs(slow.gain) < 0.25, `a sideways force is (nearly) speed neutral: ${slow.gain}, ${fast.gain}`);
  assert.ok(fast.angle > slow.angle * 0.45, 'responsive at high speed (angular rate does not collapse as speed rises)');
});

test('swing steering: forward pumps, backward brakes, and the push stays in the rope tangent plane (never free flight)', () => {
  const anchor = { x: 0, y: 40, z: 0 }, pos = { x: 0, y: 10, z: 0 };
  const run = (fwd) => { const v = { x: 0, y: 0, z: 15 }; for (let i = 0; i < 24; i++) P.swingForces(v, pos, anchor, { x: 0, y: 0, z: 1 }, { x: -1, y: 0, z: 0 }, fwd, 0, 1 / 120); return Math.hypot(v.x, v.y, v.z); };
  assert.ok(run(1) > 15.5, 'pump'); assert.ok(run(-1) < 14.7, 'brake');
  // the wish is purely radial (straight up the rope): nothing can be added along the rope
  const v = { x: 0, y: 0, z: 0 };
  P.swingForces(v, pos, anchor, { x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 0 }, 1, 0, 0.1);
  assert.ok(Math.hypot(v.x, v.y, v.z) < 1e-9, 'a push along the rope is removed');
});

test('swing steering never produces NaN or spikes, including from rest and at the speed cap', () => {
  const anchor = { x: 0, y: 40, z: 0 };
  for (const [vx, vy, vz] of [[0, 0, 0], [0, 0, 1e-9], [0, 0, 41], [30, -30, 30], [0, 0, 200]]) {
    const v = { x: vx, y: vy, z: vz }, before = Math.hypot(vx, vy, vz);
    for (const [f, s] of [[1, 1], [-1, 1], [0, -1], [1, 0], [1, 1]]) P.swingForces(v, { x: 0, y: 10, z: 0 }, anchor, { x: 0, y: 0, z: 1 }, { x: -1, y: 0, z: 0 }, f, s, 1 / 120);
    assert.ok(Number.isFinite(v.x + v.y + v.z));
    assert.ok(Math.hypot(v.x, v.y, v.z) <= Math.max(SPIDER.swingMax, before) + 1e-6);
  }
});
