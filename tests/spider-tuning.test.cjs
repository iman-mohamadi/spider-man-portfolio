const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');

const read = (p) => readFileSync(join(__dirname, '..', p), 'utf8');
const physics = loadModule(read('js/spider-physics.js'));
const gait = loadModule(read('js/spider-gait.js'));
const camera = loadModule(read('js/spider-camera.js'), { imports: { './spider-physics.js': physics } });
const sim = loadModule(read('js/spider-swing-sim.js'), { imports: { './spider-physics.js': physics } });
const targeting = loadModule(read('js/spider-targeting.js'), { imports: { './spider-physics.js': physics, './spider-swing-sim.js': sim } });
const input = loadModule(read('js/spider-input.js'), { globals: { window: {}, document: {} }, imports: { './city-config.js': { isTypingInField: () => false } } });
const T = loadModule(read('js/spider-tuning.js'));

const objects = () => ({ spider: physics.SPIDER, camera: camera.SPIDER_CAMERA, targeting: targeting.TARGETING, look: input.LOOK_SENS, gait: gait.GAIT });

test('every tunable in the panel exists in the real config it claims to edit (no stale or misspelled keys)', () => {
  const o = objects();
  for (const [group, obj, key, , min, max] of T.SPECS) {
    assert.ok(o[obj], `${group}: unknown object ${obj}`);
    assert.ok(key in o[obj], `${obj}.${key} is not in the config`);
    assert.ok(typeof o[obj][key] === 'number', `${obj}.${key} is a number`);
    assert.ok(min < max);
    assert.ok(o[obj][key] >= min && o[obj][key] <= max, `${obj}.${key} default ${o[obj][key]} is inside its slider range ${min}..${max}`);
  }
});

test('applyValues clamps to the slider range, ignores unknown keys and non-numbers, and diffValues reports only real changes', () => {
  const o = { spider: { run: 8.5, sprint: 15 }, camera: {}, targeting: {}, look: {}, gait: {} };
  const d = T.snapshot(o);
  assert.equal(JSON.stringify(Object.keys(d).sort()), JSON.stringify(['spider.run', 'spider.sprint']));
  const n = T.applyValues(o, { 'spider.run': 99, 'spider.sprint': 'fast', 'spider.nope': 1, 'bogus.x': 2 });
  assert.equal(n, 1);
  assert.equal(o.spider.run, 14, 'clamped to the slider maximum');
  assert.equal(o.spider.sprint, 15);
  assert.equal(JSON.stringify(T.diffValues(o, d)), JSON.stringify({ 'spider.run': 14 }));
  o.spider.run = 8.5;
  assert.equal(JSON.stringify(T.diffValues(o, d)), '{}', 'back at the default: no diff');
});

test('the gait tuning multipliers scale cadence and foot lift, and default to 1', () => {
  assert.equal(gait.GAIT.cadence, 1); assert.equal(gait.GAIT.lift, 1);
  const base = gait.gaitParams(8.5), f0 = base.freq, l0 = base.lift;
  gait.GAIT.cadence = 1.2; gait.GAIT.lift = 2;
  const g = gait.gaitParams(8.5);
  assert.ok(Math.abs(g.freq - f0 * 1.2) < 1e-9 && Math.abs(g.lift - l0 * 2) < 1e-9);
  gait.GAIT.cadence = 1; gait.GAIT.lift = 1;
});

test('the tuning panel is only loaded on request (?spiderTune), never in the normal game', () => {
  const inst = read('js/spider-install.js');
  assert.match(inst, /has\('spiderTune'\)/);
  assert.match(inst, /await import\('\.\/spider-tuning\.js'\)/);
  assert.doesNotMatch(read('js/main.js'), /spider-tuning/);
});
