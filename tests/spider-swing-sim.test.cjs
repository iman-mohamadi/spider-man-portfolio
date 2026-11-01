const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');

const read = (p) => readFileSync(join(__dirname, '..', p), 'utf8');
const physics = loadModule(read('js/spider-physics.js'));
const { simulateSwing } = loadModule(read('js/spider-swing-sim.js'), { imports: { './spider-physics.js': physics } });

// A flat street (y = 0) with one tall building: the box x in [-40, 40], z in [60, 90] (its facade faces -z, towards the player at the origin).
const BOX = { x0: -40, x1: 40, z0: 60, z1: 90, top: 70 };
function segmentHitsBox(ax, ay, az, bx, by, bz, b = BOX) {
  const d = [bx - ax, by - ay, bz - az], o = [ax, ay, az], lo = [b.x0, 0, b.z0], hi = [b.x1, b.top, b.z1];
  let t0 = 0, t1 = 1;
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-9) { if (o[i] < lo[i] || o[i] > hi[i]) return false; continue; }
    let ta = (lo[i] - o[i]) / d[i], tb = (hi[i] - o[i]) / d[i];
    if (ta > tb) [ta, tb] = [tb, ta];
    t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
    if (t0 > t1) return false;
  }
  return true;
}
const world = { floorAt: () => 0, lineClear: (ax, ay, az, bx, by, bz) => !segmentHitsBox(ax, ay, az, bx, by, bz) };
const body = { x: 0, y: 0, z: 0 };

test('a facade just ahead is a short swing that ends in the wall; the same kind of facade further along the street gives a long one', () => {
  const near = { ...BOX, z0: 36 }, far = { ...BOX, z0: 60 };
  const w = (b) => ({ floorAt: () => 0, lineClear: (ax, ay, az, bx, by, bz) => !segmentHitsBox(ax, ay, az, bx, by, bz, b) });
  const rNear = simulateSwing(w(near), body, { x: 0, y: 0, z: 0 }, { x: 0, y: 42, z: 35.65 }, true);
  const rFar = simulateSwing(w(far), body, { x: 0, y: 0, z: 0 }, { x: 0, y: 55, z: 59.65 }, true);
  assert.equal(rNear.hitWall, true);
  assert.ok(rNear.quality < 0.8, `near facade quality ${rNear.quality.toFixed(2)} (travel ${rNear.travel.toFixed(0)} m)`);
  assert.ok(rFar.quality > rNear.quality, 'a facade further away leaves room for a longer arc');
});

test('an anchor beside the path, with the player already moving along it, carries the body a long way before anything ends the swing', () => {
  const sideBox = { x0: 30, x1: 70, z0: -20, z1: 120, top: 70 };
  const w = { floorAt: () => 0, lineClear: (ax, ay, az, bx, by, bz) => !segmentHitsBox(ax, ay, az, bx, by, bz, sideBox) };
  const r = simulateSwing(w, { x: 0, y: 14, z: 0 }, { x: 0, y: 0, z: 14 }, { x: 29.65, y: 55, z: 35 }, false);
  assert.ok(r.travel > 45 && r.quality === 1, JSON.stringify(r));
});

test('with open air all around the swing is judged on its own merits and never reports a wall', () => {
  const open = { floorAt: () => 0, lineClear: () => true };
  const r = simulateSwing(open, { x: 0, y: 25, z: 0 }, { x: 0, y: 0, z: 10 }, { x: 0, y: 70, z: 35 }, false);
  assert.equal(r.hitWall, false);
  assert.ok(r.ok && r.travel > 12, JSON.stringify(r));
});

test('an arc that scrapes the street is not ok and does not claim a good quality unless it travelled far', () => {
  const open = { floorAt: () => 0, lineClear: () => true };
  const r = simulateSwing(open, { x: 0, y: 3, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 0, y: 24, z: 60 }, false);
  assert.ok(r.hitGround || r.minClear < 3, `minClear ${r.minClear}`);
});

test('the prediction is finite and bounded for any start, and does not mutate its inputs', () => {
  const open = { floorAt: () => 0, lineClear: () => true };
  const b = { x: 1, y: 30, z: 2 }, v = { x: 3, y: -4, z: 5 }, a = { x: 10, y: 80, z: 40 };
  const r = simulateSwing(open, b, v, a, false);
  assert.ok(Number.isFinite(r.travel) && Number.isFinite(r.t) && r.t <= 3.7 && r.quality >= 0 && r.quality <= 1);
  assert.equal(JSON.stringify(b), JSON.stringify({ x: 1, y: 30, z: 2 }));
  assert.equal(JSON.stringify(v), JSON.stringify({ x: 3, y: -4, z: 5 }));
});
