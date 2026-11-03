// The eyes of the Brand New Day suit: the eye frame mesh has two morph targets, "Squint" (the lenses narrow) and "Open" (they widen). They are driven from the same per-frame
// state the rig gets: narrowed with speed, swinging and climbing (and a quick blink now and then), wide open in a fall, after a hard drop and in a double jump. Pure
// functions of the state plus a little smoothing, so it is testable without a renderer. Nothing happens for a model without those morph targets.

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

/** The mesh with the "Squint" and "Open" morph targets, or null. */
function findEyeMesh(root) {
  let found = null;
  root.traverse((o) => {
    const d = o.isMesh && o.morphTargetDictionary;
    if (!found && d && d.Squint !== undefined && d.Open !== undefined && o.morphTargetInfluences) found = o;
  });
  return found;
}

/** Target eye shape (0..1 each, never both) for a rig state; `blink` (0..1) is the blink in progress. */
function eyeTargets(st, blink = 0, out = { squint: 0, open: 0 }) {
  const speed = st.speed3 ?? st.speed ?? 0, vy = st.vy ?? 0;
  let squint = 0.7 * smoothstep(7, 17, speed);
  if (st.swinging) squint = Math.max(squint, 0.45 + 0.35 * clamp(st.tension ?? 0.5, 0, 1));
  if (st.cling || st.wallRun) squint = Math.max(squint, st.wallRun ? 0.55 : 0.3);
  let open = 0;
  if (!st.grounded && !st.swinging) open = 0.9 * smoothstep(5, 14, -vy);
  if (st.landIn !== undefined && st.landIn < 0.25 && !st.grounded && vy < -3) open = Math.max(open, 0.7);
  if ((st.airJumpT ?? -1) >= 0 && st.airJumpT < 0.45) open = Math.max(open, 0.8 * (1 - st.airJumpT / 0.45));
  squint = Math.max(squint * (1 - open), blink);
  out.squint = clamp(squint, 0, 1); out.open = clamp(open * (1 - blink), 0, 1);
  return out;
}

/** @returns {{ mesh: object, update(dt: number, st: object): void, state: object } | null} */
function createEyeController(root, rng = Math.random) {
  const mesh = findEyeMesh(root);
  if (!mesh) return null;
  const iS = mesh.morphTargetDictionary.Squint, iO = mesh.morphTargetDictionary.Open;
  const state = { squint: 0, open: 0, blinkT: -1, nextBlink: 2 + rng() * 3 }, tgt = { squint: 0, open: 0 };
  function update(dt, st) {
    dt = clamp(dt, 1e-4, 0.1);
    state.nextBlink -= dt;
    if (state.nextBlink <= 0 && state.blinkT < 0) { state.blinkT = 0; state.nextBlink = 2.5 + rng() * 4; }
    let blink = 0;
    if (state.blinkT >= 0) { state.blinkT += dt; const u = state.blinkT / 0.16; blink = u >= 1 ? 0 : Math.sin(Math.PI * u); if (u >= 1) state.blinkT = -1; }
    eyeTargets(st, blink * 0.9, tgt);
    const rate = (tgt.squint > state.squint || tgt.open > state.open) ? 16 : 7; // fast in, slower out (a blink is fast either way: it is the target that moves)
    const k = 1 - Math.exp(-dt * rate);
    state.squint += (tgt.squint - state.squint) * k; state.open += (tgt.open - state.open) * k;
    mesh.morphTargetInfluences[iS] = state.squint; mesh.morphTargetInfluences[iO] = state.open;
  }
  return { mesh, update, state };
}

export { findEyeMesh, eyeTargets, createEyeController };
