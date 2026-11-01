const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');

const G = loadModule(readFileSync(join(__dirname, '../js/spider-gait.js'), 'utf8'));
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} should be within ${eps} of ${b}`);

// the measured Spider-Man legs (metres): thigh 0.459, shank 0.402, so the fully stretched leg reaches 0.861
const A = 0.459, B = 0.402;

test('stance feet move backwards relative to the hips at exactly the ground speed (no foot sliding) at every speed', () => {
  for (const speed of [1.5, 3, 5, 8.5, 12, 15]) {
    const gp = G.gaitParams(speed);
    const dt = 1e-4, tr = {}, tr2 = {};
    for (let ph = 0.01; ph < gp.duty - 0.02; ph += 0.03) {
      G.footTrajectory(ph, gp, tr);
      G.footTrajectory(ph + dt * gp.freq, gp, tr2);
      const v = (tr2.z - tr.z) / dt; // relative velocity of the foot along z
      near(v, -speed, speed * 0.02);
      assert.equal(tr.y, 0, 'planted foot stays on the ground');
    }
  }
});

test('duty factor falls and the airborne share of the cycle grows from walking to sprinting', () => {
  const walk = G.gaitParams(1.5), run = G.gaitParams(8.5), sprint = G.gaitParams(15);
  assert.ok(walk.duty > 0.5, 'walking always has a foot down');
  assert.ok(run.duty < 0.3 && sprint.duty < run.duty, 'running and sprinting have a flight phase');
  assert.ok(sprint.freq > run.freq && run.freq > walk.freq, 'cadence rises with speed');
  assert.ok(sprint.lift > run.lift && run.lift > walk.lift, 'feet lift higher the faster the pace');
  assert.ok(sprint.span >= run.span, 'the sprint contact is a little longer');
});

test('the foot path is continuous across the whole cycle, including the wrap from swing back into stance', () => {
  for (const speed of [2, 6, 8.5, 15]) {
    const gp = G.gaitParams(speed), a = {}, b = {};
    let maxJump = 0;
    for (let ph = 0; ph < 1; ph += 0.0005) {
      G.footTrajectory(ph, gp, a); G.footTrajectory(ph + 0.0005, gp, b);
      maxJump = Math.max(maxJump, Math.abs(b.z - a.z), Math.abs(b.y - a.y), Math.abs(b.pitch - a.pitch) * 0.1);
    }
    assert.ok(maxJump < 0.02, `speed ${speed}: largest step ${maxJump}`);
  }
});

test('the swing foot is lifted and the two feet are half a cycle apart', () => {
  const gp = G.gaitParams(8.5), a = {}, b = {};
  let top = 0;
  for (let ph = 0; ph < 1; ph += 0.01) { G.footTrajectory(ph, gp, a); top = Math.max(top, a.y); }
  assert.ok(top > 0.15 && top < 0.4, `foot lift ${top}`);
  G.footTrajectory(0.1, gp, a); G.footTrajectory(0.6, gp, b);
  assert.notEqual(a.stance, b.stance, 'when one foot is planted the other is swinging at duty < 0.5');
});

test('two-bone IK reaches the target, keeps the bone lengths and bends the knee towards the pole', () => {
  const H = { x: 0.08, y: 0.9, z: 0 }, F = { x: 0.1, y: 0.1, z: 0.3 }, ik = {};
  G.twoBoneIK(H, F, A, B, { x: 0, y: 0, z: 1 }, ik);
  const k = ik.knee;
  near(Math.hypot(k.x - H.x, k.y - H.y, k.z - H.z), A, 1e-9);
  near(Math.hypot(F.x - k.x, F.y - k.y, F.z - k.z), B, 1e-9);
  assert.ok(k.z > (H.z + F.z) / 2, 'the knee is in front of the hip-foot line');
  near(Math.hypot(ik.thigh.x, ik.thigh.y, ik.thigh.z), 1, 1e-9);
  near(Math.hypot(ik.shank.x, ik.shank.y, ik.shank.z), 1, 1e-9);
  assert.ok(ik.reached);
});

test('two-bone IK stays finite and within reach for out-of-reach and degenerate targets', () => {
  const ik = {};
  G.twoBoneIK({ x: 0, y: 1, z: 0 }, { x: 0, y: -5, z: 0 }, A, B, { x: 0, y: 0, z: 1 }, ik);
  assert.equal(ik.reached, false);
  for (const v of [ik.knee.x, ik.knee.y, ik.knee.z, ik.thigh.x, ik.shank.y]) assert.ok(Number.isFinite(v));
  G.twoBoneIK({ x: 0, y: 1, z: 0 }, { x: 0, y: 1, z: 0 }, A, B, { x: 0, y: 0, z: 1 }, ik); // foot on the hip
  for (const v of [ik.knee.x, ik.knee.y, ik.knee.z, ik.thigh.x, ik.shank.y]) assert.ok(Number.isFinite(v));
  G.twoBoneIK({ x: 0, y: 1, z: 0 }, { x: 0, y: 0.2, z: 0 }, A, B, { x: 0, y: -1, z: 0 }, ik); // pole parallel to the leg
  for (const v of [ik.knee.x, ik.knee.y, ik.knee.z]) assert.ok(Number.isFinite(v));
});

test('the planted foot is reachable at the contact points when the hips drop enough (the rig uses the same relation)', () => {
  for (const speed of [1.5, 4, 8.5, 15]) {
    const gp = G.gaitParams(speed), half = gp.span * 0.5 + 0.02, reach = 0.985 * (A + B);
    const hipRel = Math.sqrt(Math.max(0.3, reach * reach - half * half)); // vertical hip-to-ankle distance needed
    const drop = 0.859 - hipRel;
    assert.ok(drop >= -0.001 && drop < 0.2, `speed ${speed}: hip drop ${drop}`);
  }
});
