const assert = require('node:assert/strict');
const { existsSync, readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');

const root = join(__dirname, '..');
const read = (p) => readFileSync(join(root, p), 'utf8');
const sel = JSON.parse(read('tools/clip-selection.json'));
const animsDir = join(root, 'content/spider-raimi/anims');
const manifestPath = join(animsDir, 'manifest.json');
const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : null;

// The animation library (Mixamo FBX) is converted once by tools/model-lab.html into baked clips. These tests pin what the game relies on: the selection file, the
// baked data (finite, unit quaternions, the Raimi bone names) and the measurements the state machine reads (root speed for the stride, contact and flight events).

test('clip selection names every slot the state machine plays and only uses known options', () => {
  const need = ['idle', 'walk', 'run', 'sprint', 'jump', 'fall', 'hardLand', 'runStop', 'swingStart', 'swingLoop', 'swingLand'];
  for (const n of need) assert.ok(sel.clips[n], `missing slot ${n}`);
  for (const [n, c] of Object.entries(sel.clips)) {
    assert.match(c.src, /\.fbx$/, n);
    assert.ok(['full', 'crouchOnly'].includes(c.hips), `${n}: hips`);
    assert.ok(['detrend', 'strip'].includes(c.rootXZ), `${n}: rootXZ`);
  }
  // clips the physics owns the body height for must not lift the hips again; locomotion keeps its bob
  for (const n of ['jump', 'fall', 'swingStart', 'swingLoop']) assert.equal(sel.clips[n].hips, 'crouchOnly', n);
  for (const n of ['walk', 'run', 'sprint']) assert.equal(sel.clips[n].rootXZ, 'detrend', n);
  for (const n of ['swingStart', 'swingLoop', 'swingLand']) assert.ok(sel.clips[n].mirror && sel.clips[n].hand, `${n} needs both hands`);
});

test('the A-pose arm correction is on for ground locomotion and landings and off for jump, fall and swing (those stay exactly as they were)', () => {
  for (const n of ['idle', 'walk', 'run', 'sprint', 'hardLand', 'runStop']) assert.equal(sel.clips[n].armRest, 'align', n);
  for (const n of ['jump', 'fall', 'swingStart', 'swingLoop', 'swingLand']) assert.ok(!sel.clips[n].armRest && !sel.clips[n].armSpread, `${n} must keep its original arms`);
  for (const n of ['walk', 'run', 'sprint']) assert.ok(sel.clips[n].armSpread >= 0 && sel.clips[n].armSpread <= 15, `${n}: spread is a few degrees`);
  assert.ok(sel.clips.sprint.armSpread > sel.clips.run.armSpread, 'the sprint tucks its elbows the most');
  const clips = read('js/spider-clips.js');
  assert.match(clips, /armRest === 'align'/); assert.match(clips, /setFromUnitVectors\(ud, us\)/);
  assert.match(clips, /'none' \(the default\) keeps the clips exactly as they were baked before/);
});

test('the second locomotion pass: leaned pack run, running jump, look-around idles, heading-aware lean', () => {
  assert.match(sel.clips.run.src, /Male Locomotion Pack\/standard run\.fbx$/);
  for (const n of ['runJump', 'idleLookA', 'idleLookB']) assert.equal(sel.clips[n].armRest, 'align', n);
  assert.equal(sel.clips.runJump.hips, 'crouchOnly', 'the physics owns the height in the air');
  if (manifest) { const m = (n) => manifest.clips[n].meta; assert.ok(m('runJump').airStart < 0.2 && m('runJump').airEnd > 0.4 && m('runJump').airEnd < m('runJump').duration); assert.ok(m('idleLookA').duration > 2 && m('idleLookB').duration > 2); }
  const clips = read('js/spider-clips.js');
  assert.match(clips, /AX\.right\.set\(1, 0, 0\)\.applyAxisAngle\(AX\.up, h\)/, 'lean and bank use the character own axes, not the world X and Z');
  assert.doesNotMatch(clips, /rotateBoneWorld\([^)]*(X|Z)[,)]/, 'no world-axis lean');
  assert.match(clips, /runJumpFrom/); assert.match(clips, /idleLookA/); assert.match(read('js/spider-install.js'), /spiderRunJump/);
});

test('final polish: stride correction when the cadence cap is reached, and a running-fall landing that mixes the stride landing with the hard landing', () => {
  const clips = read('js/spider-clips.js');
  assert.match(clips, /function strideIK\(k, fwd\)/); assert.match(clips, /strideMax: 1\.2/);
  assert.match(clips, /S\.kStride = clamp\(want \/ rate, 1, C\.strideMax\)/, 'only what the cadence cap cannot cover is made up in stride length');
  assert.match(clips, /S\.shot\.mix = \{ name: 'hardLand'/);
  assert.match(clips, /impact > 14 && hs > 5 && animator\.has\('runJump'\)/);
  // the swing-to-land branch comes first and is untouched
  assert.ok(clips.indexOf('if (flipLand)') < clips.indexOf("impact > 14 && hs > 5"));
});

test('source FBX files named by the selection exist (when the downloads are present)', (t) => {
  const dir = join(root, 'content/spider-raimi/anims-src');
  if (!existsSync(dir)) return t.skip('no anims-src folder on this machine');
  for (const [n, c] of Object.entries(sel.clips)) assert.ok(existsSync(join(dir, c.src)), `${n}: ${c.src}`);
  assert.equal(sel.dir, '/content/spider-raimi/anims-src/');
});

test('the manifest (version 2) lists baked clips with the measurements the runtime reads', (t) => {
  if (!manifest) return t.skip('clips not converted yet');
  assert.equal(manifest.version, 2);
  for (const [n, c] of Object.entries(sel.clips)) {
    assert.ok(manifest.clips[n], `manifest has ${n}`);
    if (c.mirror) assert.ok(manifest.clips[n + 'M'], `manifest has the mirror image ${n}M`);
  }
  for (const [n, e] of Object.entries(manifest.clips)) {
    assert.ok(existsSync(join(animsDir, e.file)), e.file);
    assert.ok(e.meta.duration > 0.2, n);
    for (const k of ['rootSpeed', 'footSpeed', 'contact', 'firstContact']) assert.ok(Number.isFinite(e.meta[k]), `${n}.${k}`);
  }
  // locomotion: the root speed IS the stride (m per cycle = rootSpeed x duration); a walk is slower than a run, which is not faster than a sprint
  const m = (n) => manifest.clips[n].meta;
  assert.ok(m('walk').rootSpeed > 1 && m('walk').rootSpeed < m('run').rootSpeed);
  assert.ok(m('run').rootSpeed <= m('sprint').rootSpeed + 0.5);
  // the jump's flight window (feet off the ground .. back on it) is inside the clip
  assert.ok(m('jump').airStart > 0.2 && m('jump').airEnd > m('jump').airStart && m('jump').airEnd < m('jump').duration);
  // a swing clip made for the left hand has a mirror image made for the right one
  for (const n of ['swingStart', 'swingLoop', 'swingLand']) assert.notEqual(m(n).hand, m(n + 'M').hand, n);
});

test('baked clips are finite, normalised, loop-safe and animate only bones of the Raimi skeleton', (t) => {
  if (!manifest) return t.skip('clips not converted yet');
  let ref = null;
  for (const [n, e] of Object.entries(manifest.clips)) {
    const j = JSON.parse(readFileSync(join(animsDir, e.file), 'utf8'));
    assert.equal(j.baked, true, n);
    const clip = j.clip, names = clip.tracks.map((x) => x.name);
    assert.ok(Math.abs(clip.duration - e.meta.duration) < 1e-3, `${n}: duration`);
    assert.ok(names.every((x) => /^mixamorig[A-Za-z0-9_]+\.(quaternion|position)$/.test(x)), `${n}: unexpected track`);
    ref = ref || names.slice().sort().join();
    assert.equal(names.slice().sort().join(), ref, `${n}: every clip drives the same bones, so blending never leaves a bone behind`);
    for (const tr of clip.tracks) {
      assert.ok(tr.values.every(Number.isFinite), `${n} ${tr.name}`);
      assert.ok(tr.times.every((x, i) => i === 0 || x > tr.times[i - 1]), `${n} ${tr.name}: times increase`);
      if (tr.type === 'quaternion') for (let i = 0; i < tr.values.length; i += 4) assert.ok(Math.abs(Math.hypot(tr.values[i], tr.values[i + 1], tr.values[i + 2], tr.values[i + 3]) - 1) < 1e-4, `${n} ${tr.name}`);
    }
  }
});

test('the clip state machine scrubs by game state, keeps the web arm procedural and never feeds the physics', () => {
  const clips = read('js/spider-clips.js');
  assert.match(clips, /timeScale = 0/, 'time is set by the caller, never by free-running playback');
  assert.match(clips, /MAX_CADENCE/);
  assert.match(clips, /groundSpeedOf/, "stride from the clip's own root speed, not a blind playback rate");
  for (const slot of ["'idle'", "'walk'", "'run'", "'sprint'", "'jump'", "'fall'", "'hardLand'", "'runStop'", "'swingStart'", "'swingLoop'", "'swingLand'"]) assert.ok(clips.includes(slot), slot);
  assert.match(clips, /SWING_BONES = \{[^}]*webArm: 1\.0/, 'the web arm is fully procedural while swinging');
  assert.match(clips, /put the web arm back on the procedural world aim/);
  assert.match(clips, /landIn/, 'the landing flip is paced by the time to impact');
  // the clip layer reads the controller's state and animates; it does not set positions or velocities of the body
  assert.doesNotMatch(clips, /controller\.|\.vel\.|entity\.position|mesh\.position\.set/);
  // controller (physics) and swing code do not know about the clip layer
  assert.doesNotMatch(read('js/spider-controller.js'), /spider-clips/);
  assert.doesNotMatch(read('js/spider-swing-sim.js'), /spider-clips/);
});
