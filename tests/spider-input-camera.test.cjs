const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');

const read = (p) => readFileSync(join(__dirname, '..', p), 'utf8');
const physics = loadModule(read('js/spider-physics.js'));

// ------------------------------------------------------------------ input: pointer lock, left button, look
function inputHarness({ lockSupported = true, active = true } = {}) {
  const listeners = { window: {}, document: {}, canvas: {} };
  const reg = (bucket) => ({ addEventListener(type, fn) { (listeners[bucket][type] ||= []).push(fn); } });
  const state = { lockedEl: null, lockRequests: 0, active };
  const canvas = { ...reg('canvas'), requestPointerLock() { state.lockRequests++; if (lockSupported) { state.lockedEl = canvas; fire('document', 'pointerlockchange', {}); } } };
  if (!lockSupported) delete canvas.requestPointerLock;
  const document = { ...reg('document'), hidden: false, get pointerLockElement() { return state.lockedEl; }, exitPointerLock() { state.lockedEl = null; fire('document', 'pointerlockchange', {}); } };
  const window = { ...reg('window') };
  const fire = (bucket, type, ev) => (listeners[bucket][type] || []).forEach((fn) => fn({ preventDefault() {}, ...ev }));
  const { SpiderInput } = loadModule(read('js/spider-input.js'), {
    globals: { window, document, performance: { now: () => 5000 } },
    imports: { './city-config.js': { isTypingInField: () => false } }
  });
  const input = new SpiderInput({ canvas, isActive: () => state.active });
  return { input, state, fire, canvas, document };
}

test('the first click captures the mouse (not a web); after that a click is a web press that lasts while held', () => {
  const h = inputHarness();
  h.fire('canvas', 'pointerdown', { button: 0 });
  assert.equal(h.state.lockRequests, 1);
  assert.equal(h.input.consumeWebPress(), false, 'capturing the mouse is not a web shot');
  assert.equal(h.input.webHeld, false);
  h.fire('canvas', 'pointerdown', { button: 0 });
  assert.equal(h.input.webHeld, true);
  assert.equal(h.input.consumeWebPress(), true);
  assert.equal(h.input.consumeWebPress(), false, 'a press is reported once');
  h.fire('window', 'pointerup', { button: 0 });
  assert.equal(h.input.webHeld, false);
});

test('only the left button shoots; other buttons and clicks while Spider-Man does not own the mouse are ignored', () => {
  const h = inputHarness();
  h.fire('canvas', 'pointerdown', { button: 0 }); // lock
  h.fire('canvas', 'pointerdown', { button: 2 });
  h.fire('canvas', 'pointerdown', { button: 1 });
  assert.equal(h.input.webHeld, false);
  h.state.active = false; // another mode / camera preset: the original drag controls keep the mouse
  h.fire('canvas', 'pointerdown', { button: 0 });
  assert.equal(h.input.webHeld, false);
  assert.equal(h.input.consumeWebPress(), false);
});

test('losing pointer lock (Esc) lets go of a held web button; the portfolio panel pauses all mouse input', () => {
  const h = inputHarness();
  h.fire('canvas', 'pointerdown', { button: 0 });
  h.fire('canvas', 'pointerdown', { button: 0 });
  assert.equal(h.input.webHeld, true);
  h.document.exitPointerLock();
  assert.equal(h.input.webHeld, false);
  h.input.paused = true;
  h.fire('canvas', 'pointerdown', { button: 0 });
  assert.equal(h.input.consumeWebPress(), false);
});

test('without pointer lock support a click shoots straight away and a right-button drag looks', () => {
  const h = inputHarness({ lockSupported: false });
  assert.equal(h.input.lockFailed, true);
  h.fire('canvas', 'pointerdown', { button: 0 });
  assert.equal(h.input.consumeWebPress(), true);
  h.fire('document', 'mousemove', { movementX: 40, movementY: 0, buttons: 0 });
  assert.equal(h.input.consumeLook().yaw, -0 + 0, 'no look without the right button');
  h.fire('document', 'mousemove', { movementX: 40, movementY: 10, buttons: 2 });
  const look = h.input.consumeLook();
  assert.ok(look.yaw < 0 && look.pitch > 0);
});

test('mouse look: right turns right (yaw decreases), down looks down (pitch grows); deltas accumulate and are consumed once', () => {
  const h = inputHarness();
  h.fire('canvas', 'pointerdown', { button: 0 }); // locked
  h.fire('document', 'mousemove', { movementX: 100, movementY: 50 });
  h.fire('document', 'mousemove', { movementX: 100, movementY: -20 });
  const look = h.input.consumeLook();
  assert.ok(look.yaw < -0.4 && look.yaw > -0.5, `yaw ${look.yaw}`);
  assert.ok(look.pitch > 0 && look.pitch < 0.1);
  const again = h.input.consumeLook();
  assert.equal(again.yaw, 0); assert.equal(again.pitch, 0);
});

test('a pointer-lock error falls back to unlocked clicks instead of leaving the web unusable', () => {
  const h = inputHarness();
  h.fire('document', 'pointerlockerror', {});
  assert.equal(h.input.lockFailed, true);
  h.fire('canvas', 'pointerdown', { button: 0 });
  assert.equal(h.input.consumeWebPress(), true);
});

// ------------------------------------------------------------------ camera
class V3 {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
  copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
}
const { SpiderCamera, SPIDER_CAMERA: CFG } = loadModule(read('js/spider-camera.js'), { imports: { './spider-physics.js': physics } });

function cameraHarness({ wall = null } = {}) {
  const cam = { position: new V3(), fov: 56, lookAtArg: null, lookAt(v) { this.lookAtArg = new V3().copy(v); }, updateProjectionMatrix() {}, updateMatrixWorld() {} };
  const cs = {
    camera: cam, activePresetId: 'chase', orbitYawOffset: 0, orbitPitchOffset: 0.09, zoomMultiplier: 1, isDragging: false,
    currentPos: new V3(), currentLookAt: new V3(), initialized: false, getActivePreset: () => ({ fov: 56 })
  };
  const entity = { heading: 0, speed: 0, position: new V3(0, 0, 0) };
  const controller = { vel: { x: 0, y: 0, z: 0 }, swinging: false, renderPos: { x: 0, y: 0, z: 0 } };
  const world = { rayFirstHit: (...a) => (wall ? wall(...a) : null), floorAt: () => 0 };
  const input = { lastLookTime: -1e9, _look: { yaw: 0, pitch: 0 }, consumeLook(o) { o.yaw = this._look.yaw; o.pitch = this._look.pitch; this._look.yaw = this._look.pitch = 0; return o; }, releaseLock() { this.released = true; } };
  const camera = new SpiderCamera({ cameraSystem: cs, controllers: { activeMode: 'spider' }, entity, controller, world, input, THREE: { Vector3: V3 } });
  const run = (n, dt = 1 / 60) => { for (let i = 0; i < n; i++) camera.update(dt); };
  return { camera, cs, cam, controller, input, entity, run, world };
}

test('the camera sits behind the character, looks along its view direction and the crosshair ray matches the view', () => {
  const h = cameraHarness();
  h.run(30);
  const v = h.camera.view;
  assert.ok(h.cam.position.z < -3, 'behind (the character faces +z)');
  assert.ok(Math.abs(Math.hypot(v.fx, v.fy, v.fz) - 1) < 1e-9);
  assert.ok(Math.abs(v.px - h.cam.position.x) < 1e-9);
  assert.ok(h.cs.initialized && h.cs.currentPos.z === h.cam.position.z);
});

test('mouse look turns the camera and clamps pitch; the camera never fights the player by recentring while the mouse is in use', () => {
  const h = cameraHarness();
  h.run(10);
  h.input._look.yaw = -0.5; h.camera.update(1 / 60);
  assert.ok(Math.abs(h.camera.yaw - -0.5) < 1e-9);
  h.input._look.pitch = 5; h.camera.update(1 / 60);
  assert.equal(h.camera.pitch, CFG.pitchMax);
  h.input._look.pitch = -9; h.camera.update(1 / 60);
  assert.equal(h.camera.pitch, CFG.pitchMin);
  // running straight ahead (+z) while the camera looks sideways: no drift while the mouse was used a moment ago
  h.camera.yaw = -1.0; h.controller.vel.z = 10;
  h.camera._sinceLook = 0.2; // the mouse was used 0.2 s ago
  const yaw0 = h.camera.yaw;
  h.run(30); // 0.5 s: still inside the idle delay
  assert.equal(h.camera.yaw, yaw0, 'untouched during and shortly after mouse use');
});

test('the camera never rotates by itself on the ground or in the air, whatever the player is doing with the keys', () => {
  const h = cameraHarness();
  h.run(5);
  h.camera.yaw = -0.8; h.controller.vel.z = 14; h.controller.vel.x = 0; h.camera._sinceLook = 1e9;
  h.run(300);
  assert.equal(h.camera.yaw, -0.8, 'running forward while looking sideways: the view stays where the player put it');
  h.controller.grounded = false; h.controller.vel.y = -30; h.run(120);
  assert.equal(h.camera.yaw, -0.8, 'same in a fall');
  assert.equal(h.camera.pitch, h.camera.pitch); // pitch is only ever changed by the mouse
});

test('while swinging the camera only nudges towards travel when it is already within ~30 degrees of the view, and never against a recent mouse move', () => {
  const run = (yaw, busy) => {
    const h = cameraHarness();
    h.run(5);
    h.controller.swinging = true; h.controller.grounded = false; h.controller.vel.z = 20; h.controller.vel.x = 0;
    h.camera.yaw = yaw; h.camera._sinceLook = busy ? 0 : 1e9;
    for (let i = 0; i < 120; i++) { if (busy) h.input._look.pitch = 1e-9; h.camera.update(1 / 60); }
    return h.camera.yaw;
  };
  assert.ok(Math.abs(run(-0.4, false)) < 0.15, 'a swing that is nearly where you look is gently centred');
  assert.equal(run(-1.2, false), -1.2, 'a swing you are looking away from is left alone');
  assert.ok(Math.abs(run(-0.4, true) - -0.4) < 1e-6, 'no drift while the mouse is in use');
});

test('walls pull the camera in at once and let it out slowly; the camera stays above the ground', () => {
  let blocked = true;
  const h = cameraHarness({ wall: (ox, oy, oz, dx, dy, dz, max) => (blocked ? { t: 2.2 } : null) });
  h.run(30);
  const close = Math.hypot(h.cam.position.x - h.camera.pivot.x, h.cam.position.z - h.camera.pivot.z);
  assert.ok(close < 3.2, `pulled in: ${close}`);
  blocked = false;
  h.run(3);
  const after = Math.hypot(h.cam.position.x - h.camera.pivot.x, h.cam.position.z - h.camera.pivot.z);
  assert.ok(after - close < 1.5, 'only a little recovery in 3 frames');
  h.run(240);
  assert.ok(Math.hypot(h.cam.position.x - h.camera.pivot.x, h.cam.position.z - h.camera.pivot.z) > 4, 'fully recovered');
  h.camera.pitch = CFG.pitchMin; h.run(60);
  assert.ok(h.cam.position.y >= CFG.groundPad - 1e-9);
});

test('FOV and distance grow smoothly with speed and stay bounded', () => {
  const h = cameraHarness();
  h.run(20);
  const fov0 = h.cam.fov, dist0 = h.camera.dist;
  h.controller.vel.z = 80; h.controller.vel.y = -30;
  let maxStep = 0, last = h.cam.fov;
  for (let i = 0; i < 300; i++) { h.camera.update(1 / 60); maxStep = Math.max(maxStep, Math.abs(h.cam.fov - last)); last = h.cam.fov; }
  assert.ok(h.cam.fov > fov0 + 5 && h.cam.fov <= CFG.baseFov + CFG.fovBoost + 1e-6, `fov ${h.cam.fov}`);
  assert.ok(h.camera.dist > dist0 && h.camera.dist < 12);
  assert.ok(maxStep < 0.6, `no FOV jump between frames: ${maxStep}`);
});

test('camera motion is frame-rate independent: 30 fps and 120 fps end in nearly the same place', () => {
  const end = (fps) => {
    const h = cameraHarness();
    h.run(10, 1 / 60);
    h.controller.vel.z = 15; h.controller.renderPos.z = 0;
    for (let i = 0; i < fps * 3; i++) { h.controller.renderPos.z += 15 / fps; h.camera.update(1 / fps); }
    return [h.cam.position.z, h.cam.fov];
  };
  const a = end(30), b = end(120);
  assert.ok(Math.abs(a[0] - b[0]) < 0.35, `position ${a[0]} vs ${b[0]}`);
  assert.ok(Math.abs(a[1] - b[1]) < 0.3, `fov ${a[1]} vs ${b[1]}`);
});

test('the camera only owns the view while Spider-Man and the chase preset are active, and restores the preset FOV and frees the mouse on exit', () => {
  const h = cameraHarness();
  h.run(10);
  assert.ok(h.camera.active);
  h.cs.activePresetId = 'cockpit';
  h.camera.update(1 / 60);
  assert.equal(h.camera.active, false);
  assert.equal(h.cam.fov, 56);
  assert.equal(h.input.released, true);
  const pos = h.cam.position.z;
  h.run(10);
  assert.equal(h.cam.position.z, pos, 'hands-off while inactive');
});
