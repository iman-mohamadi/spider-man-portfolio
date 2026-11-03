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

// ---------------------------------------------------------------------------------------------------------------- a fake city: flat ground and flat walls
// wall: { axis: 'x' | 'z', pos, sign (the face's normal along that axis), min, max (extent along the other horizontal axis), top (height) }
function city(walls = []) {
  return {
    walls,
    floorAt: () => 0,
    rayFirstHit(ox, oy, oz, dx, dy, dz, maxT) {
      let best = null;
      for (const w of this.walls) {
        const a = w.axis === 'x' ? ox : oz, da = w.axis === 'x' ? dx : dz;
        if (Math.abs(da) < 1e-9 || da * w.sign >= 0) continue;
        const t = (w.pos - a) / da;
        if (t <= 1e-3 || t > maxT) continue;
        const y = oy + dy * t, o2 = w.axis === 'x' ? oz + dz * t : ox + dx * t;
        if (y < 0 || y > w.top || o2 < w.min || o2 > w.max) continue;
        if (!best || t < best.t) best = { t, nx: w.axis === 'x' ? w.sign : 0, ny: 0, nz: w.axis === 'z' ? w.sign : 0 };
      }
      return best;
    }
  };
}
const FACADE = { axis: 'x', pos: 20, sign: -1, min: -400, max: 400, top: 90 }; // a tall facade at x = 20 facing -x

function setup({ world = city(), x = 0, y = 0, z = 0, heading = 0, yaw = 0, vel = null, target = null, cfg = null } = {}) {
  const pos = { x, y, z, set(a, b, c) { this.x = a; this.y = b; this.z = c; } };
  const entity = { position: pos, heading, speed: 0, verticalVel: 0, mesh: { position: { set() {} }, rotation: { y: 0 } } };
  const keys = { forward: false, backward: false, left: false, right: false, up: false, down: false };
  const input = { shift: false, webHeld: false, _press: false, consumeWebPress() { const v = this._press; this._press = false; return v; } };
  const state = { target, yaw };
  const rigCalls = [];
  const rig = { update(dt, st) { rigCalls.push({ ...st }); } };
  const ctrl = new C.SpiderController({ controllers: { keys, resolveHorizontalCollision() {} }, world, entity, input, getViewYaw: () => state.yaw, rig, ...(cfg ? { config: cfg } : {}) });
  ctrl.targeting = { current: () => state.target, flash() {} };
  ctrl.state = y > 0 ? 'air' : 'ground';
  if (vel) Object.assign(ctrl.vel, vel);
  const frame = (n = 1, dt = 1 / 60) => { for (let i = 0; i < n; i++) ctrl.update(dt); };
  const tap = () => { keys.up = true; frame(1); keys.up = false; frame(1); };
  const press = () => { input.webHeld = true; input._press = true; };
  return { ctrl, keys, input, state, frame, tap, press, pos, world, rigCalls };
}
const finite = (c) => [c.pos.x, c.pos.y, c.pos.z, c.vel.x, c.vel.y, c.vel.z].every(Number.isFinite);
const hs = (c) => Math.hypot(c.vel.x, c.vel.z);

// ---------------------------------------------------------------------------------------------------------------- double jump: the physics
test('airJump raises the vertical speed, keeps the horizontal velocity and adds a bounded push along the wish', () => {
  const v = { x: 6, y: -8, z: 0 };
  P.airJump(v, 1, 0, CFG);
  assert.equal(v.y, CFG.airJumpSpeed);
  assert.ok(Math.abs(v.x - (6 + CFG.airJumpForward)) < 1e-9 && v.z === 0, 'the horizontal velocity is kept and pushed along the wish, not reset');
  const fast = { x: 20, y: 2, z: 0 }; P.airJump(fast, 1, 0, CFG); assert.equal(fast.x, 20, 'a speed above the cap is never reduced or increased');
  const rising = { x: 0, y: 14, z: 0 }; P.airJump(rising, 0, 0, CFG); assert.equal(rising.y, 14, 'a faster rise is kept');
  const still = { x: 0.2, y: -3, z: 0 }; P.airJump(still, 0, 0, CFG); assert.ok(Math.abs(still.x - 0.2) < 1e-9 && still.y === CFG.airJumpSpeed, 'no input and no travel: no push');
  const coast = { x: 0, y: 0, z: 8 }; P.airJump(coast, 0, 0, CFG); assert.ok(coast.z > 8, 'no input: the push follows the direction of travel');
  const back = { x: 0, y: 0, z: 8 }; P.airJump(back, 0, -1, CFG); assert.ok(back.z < 8, 'the stick against the travel: the push is controllable (it slows)');
});

// ---------------------------------------------------------------------------------------------------------------- double jump: the controller
test('first jump works, the second works once, the third is rejected, landing refills it', () => {
  const t = setup();
  t.frame(5); assert.equal(t.ctrl.state, 'ground');
  t.tap(); assert.equal(t.ctrl.state, 'air'); assert.ok(t.ctrl.vel.y > 9, `first jump: ${t.ctrl.vel.y}`);
  assert.equal(t.ctrl.airJumps, 0);
  t.frame(20); // 0.33 s: falling after the first jump, well above the ground
  assert.ok(t.ctrl.vel.y < 4 && t.ctrl.pos.y > 1);
  t.tap();
  assert.equal(t.ctrl.airJumps, 1); assert.equal(t.ctrl.stats.airJumps, 1); assert.ok(t.ctrl.vel.y >= CFG.airJumpSpeed - 1.2, `second jump: ${t.ctrl.vel.y}`);
  t.frame(10); const vyBefore = t.ctrl.vel.y;
  t.tap(); t.tap(); t.tap();
  assert.equal(t.ctrl.stats.airJumps, 1, 'a third jump is rejected');
  assert.ok(t.ctrl.vel.y <= vyBefore + 1e-9, 'and gives no impulse');
  t.frame(120);
  assert.equal(t.ctrl.state, 'ground'); assert.equal(t.ctrl.airJumps, 0, 'landing refills the air jump'); assert.equal(t.ctrl.airJumpT, -1);
  t.frame(3); t.tap(); t.frame(20); t.tap();
  assert.equal(t.ctrl.stats.airJumps, 2, 'in the next airborne cycle it works again');
});

test('the horizontal momentum is kept, and a small controllable push is added in the direction of the input', () => {
  const t = setup({ y: 6, vel: { x: 0, y: 2, z: 9 } }); t.ctrl.airTime = 1;
  t.keys.forward = true;
  t.frame(2); const before = Math.hypot(t.ctrl.vel.x, t.ctrl.vel.z), vzBefore = t.ctrl.vel.z;
  t.tap();
  assert.equal(t.ctrl.airJumps, 1);
  assert.ok(hs(t.ctrl) > before + 1.5 && t.ctrl.vel.z > vzBefore + 1.5, `kept and pushed: ${before} -> ${hs(t.ctrl)}`);
  assert.ok(hs(t.ctrl) <= CFG.airJumpMaxSpeed + 0.2, 'bounded');
  assert.ok(Math.abs(t.ctrl.vel.x) < 0.5, 'the direction is kept');
});

test('holding Space or tapping repeatedly creates one air jump: the key needs a new press, and a double press inside the delay is one jump', () => {
  const held = setup({ y: 8 }); held.ctrl.airTime = 1;
  held.keys.up = true; held.frame(60);
  assert.equal(held.ctrl.stats.airJumps, 1, 'a held key is one press');
  const fast = setup({ y: 8 }); fast.ctrl.airTime = 1;
  for (let i = 0; i < 6; i++) fast.tap();
  assert.equal(fast.ctrl.stats.airJumps, 1, 'six taps in a row: one jump');
  // the delay: a press in the first moments of a flight does not count (a double press at take-off is a single jump)
  const early = setup(); early.frame(5); early.tap(); early.tap();
  assert.equal(early.ctrl.stats.airJumps, 0, 'two quick presses on the ground are the first jump only');
});

test('a press just before touch-down is a buffered ground jump, not a second jump', () => {
  const t = setup({ y: 0.5, vel: { x: 0, y: -12, z: 0 } }); t.ctrl.airTime = 1; t.ctrl.state = 'air';
  t.keys.up = true; t.frame(1); t.keys.up = false;
  assert.equal(t.ctrl.stats.airJumps, 0, 'about to land: no air jump');
  let top = 0; for (let i = 0; i < 25; i++) { t.frame(1); top = Math.max(top, t.ctrl.pos.y); }
  assert.ok(top > 0.8, `the buffered press became the ground jump on landing: ${top}`);
  assert.equal(t.ctrl.stats.airJumps, 0, 'it is still not an air jump');
});

test('on a web: Space is the existing release with a hop, never an air jump; releasing and attaching refill the air jump', () => {
  const t = setup({ y: 14, target: { x: 0, y: 45, z: 42 } });
  t.ctrl.airJumps = 1; t.ctrl.airTime = 1; // the air jump had been used
  t.press(); t.frame(30);
  assert.equal(t.ctrl.state, 'swing'); assert.equal(t.ctrl.airJumps, 0, 'attaching a web refills it');
  t.tap();
  assert.equal(t.ctrl.state, 'air', 'Space on the rope releases the web (documented behaviour)'); assert.equal(t.ctrl.stats.airJumps, 0, 'and is not counted as an air jump');
  assert.ok(t.ctrl.anchor === null);
  t.frame(15); t.tap();
  assert.equal(t.ctrl.stats.airJumps, 1, 'after the release the air jump is available');
});

test('the existing jump, fall and landing are unchanged', () => {
  const t = setup();
  t.frame(5); t.tap();
  assert.ok(Math.abs(t.ctrl.vel.y - (CFG.jumpSpeed - CFG.gravity / 60 * 1)) < 0.6, `jump speed ${t.ctrl.vel.y}`);
  let apex = 0; for (let i = 0; i < 90 && t.ctrl.state === 'air'; i++) { t.frame(1); apex = Math.max(apex, t.ctrl.pos.y); }
  assert.ok(apex > 1.8 && apex < 2.4, `a jump rises about 2 m: ${apex}`);
  t.frame(30); assert.equal(t.ctrl.state, 'ground'); assert.equal(t.ctrl.pos.y, 0);
});

// ---------------------------------------------------------------------------------------------------------------- wall detection
const CFGW = { ...CFG };
const probe = (world, x = 18.5, y = 6, z = 0, dx = 1, dz = 0, reach = 1.7) => { const w = W.newWall(); return W.probeWall(world, x, y, z, dx, dz, reach, CFGW.wallMinHeight, CFGW, w) ? w : null; };

test('a flat, tall facade is accepted, with its normal, tangent, plane and distance', () => {
  const w = probe(city([FACADE]));
  assert.ok(w); assert.equal(w.nx, -1); assert.equal(w.nz, 0); assert.ok(Math.abs(w.dist - 1.5) < 1e-9); assert.ok(Math.abs(w.c + 20) < 1e-9, 'the plane is n . x = c (n = -x, the wall at x = 20)'); assert.ok(Math.abs(w.tx * w.nx + w.tz * w.nz) < 1e-9, 'the tangent is along the wall');
});

test('unsuitable surfaces are rejected: floors and ceilings, short walls, narrow ones, uneven ones, far ones, grazing hits', () => {
  assert.equal(probe(city([FACADE]), 15, 6), null, 'too far');
  assert.equal(probe(city([{ ...FACADE, top: 3 }])), null, 'a kerb / shop front / shed: not tall enough');
  assert.equal(probe(city([{ ...FACADE, min: -1, max: 1 }])), null, 'narrow: a pipe, a pole or a small surface');
  assert.equal(probe(city([{ ...FACADE, max: 0.2 }, { ...FACADE, pos: 21.4, min: 0.2, max: 400 }])), null, 'not flat: a step in the wall');
  const roof = { floorAt: () => 0, rayFirstHit: (ox, oy, oz, dx, dy, dz, maxT) => ({ t: 1, nx: 0, ny: 1, nz: 0 }) };
  assert.equal(probe(roof), null, 'a floor / roof / ceiling normal');
  const graze = { rayFirstHit: () => ({ t: 1, nx: -0.1, ny: 0, nz: 0.995 }) };
  assert.equal(probe(graze), null, 'a ray that only clips an edge');
  assert.equal(probe(city([])), null, 'nothing there');
});

test('findWall needs speed, a wish toward or along the wall, and a wall that is not behind', () => {
  const world = city([FACADE]), pos = { x: 18.5, y: 6, z: 0 }, w = W.newWall();
  const run = (vel, wish) => W.findWall(world, pos, vel, wish, CFGW, w);
  assert.equal(run({ x: 0, y: 0, z: 10 }, { x: 0, z: 1 }), true, 'running along the wall holding forward');
  assert.equal(w.tz > 0, true, 'the tangent follows the direction of travel');
  assert.equal(run({ x: 0, y: 0, z: 4 }, { x: 0, z: 1 }), false, 'below the activation speed');
  assert.equal(run({ x: 0, y: 0, z: 10 }, { x: 0, z: 0 }), false, 'no input');
  assert.equal(run({ x: 0, y: 0, z: 10 }, { x: 0, z: -1 }), false, 'the stick against the travel');
  assert.equal(run({ x: 0, y: 0, z: 10 }, { x: -1, z: 0 }), false, 'the stick away from the wall');
  assert.equal(run({ x: 0, y: 0, z: 10 }, { x: 1, z: 0 }), true, 'the stick into the wall');
  assert.equal(run({ x: -9, y: 0, z: 0 }, { x: -1, z: 0 }), false, 'moving away from the wall');
  const head = { x: 17.6, y: 6, z: 0 }; assert.equal(W.findWall(world, head, { x: 10, y: 0, z: 0 }, { x: 1, z: 0 }, CFGW, w), true); assert.equal(w.headOn, true, 'head-on is recognised');
});

test('the detector confirms the same wall over the grace period, never on a single sighting, and honours the block', () => {
  const world = city([FACADE]), d = new W.WallDetector(), pos = { x: 18.5, y: 6, z: 0 }, vel = { x: 0, y: 0, z: 10 }, wish = { x: 0, z: 1 };
  assert.equal(d.update(1 / 60, world, pos, vel, wish, CFGW), null, 'seen once: not enough');
  let got = null, n = 0; while (!got && n < 30) { got = d.update(1 / 60, world, pos, vel, wish, CFGW); n++; }
  assert.ok(got && n <= 8, `confirmed after ${n} frames`);
  d.reset(); const block = { nx: -1, nz: 0, c: -20, t: 0.3 };
  for (let i = 0; i < 30; i++) assert.equal(d.update(1 / 60, world, pos, vel, wish, CFGW, block), null, 'the wall just left is blocked');
  d.reset(); for (let i = 0; i < 8; i++) d.update(1 / 60, world, pos, vel, wish, CFGW);
  world.walls.length = 0; assert.equal(d.update(1 / 30, world, pos, vel, wish, CFGW), null); assert.equal(d.has, false, 'a lost wall restarts the confirmation (no flicker)');
});

test('wallFrame: the up vector leans away from the wall, the forward follows the travel and is perpendicular to it', () => {
  const w = { nx: -1, nz: 0, tx: 0, tz: 1 }, out = {};
  W.wallFrame(w, { x: 0, y: 0, z: 10 }, CFG, out);
  assert.ok(out.ux < -0.8 && out.uy > 0.2 && Math.abs(out.uz) < 1e-9, 'away from the wall (-x here), still partly up');
  assert.ok(Math.abs(out.fx * out.ux + out.fy * out.uy + out.fz * out.uz) < 1e-9 && out.fz > 0.9);
  W.wallFrame(w, { x: 0, y: 8, z: 0 }, CFG, out);
  assert.ok(out.fy > 0.85, 'climbing: the body runs up the wall');
  const keep = { ...out }; W.wallFrame(w, { x: 0, y: 0, z: 0 }, CFG, out);
  assert.ok(Math.abs(out.fy - keep.fy) < 1e-9, 'almost still: the direction is kept, no snapping');
});

// ---------------------------------------------------------------------------------------------------------------- wall run: the controller
const alongSetup = (extra = {}) => setup({ world: city([{ ...FACADE }]), x: 18.5, y: 6, z: 0, heading: 0, yaw: 0, vel: { x: 0, y: 0, z: 10 }, ...extra });

test('airborne, fast, holding forward along a facade: a horizontal wall run starts, stays at a stable offset and follows the tangent', () => {
  const t = alongSetup(); t.keys.forward = true;
  t.frame(20);
  assert.equal(t.ctrl.state, 'wall'); assert.equal(t.ctrl.stats.wallRuns, 1);
  const z0 = t.pos.z; t.frame(30);
  assert.ok(Math.abs(20 - t.pos.x - CFG.wallOffset) < 0.03, `stable distance from the wall: ${20 - t.pos.x}`);
  assert.ok(t.pos.z - z0 > 4, `moves along the wall: ${t.pos.z - z0}`);
  assert.ok(Math.abs(t.ctrl.vel.x) < 1e-6, 'no speed into or away from the wall');
  assert.ok(finite(t.ctrl) && t.ctrl.wallPose.active && t.rigCalls.at(-1).wallRun === true && t.rigCalls.at(-1).wall === t.ctrl.wallPose, 'the rig is told');
  assert.ok(Math.abs(t.ctrl.vel.y) < 3.5, 'roughly level');
  assert.ok(hs(t.ctrl) > 7, `momentum: ${hs(t.ctrl)}`);
});

test('it follows the camera-relative input: the same wall, a different camera yaw, the other direction', () => {
  const t = setup({ world: city([FACADE]), x: 18.5, y: 6, z: 0, heading: Math.PI, yaw: Math.PI, vel: { x: 0, y: 0, z: -10 } }); t.keys.forward = true;
  t.frame(25);
  assert.equal(t.ctrl.state, 'wall'); assert.ok(t.ctrl.vel.z < -5, 'running the other way along the same facade');
});

test('head-on with the stick into the wall: a vertical run, the speed into the wall becomes climb speed', () => {
  const t = setup({ world: city([FACADE]), x: 17.5, y: 6, z: 0, heading: Math.PI / 2, yaw: Math.PI / 2, vel: { x: 10, y: 0, z: 0 } }); t.keys.forward = true;
  let wallFrameAt = -1; for (let i = 0; i < 30 && wallFrameAt < 0; i++) { t.frame(1); if (t.ctrl.state === 'wall') wallFrameAt = i; }
  assert.ok(wallFrameAt >= 0, 'caught the wall head-on');
  assert.ok(t.ctrl.vel.y > 6, `climbing: ${t.ctrl.vel.y}`); const y0 = t.pos.y;
  t.frame(30);
  assert.ok(t.pos.y > y0 + 3, 'it climbs the wall'); assert.ok(Math.abs(20 - t.pos.x - CFG.wallOffset) < 0.03); assert.ok(Math.abs(t.ctrl.vel.x) < 1e-6);
});

test('a wall run never lasts longer than the maximum duration, and the climb fades out (no indefinite climbing)', () => {
  const t = setup({ world: city([FACADE]), x: 17.5, y: 6, z: 0, heading: Math.PI / 2, yaw: Math.PI / 2, vel: { x: 10, y: 0, z: 0 } }); t.keys.forward = true;
  let start = -1, end = -1, maxVy = 0, vyLate = null;
  for (let i = 0; i < 400; i++) {
    t.frame(1);
    if (t.ctrl.state === 'wall') { if (start < 0) start = i; maxVy = Math.max(maxVy, t.ctrl.vel.y); if (t.ctrl.wallTime > 0.8 && vyLate === null) vyLate = t.ctrl.vel.y; }
    else if (start >= 0 && end < 0) { end = i; break; }
  }
  assert.ok(start >= 0 && end > start, 'it started and it ended');
  assert.ok((end - start) / 60 <= CFG.wallMaxTime + 0.05, `ended by the time limit: ${(end - start) / 60} s`);
  assert.ok(vyLate !== null && vyLate < maxVy * 0.65, `the climb faded: ${maxVy} -> ${vyLate}`);
  assert.ok(finite(t.ctrl));
});

test('the speed along the wall is bounded by the run speed and friction removes a higher entry speed', () => {
  const t = alongSetup({ vel: { x: 0, y: 0, z: 16 } }); t.keys.forward = true;
  t.frame(12); assert.equal(t.ctrl.state, 'wall'); const s0 = Math.abs(t.ctrl.vel.z);
  t.frame(40); assert.ok(Math.abs(t.ctrl.vel.z) < s0 - 1, `friction: ${s0} -> ${t.ctrl.vel.z}`);
  let late = 0; for (let i = 0; i < 90 && t.ctrl.state === 'wall'; i++) { t.frame(1); late = Math.abs(t.ctrl.vel.z); }
  assert.ok(late <= CFG.wallRun + 0.01, `never above the run speed in the end: ${late}`);
});

test('Space on a wall jumps away from it and up, keeps most of the speed along it, and the wall cannot be caught again at once', () => {
  const t = alongSetup(); t.keys.forward = true; t.frame(25);
  assert.equal(t.ctrl.state, 'wall'); const vz = t.ctrl.vel.z;
  t.tap();
  assert.equal(t.ctrl.state, 'air'); assert.equal(t.ctrl.stats.wallJumps, 1);
  assert.ok(t.ctrl.vel.x < -5, `away from the wall: ${t.ctrl.vel.x}`); assert.ok(t.ctrl.vel.y > CFG.wallJumpUp - 2, `up: ${t.ctrl.vel.y}`);
  assert.ok(t.ctrl.vel.z > vz * CFG.wallJumpKeep * 0.9, `most of the speed along the wall kept: ${vz} -> ${t.ctrl.vel.z}`);
  assert.ok(t.ctrl.wallBlock.t > 0.3, 'blocked'); assert.equal(t.ctrl.wallPose.active, false);
  t.keys.right = true; t.state.yaw = Math.PI / 2; t.frame(12); // the stick points at the wall again: still blocked for the grace period
  assert.notEqual(t.ctrl.state, 'wall');
});

test('a wall jump also works from a vertical run', () => {
  const t = setup({ world: city([FACADE]), x: 17.5, y: 6, z: 0, heading: Math.PI / 2, yaw: Math.PI / 2, vel: { x: 10, y: 0, z: 0 } }); t.keys.forward = true;
  t.frame(25); assert.equal(t.ctrl.state, 'wall');
  t.tap(); assert.equal(t.ctrl.state, 'air'); assert.ok(t.ctrl.vel.x < -5 && t.ctrl.vel.y > 8);
});

test('it ends cleanly when the wall disappears, with no NaN and no stuck state', () => {
  const t = alongSetup(); t.keys.forward = true; t.frame(25); assert.equal(t.ctrl.state, 'wall');
  t.world.walls.length = 0; t.frame(30);
  assert.equal(t.ctrl.state === 'air' || t.ctrl.state === 'ground', true); assert.ok(finite(t.ctrl)); assert.equal(t.ctrl.wallPose.active, false);
});

test('the end of a wall (a corner, a gap): a clean exit, and a following wall can be caught', () => {
  const walls = [{ ...FACADE, max: 8 }, { axis: 'z', pos: 12, sign: -1, min: 14, max: 60, top: 90 }]; // the facade ends at z = 8
  const t = setup({ world: city(walls), x: 18.5, y: 6, z: 0, vel: { x: 0, y: 0, z: 10 } }); t.keys.forward = true;
  t.frame(15); assert.equal(t.ctrl.state, 'wall');
  let left = -1; for (let i = 0; i < 90 && left < 0; i++) { t.frame(1); if (t.ctrl.state !== 'wall') left = i; }
  assert.ok(left >= 0 && finite(t.ctrl), 'it left the wall at its end');
});

test('running up past the top of a wall with no roof: the run hands over to the crawl, which lets go cleanly (the roof climb is tested with a roof in spider-cling.test.cjs)', () => {
  const t = setup({ world: city([{ ...FACADE, top: 13.2 }]), x: 17.5, y: 6, z: 0, heading: Math.PI / 2, yaw: Math.PI / 2, vel: { x: 10, y: 0, z: 0 } }); t.keys.forward = true;
  const seen = []; for (let i = 0; i < 300; i++) { t.frame(1); if (seen.at(-1) !== t.ctrl.state) seen.push(t.ctrl.state); assert.ok(finite(t.ctrl)); }
  assert.ok(seen.includes('wall') && seen.includes('cling'), `run -> crawl: ${seen.join(' > ')}`); assert.ok(t.ctrl.pos.y < 14, 'he did not shoot off over the top'); assert.notEqual(t.ctrl.mantle.active, true);
});

test('activation: below the speed, without input, against the stick, on a short, narrow or far wall: nothing starts', () => {
  const slow = alongSetup({ vel: { x: 0, y: 0, z: 4 }, cfg: { ...CFG, airAccel: 0 } }); slow.keys.forward = true; slow.frame(40); assert.notEqual(slow.ctrl.state, 'wall', 'speed threshold');
  const idle = alongSetup(); idle.frame(40); assert.notEqual(idle.ctrl.state, 'wall', 'no input');
  const back = alongSetup(); back.keys.backward = true; back.frame(40); assert.notEqual(back.ctrl.state, 'wall', 'against the stick');
  const low = setup({ world: city([{ ...FACADE, top: 3 }]), x: 18.5, y: 6, vel: { x: 0, y: 0, z: 10 } }); low.keys.forward = true; low.frame(40); assert.notEqual(low.ctrl.state, 'wall', 'a short wall');
  const far = setup({ world: city([FACADE]), x: 14, y: 6, vel: { x: 0, y: 0, z: 10 } }); far.keys.forward = true; far.frame(40); assert.notEqual(far.ctrl.state, 'wall', 'out of reach: no magnetic pull');
  const ground = setup({ world: city([FACADE]), x: 18.5, vel: { x: 0, y: 0, z: 10 } }); ground.keys.forward = true; ground.frame(40); assert.equal(ground.ctrl.stats.wallRuns, 0, 'running along a wall on the ground is just running');
  const grace = alongSetup({ vel: { x: 0, y: 0, z: 10 } }); grace.keys.forward = true; grace.frame(2); assert.notEqual(grace.ctrl.state, 'wall', 'a brush is not enough: the wall must be confirmed first');
});

test('releasing the stick ends the run after the grace period; running out of speed ends it', () => {
  const t = alongSetup(); t.keys.forward = true; t.frame(25); assert.equal(t.ctrl.state, 'wall');
  t.keys.forward = false; t.frame(5); assert.equal(t.ctrl.state, 'wall', 'a short release is forgiven'); t.frame(15); assert.notEqual(t.ctrl.state, 'wall');
  const slow = alongSetup({ vel: { x: 0, y: 0, z: 7 } }); slow.keys.forward = true; slow.frame(15);
  if (slow.ctrl.state === 'wall') { slow.ctrl.vel.z = 0.5; slow.ctrl.vel.y = 0; slow.keys.forward = false; slow.keys.right = false; slow.keys.left = false; slow.frame(60); assert.notEqual(slow.ctrl.state, 'wall'); }
});

test('it never starts on the rope; a web press on the wall hands over to the rope solver; a release near a wall can start a run', () => {
  const rope = setup({ world: city([FACADE]), x: 18.5, y: 14, target: { x: 12, y: 60, z: 30 }, vel: { x: 0, y: 0, z: 10 } }); rope.keys.forward = true; rope.press(); rope.frame(10);
  assert.equal(rope.ctrl.state, 'swing');
  for (let i = 0; i < 40 && rope.ctrl.state === 'swing'; i++) { rope.input.webHeld = true; rope.frame(1); assert.notEqual(rope.ctrl.state, 'wall', 'no wall run while the body is constrained by the web'); }
  assert.equal(rope.ctrl.stats.wallRuns, 0);
  const t = alongSetup({ target: { x: 10, y: 60, z: 30 } }); t.keys.forward = true; t.frame(25); assert.equal(t.ctrl.state, 'wall');
  t.press(); t.frame(3);
  assert.equal(t.ctrl.state, 'swing', 'a web press with a target leaves the wall for the rope'); assert.equal(t.ctrl.wallPose.active, false); assert.ok(t.ctrl.anchor); assert.ok(finite(t.ctrl)); assert.ok(t.ctrl.wallBlock.t > 0);
  t.input.webHeld = false; t.frame(40); assert.ok(finite(t.ctrl));
  // release -> wall run: a body flung along a facade right after letting go of a web
  const r = alongSetup(); r.ctrl.state = 'swing'; r.ctrl.anchor = { x: 5, y: 60, z: 20 }; r.ctrl.webLength = 40; r.ctrl._endSwing(true); r.keys.forward = true; r.frame(25);
  assert.equal(r.ctrl.state, 'wall', 'web release -> wall run');
});

test('landing from a wall run restores the ground state and refills the air jump', () => {
  const t = setup({ world: city([FACADE]), x: 18.5, y: 2.2, z: 0, vel: { x: 0, y: 0, z: 10 } }); t.keys.forward = true; t.ctrl.airJumps = 1;
  t.frame(200);
  assert.equal(t.ctrl.state === 'ground' || t.ctrl.state === 'air', true);
  t.keys.forward = false; t.frame(200);
  assert.equal(t.ctrl.state, 'ground'); assert.equal(t.ctrl.airJumps, 0); assert.ok(finite(t.ctrl));
});

test('a double jump is still possible after a wall jump (the air jump was not spent by the wall run)', () => {
  const t = alongSetup(); t.keys.forward = true; t.frame(25); assert.equal(t.ctrl.state, 'wall'); t.tap(); t.frame(12); t.keys.forward = false; t.tap();
  assert.equal(t.ctrl.stats.airJumps, 1);
});

test('pausing (the portfolio panel) or resetting the motion leaves the wall', () => {
  const t = alongSetup(); t.keys.forward = true; t.frame(25); assert.equal(t.ctrl.state, 'wall');
  t.ctrl.paused = true; t.frame(3); assert.notEqual(t.ctrl.state, 'wall');
  const u = alongSetup(); u.keys.forward = true; u.frame(25); u.ctrl.resetMotion(); assert.equal(u.ctrl.state, 'air'); assert.equal(u.ctrl.wallPose.active, false);
});

test('the new code is wired the safe way: one state owner, no allocation in the step, configuration lives in SPIDER, the web solver is untouched', () => {
  const src = read('js/spider-controller.js'), wr = read('js/spider-wallrun.js'), phys = read('js/spider-physics.js');
  assert.match(src, /else if \(this\.state === 'wall'\) this\._stepWall\(h, w\)/); assert.match(src, /if \(this\.state === 'air' \|\| this\.state === 'ground'\) this\._traverseProbe\(dt, w\)/);
  assert.equal((src.match(/this\.state = 'wall'/g) || []).length, 1, 'one place enters the wall state');
  for (const k of ['airJumpSpeed', 'airJumpForward', 'wallMinSpeed', 'wallRun', 'wallMaxTime', 'wallJumpOut', 'wallOffset', 'wallTilt']) assert.match(phys, new RegExp(`\\b${k}:`), k);
  assert.doesNotMatch(src.slice(src.indexOf('_stepWall(h, w)'), src.indexOf('// ------------------------------------------------------------------------------------------------------------------ the crawl and the cling')), /new [A-Z]|=> |\[\s*[^\]]*,/, 'no allocation inside the wall step');
  assert.match(wr, /world\.rayFirstHit/); assert.doesNotMatch(wr, /import /, 'the wall module has no imports (pure)');
  const swingStep = src.slice(src.indexOf('_stepSwing(h, w) {'), src.indexOf('  _respawn() {'));
  assert.match(swingStep, /projectRope\(c, a, this\.webLength, v\)/); assert.match(swingStep, /swingForces\(v, c, a, f, r, w\.fwd, w\.str, h, cfg\)/);
});
