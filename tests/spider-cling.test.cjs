const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');

const read = (p) => readFileSync(join(__dirname, '..', p), 'utf8');
const P = loadModule(read('js/spider-physics.js'));
const W = loadModule(read('js/spider-wallrun.js'));
const CL = loadModule(read('js/spider-cling.js'), { imports: { './spider-wallrun.js': W } });
const C = loadModule(read('js/spider-controller.js'), { imports: { './spider-physics.js': P, './spider-wallrun.js': W, './spider-cling.js': CL } });
const { SPIDER: CFG } = P;

// ---------------------------------------------------------------------------------------------------------------- a fake city
// surface: { axis: 'x' | 'y' | 'z', pos, sign (normal along the axis), min, max (extent along the first other axis), min2, max2 (the second one), top (walls: height) }
//   x-walls span z in [min, max] and y in [0, top]; z-walls span x in [min, max] and y in [0, top]; y-surfaces (roofs: sign +1, undersides: sign -1) span x in [min, max] and z in [min2, max2].
function city(surfaces = []) {
  return {
    surfaces,
    floorAt(x, z, feetY, stepUp = 0.55) {
      let best = 0;
      for (const s of this.surfaces) if (s.axis === 'y' && s.sign > 0 && x >= s.min && x <= s.max && z >= s.min2 && z <= s.max2 && s.pos <= feetY + stepUp && s.pos > best) best = s.pos;
      return best;
    },
    rayFirstHit(ox, oy, oz, dx, dy, dz, maxT) {
      let best = null;
      const o = [ox, oy, oz], d = [dx, dy, dz];
      for (const s of this.surfaces) {
        const a = s.axis === 'x' ? 0 : s.axis === 'y' ? 1 : 2;
        if (Math.abs(d[a]) < 1e-9 || d[a] * s.sign >= 0) continue;
        const t = (s.pos - o[a]) / d[a];
        if (t <= 1e-3 || t > maxT) continue;
        const px = ox + dx * t, py = oy + dy * t, pz = oz + dz * t;
        let inside;
        if (s.axis === 'x') inside = pz >= s.min && pz <= s.max && py >= 0 && py <= s.top;
        else if (s.axis === 'z') inside = px >= s.min && px <= s.max && py >= 0 && py <= s.top;
        else inside = px >= s.min && px <= s.max && pz >= s.min2 && pz <= s.max2;
        if (!inside) continue;
        if (!best || t < best.t) best = { t, nx: a === 0 ? s.sign : 0, ny: a === 1 ? s.sign : 0, nz: a === 2 ? s.sign : 0 };
      }
      return best;
    }
  };
}
const FACADE = { axis: 'x', pos: 20, sign: -1, min: -400, max: 400, top: 90 }; // a tall facade at x = 20 (the building is at x > 20), its face looks to -x

// camera yaw pi/2 looks along +x, straight at the facade: W pushes into the wall, then (on it) crawls up; D goes to +z
function setup({ world = city([FACADE]), x = 19, y = 6, z = 0, yaw = Math.PI / 2, heading = Math.PI / 2, vel = null, target = null, cfg = null, solidX = null } = {}) {
  const pos = { x, y, z, set(a, b, c) { this.x = a; this.y = b; this.z = c; } };
  const entity = { position: pos, heading, speed: 0, verticalVel: 0, mesh: { position: { set() {} }, rotation: { y: 0 } } };
  const keys = { forward: false, backward: false, left: false, right: false, up: false, down: false };
  const input = { shift: false, webHeld: false, _press: false, consumeWebPress() { const v = this._press; this._press = false; return v; } };
  const state = { target, yaw }, rigCalls = [];
  const rig = { update(dt, st) { rigCalls.push({ ...st }); } };
  const solid = { resolveHorizontalCollision(p, r) { if (solidX !== null && p.x > solidX - r) p.x = solidX - r; } }; // with solidX: the building at x > 20 is solid, as in the city (ground tests)
  const ctrl = new C.SpiderController({ controllers: { keys, ...solid }, world, entity, input, getViewYaw: () => state.yaw, rig, ...(cfg ? { config: cfg } : {}) });
  ctrl.targeting = { current: () => state.target, flash() {} };
  ctrl.state = y > 0.3 ? 'air' : 'ground';
  if (vel) Object.assign(ctrl.vel, vel);
  const frame = (n = 1, dt = 1 / 60) => { for (let i = 0; i < n; i++) ctrl.update(dt); };
  const tap = () => { keys.up = true; frame(1); keys.up = false; frame(1); };
  const press = () => { input.webHeld = true; input._press = true; };
  // distance of the chest to the plane of the surface being clung to
  const offset = () => ctrl.surf.nx * ctrl.pos.x + ctrl.surf.ny * (ctrl.pos.y + 1) + ctrl.surf.nz * ctrl.pos.z - ctrl.surf.c;
  return { ctrl, keys, input, state, frame, tap, press, pos, world, rig, rigCalls, offset };
}
const finite = (c) => [c.pos.x, c.pos.y, c.pos.z, c.vel.x, c.vel.y, c.vel.z].every(Number.isFinite);
// pushes the stick into the wall until he is on it, then lets the stick go: a stationary cling
const clung = (opts) => { const t = setup(opts); t.keys.forward = true; for (let i = 0; i < 60 && t.ctrl.state !== 'cling'; i++) t.frame(1); t.keys.forward = false; assert.equal(t.ctrl.state, 'cling', 'attached'); t.frame(10); return t; };
const pushFor = (opts, frames, key = 'forward') => { const t = setup(opts); t.keys[key] = true; t.frame(frames); return t; };

// ---------------------------------------------------------------------------------------------------------------- attaching without a key
test('walking into a wall attaches by itself: in the air after a moment, on the ground after a little longer; there is no key', () => {
  const air = clung(); air.frame(40);
  assert.ok(Math.abs(air.offset() - CFG.clingOffset) < 0.02, `offset ${air.offset()}`); assert.equal(air.ctrl.stats.clings, 1);
  assert.equal(air.ctrl.wallPose.active, true); assert.equal(air.rigCalls.at(-1).cling, true); assert.equal(air.rigCalls.at(-1).wallRun, false);
  const brush = pushFor({ x: 19.4, y: 0, solidX: 20 }, 9); assert.notEqual(brush.ctrl.state, 'cling', 'a brush against a wall on the ground does nothing');
  const walk = pushFor({ x: 19.4, y: 0, solidX: 20 }, 40); assert.equal(walk.ctrl.state, 'cling', 'pushing into it for a moment does');
  const src = read('js/spider-controller.js') + read('js/spider-input.js') + read('js/main.js');
  assert.doesNotMatch(src, /clingInput|clingKey|keys\.down[^\n]*cling/, 'no key is read for it');
});

test('attachment is deliberate: only a stick pushing straight into a flat tall wide wall; never passing by, never a floor or a roof, never a stick away from it', () => {
  const state = (opts, key = 'forward') => pushFor(opts, 40, key).ctrl.state;
  assert.notEqual(state({ x: 16 }), 'cling', 'too far: no magnetic pull');
  assert.notEqual(state({ world: city([{ ...FACADE, top: 3 }]) }), 'cling', 'a short wall');
  assert.notEqual(state({ world: city([{ ...FACADE, min: -0.5, max: 0.5 }]) }), 'cling', 'a narrow pier');
  assert.notEqual(state({ world: city([{ ...FACADE, max: 0.2 }, { ...FACADE, pos: 21.4, min: 0.2, max: 400 }]) }), 'cling', 'a wall with a step in it');
  assert.notEqual(state({ world: city([]) }), 'cling', 'nothing there');
  assert.notEqual(state({ world: city([{ axis: 'y', pos: 12, sign: 1, min: -50, max: 50, min2: -50, max2: 50 }]), y: 10.5, x: 0 }), 'cling', 'a floor or a roof is not clung to');
  assert.notEqual(state({}, 'right'), 'cling', 'moving along the wall (the stick across it) is passing by');
  assert.notEqual(state({}, 'backward'), 'cling', 'the stick away from it');
  assert.notEqual(state({ yaw: Math.PI / 2 }, 'left'), 'cling', 'the camera looks at the wall but the stick goes the other way: the stick decides');
  const idle = setup(); idle.frame(40); assert.notEqual(idle.ctrl.state, 'cling', 'standing next to a wall with no stick');
  const diag = setup(); diag.keys.forward = true; diag.keys.right = true; diag.frame(60); assert.equal(diag.ctrl.state, 'cling', 'a diagonal approach within 45 degrees still counts');
  const shallow = setup(); shallow.keys.right = true; shallow.state.yaw = 2 * Math.PI / 3; shallow.frame(60); // the stick points 60 degrees off the wall's normal assert.notEqual(shallow.ctrl.state, 'cling', 'a shallow approach is not straight at it');
  const edge = setup({ world: city([{ ...FACADE, max: 0 }]), z: 0.3 }); edge.keys.forward = true; edge.frame(40); assert.notEqual(edge.ctrl.state, 'cling', 'the very end of a wall');
});

test('the stick decides, not the camera: the camera may look along the wall', () => {
  const t = setup({ yaw: 0, heading: 0 }); t.keys.left = true; t.frame(40); assert.equal(t.ctrl.state, 'cling', 'camera along +z, the stick (A) towards the wall at +x');
  const u = setup({ yaw: Math.PI, heading: Math.PI }); u.keys.right = true; u.frame(40); assert.equal(u.ctrl.state, 'cling');
});

// ---------------------------------------------------------------------------------------------------------------- staying and crawling
test('without any input the body stays attached and does not move: no gravity, no drift, no jitter', () => {
  const t = clung({ y: 6 }); t.frame(120); const y0 = t.pos.y, x0 = t.pos.x, z0 = t.pos.z;
  let maxMove = 0, prev = t.pos.y; for (let i = 0; i < 240; i++) { t.frame(1); maxMove = Math.max(maxMove, Math.abs(t.pos.y - prev)); prev = t.pos.y; }
  assert.equal(t.ctrl.state, 'cling'); assert.ok(Math.abs(t.pos.y - y0) < 1e-5 && Math.abs(t.pos.x - x0) < 1e-5 && Math.abs(t.pos.z - z0) < 1e-5, 'it did not move');
  assert.ok(maxMove < 1e-6 && Math.hypot(t.ctrl.vel.x, t.ctrl.vel.y, t.ctrl.vel.z) < 1e-6, 'no gravity, no velocity: the cling has zero intentional movement');
});

test('W up, S down, A left, D right along the surface as the camera sees it, the distance holds, and releasing the stick stops him without letting go', () => {
  const dirs = { forward: [0, 1, 0], backward: [0, -1, 0], right: [0, 0, 1], left: [0, 0, -1] };
  for (const [key, d] of Object.entries(dirs)) {
    const t = clung({ y: 8 }); t.frame(20); t.keys[key] = true;
    const x0 = t.pos.x, p0 = { y: t.pos.y, z: t.pos.z }; let maxDev = 0;
    for (let i = 0; i < 60; i++) { t.frame(1); maxDev = Math.max(maxDev, Math.abs(t.offset() - CFG.clingOffset)); }
    assert.equal(t.ctrl.state, 'cling', key);
    assert.ok(d[1] === 0 ? Math.abs(t.pos.y - p0.y) < 1e-6 : Math.sign(t.pos.y - p0.y) === d[1] && Math.abs(t.pos.y - p0.y) > 1, `${key}: vertical ${t.pos.y - p0.y}`);
    assert.ok(d[2] === 0 || Math.sign(t.pos.z - p0.z) === d[2], `${key}: sideways ${t.pos.z - p0.z}`);
    const moved = Math.hypot(t.pos.y - p0.y, t.pos.z - p0.z); assert.ok(moved > 1.0 && moved < 3, `${key}: ${moved} m in a second`);
    assert.ok(Math.abs(t.pos.x - x0) < 0.03, `${key}: it follows the wall plane`); assert.ok(maxDev < 0.02, `${key}: the distance holds (${maxDev})`);
    t.keys[key] = false; t.frame(30); assert.equal(t.ctrl.state, 'cling', `${key}: still attached`); assert.ok(Math.hypot(t.ctrl.vel.y, t.ctrl.vel.z) < 1e-6, `${key}: stopped`);
    t.keys[key] = true; t.frame(10); assert.ok(Math.hypot(t.ctrl.vel.y, t.ctrl.vel.z) > 0.5, `${key}: restarts at once`);
  }
});

test('diagonals are normalised, the crawl accelerates and brakes (not a jump in speed), Shift is faster, an analog-sized stick is slower', () => {
  const t = clung({ y: 8 }); t.frame(20); t.keys.forward = true; t.frame(1);
  const first = Math.hypot(t.ctrl.vel.y, t.ctrl.vel.z); assert.ok(first > 0 && first < CFG.clingCrawl * 0.5, `one frame is not the full speed: ${first}`);
  t.frame(60); const slow = Math.hypot(t.ctrl.vel.y, t.ctrl.vel.z); assert.ok(Math.abs(slow - CFG.clingCrawl) < 0.05, `crawl ${slow}`);
  t.keys.right = true; t.frame(30); assert.ok(Math.hypot(t.ctrl.vel.y, t.ctrl.vel.z) <= CFG.clingCrawl + 0.01, 'a diagonal is not faster than straight');
  t.keys.forward = false; t.keys.right = false; t.frame(2); assert.ok(Math.hypot(t.ctrl.vel.y, t.ctrl.vel.z) < CFG.clingCrawl, 'braking, not an instant stop'); t.frame(20);
  t.input.shift = true; t.frame(2); t.keys.forward = true; t.frame(60); // Shift already down: no new press, so the faster crawl (a press with the stick on would start a run)
  assert.ok(Math.abs(Math.hypot(t.ctrl.vel.y, t.ctrl.vel.z) - CFG.clingFast) < 0.05, 'Shift: faster crawl'); assert.equal(t.ctrl.state, 'cling');
  assert.ok(CFG.clingRunSpeed > CFG.clingFast * 1.5 && CFG.wallRun > CFG.clingFast * 2, 'a run is noticeably faster than any crawl');
  const half = CL.crawlVelocity({ x: 0, y: 0, z: 0 }, { nx: -1, ny: 0, nz: 0 }, 0, 0.4, 0, CFG.clingCrawl, 1e6, 1e6, 1); assert.ok(Math.abs(half - 0.4 * CFG.clingCrawl) < 1e-9, 'a small stick deflection crawls slowly and exactly');
});

test('the stick is the stick in the world, seen from the camera: with the camera at the wall W is up and D is right; looking away they turn round; looking along the wall W goes along it', () => {
  const t = clung({ y: 8 }); t.state.yaw = Math.PI / 2 + 0.3; t.keys.right = true; t.frame(30); assert.ok(t.ctrl.vel.z > 1, 'D is still to the right of the screen');
  const u = clung({ y: 8 }); u.state.yaw = Math.PI / 2 + Math.PI; u.keys.right = true; u.frame(40); assert.ok(u.ctrl.vel.z < -1, 'the camera looks away from the wall: D goes to the right of that view (-z)');
  const w = clung({ y: 8 }); w.state.yaw = Math.PI / 2 + Math.PI; w.keys.forward = true; w.frame(40); assert.ok(w.ctrl.vel.y < -1, 'looking away from the wall W is away from it: down');
  const v = clung({ y: 8 }); v.state.yaw = 0; v.keys.forward = true; v.frame(40); assert.ok(v.ctrl.vel.z > 1 && Math.abs(v.ctrl.vel.y) < 0.2, 'the camera looks along the wall: W goes along it, not up');
  const x = clung({ y: 8 }); x.state.yaw = 0; x.keys.left = true; x.frame(40); assert.ok(x.ctrl.vel.y > 1, 'and the stick towards the wall climbs');
  const s = { nx: -1, ny: 0, nz: 0 }, d = {}; CL.stickDirection(s, 0.6, 0.8, d); assert.ok(Math.abs(Math.hypot(d.x, d.y, d.z) - 1) < 1e-9, 'a rotation of the stick: never faster than the stick');
});

test('the head turns smoothly towards the direction of travel: no step bigger than the turn rate allows, and it ends up where it is going', () => {
  const t = clung({ y: 8 }); t.frame(20); const h = t.ctrl.clingHead; let prev = { ...h }, worst = 0;
  const track = (n) => { for (let i = 0; i < n; i++) { t.frame(1); const dot = Math.max(-1, Math.min(1, h.x * prev.x + h.y * prev.y + h.z * prev.z)); worst = Math.max(worst, Math.acos(dot)); prev = { ...h }; } };
  assert.ok(Math.abs(h.y - 1) < 1e-6, 'starts with the head up');
  t.keys.forward = true; track(30); t.keys.forward = false; t.keys.right = true; track(40);
  assert.ok(h.z > 0.95, `the head points the way he crawls: ${h.z}`); t.keys.right = false; t.keys.backward = true; track(60); assert.ok(h.y < -0.95, `and down: ${h.y}`);
  assert.ok(worst <= CFG.clingTurn / 60 * 1.05, `no snapping: the biggest step was ${worst} rad (limit ${CFG.clingTurn / 60})`);
  assert.ok(Math.abs(h.x * 1) < 1e-6 && Math.abs(Math.hypot(h.x, h.y, h.z) - 1) < 1e-9, 'always a unit vector in the plane of the wall');
  const pose = t.ctrl.wallPose; assert.ok(Math.abs(pose.fx + t.ctrl.surf.nx) < 1e-9 && Math.abs(pose.ux * pose.fx + pose.uy * pose.fy + pose.uz * pose.fz) < 1e-9, 'the chest faces the wall, the head is along it');
});

// ---------------------------------------------------------------------------------------------------------------- corners, ceilings, roofs
test('round an outside corner: onto the face that turns away, smoothly, still attached at the right distance', () => {
  const world = city([{ ...FACADE, max: 8 }, { axis: 'z', pos: 8, sign: 1, min: 20, max: 400, top: 90 }]);
  const t = clung({ world, y: 8, z: 0 }); t.frame(20); t.keys.right = true;
  let turned = -1; for (let i = 0; i < 400 && turned < 0; i++) { t.frame(1); if (t.ctrl.surf.nz > 0.9) turned = i; assert.equal(t.ctrl.state, 'cling'); assert.ok(finite(t.ctrl)); }
  assert.ok(turned >= 0, 'he went round the corner'); t.keys.right = false; t.frame(40);
  assert.equal(t.ctrl.state, 'cling'); assert.ok(Math.abs(t.offset() - CFG.clingOffset) < 0.03, `distance to the new face ${t.offset()}`); assert.ok(t.pos.z > 8, `he is on the other face: z = ${t.pos.z}`);
  const pose = t.ctrl.wallPose; assert.ok(Math.abs(pose.fz + 1) < 1e-6, 'the chest faces the new face');
});

test('round an inside corner: the wall that closes the way ahead', () => {
  const world = city([FACADE, { axis: 'z', pos: 8, sign: -1, min: -400, max: 20, top: 90 }]);
  const t = clung({ world, y: 8, z: 0 }); t.frame(20); t.keys.right = true;
  let turned = -1; for (let i = 0; i < 400 && turned < 0; i++) { t.frame(1); if (t.ctrl.surf.nz < -0.9) turned = i; }
  assert.ok(turned >= 0, 'he turned into the corner'); t.keys.right = false; t.frame(40);
  assert.equal(t.ctrl.state, 'cling'); assert.ok(Math.abs(t.offset() - CFG.clingOffset) < 0.03, `distance ${t.offset()}`); assert.ok(t.pos.z < 8, 'in front of the second wall');
});

test('after a corner the stick that went round it keeps going round it, even when the camera sees the new face from the other side; a new stick direction takes over', () => {
  const world = city([{ ...FACADE, max: 8 }, { axis: 'z', pos: 8, sign: 1, min: 20, max: 400, top: 90 }]);
  const t = clung({ world, y: 8, z: 0, yaw: Math.PI / 2 - 0.5 }); t.frame(20); t.keys.right = true;
  let turned = -1; for (let i = 0; i < 400 && turned < 0; i++) { t.frame(1); if (t.ctrl.surf.nz > 0.9) turned = i; }
  assert.ok(turned >= 0); t.frame(30); const x0 = t.pos.x; t.frame(20);
  assert.ok(t.pos.x > x0 + 0.5, `still going round the building (away from the corner): ${x0} -> ${t.pos.x}`);
  const raw = {}; CL.stickDirection({ nx: 0, ny: 0, nz: 1 }, -0.48, 0.88, raw); assert.ok(raw.x < 0 && raw.y < 0, 'without it the same stick would send him down and back');
  t.keys.right = false; t.keys.left = true; t.frame(10); assert.equal(t.ctrl.clingTurnT, 0, 'a different stick ends it');
});

const SLAB = { axis: 'y', pos: 10, sign: -1, min: -50, max: 50, min2: -50, max2: 50 };
test('a ceiling (an underside the collision data really has): a rising body catches it, crawls in its plane with no gravity, and lets go by jumping', () => {
  const t = setup({ world: city([SLAB]), x: 0, y: 8, z: 0, yaw: 0, heading: 0, vel: { x: 0, y: 7, z: 0 } }); t.frame(40);
  assert.equal(t.ctrl.state, 'cling'); assert.equal(t.ctrl.surf.kind, 'ceiling'); assert.ok(t.ctrl.surf.ny < -0.99);
  t.frame(30); assert.ok(Math.abs(t.offset() - CFG.clingOffset) < 0.02, `offset ${t.offset()}`); const y0 = t.pos.y; t.frame(60); assert.ok(Math.abs(t.pos.y - y0) < 1e-4, 'no gravity: it hangs');
  t.keys.forward = true; t.frame(60); assert.ok(t.pos.z > 1, 'W goes forward along the ceiling'); t.keys.forward = false; t.keys.right = true; t.frame(60); assert.ok(t.pos.x < -1, 'D goes to the right of the camera');
  assert.ok(Math.abs(t.offset() - CFG.clingOffset) < 0.02 && Math.abs(t.pos.y - y0) < 1e-4, 'and keeps its distance'); assert.equal(t.ctrl.state, 'cling');
  assert.ok(Math.abs(t.ctrl.wallPose.fy - 1) < 1e-6, 'the chest faces up into the ceiling');
  t.keys.right = false; t.tap(); assert.equal(t.ctrl.state, 'air'); assert.ok(t.ctrl.vel.y < 0, 'a jump off a ceiling lets go downwards');
  const falling = setup({ world: city([SLAB]), x: 0, y: 8.2, z: 0, vel: { x: 0, y: -2, z: 0 } }); falling.frame(30); assert.notEqual(falling.ctrl.state, 'cling', 'passing under a ceiling while falling does not catch it');
  const none = setup({ world: city([]), x: 0, y: 8, z: 0, vel: { x: 0, y: 7, z: 0 } }); none.frame(40); assert.notEqual(none.ctrl.state, 'cling', 'no underside in the collision data, no ceiling cling');
});

test('wall to ceiling: crawling up a wall into an overhang turns onto its underside', () => {
  const world = city([FACADE, { axis: 'y', pos: 14, sign: -1, min: -50, max: 20, min2: -50, max2: 50 }]);
  const t = clung({ world, y: 9 }); t.frame(10); t.keys.forward = true;
  let ceiling = -1; for (let i = 0; i < 400 && ceiling < 0; i++) { t.frame(1); if (t.ctrl.surf.kind === 'ceiling') ceiling = i; assert.ok(finite(t.ctrl)); }
  assert.ok(ceiling >= 0, 'he went from the wall onto the ceiling'); t.keys.forward = false; t.frame(40); assert.equal(t.ctrl.state, 'cling'); assert.ok(Math.abs(t.offset() - CFG.clingOffset) < 0.05);
});

test('the roof edge: a staged climb whose length sets its duration, continuous, ending standing on the roof', () => {
  const world = city([{ ...FACADE, top: 12 }, { axis: 'y', pos: 12, sign: 1, min: 20, max: 80, min2: -80, max2: 80 }]);
  const t = clung({ world, y: 8, z: 0 }); t.frame(20); t.keys.forward = true;
  let start = -1, steps = 0, worst = 0, prev = { x: t.pos.x, y: t.pos.y, z: t.pos.z }, split = null;
  for (let i = 0; i < 600; i++) {
    t.frame(1);
    const d = Math.hypot(t.pos.x - prev.x, t.pos.y - prev.y, t.pos.z - prev.z); prev = { x: t.pos.x, y: t.pos.y, z: t.pos.z };
    if (t.ctrl.mantle.active) { if (start < 0) start = i; steps++; worst = Math.max(worst, d); split = t.ctrl.mantle.u1; assert.equal(t.rigCalls.at(-1).cling, true); assert.ok(t.rigCalls.at(-1).mantle >= 0 && t.rigCalls.at(-1).mantle <= 1); }
    else if (start >= 0) break;
  }
  assert.ok(start >= 0, 'a mantle started'); const dur = steps / 60;
  assert.ok(dur >= CFG.mantleMin - 0.05 && dur < 3, `its duration follows the path: ${dur} s`); assert.ok(worst < 0.15, `no jump: the biggest step was ${worst} m in a frame`);
  assert.ok(split > 0.15 && split < 0.85, 'two stages: up the wall, then over the edge');
  t.keys.forward = false; t.frame(20);
  assert.equal(t.ctrl.state, 'ground'); assert.ok(Math.abs(t.pos.y - 12) < 0.05, `standing on the roof: y = ${t.pos.y}`); assert.ok(t.pos.x > 20, 'on the roof, over the building'); assert.equal(t.ctrl.airJumps, 0);
  assert.ok(t.rigCalls.some((c) => c.mantle > 0.6 && c.mantle < 1 && c.cling), 'the rig was told how far the climb is');
  const tall = city([{ ...FACADE, top: 30 }, { axis: 'y', pos: 30, sign: 1, min: 20, max: 80, min2: -80, max2: 80 }]); // a higher edge: the first stage is longer, the climb takes longer
  const u = clung({ world: tall, y: 26, z: 0 }); u.frame(10); u.keys.forward = true; let n2 = 0, begun = false; for (let i = 0; i < 800; i++) { u.frame(1); if (u.ctrl.mantle.active) { begun = true; n2++; } else if (begun) break; }
  assert.ok(begun && n2 > 0); t.keys.forward = true; t.state.yaw = Math.PI / 2; t.keys.down = false; t.frame(30); assert.ok(t.ctrl.vel.x > 3, 'and he walks on');
});

// ---------------------------------------------------------------------------------------------------------------- letting go
test('a lost wall: a fall after the grace period with the velocity he had; paused or reset: off the wall', () => {
  const u = clung({ y: 8 }); u.frame(10); u.keys.right = true; u.frame(30); u.world.surfaces.length = 0; u.frame(5); assert.equal(u.ctrl.state, 'cling', 'a gap is bridged for a moment');
  u.frame(40); assert.equal(u.ctrl.state === 'air' || u.ctrl.state === 'ground', true); assert.ok(finite(u.ctrl)); assert.equal(u.ctrl.wallPose.active, false);
  const v = clung({ y: 8 }); v.ctrl.paused = true; v.frame(3); assert.notEqual(v.ctrl.state, 'cling');
  const r = clung({ y: 8 }); r.ctrl.resetMotion(); assert.equal(r.ctrl.state, 'air'); assert.equal(r.ctrl.wallPose.active, false);
});

test('Space jumps off the wall (away and up), keeps some of the crawl, blocks the wall for a moment; the double jump is still there afterwards', () => {
  const t = clung({ y: 8 }); t.keys.forward = true; t.frame(40); const vy = t.ctrl.vel.y; t.keys.forward = false; t.tap();
  assert.equal(t.ctrl.state, 'air'); assert.equal(t.ctrl.stats.wallJumps, 1);
  assert.ok(t.ctrl.vel.x < -CFG.clingJumpOut + 0.8, `away from the wall: ${t.ctrl.vel.x}`); assert.ok(t.ctrl.vel.y > CFG.clingJumpUp - 1 + vy * CFG.clingJumpKeep - 0.5, `up: ${t.ctrl.vel.y}`);
  assert.ok(t.ctrl.wallBlock.t > 0.3); t.frame(20); t.tap();
  assert.equal(t.ctrl.stats.airJumps, 1, 'wall crawl -> wall jump -> double jump'); assert.ok(finite(t.ctrl));
  const held = clung({ y: 8 }); held.tap(); held.keys.forward = true; held.frame(20); assert.notEqual(held.ctrl.state, 'cling', 'pushing at the same wall right after the jump does not grab it again');
  const air = clung({ y: 8 }); air.tap(); air.keys.left = true; air.state.yaw = Math.PI / 2 + Math.PI; air.frame(1); assert.equal(air.ctrl.airJumps, 0);
});

test('a wall jump can end on another wall: the next wall is caught by the same rules', () => {
  const world = city([FACADE, { axis: 'x', pos: 9, sign: 1, min: -400, max: 400, top: 90 }]); // a second wall across the street, facing +x
  const t = clung({ world, x: 19, y: 8 }); t.tap();
  t.state.yaw = -Math.PI / 2; t.keys.forward = true; let got = false; for (let i = 0; i < 400 && !got; i++) { t.frame(1); if (t.ctrl.state === 'cling' || t.ctrl.state === 'wall') got = true; }
  assert.ok(got, 'a second wall caught after the jump'); assert.ok(finite(t.ctrl));
});

test('crawling down to the floor stands him up again on the ground, with the air jump back', () => {
  const t = clung({ y: 2.2, z: 0 }); t.ctrl.airJumps = 1; t.frame(10); t.keys.backward = true;
  let down = -1; for (let i = 0; i < 300 && down < 0; i++) { t.frame(1); if (t.ctrl.state === 'ground') down = i; }
  assert.ok(down >= 0, 'he reached the ground'); assert.equal(t.pos.y, 0); assert.equal(t.ctrl.airJumps, 0); t.keys.backward = false; t.frame(5); assert.equal(t.ctrl.state, 'ground');
  assert.ok(finite(t.ctrl));
});

// ---------------------------------------------------------------------------------------------------------------- the run, and the hand-over between run and crawl
const AT_WALL_AIR = { x: 18.5, y: 6, z: 0, yaw: 0, heading: 0, vel: { x: 0, y: 0, z: 10 } }; // flying along the facade, the camera looks along +z

test('a run that is over hands over to the crawl with the speed it had, instead of dropping him; the stick released while running is enough', () => {
  const t = setup(AT_WALL_AIR); t.keys.forward = true; t.frame(25); assert.equal(t.ctrl.state, 'wall');
  t.keys.forward = false; let first = null; for (let i = 0; i < 40 && !first; i++) { t.frame(1); if (t.ctrl.state === 'cling') first = Math.hypot(t.ctrl.vel.x, t.ctrl.vel.y, t.ctrl.vel.z); }
  assert.ok(first !== null, 'run -> crawl'); assert.ok(first > 5, `the speed is kept at the hand-over: ${first}`);
  t.frame(8); assert.ok(Math.hypot(t.ctrl.vel.x, t.ctrl.vel.y, t.ctrl.vel.z) < first && Math.hypot(t.ctrl.vel.y, t.ctrl.vel.z) > 0.3, 'and it is let go gently, not stopped dead');
  t.frame(60); assert.equal(t.ctrl.state, 'cling'); assert.ok(Math.hypot(t.ctrl.vel.x, t.ctrl.vel.y, t.ctrl.vel.z) < 1e-6, 'then he hangs there'); assert.ok(Math.abs(t.offset() - CFG.clingOffset) < 0.03);
  assert.equal(t.ctrl.stats.wallRuns, 1); assert.equal(t.ctrl.stats.clings, 1);
});

test('the time limit of a run also hands over to the crawl, and Shift pressed while crawling along the wall starts a run again with momentum', () => {
  const t = setup(AT_WALL_AIR); t.keys.forward = true; t.frame(25); let ended = -1; for (let i = 0; i < 400 && ended < 0; i++) { t.frame(1); if (t.ctrl.state !== 'wall') ended = i; }
  assert.ok(ended >= 0); assert.equal(t.ctrl.state, 'cling', 'no fall at the end of the run'); t.keys.forward = false; t.frame(60);
  // crawl along the wall (camera looking at it, D = +z), then press Shift
  t.state.yaw = Math.PI / 2; t.keys.right = true; t.frame(30); assert.ok(t.ctrl.vel.z > 1 && t.ctrl.vel.z < CFG.clingFast, 'a crawl'); const runs = t.ctrl.stats.wallRuns;
  t.input.shift = true; t.frame(2);
  assert.equal(t.ctrl.state, 'wall', 'Shift: crawl -> run'); assert.equal(t.ctrl.stats.wallRuns, runs + 1); assert.ok(Math.hypot(t.ctrl.vel.x, t.ctrl.vel.z) >= CFG.wallMinSpeed - 0.01, `speed ${Math.hypot(t.ctrl.vel.x, t.ctrl.vel.z)}`);
  assert.ok(t.ctrl.vel.z > CFG.clingFast * 1.5, 'noticeably faster than any crawl');
  const idle = clung({ y: 8 }); idle.input.shift = true; idle.frame(5); assert.equal(idle.ctrl.state, 'cling', 'Shift alone (no stick) does not start a run');
});

test('a run that meets a corner goes round it as a crawl and goes on running while Shift is held', () => {
  const world = city([{ ...FACADE, max: 14 }, { axis: 'z', pos: 14, sign: 1, min: 20, max: 400, top: 90 }]);
  const t = setup({ ...AT_WALL_AIR, world }); t.input.shift = true; t.keys.forward = true; t.frame(25); assert.equal(t.ctrl.state, 'wall');
  let turned = -1, run2 = -1; for (let i = 0; i < 400; i++) { t.frame(1); if (turned < 0 && t.ctrl.state === 'cling' && t.ctrl.surf.nz > 0.9) turned = i; if (turned >= 0 && t.ctrl.state === 'wall') { run2 = i; break; } assert.ok(finite(t.ctrl)); }
  assert.ok(turned >= 0, 'the run turned the corner (as a crawl)'); assert.ok(run2 >= 0, 'and picked the run up again on the new face'); assert.ok(t.ctrl.wall.nz > 0.9);
});

test('from the ground: sprinting straight at a facade runs up it with the speed; walking, sprinting along it or past it does not', () => {
  const sprint = setup({ x: 15, y: 0, z: 0, vel: { x: 12, y: 0, z: 0 }, solidX: 20 }); sprint.input.shift = true; sprint.keys.forward = true; sprint.state.yaw = Math.PI / 2; sprint.frame(40);
  assert.equal(sprint.ctrl.state, 'wall', 'Shift + speed + straight at it: a wall run'); assert.ok(sprint.ctrl.vel.y > 5, `the speed became climb: ${sprint.ctrl.vel.y}`); assert.ok(sprint.pos.y > 0.5);
  const walk = setup({ x: 15, y: 0, z: 0, vel: { x: 6, y: 0, z: 0 }, solidX: 20 }); walk.keys.forward = true; walk.state.yaw = Math.PI / 2; walk.frame(40); assert.notEqual(walk.ctrl.state, 'wall', 'no Shift, no run');
  const slow = setup({ x: 19, y: 0, z: 0, vel: { x: 4, y: 0, z: 0 }, solidX: 20 }); slow.input.shift = true; slow.keys.forward = true; slow.state.yaw = Math.PI / 2; slow.frame(40); assert.notEqual(slow.ctrl.state, 'wall', 'too slow for a run');
  const along = setup({ x: 18.5, y: 0, z: 0, yaw: 0, heading: 0, vel: { x: 0, y: 0, z: 12 } }); along.input.shift = true; along.keys.forward = true; along.frame(60); assert.equal(along.ctrl.stats.wallRuns, 0, 'sprinting along a wall on the street is just sprinting'); assert.equal(along.ctrl.state, 'ground');
});

test('in the air, hitting a facade at speed keeps the momentum with no stick at all (the run along it), but flying past one does not', () => {
  const hit = setup({ x: 17, y: 8, z: 0, yaw: 0, heading: 0, vel: { x: 8, y: 0, z: 8 } }); hit.frame(30);
  assert.equal(hit.ctrl.stats.wallRuns, 1, 'an angled impact runs along the wall'); assert.ok(hit.ctrl.vel.z > 4 || hit.ctrl.state === 'cling', 'and does not stop dead'); assert.ok(finite(hit.ctrl));
  const past = setup({ ...AT_WALL_AIR }); past.frame(30); assert.equal(past.ctrl.stats.wallRuns, 0, 'flying along it with no stick is not an impact');
});

test('web: a press on the wall hands over to the rope; a web release at a wall runs or crawls; a swing, a wall, a crawl and a jump chain without a stop', () => {
  const t = clung({ y: 12 }); t.state.target = { x: 5, y: 60, z: 30 }; t.frame(5); t.press(); t.frame(4);
  assert.equal(t.ctrl.state, 'swing'); assert.ok(t.ctrl.anchor); assert.equal(t.ctrl.wallPose.active, false); assert.ok(finite(t.ctrl)); assert.ok(t.ctrl.wallBlock.t > 0);
  for (let i = 0; i < 5; i++) { t.input.webHeld = true; t.frame(1); assert.notEqual(t.ctrl.state, 'cling', 'never a cling on the rope'); assert.notEqual(t.ctrl.state, 'wall', 'never a run on the rope'); }
  // the chain: a swing ends at speed next to the facade; the impact is a run, the run becomes a crawl, the crawl a jump, the jump a double jump
  const c = setup({ x: 17.5, y: 12, z: 0, yaw: Math.PI / 2, heading: Math.PI / 2, vel: { x: 9, y: 0, z: 6 } }); c.ctrl.state = 'swing'; c.ctrl.anchor = { x: 5, y: 60, z: 20 }; c.ctrl.webLength = 40; c.ctrl._endSwing(true);
  const seen = []; for (let i = 0; i < 160; i++) { c.frame(1); if (seen.at(-1) !== c.ctrl.state) seen.push(c.ctrl.state); if (i === 100 && c.ctrl.state === 'cling') c.tap(); if (i === 130 && c.ctrl.state === 'air') c.tap(); }
  assert.deepEqual(seen.slice(0, 4).join(), 'air,wall,cling,air', `the chain: ${seen.join(' > ')}`); assert.equal(c.ctrl.stats.airJumps, 1, 'and the double jump after the wall jump'); assert.ok(finite(c.ctrl));
});

test('the controller stays the one owner: one place enters each state, the rope solver is untouched, nothing allocates in the steps, the numbers are in SPIDER, no key', () => {
  const src = read('js/spider-controller.js'), phys = read('js/spider-physics.js'), cl = read('js/spider-cling.js');
  assert.equal((src.match(/this\.state = 'cling'/g) || []).length, 1); assert.match(src, /else if \(this\.state === 'cling'\) this\._stepCling\(h, w\)/);
  assert.match(src, /if \(this\.state === 'air' \|\| this\.state === 'ground'\) this\._traverseProbe\(dt, w\)/);
  for (const k of ['clingReach', 'clingOffset', 'clingCrawl', 'clingFast', 'clingFollow', 'clingTurn', 'clingCorner', 'clingCornerDot', 'clingInto', 'clingApproach', 'clingIntentGround', 'clingIntentAir', 'clingCoast', 'clingJumpOut', 'clingJumpUp', 'clingRunSpeed', 'wallGroundMin', 'wallImpactSpeed', 'mantleSpeed', 'mantleRise']) assert.match(phys, new RegExp(`\\b${k}:`), k);
  const step = src.slice(src.indexOf('_stepCling(h, w) {'), src.indexOf('/** The press / buffer part'));
  assert.doesNotMatch(step, /new [A-Z]|=> |\[[^\]]*,[^\]]*\]/, 'no allocation inside the crawl step');
  const mantle = src.slice(src.indexOf('_stepMantle(h) {'), src.indexOf('_stepCling(h, w) {'));
  assert.doesNotMatch(mantle.replace(/const ease = \(a\) => a \* a \* \(3 - 2 \* a\);/, ''), /new [A-Z]|=> |\[[^\]]*,[^\]]*\]/, 'and none in the mantle step');
  const swing = src.slice(src.indexOf('_stepSwing(h, w) {'), src.indexOf('  _respawn() {'));
  assert.match(swing, /projectRope\(c, a, this\.webLength, v\)/); assert.match(swing, /swingForces\(v, c, a, f, r, w\.fwd, w\.str, h, cfg\)/);
  assert.match(cl, /world\.rayFirstHit/); assert.match(cl, /from '\.\/spider-wallrun\.js'/, 'the wall detection of the run is reused'); assert.doesNotMatch(cl, /from 'three/);
});

test('the camera knows the wall states: eased in and out, gentle and only while the mouse is idle; and the rigs have the climbing pose, the hand IK, the mantle and the body frame', () => {
  const cam = read('js/spider-camera.js'), anim = read('js/spider-anim.js'), clips = read('js/spider-clips.js'), inst = read('js/spider-install.js');
  for (const re of [/this\.wallK = this\.snapNext/, /CFG\.wallDistance \* this\.wallK/, /if \(this\.wallK > 0\.05 && idle\)/, /Math\.abs\(diff\) < CFG\.wallYawMax/, /this\.wallK > 0\.5 \? CFG\.wallFrameUp/]) assert.match(cam, re, String(re));
  for (const re of [/function poseCling\(/, /twoBoneIK\(shv, fv, upperLen, foreLen, pv, armIK\[s2\]\)/, /HAND = 43/, /const mu = st\.mantle \?\? -1/, /\(st\.wallRun \|\| st\.cling\)/]) assert.match(anim, re, String(re));
  for (const re of [/clinging = !!st\.cling/, /S\.wCling/, /proc\.bodyFrame/]) assert.match(clips, re, String(re));
  assert.match(inst, /createSpiderRig\(\{ root: model\.root, visual \}\)/, 'both models go through the same procedural rig (the clip rig wraps it)');
});

test('crawlVelocity, turnHead and the other pure helpers: bounded, finite, in the plane; a speed above the target is let go gently', () => {
  const s = { nx: -1, ny: 0, nz: 0, c: -20, dist: 0.5, kind: 'wall' }, D = CL.stickDirection(s, 1, 0, {});
  assert.ok(Math.abs(D.y - 1) < 1e-9 && Math.abs(D.x) < 1e-9, 'the stick into the wall is up');
  const v = { x: 3, y: 0, z: 0 }; CL.crawlVelocity(v, s, 0, 1, 0, 2.4, 24, 40, 1 / 120); assert.equal(v.x, 0, 'the part into the wall is removed at once');
  for (let i = 0; i < 100; i++) CL.crawlVelocity(v, s, 0, 0.7, 0.7, 2.4, 24, 40, 1 / 120); assert.ok(Math.hypot(v.x, v.y, v.z) <= 2.4 + 1e-9);
  for (let i = 0; i < 100; i++) CL.crawlVelocity(v, s, 0, 0, 0, 2.4, 24, 40, 1 / 120); assert.equal(Math.hypot(v.x, v.y, v.z), 0, 'braked to a stop');
  const fast = { x: 0, y: 11, z: 0 }; CL.crawlVelocity(fast, s, 0, 0, 0, 2.4, 24, 40, 1 / 60, 14); assert.ok(Math.abs(fast.y - (11 - 14 / 60)) < 1e-9, 'a run slowing into a crawl loses only the coast rate: 14 m/s^2');
  const head = { x: 0, y: 1, z: 0 }; const a = CL.turnHead(head, s, 0, 0, 1, 0.2); assert.ok(Math.abs(Math.abs(a) - 0.2) < 1e-9 && Math.abs(Math.hypot(head.x, head.y, head.z) - 1) < 1e-9);
  const g = { x: 1, y: 0, z: 0 }; CL.projectHead(g, s, 0, 1, 0); assert.ok(Math.abs(g.y - 1) < 1e-9, 'a head with no part in the plane falls back');
  const jump = P.clingJumpVelocity({ x: 0, y: 2, z: 1 }, -1, 0, 0, CFG); assert.ok(jump.x < -5 && jump.y > 8 && Math.abs(jump.z - CFG.clingJumpKeep) < 1e-9);
  const down = P.clingJumpVelocity({ x: 0, y: 0, z: 0 }, 0, -1, 0, CFG); assert.ok(down.y < 0, 'off a ceiling: down');
});
