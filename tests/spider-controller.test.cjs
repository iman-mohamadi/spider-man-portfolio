const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');

const read = (p) => readFileSync(join(__dirname, '..', p), 'utf8');
const physics = loadModule(read('js/spider-physics.js'));
const C = loadModule(read('js/spider-controller.js'), { imports: { './spider-physics.js': physics } });

// A flat world with a Spider-Man controller on it. `target` is what the (stub) targeting system currently offers.
function setup({ target = null, y = 0 } = {}) {
  const pos = { x: 0, y, z: 0, set(x, yy, z) { this.x = x; this.y = yy; this.z = z; } };
  const entity = { position: pos, heading: 0, speed: 0, verticalVel: 0, mesh: { position: { set() {} }, rotation: { y: 0 } } };
  const keys = { forward: false, backward: false, left: false, right: false, up: false, down: false };
  const input = { shift: false, webHeld: false, _press: false, consumeWebPress() { const v = this._press; this._press = false; return v; } };
  const flashes = [];
  const state = { target };
  const ctrl = new C.SpiderController({
    controllers: { keys, resolveHorizontalCollision() {} },
    world: { floorAt: () => 0 },
    entity, input, getViewYaw: () => 0, rig: null
  });
  ctrl.targeting = { current: () => state.target, flash: (k) => flashes.push(k) };
  ctrl.state = y > 0 ? 'air' : 'ground';
  const frame = (n = 1, dt = 1 / 60) => { for (let i = 0; i < n; i++) ctrl.update(dt); };
  const press = () => { input.webHeld = true; input._press = true; };
  const release = () => { input.webHeld = false; };
  return { ctrl, input, keys, state, flashes, frame, press, release, pos };
}
const TARGET = { x: 0, y: 45, z: 42 };
const speed = (c) => Math.hypot(c.vel.x, c.vel.y, c.vel.z);

test('left click with a target: from the ground it launches into a swing; no Shift is involved', () => {
  const t = setup({ target: TARGET });
  t.frame(10);
  assert.equal(t.ctrl.state, 'ground');
  t.press(); t.frame(5);
  assert.equal(t.ctrl.state, 'swing');
  assert.deepEqual({ ...t.ctrl.anchor }, TARGET);
  assert.equal(t.ctrl.stats.launches, 1);
  assert.equal(t.input.shift, false);
  assert.ok(t.flashes.includes('hit'));
});

test('holding Shift without clicking never shoots a web', () => {
  const t = setup({ target: TARGET, y: 20 });
  t.input.shift = true;
  t.frame(120);
  assert.notEqual(t.ctrl.state, 'swing');
});

test('the web stays up while the button is held and releasing it lets go with the momentum kept', () => {
  const t = setup({ target: TARGET, y: 14 });
  t.press(); t.frame(90);
  assert.equal(t.ctrl.state, 'swing');
  const before = speed(t.ctrl);
  assert.ok(before > 3, `built up some speed: ${before}`);
  t.release(); t.frame(2);
  assert.equal(t.ctrl.state, 'air');
  assert.equal(t.ctrl.anchor, null);
  assert.ok(speed(t.ctrl) > before * 0.95, 'momentum preserved (plus the small release boost)');
});

test('a twitchy tap does not destroy the swing at once (minimum hold), but it ends soon after', () => {
  const t = setup({ target: TARGET, y: 14 });
  t.press(); t.frame(2);
  assert.equal(t.ctrl.state, 'swing');
  t.release(); t.frame(2, 1 / 120);
  assert.equal(t.ctrl.state, 'swing', 'still up inside the minimum hold');
  t.frame(30);
  assert.equal(t.ctrl.state, 'air');
});

test('a press and release inside one frame still shoots the web (tap grace)', () => {
  const t = setup({ target: TARGET, y: 14 });
  t.input._press = true; t.input.webHeld = false; // down and up before the controller looked
  t.frame(2);
  assert.equal(t.ctrl.state, 'swing');
});

test('pressing with no target does nothing but flash a miss; a target found within the buffer still attaches, a late one does not', () => {
  const t = setup({ target: null, y: 14 });
  t.press(); t.frame(2);
  assert.equal(t.ctrl.state, 'air');
  assert.ok(t.ctrl.noAnchorFlash > 0); assert.ok(t.flashes.includes('miss'));
  t.state.target = TARGET; t.frame(3); // 0.05 s later, still held
  assert.equal(t.ctrl.state, 'swing');
  const late = setup({ target: null, y: 14 });
  late.press(); late.frame(30); // 0.5 s: the buffer (0.22 s) has expired
  late.state.target = TARGET; late.frame(5);
  assert.notEqual(late.ctrl.state, 'swing');
});

test('a held button never re-attaches by itself: after the web ends a new press is needed', () => {
  const t = setup({ target: TARGET, y: 14 });
  t.press(); t.frame(60);
  t.ctrl._endSwing(true); // e.g. the rope's far side
  t.frame(120); // button still held
  assert.notEqual(t.ctrl.state, 'swing');
  t.release(); t.frame(2); t.press(); t.frame(10);
  assert.equal(t.ctrl.state, 'swing');
});

test('Space on the rope releases with a hop; a second click while on the rope is not a new web', () => {
  const t = setup({ target: TARGET, y: 14 });
  t.press(); t.frame(40);
  assert.equal(t.ctrl.state, 'swing');
  t.input._press = true; t.frame(2); // click again: ignored, stays on the same web
  assert.equal(t.ctrl.stats.swings, 1);
  const vy = t.ctrl.vel.y;
  t.keys.up = true; t.frame(2);
  assert.equal(t.ctrl.state, 'air');
  assert.ok(t.ctrl.vel.y > vy + 2, 'a hop on top of the momentum');
});

test('while paused (portfolio panel) a click does nothing', () => {
  const t = setup({ target: TARGET, y: 14 });
  t.ctrl.paused = true;
  t.press(); t.frame(10);
  assert.notEqual(t.ctrl.state, 'swing');
});

test('steering on the rope: D turns the swing towards the camera right, speed stays bounded, the rope length holds, nothing goes NaN', () => {
  const t = setup({ target: TARGET, y: 14 });
  t.press(); t.frame(60); // swinging now
  assert.equal(t.ctrl.state, 'swing');
  const len = t.ctrl.webLength;
  let maxSpeed = 0, nan = false, maxDist = 0, prev = speed(t.ctrl), maxJump = 0;
  t.keys.right = true;
  const x0 = t.ctrl.pos.x;
  for (let i = 0; i < 120; i++) {
    t.frame(1);
    if (t.ctrl.state !== 'swing') break;
    const sp = speed(t.ctrl);
    if (!Number.isFinite(sp + t.ctrl.pos.x + t.ctrl.pos.y)) nan = true;
    maxSpeed = Math.max(maxSpeed, sp); maxJump = Math.max(maxJump, Math.abs(sp - prev)); prev = sp;
    const a = t.ctrl.anchor;
    maxDist = Math.max(maxDist, Math.hypot(t.ctrl.pos.x - a.x, t.ctrl.pos.y + 1.3 - a.y, t.ctrl.pos.z - a.z) - t.ctrl.webLength);
  }
  assert.equal(nan, false);
  assert.ok(maxSpeed <= physics.SPIDER.swingMax + 1e-6, `speed capped: ${maxSpeed}`);
  assert.ok(maxJump < 2.5, `no velocity spike per frame: ${maxJump}`);
  assert.ok(maxDist < 0.2, `rope constraint holds: ${maxDist}`);
  assert.ok(t.ctrl.pos.x < x0 - 1, `steered to the right (camera right is -x here): ${t.ctrl.pos.x - x0}`);
  assert.ok(len > 0);
});

test('W pumps the swing: holding forward ends with more speed than letting it hang', () => {
  const run = (fwd) => {
    const t = setup({ target: TARGET, y: 14 });
    t.press(); t.keys.forward = fwd;
    let best = 0;
    for (let i = 0; i < 150; i++) { t.frame(1); if (t.ctrl.state !== 'swing') break; best = Math.max(best, speed(t.ctrl)); }
    return best;
  };
  assert.ok(run(true) > run(false), 'pumping adds speed');
});

test('render position is the simulation extrapolated by the leftover time (smooth between 120 Hz steps)', () => {
  const t = setup({ y: 30 });
  t.ctrl.vel.z = 10; t.ctrl.vel.y = 0;
  t.frame(1, 1 / 90); // 1.33 steps: one step taken, 0.33 left over
  const lead = t.ctrl.renderPos.z - t.ctrl.pos.z;
  assert.ok(lead > 0 && lead < 10 / 120, `lead ${lead}`);
});

test('the reel-in eases in: the rope barely shortens in the first moments and then pulls at full speed', () => {
  const t = setup({ target: TARGET, y: 14 });
  t.press(); t.frame(2);
  assert.equal(t.ctrl.state, 'swing');
  const start = t.ctrl.webLength;
  t.frame(6); // 0.1 s
  const early = start - t.ctrl.webLength;
  t.frame(24); // up to ~0.5 s: past the 0.3 s ramp
  const l1 = t.ctrl.webLength; t.frame(6);
  const late = l1 - t.ctrl.webLength;
  assert.ok(early < late * 0.6, `early ${early.toFixed(2)} m vs a later 0.1 s ${late.toFixed(2)} m`);
  assert.ok(late <= physics.SPIDER.reelSpeed * 0.1 + 0.05, 'never faster than reelSpeed');
});

test('a swing that runs into a wall at speed lets go instead of staying pinned to it', () => {
  const t = setup({ target: TARGET, y: 14 });
  t.press(); t.frame(40);
  assert.equal(t.ctrl.state, 'swing');
  // a wall: pushes the body back 0.1 m and the hit removes most of its speed
  t.ctrl.ctrl.resolveHorizontalCollision = (p) => { p.z -= 0.1; };
  t.ctrl.vel.z = 20; t.ctrl.vel.x = 0;
  t.frame(3);
  assert.equal(t.ctrl.state, 'air', 'released');
});
