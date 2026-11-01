const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');

const read = (p) => readFileSync(join(__dirname, '..', p), 'utf8');

// The Spider-Man prototype registers a fifth entity with the existing ThirdPersonControllerManager. These tests pin the places where
// that used to break the original modes (found in the M0 review) and the isolation of the whole feature.

function controllerHarness(activeType, extraTypes = []) {
  const et = { addEventListener() {} };
  const { ThirdPersonControllerManager } = loadModule(read('js/controllers.js'), {
    globals: { window: et, document: { ...et, hidden: false } },
    imports: {
      'three/webgpu': {},
      './city-config.js': {
        streetZ: () => 0, isTypingInField: () => false,
        ISLAND_BOUNDS: { minX: -500, maxX: 500, minZ: -500, maxZ: 500, sidewalkHeight: 0.22 },
        CENTRAL_PARK_BOUNDS: { minX: 1000, maxX: 1100, minZ: 1000, maxZ: 1100 },
        getIslandBoundsAtZ: () => ({ westX: -500, eastX: 500 }), blockAt: () => null
      },
      './tsl-materials.js': {}, './cars.js': {}, './helicopter.js': {}, './pedestrians.js': {}, './vehicle-lights.js': {}, './landmarks.js': {},
      './building-collision.js': loadModule(read('js/building-collision.js'))
    }
  });
  const c = Object.create(ThirdPersonControllerManager.prototype);
  const v = (x = 0, y = 0, z = 0) => ({ x, y, z, copy(p) { this.x = p.x; this.y = p.y; this.z = p.z; } });
  const entity = (type, x = 0, z = 0) => ({ type, chaseDistance: 4.3, chaseHeight: 1.95, position: v(x, 0, z), heading: 0, speed: 0, mesh: { position: v(), rotation: { x: 0, y: 0, z: 0 } } });
  c.keys = Object.fromEntries(['forward', 'backward', 'left', 'right', 'up', 'down'].map((a) => [a, false]));
  c.bindKeyboard();
  c.activeMode = activeType;
  c.entities = { [activeType]: entity(activeType) };
  extraTypes.forEach((t, i) => { c.entities[t] = entity(t, 200 + i * 10, 200); });
  c.colliders = []; c._colliderCells = null;
  c.getGroundHeight = () => 0;
  return c;
}

test('the Spider-Man entity type is a known body: teleport placement works for it', () => {
  const c = controllerHarness('spider');
  const p = c.findTeleportPosition(10, 10, 0, 0);
  assert.deepEqual([p.x, p.z], [10, 10]);
});

test('registering a spider entity does not break teleports of the original modes', () => {
  for (const mode of ['person', 'car', 'cyclist', 'helicopter']) {
    const c = controllerHarness(mode, ['spider']);
    const p = c.findTeleportPosition(10, 10, 0, mode === 'helicopter' ? 100 : 0);
    assert.deepEqual([p.x, p.z], [10, 10], `${mode} arrival with a spider entity present`);
  }
});

test('teleportActiveTo calls the entity onTeleport hook (Spider-Man resets its motion there)', () => {
  const c = controllerHarness('spider');
  let called = null;
  c.entities.spider.onTeleport = (e) => { called = e; };
  const r = c.teleportActiveTo(30, 20, 0.5);
  assert.deepEqual({ ...r }, { x: 30, z: 20 });
  assert.equal(called, c.entities.spider);
  assert.equal(c.entities.spider.heading, 0.5);
});

test('entities without the hook teleport exactly as before', () => {
  const c = controllerHarness('cyclist');
  Object.assign(c.entities.cyclist, { leanAngle: 0.3, leanPivot: { rotation: { z: 0.3 } }, helmet: { visible: false } });
  assert.doesNotThrow(() => c.teleportActiveTo(30, 20, 0));
  assert.equal(c.entities.cyclist.leanAngle, 0, 'its own reset still runs');
});

test('traffic gives Spider-Man a pedestrian-sized hitbox, not a car-sized one', () => {
  const src = read('js/traffic.js');
  assert.match(src, /player\.halfW = activeMode === 'cyclist' \? 0\.35 : activeMode === 'person' \|\| activeMode === 'spider' \? 0\.32 : 0\.86;/);
  assert.match(src, /player\.halfL = activeMode === 'cyclist' \? 0\.85 : activeMode === 'person' \|\| activeMode === 'spider' \? 0\.32 : 2\.18;/);
});

test('the prototype is loaded lazily and can be switched off with ?spider=0', () => {
  const main = read('js/main.js');
  assert.match(main, /get\('spider'\) !== '0'/);
  assert.match(main, /await import\('\.\/spider-install\.js'\)/);
  assert.doesNotMatch(main, /from '\.\/spider-/, 'no static import: the module graph of the original game is unchanged');
  assert.match(main, /delete controllerManager\.entities\.spider/, 'a failed load removes the entity again');
});

test('the Spider-Man entity is registered after the audio system exists, so it never becomes an engine sound source', () => {
  const main = read('js/main.js');
  assert.ok(main.indexOf('new CityAudioSystem(') < main.indexOf("import('./spider-install.js')"));
  assert.ok(main.indexOf("import('./spider-install.js')") < main.indexOf('const dynamicRoots = ['), 'installed before the dynamic roots are collected');
});

test('the original model file is read, never written: the loader only fetches it and fixes materials on the loaded copy', () => {
  const src = read('js/spider-model.js');
  assert.match(src, /marvel_spider_man_ps4_for_blender\/scene\.gltf/);
  assert.doesNotMatch(src, /writeFile|fs\./);
});

test('controls text is consistent: the web is the left mouse button, Shift only sprints, and no file still says hold-Shift-to-web', () => {
  const main = read('js/main.js'), ctrl = read('js/spider-controller.js'), input = read('js/spider-input.js'), notes = read('docs/spider-man-portfolio/prototype-notes.md');
  assert.match(main, /spider: \[.*'Left click'.*'Web: hold to swing'/s);
  assert.doesNotMatch(main, /hold in air: Web/);
  assert.doesNotMatch(notes, /hold \*\*Shift\*\* in the air|hold Shift in the air|Shift \(hold in the air/);
  assert.match(notes, /Left mouse button/);
  assert.match(notes, /Shift \| Sprint \(on the ground\)/);
  // Shift is only ever read for sprinting in the controller; every web decision goes through the mouse button state
  const shiftUses = ctrl.match(/input\.shift/g) || [];
  assert.equal(shiftUses.length, 1);
  assert.match(ctrl, /groundVelocity\(this\.vel, w\.x, w\.z, this\.input\.shift/);
  assert.match(ctrl, /input\.webHeld/);
  assert.match(input, /e\.button !== 0/);
});

test('the installer gives the mouse to Spider-Man only while his camera is active, and frees pointer lock for UI and other modes', () => {
  const inst = read('js/spider-install.js');
  assert.match(inst, /isActive: \(\) => camera\.active/);
  assert.match(inst, /onOpen: \(\) => \{[^}]*input\.releaseLock\(\)/);
  assert.match(inst, /if \(mode !== 'spider'\) input\.releaseLock\(\)/);
  assert.match(inst, /controller\.targeting = targeting/);
});

test('the animation module no longer owns fixed sine poses: it is driven by the gait module and IK', () => {
  const anim = read('js/spider-anim.js');
  assert.match(anim, /from '\.\/spider-gait\.js'/);
  assert.match(anim, /twoBoneIK/);
  assert.match(anim, /footTrajectory/);
  assert.doesNotMatch(anim, /const poses = \{ idle: newPose\(\)/);
});

test('the controller feeds the animation what it needs: world position for foot locking, time to impact and release anticipation', () => {
  const ctrl = read('js/spider-controller.js'), anim = read('js/spider-anim.js'), inst = read('js/spider-install.js');
  assert.match(ctrl, /px: rp\.x, pz: rp\.z/);
  assert.match(ctrl, /landIn, releaseSoon/);
  assert.match(anim, /const feet = \[0, 1\]\.map/, 'planted feet are pinned to world positions');
  assert.match(anim, /S\.lockOn/);
  assert.match(anim, /AIR_KEYS = \['takeoff', 'rise', 'apex', 'fall', 'prep', 'launch'\]/, 'the air state set');
  assert.match(anim, /S\.relSoon/, 'release anticipation drives the swing pose');
  assert.match(inst, /controller\.vel, controller\.grounded/, 'targeting gets the body velocity so it can predict the swing arc');
});

test('the dev-only animation probe is never loaded by the game', () => {
  for (const f of ['js/main.js', 'js/spider-install.js', 'index.html']) assert.doesNotMatch(read(f), /anim-probe/);
});

test('the Raimi model is the default character with the original as fallback, and the original model files are untouched by the new code', () => {
  const inst = read('js/spider-install.js'), raimi = read('js/spider-model-raimi.js');
  assert.match(inst, /loadRaimiModel\(\)/);
  assert.match(inst, /spiderModel'\) \?\? ?|get\('spiderModel'\)/);
  assert.match(inst, /wantModel !== 'ps4'/);
  assert.match(inst, /loadSpiderModel\(\{ textureSize/, 'the original model is the fallback');
  assert.doesNotMatch(raimi + read('js/spider-clips.js'), /writeFile|fs\./);
  assert.match(raimi, /content\/spider-raimi\/spider-raimi\.glb/);
  assert.match(raimi, /0x46546c67/, 'a body that is not a GLB (download manager, proxy) is reported, not fed to the parser');
});

test('animation clips are optional and layered: the mixer drives the base, the procedural rig the web and the air, and a missing manifest keeps the procedural rig', () => {
  const clips = read('js/spider-clips.js'), inst = read('js/spider-install.js');
  assert.match(clips, /AnimationMixer/);
  assert.match(clips, /bakeRetarget/);
  assert.match(clips, /MAX_CADENCE/);
  assert.match(clips, /manifest\.json/);
  assert.match(clips, /copy\(s\.q\)\.slerp\(TMP\.q, w\)/,'the bone blend must not feed slerpQuaternions its own output');
  assert.match(inst, /createClipRig/);
  assert.match(inst, /clipMode !== 'off'/);
  assert.match(inst, /rig\.rig\.kind === 'mixamo'/);
});

test('the 3D web strand is real geometry attached to the hand bone, with a shoot and a retract', () => {
  const web = read('js/spider-web.js'), inst = read('js/spider-install.js');
  assert.match(web, /STRANDS = 3/);
  assert.doesNotMatch(web, /THREE\.Line|CylinderGeometry/);
  assert.match(web, /shoot\(anchor\)/); assert.match(web, /release\(\)/); assert.match(web, /'retracting'/);
  assert.match(inst, /side\.hand\.getWorldPosition/);
  assert.match(inst, /mesh\.updateMatrixWorld\(true\);[\s\S]*web\.update\(/, 'matrices are refreshed before the strand reads the hand');
});
