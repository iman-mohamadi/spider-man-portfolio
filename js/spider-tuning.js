// Live feel-tuning panel for the Spider-Man prototype. Only loaded with `?spiderTune` (spider-install.js imports it dynamically).
// Every slider writes straight into the shared config objects the game already reads each frame (SPIDER, the camera CFG, the targeting
// CFG, the mouse sensitivity and the gait multipliers), so changes apply instantly. Values persist in localStorage; "Copy changes" puts a
// JSON of everything that differs from the defaults on the clipboard so it can be pasted back as the new defaults.

// [group, object, key, label, min, max, step]
const SPECS = [
  ['Movement', 'spider', 'run', 'Run speed (m/s)', 4, 14, 0.1],
  ['Movement', 'spider', 'sprint', 'Sprint speed (m/s)', 8, 26, 0.1],
  ['Movement', 'spider', 'accel', 'Ground acceleration', 15, 90, 1],
  ['Movement', 'spider', 'jumpSpeed', 'Jump speed', 6, 18, 0.1],
  ['Movement', 'spider', 'gravity', 'Jump gravity', 12, 48, 0.5],
  ['Movement', 'spider', 'airAccel', 'Air control', 2, 24, 0.5],
  ['Movement', 'spider', 'airMax', 'Air speed cap (no swing)', 6, 26, 0.5],
  ['Swing', 'spider', 'swingGravity', 'Swing gravity', 12, 44, 0.5],
  ['Swing', 'spider', 'swingPump', 'Pump (W) acceleration', 0, 28, 0.5],
  ['Swing', 'spider', 'swingBrake', 'Brake (S) acceleration', 0, 24, 0.5],
  ['Swing', 'spider', 'swingSteer', 'Steer (A/D) base', 0, 36, 0.5],
  ['Swing', 'spider', 'swingTurn', 'Steer per m/s of speed', 0, 2, 0.05],
  ['Swing', 'spider', 'swingDrag', 'Air drag', 0, 0.2, 0.005],
  ['Swing', 'spider', 'swingMax', 'Swing speed cap (m/s)', 20, 80, 1],
  ['Swing', 'spider', 'reelSpeed', 'Reel-in speed', 0, 44, 1],
  ['Swing', 'spider', 'reelRamp', 'Reel ease-in (s)', 0, 1.2, 0.05],
  ['Swing', 'spider', 'swingClearance', 'Clearance above street', 0, 16, 0.5],
  ['Swing', 'spider', 'releaseBoost', 'Release boost', 0, 0.4, 0.01],
  ['Swing', 'spider', 'releaseLift', 'Release lift (m/s)', 0, 10, 0.25],
  ['Camera', 'camera', 'distance', 'Distance', 2.5, 12, 0.1],
  ['Camera', 'camera', 'distanceSpeed', 'Extra distance at speed', 0, 10, 0.1],
  ['Camera', 'camera', 'shoulder', 'Shoulder offset', 0, 1.8, 0.05],
  ['Camera', 'camera', 'pivotHeight', 'Pivot height', 0.6, 2.4, 0.05],
  ['Camera', 'camera', 'frameUp', 'Frame character lower', 0, 1.2, 0.02],
  ['Camera', 'camera', 'baseFov', 'Field of view', 40, 90, 1],
  ['Camera', 'camera', 'fovBoost', 'FOV boost at speed', 0, 30, 0.5],
  ['Camera', 'camera', 'lookAhead', 'Look-ahead', 0, 0.5, 0.01],
  ['Camera', 'camera', 'pivotRate', 'Follow tightness', 4, 40, 0.5],
  ['Camera', 'camera', 'pivotRateSpeed', 'Extra tightness at speed', 0, 30, 0.5],
  ['Camera', 'camera', 'followRateSwing', 'Swing auto-follow (0 = off)', 0, 4, 0.05],
  ['Camera', 'camera', 'followIdle', 'Mouse idle before swing follow (s)', 0.1, 4, 0.1],
  ['Camera', 'look', 'yaw', 'Mouse sensitivity X', 0.0005, 0.007, 0.0001],
  ['Camera', 'look', 'pitch', 'Mouse sensitivity Y', 0.0005, 0.007, 0.0001],
  ['Targeting', 'targeting', 'cone', 'Aim cone (bearing)', 0.2, 1.0, 0.02],
  ['Targeting', 'targeting', 'coneV', 'Aim cone (elevation)', 0.2, 1.3, 0.02],
  ['Targeting', 'targeting', 'elevWeight', 'Elevation weight', 0, 1.5, 0.05],
  ['Targeting', 'targeting', 'switchRatio', 'Switch only if better by (ratio)', 0.3, 1, 0.02],
  ['Targeting', 'targeting', 'grace', 'Keep after losing sight (s)', 0, 1, 0.05],
  ['Targeting', 'spider', 'targetRange', 'Max target range (m)', 30, 95, 1],
  ['Targeting', 'spider', 'reelLimit', 'Reel limit (min rope fraction)', 0.2, 0.95, 0.02],
  ['Animation', 'gait', 'cadence', 'Run cadence x', 0.6, 1.5, 0.02],
  ['Animation', 'gait', 'lift', 'Foot lift x', 0.3, 2, 0.05],
  ['Animation', 'gait', 'lean', 'Forward lean x', 0, 2.5, 0.05],
  ['Animation', 'gait', 'armSwing', 'Arm swing x', 0, 2, 0.05]
];

const STORE = 'spiderTune';

/** Clamps and applies { 'obj.key': value } onto the config objects; unknown keys are ignored. Returns the number applied. */
function applyValues(objects, values, specs = SPECS) {
  let n = 0;
  for (const [, obj, key, , min, max] of specs) {
    const v = values?.[`${obj}.${key}`];
    if (typeof v !== 'number' || !Number.isFinite(v) || !objects[obj] || !(key in objects[obj])) continue;
    objects[obj][key] = Math.min(max, Math.max(min, v));
    n++;
  }
  return n;
}

/** { 'obj.key': value } for everything that differs from the defaults snapshot. */
function diffValues(objects, defaults, specs = SPECS) {
  const out = {};
  for (const [, obj, key] of specs) {
    const id = `${obj}.${key}`;
    if (objects[obj] && key in objects[obj] && Math.abs(objects[obj][key] - defaults[id]) > 1e-9) out[id] = +objects[obj][key].toFixed(5);
  }
  return out;
}

function snapshot(objects, specs = SPECS) {
  const d = {};
  for (const [, obj, key] of specs) if (objects[obj] && key in objects[obj]) d[`${obj}.${key}`] = objects[obj][key];
  return d;
}

function installTuning(objects, doc = document) {
  const defaults = snapshot(objects);
  let stored = {};
  try { stored = JSON.parse(localStorage.getItem(STORE) || '{}'); } catch { stored = {}; }
  applyValues(objects, stored);

  const root = doc.createElement('aside');
  root.className = 'spider-tune';
  root.innerHTML = '<header><b>Feel tuning</b><span class="st-actions"><button type="button" data-a="copy">Copy changes</button><button type="button" data-a="reset">Reset</button><button type="button" data-a="min" aria-label="Collapse">_</button></span></header><div class="st-body"></div><p class="st-note" hidden></p>';
  const body = root.querySelector('.st-body'), note = root.querySelector('.st-note');
  const rows = new Map();
  let group = '', section = null;
  for (const [g, obj, key, label, min, max, step] of SPECS) {
    if (!objects[obj] || !(key in objects[obj])) continue;
    if (g !== group) { group = g; section = doc.createElement('details'); section.open = g === 'Swing' || g === 'Camera'; section.innerHTML = `<summary>${g}</summary>`; body.append(section); }
    const id = `${obj}.${key}`, row = doc.createElement('label');
    const name = doc.createElement('span'), val = doc.createElement('output'), input = doc.createElement('input');
    name.textContent = label; input.type = 'range'; input.min = min; input.max = max; input.step = step; input.value = objects[obj][key];
    const show = () => { val.textContent = (+objects[obj][key]).toFixed(step < 0.01 ? 4 : step < 0.1 ? 2 : 1); row.classList.toggle('is-changed', Math.abs(objects[obj][key] - defaults[id]) > 1e-9); };
    input.addEventListener('input', () => { objects[obj][key] = parseFloat(input.value); show(); save(); });
    input.addEventListener('change', () => input.blur()); // keep the game keys flowing after a drag
    row.append(name, input, val); section.append(row); rows.set(id, { input, show }); show();
  }
  function save() { try { localStorage.setItem(STORE, JSON.stringify(diffValues(objects, defaults))); } catch { /* storage unavailable */ } }
  function say(text) { note.hidden = false; note.textContent = text; }
  root.addEventListener('click', async (e) => {
    const a = e.target?.dataset?.a;
    if (a === 'min') root.classList.toggle('is-min');
    else if (a === 'reset') { for (const [id, r] of rows) { const [obj, key] = id.split('.'); objects[obj][key] = defaults[id]; r.input.value = defaults[id]; r.show(); } save(); say('Reset to the defaults.'); }
    else if (a === 'copy') {
      const text = JSON.stringify(diffValues(objects, defaults), null, 2);
      try { await navigator.clipboard.writeText(text); say(`Copied ${Object.keys(JSON.parse(text)).length} changed values to the clipboard.`); }
      catch { say(text); }
    }
  });
  doc.body.append(root);
  return { root, defaults, apply: (v) => applyValues(objects, v), diff: () => diffValues(objects, defaults) };
}

export { SPECS, applyValues, diffValues, snapshot, installTuning };
