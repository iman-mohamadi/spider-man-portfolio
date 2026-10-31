import { SPIDER } from './spider-physics.js';

// Web targeting: which anchor point would the web hit if the player clicked now?
//
// Candidates are facade and corner points near the roof line of the buildings around Spider-Man (spider-world.js). Each is scored by its
// angle to the CAMERA's centre line (the crosshair), so the player aims by looking; a small penalty prefers a comfortable swing distance.
// A candidate is only valid when it is in range, high enough for the swing to clear the street, in front of the player, and has a free
// line of sight both from the camera (so the marker is never drawn through a wall) and from Spider-Man.
//
// The choice is stabilised: the current target is kept until another is clearly better, and it survives a short loss of line of sight,
// so the marker does not flicker between neighbouring buildings. Selection runs at ~30 Hz; the marker is re-projected every frame.

const CFG = { cone: 0.6, coneV: 1.05, elevWeight: 0.6, interval: 1 / 30, keep: 12, losChecks: 6, alternatives: 3, switchRatio: 0.68, switchMargin: 0.025, grace: 0.25, idealDist: 42, distWeight: 0.0014 };

/**
 * How well a point lines up with the crosshair: the bearing difference and the elevation difference to the camera's centre line, with the
 * elevation counting for 60% (roof lines are normally well above the horizon, so looking at the building must be enough; looking exactly
 * at the roof edge still scores best). Plus a mild preference for ~42 m. Infinity outside the aiming cone.
 */
function scoreAnchor(view, x, y, z, cfg = CFG) {
  const dx = x - view.px, dy = y - view.py, dz = z - view.pz, h = Math.hypot(dx, dz);
  if (h < 1e-3) return Infinity;
  let dB = Math.atan2(dx, dz) - Math.atan2(view.fx, view.fz);
  if (dB > Math.PI) dB -= Math.PI * 2; else if (dB < -Math.PI) dB += Math.PI * 2;
  const dE = Math.atan2(dy, h) - Math.asin(Math.max(-1, Math.min(1, view.fy)));
  // only points that are actually on screen can be offered (the marker must be visible): inside the cone and inside ~85-90% of the frustum
  const coneV = view.vHalf ? Math.min(cfg.coneV, view.vHalf * 0.85) : cfg.coneV, cone = view.hHalf ? Math.min(cfg.cone, view.hHalf * 0.9) : cfg.cone;
  if (Math.abs(dB) > cone || Math.abs(dE) > coneV) return Infinity;
  return Math.hypot(dB, cfg.elevWeight * dE) + cfg.distWeight * Math.abs(Math.hypot(h, dy) - cfg.idealDist);
}

/** Keeps `list` (sorted by score, ascending) at most `max` long after adding an item. */
function insertRanked(list, item, max) {
  let i = list.length;
  while (i > 0 && list[i - 1].score > item.score) i--;
  if (i >= max) return;
  list.splice(i, 0, item);
  if (list.length > max) list.pop();
}

const same = (a, b) => a && b && Math.abs(a.x - b.x) < 0.2 && Math.abs(a.y - b.y) < 0.2 && Math.abs(a.z - b.z) < 0.2;

/**
 * Stable choice: `valid` is the ranked list of candidates that passed every check (best first); `current` is the previous target with
 * its re-evaluated score (or null when it no longer qualifies). Returns the target to use and how long the current one has been missing.
 */
function chooseTarget(valid, current, currentScore, missing, dt, cfg = CFG) {
  const best = valid[0] || null;
  if (current && Number.isFinite(currentScore)) {
    if (best && !same(best, current) && best.score < currentScore * cfg.switchRatio - cfg.switchMargin) return { target: best, missing: 0 };
    return { target: current, missing: 0 };
  }
  if (current && missing + dt < cfg.grace) return { target: current, missing: missing + dt, stale: true }; // brief loss: keep the marker
  return { target: best, missing: 0 };
}

class WebTargeting {
  constructor({ world, document: doc = document, config = SPIDER }) {
    this.world = world;
    this.cfg = config;
    this.selected = null;
    this.alternatives = [];
    this.valid = false;
    this._acc = 1;
    this._missing = 0;
    this._ranked = [];
    this._validList = [];
    this._flash = 0;
    this._flashKind = '';
    this._tmp = { x: 0, y: 0, z: 0 };
    this._ui = doc ? this._buildUi(doc) : null;
  }

  _buildUi(doc) {
    const root = doc.createElement('div');
    root.className = 'spider-reticle';
    root.setAttribute('aria-hidden', 'true');
    const mk = (cls) => { const e = doc.createElement('div'); e.className = cls; root.append(e); return e; };
    const center = mk('sr-center');
    const target = mk('sr-target');
    target.innerHTML = '<i class="sr-ring"></i><i class="sr-dot"></i>';
    const alts = [];
    for (let i = 0; i < CFG.alternatives; i++) alts.push(mk('sr-alt'));
    doc.body.append(root);
    return { root, center, target, alts, visible: false };
  }

  /** Visual feedback for a click: 'hit' (the web shot) or 'miss' (no valid target). */
  flash(kind) { this._flash = 0.28; this._flashKind = kind; }

  /**
   * view: camera position + unit forward { px, py, pz, fx, fy, fz }; body: feet position { x, y, z }; opts: { enabled }.
   * Call every frame; the candidate search itself runs at CFG.interval.
   */
  update(dt, view, body, enabled) {
    this._flash = Math.max(0, this._flash - dt);
    if (!enabled) { this.selected = null; this.alternatives.length = 0; this.valid = false; this._acc = 1; return; }
    this._acc += dt;
    if (this._acc < CFG.interval) return;
    const step = this._acc; this._acc = 0;
    const cfg = this.cfg, world = this.world;
    const cy = body.y + cfg.chest;
    const ground = world.floorAt(body.x, body.z, body.y, 0.3);
    const minY = ground + cfg.swingClearance + cfg.webMin;
    // horizontal view direction: anchors behind the player are never offered
    const fh = Math.hypot(view.fx, view.fz) || 1, hx = view.fx / fh, hz = view.fz / fh;
    const ranked = this._ranked; ranked.length = 0;
    world.forEachAnchor(body.x, cy, body.z, { minY, minHoriz: 8, maxHoriz: cfg.targetRange, minUp: 6, maxUp: 80 }, (x, y, z, nx, nz, h, dy) => {
      if (((x - body.x) * hx + (z - body.z) * hz) / h < 0.05) return;
      // the rope may be reeled in to clear the street; an anchor that would need more than half of it shortened is a zip, not a swing
      if (y - ground - cfg.swingClearance < cfg.reelLimit * Math.hypot(h, dy)) return;
      const score = scoreAnchor(view, x, y, z);
      if (score !== Infinity) insertRanked(ranked, { x, y, z, score, dist: Math.hypot(x - body.x, y - cy, z - body.z) }, CFG.keep);
    });
    // line of sight, best first, for a bounded number of candidates
    const valid = this._validList; valid.length = 0;
    for (let i = 0, checks = 0; i < ranked.length && checks < CFG.losChecks && valid.length < 1 + CFG.alternatives; i++, checks++) {
      const c = ranked[i];
      if (world.lineClear(body.x, cy, body.z, c.x, c.y, c.z) && world.lineClear(view.px, view.py, view.pz, c.x, c.y, c.z, 1.6)) valid.push(c);
    }
    // keep or switch
    const cur = this.selected;
    let curScore = Infinity;
    if (cur) {
      curScore = scoreAnchor(view, cur.x, cur.y, cur.z);
      if (curScore !== Infinity && !(world.lineClear(body.x, cy, body.z, cur.x, cur.y, cur.z) && world.lineClear(view.px, view.py, view.pz, cur.x, cur.y, cur.z, 1.6))) curScore = Infinity;
      if (curScore !== Infinity) cur.score = curScore;
    }
    const pick = chooseTarget(valid, cur, curScore, this._missing, step);
    this._missing = pick.missing;
    this.selected = pick.target;
    this.valid = !!pick.target && !pick.stale;
    this.alternatives.length = 0;
    for (const c of valid) if (!same(c, this.selected) && this.alternatives.length < CFG.alternatives) this.alternatives.push(c);
  }

  /** The target to shoot at right now (null when there is none). */
  current() { return this.valid ? this.selected : null; }

  /** Moves the DOM marker. `camera` must have up-to-date matrices. Call every frame (hides itself when inactive). */
  render(camera, visible) {
    const ui = this._ui;
    if (!ui) return;
    if (!visible) { if (ui.visible) { ui.root.classList.remove('is-on'); ui.visible = false; } return; }
    if (!ui.visible) { ui.root.classList.add('is-on'); ui.visible = true; }
    const w = innerWidth, h = innerHeight, t = this._tmp;
    const place = (el, p, size) => {
      if (!p) { el.style.display = 'none'; return false; }
      t.x = p.x; t.y = p.y; t.z = p.z;
      const ok = project(camera, t, w, h);
      if (!ok) { el.style.display = 'none'; return false; }
      el.style.display = 'block';
      el.style.transform = `translate3d(${t.x.toFixed(1)}px, ${t.y.toFixed(1)}px, 0) translate(-50%, -50%)`;
      if (size) el.style.setProperty('--sr-size', `${size.toFixed(0)}px`);
      return true;
    };
    ui.center.classList.toggle('is-none', !this.valid);
    const sel = this.selected;
    const shown = place(ui.target, sel, sel ? Math.max(22, Math.min(46, 50 - sel.dist * 0.22)) : 0);
    ui.target.classList.toggle('is-stale', shown && !this.valid);
    ui.target.classList.toggle('is-hit', this._flash > 0 && this._flashKind === 'hit');
    ui.center.classList.toggle('is-miss', this._flash > 0 && this._flashKind === 'miss');
    for (let i = 0; i < ui.alts.length; i++) place(ui.alts[i], this.alternatives[i] || null, 0);
  }

  dispose() { if (this._ui) this._ui.root.remove(); }
}

/** Projects (t.x, t.y, t.z) to screen pixels in place; false when behind the camera. */
function project(camera, t, w, h) {
  const m = camera.matrixWorldInverse.elements;
  const vz = m[2] * t.x + m[6] * t.y + m[10] * t.z + m[14];
  if (vz > -0.2) return false;
  const vx = m[0] * t.x + m[4] * t.y + m[8] * t.z + m[12], vy = m[1] * t.x + m[5] * t.y + m[9] * t.z + m[13];
  const p = camera.projectionMatrix.elements; // symmetric perspective: ndc = view * focal / -z
  const ndcX = vx * p[0] / -vz, ndcY = vy * p[5] / -vz;
  if (Math.abs(ndcX) > 1.2 || Math.abs(ndcY) > 1.2) return false;
  t.x = (ndcX * 0.5 + 0.5) * w; t.y = (-ndcY * 0.5 + 0.5) * h;
  return true;
}

export { WebTargeting, scoreAnchor, chooseTarget, insertRanked, project, CFG as TARGETING };
