const assert = require('node:assert/strict');
const { readFileSync, existsSync, statSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');

const read = (f) => readFileSync(join(__dirname, '..', f), 'utf8');
const E = loadModule(read('js/spider-eyes.js'));
const calm = { speed: 0, speed3: 0, vy: 0, grounded: true, swinging: false, cling: false, wallRun: false, airJumpT: -1 };

// a stand-in for the eye frame mesh: only the morph dictionary and influences are read
const fakeEyes = () => ({ isMesh: true, morphTargetDictionary: { Squint: 0, Open: 1 }, morphTargetInfluences: [0, 0], traverse(fn) { fn(this); } });

test('standing still the eyes are neutral', () => {
  const t = E.eyeTargets(calm);
  assert.equal(t.squint, 0); assert.equal(t.open, 0);
});

test('the eyes narrow with speed, in a swing and on a wall, and never exceed 0..1', () => {
  assert.ok(E.eyeTargets({ ...calm, speed3: 6 }).squint < 0.05, 'a walk does not squint');
  assert.ok(E.eyeTargets({ ...calm, speed3: 18 }).squint > 0.6, 'a sprint does');
  assert.ok(E.eyeTargets({ ...calm, grounded: false, swinging: true, tension: 0.8 }).squint > 0.6);
  assert.ok(E.eyeTargets({ ...calm, grounded: false, cling: true }).squint > 0.25);
  assert.ok(E.eyeTargets({ ...calm, grounded: false, wallRun: true }).squint > 0.5);
  for (const st of [{ ...calm, speed3: 99 }, { ...calm, grounded: false, vy: -99 }, { ...calm, grounded: false, swinging: true, tension: 9 }]) {
    const t = E.eyeTargets(st, 1); assert.ok(t.squint >= 0 && t.squint <= 1 && t.open >= 0 && t.open <= 1);
  }
});

test('the eyes open wide in a fall and at the start of a double jump, and never narrow and widen at once', () => {
  const fall = E.eyeTargets({ ...calm, grounded: false, vy: -14 });
  assert.ok(fall.open > 0.8); assert.equal(fall.squint, 0, 'wide eyes replace the squint');
  assert.ok(E.eyeTargets({ ...calm, grounded: false, vy: 3, airJumpT: 0.02 }).open > 0.7);
  assert.equal(E.eyeTargets({ ...calm, grounded: false, vy: 3, airJumpT: 0.6 }).open, 0, 'the widening of a double jump is brief');
  assert.equal(E.eyeTargets({ ...calm, grounded: false, vy: -14 }, 0.9).open < fall.open, true, 'a blink closes them');
  const fast = E.eyeTargets({ ...calm, speed3: 20, grounded: false, vy: -10 });
  assert.ok(fast.open > 0.3 && fast.squint > 0 && fast.squint + fast.open <= 1.0001, 'a fast fall is part squint, part wide: the two share the range');
});

test('a blink is a short squint pulse that also happens when standing still', () => {
  const eyes = fakeEyes(); let n = 0;
  const c = E.createEyeController(eyes, () => 0); // no randomness: the first blink comes after 2 s
  let peak = 0, frames = 0;
  for (let t = 0; t < 3; t += 1 / 60) { c.update(1 / 60, calm); peak = Math.max(peak, eyes.morphTargetInfluences[0]); frames++; n++; }
  assert.ok(peak > 0.3, `a blink within 3 s (peak ${peak.toFixed(2)})`);
  for (let t = 0; t < 0.6; t += 1 / 60) c.update(1 / 60, calm);
  assert.ok(eyes.morphTargetInfluences[0] < 0.05, 'and the eyes open again');
  assert.equal(eyes.morphTargetInfluences[1], 0);
});

test('the controller smooths towards the target and writes the two morph influences', () => {
  const eyes = fakeEyes(); const c = E.createEyeController(eyes, () => 1);
  for (let i = 0; i < 120; i++) c.update(1 / 60, { ...calm, grounded: false, vy: -14 });
  assert.ok(eyes.morphTargetInfluences[1] > 0.8 && eyes.morphTargetInfluences[0] < 0.05);
  for (let i = 0; i < 240; i++) c.update(1 / 60, { ...calm, speed3: 20 });
  assert.ok(eyes.morphTargetInfluences[0] > 0.6 && eyes.morphTargetInfluences[1] < 0.05);
  c.update(0.001, calm); assert.ok(eyes.morphTargetInfluences[0] < 0.7, 'one frame does not jump to the target');
});

test('a model without the eye morph targets gets no controller', () => {
  assert.equal(E.createEyeController({ traverse(fn) { fn({ isMesh: true, morphTargetDictionary: { Smile: 0 }, morphTargetInfluences: [0] }); } }), null);
  assert.equal(E.createEyeController({ traverse() {} }), null);
});

test('the Brand New Day model is the default character, falls back to Raimi and then the original, and drives the eyes', () => {
  const inst = read('js/spider-install.js'), bnd = read('js/spider-model-bnd.js');
  assert.match(inst, /loadBndModel\(\)/);
  assert.match(inst, /wantModel !== 'ps4' && wantModel !== 'raimi'/, '?spiderModel=raimi and ?spiderModel=ps4 skip it');
  assert.match(inst, /loadRaimiModel\(\)/);
  assert.match(inst, /loadSpiderModel\(\{ textureSize/, 'the original model is the last fallback');
  assert.match(inst, /createEyeController\(model\.root\)/);
  assert.match(inst, /eyes\.update\(dt, st\)/, 'the eyes follow the rig state');
  assert.match(bnd, /content\/spider-bnd\/spider-bnd\.glb/);
  assert.match(bnd, /0x46546c67/, 'a body that is not a GLB is reported, not fed to the parser');
  assert.doesNotMatch(bnd + read('js/spider-eyes.js'), /writeFile|fs\./);
});

test('the converted model file is a GLB with the Mixamo skeleton, five skinned meshes and the eye morph targets', () => {
  const f = join(__dirname, '..', 'content/spider-bnd/spider-bnd.glb');
  if (!existsSync(f)) return; // the model files are optional: the game falls back to the Raimi model
  const buf = readFileSync(f);
  assert.equal(buf.readUInt32LE(0), 0x46546c67); assert.equal(buf.readUInt32LE(4), 2);
  const jsonLen = buf.readUInt32LE(12), json = JSON.parse(buf.slice(20, 20 + jsonLen).toString('utf8'));
  assert.ok(json.skins.length >= 1);
  for (const s of json.skins) assert.deepEqual(s.joints, json.skins[0].joints, 'every mesh is skinned to the same 76 joints');
  assert.equal(json.skins[0].joints.length, 76);
  const names = json.nodes.map((n) => n.name || '');
  for (const n of ['mixamorigHips', 'mixamorigLeftHand', 'mixamorigRightForeArm', 'mixamorigHead']) assert.ok(names.includes(n), n);
  const skinned = json.nodes.filter((n) => n.skin !== undefined && n.mesh !== undefined);
  assert.equal(skinned.length, 5);
  const frameNode = json.nodes.find((n) => n.name === 'BndFrame');
  assert.ok(frameNode && frameNode.mesh !== undefined, 'the eye frame mesh');
  assert.deepEqual(json.meshes[frameNode.mesh].extras.targetNames, ['Squint', 'Open']);
  assert.ok(json.materials.some((m) => m.alphaMode === 'BLEND'), 'the eye lenses are translucent');
  assert.ok(json.materials.find((m) => m.name === 'BndSuit').pbrMetallicRoughness.metallicFactor < 0.2, 'the cloth is not a metal');
  assert.ok(statSync(f).size < 40e6, 'a web-sized file');
  assert.doesNotMatch(JSON.stringify(json.animations || []), /Suit\.position/, 'none of the FBX junk animations came along');
});
