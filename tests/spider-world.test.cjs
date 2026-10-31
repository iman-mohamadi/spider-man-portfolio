const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');

const collision = loadModule(readFileSync(join(__dirname, '../js/building-collision.js'), 'utf8'));
const { createSpiderWorld } = loadModule(readFileSync(join(__dirname, '../js/spider-world.js'), 'utf8'), {
  imports: { './building-collision.js': collision }
});

const square = (x0, z0, x1, z1) => ({ outer: [{ x: x0, z: z0 }, { x: x1, z: z0 }, { x: x1, z: z1 }, { x: x0, z: z1 }], holes: [] });
const building = (x0, z0, x1, z1, maxY) => ({ minX: x0, maxX: x1, minZ: z0, maxZ: z1, minY: 0, maxY, polygon: square(x0, z0, x1, z1) });

function world(colliders) {
  const ctrl = {
    getGroundHeight: (x, z, mode) => (mode === 'person' ? 0.22 : 0),
    // the real one returns a shared list of nearby colliders; a plain filter is enough here
    nearColliders: (x, z, r) => colliders.filter((c) => c.maxX > x - r && c.minX < x + r && c.maxZ > z - r && c.minZ < z + r)
  };
  return createSpiderWorld(ctrl);
}

test('floor is the sidewalk away from buildings and the roof on top of one', () => {
  const w = world([building(0, 0, 20, 20, 40.22)]);
  assert.equal(w.floorAt(-10, 10, 0.22), 0.22);
  assert.equal(w.floorAt(10, 10, 41), 40.22, 'feet just above the roof land on it');
  assert.equal(w.floorAt(10, 10, 5), 0.22, 'feet well below the roof are not lifted onto it (inside the building footprint at street level)');
  assert.equal(w.floorAt(10, 10, 40.0, 0.55), 40.22, 'a step up of 0.22 m is allowed');
});

test('a roof of a lower neighbour is found when walking off a higher one', () => {
  const w = world([building(0, 0, 20, 20, 60), building(20, 0, 40, 20, 30)]);
  assert.equal(w.floorAt(30, 10, 59.9), 30, 'the lower roof is the highest support below the feet');
  assert.equal(w.floorAt(10, 10, 59.9), 60);
});

test('polygon courtyards are not roof: the floor inside a hole falls to the street', () => {
  const c = building(0, 0, 20, 20, 30);
  c.polygon.holes = [[{ x: 8, z: 8 }, { x: 12, z: 8 }, { x: 12, z: 12 }, { x: 8, z: 12 }]];
  const w = world([c]);
  assert.equal(w.floorAt(10, 10, 31), 0.22);
  assert.equal(w.floorAt(3, 3, 31), 30);
});

test('rays hit facades with an outward normal and roofs from above, and miss open air', () => {
  const w = world([building(0, 0, 20, 20, 40)]);
  const wall = w.rayFirstHit(-30, 10, 10, 1, 0, 0, 100);
  assert.ok(wall, 'hits the west wall');
  assert.ok(Math.abs(wall.t - 30) < 1e-9);
  assert.ok(wall.nx < 0 && wall.ny === 0, 'the normal points back to the ray origin');
  const s = Math.SQRT1_2;
  const roof = w.rayFirstHit(10, 60, 10, 0, -1, 0, 100);
  assert.ok(roof && Math.abs(roof.t - 20) < 1e-9 && roof.ny === 1);
  assert.equal(w.rayFirstHit(-30, 50, 10, 1, 0, 0, 100), null, 'passes above the building');
  assert.equal(w.rayFirstHit(-30, 10, 10, -1, 0, 0, 100), null, 'faces away');
  assert.ok(s > 0);
});

test('a ray starting inside a footprint below the roof ignores that building (no self-hit)', () => {
  const w = world([building(0, 0, 20, 20, 40)]);
  assert.equal(w.rayFirstHit(10, 5, 10, 1, 0, 0, 100), null);
});

test('AABB colliders (landmarks) are hit with a slab test', () => {
  const box = { minX: 0, maxX: 10, minZ: 0, maxZ: 10, maxY: 100 };
  const w = world([box]);
  const hit = w.rayFirstHit(-20, 50, 5, 1, 0, 0, 100);
  assert.ok(hit && Math.abs(hit.t - 20) < 1e-9 && hit.nx === -1);
});

test('anchor search picks a facade that faces the player, ahead, above and in range', () => {
  const w = world([
    building(40, -10, 60, 10, 62),   // ahead (+x), tall
    building(-60, -10, -40, 10, 62), // behind
    building(2, 30, 10, 38, 10)      // too low
  ]);
  const a = w.findAnchor(0, 1.3, 0, 1, 0);
  assert.ok(a, 'found one');
  assert.ok(a.x > 30 && a.x < 41, `anchor ${a.x} is on the facade that faces the player (west face at x=40)`);
  assert.ok(a.y > 55, 'high on the facade');
  assert.ok(a.dist > 10 && a.dist < 100);
});

test('anchor search rejects a facade whose line of sight is blocked and returns null when nothing qualifies', () => {
  const wall = building(15, -40, 20, 40, 120); // a tall wall straight ahead blocks the building behind it
  const behindIt = building(45, -10, 65, 10, 70);
  const w = world([wall, behindIt]);
  const a = w.findAnchor(0, 1.3, 0, 1, 0);
  assert.ok(a === null || a.x < 21, 'either nothing, or the blocking wall itself');
  assert.equal(world([]).findAnchor(0, 1.3, 0, 1, 0), null);
});

test('forEachAnchor offers facade AND corner points that face the body, within range, above the minimum height', () => {
  const w = world([building(40, -10, 60, 10, 62)]);
  const found = [];
  w.forEachAnchor(0, 1.3, 0, { minY: 18 }, (x, y, z, nx, nz, h, dy) => found.push({ x, y, z, nx, nz, h, dy }));
  assert.ok(found.length >= 3, `several points: ${found.length}`);
  for (const f of found) {
    assert.ok(f.nx * (0 - f.x) + f.nz * (0 - f.z) >= 0, 'faces the body');
    assert.ok(f.h >= 8 && f.h <= 90 && f.dy >= 6 && f.dy <= 80 && f.y >= 18);
  }
  // corners: the two corners on the near (west) side sit outside the building, on the corner's diagonal
  const corners = found.filter((f) => Math.abs(f.nx) > 0.5 && Math.abs(f.nz) > 0.5);
  assert.ok(corners.length >= 2, `corner anchors: ${corners.length}`);
  for (const c of corners) assert.ok(c.x < 40 && Math.abs(c.z) > 10, `corner point is outside the wall: ${c.x}, ${c.z}`);
});

test('forEachAnchor ignores low buildings, buildings behind a minimum height, and out-of-range ones', () => {
  const w = world([building(40, -10, 60, 10, 12), building(200, -10, 220, 10, 90)]);
  let n = 0;
  w.forEachAnchor(0, 1.3, 0, { minY: 18 }, () => n++);
  assert.equal(n, 0);
});

test('lineClear is false through a building and true past it, and the end point may touch the wall it hangs on', () => {
  const w = world([building(20, -10, 30, 10, 60)]);
  assert.equal(w.lineClear(0, 30, 0, 50, 30, 0), false, 'through the building');
  assert.equal(w.lineClear(0, 70, 0, 50, 70, 0), true, 'over the roof');
  assert.equal(w.lineClear(0, 30, 0, 20.4, 30, 0), true, 'ends on the facade');
});
