// Portfolio billboards: the owner's profile (content/profile.json, see portfolio-content.js) shown as advertising boards mounted flat on building walls above the street,
// and the map pins and F-key spots that lead to them. Everything shown comes from the profile: an empty field is not drawn and a section without content has no board, so
// nothing here is invented. Boards are drawn once into canvas textures (2048 x 1024).
//
// Boards: HQ (photo, name, role, tagline, tech, website), one per project (image when it loads, title, tagline, up to 3 tags, website), Skills, Contact, and up to
// SITE_RULES.decorMax repeats of the HQ board. Where each goes is decided by allocateBoards(): the first candidate site of the category (portfolio-sites.js) that has a flat
// wall, does not overlap a board already placed and is not too close to one. A section that cannot be placed is reported with a warning (never skipped silently).
//
// Times Square: when main.js passes the city's screen slots (buildings.js: userData.timesSquareSlots), every board goes on a Times Square screen instead (allocateSlots: wide enough,
// low enough to read, in sight of a sidewalk, markers at least 16 m apart), as an LED screen (tsl-materials.js createLedScreenMaterial); every other slot shows a decor screen of the
// profile in the shape of that screen (drawBanner); the original posters are removed. A board that finds no screen falls back to the city-wide sites below. ?portfolioTs=0 turns it off.
//
//   profileBoards(...) -> { group, pins, boards, spots, warnings, timesSquare }

// W x H is the size of the canvas being drawn: 2048 x 1024 for a board on a wall, the shape of the screen for a Times Square slot (withSize sets it for one drawing).
let W = 2048, H = 1024;
const FONT = '"Inter", "Helvetica Neue", Arial, sans-serif';
const YELLOW = '#ffc82e', RED = '#c8102e';
const SIZE = { hq: [16, 8], section: [14, 7] };
function withSize(w, h, fn) { const ow = W, oh = H; W = w; H = h; try { return fn(); } finally { W = ow; H = oh; } }

/** Draws `img` into the rectangle (x, y, w, h) like CSS object-fit: cover: cropped, never stretched. */
function drawCover(ctx, img, x, y, w, h) {
  const ar = img.width / img.height, br = w / h;
  let sx = 0, sy = 0, sw = img.width, sh = img.height;
  if (ar > br) { sw = img.height * br; sx = (img.width - sw) / 2; } else { sh = img.width / br; sy = (img.height - sh) / 2; }
  ctx.drawImage(img, sx, sy, sw, sh, x, y, w, h);
}
function roundRect(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
/** Largest font size (<= max) at which `text` fits in `width`. */
function fit(ctx, text, width, max, weight = 800) { let s = max; for (; s > 24; s -= 4) { ctx.font = `${weight} ${s}px ${FONT}`; if (ctx.measureText(text).width <= width) break; } return s; }
function wrap(ctx, text, width) { const out = []; let line = ''; for (const word of String(text).split(/\s+/)) { const t = line ? line + ' ' + word : word; if (line && ctx.measureText(t).width > width) { out.push(line); line = word; } else line = t; } if (line) out.push(line); return out; }
const display = (url) => String(url).replace(/^https?:\/\//, '').replace(/\/$/, '');
const short = (s, n = 18) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);

function background(ctx) {
  const g = ctx.createLinearGradient(0, 0, W, H); g.addColorStop(0, '#0d0f16'); g.addColorStop(0.55, '#171a26'); g.addColorStop(1, '#2a0b13');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = 'rgba(255,255,255,0.05)'; ctx.lineWidth = 2; // a faint web
  const cx = W * 0.86, cy = H * 0.1;
  for (let a = 0; a < 12; a++) { ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(a * Math.PI / 6) * 1800, cy + Math.sin(a * Math.PI / 6) * 1800); ctx.stroke(); }
  for (let r = 160; r < 1800; r += 190) { ctx.beginPath(); for (let a = 0; a <= 12; a++) { const x = cx + Math.cos(a * Math.PI / 6) * r * (a % 2 ? 0.93 : 1), y = cy + Math.sin(a * Math.PI / 6) * r * (a % 2 ? 0.93 : 1); a ? ctx.lineTo(x, y) : ctx.moveTo(x, y); } ctx.stroke(); }
  ctx.fillStyle = RED; ctx.fillRect(0, H - 22, W, 22);
}

function pill(ctx, text, x, y, size, fill, ink) { ctx.font = `700 ${size}px ${FONT}`; const w = ctx.measureText(text).width + size * 1.1, h = size * 1.7; ctx.fillStyle = fill; roundRect(ctx, x, y, w, h, h / 2); ctx.fill(); ctx.fillStyle = ink; ctx.textBaseline = 'middle'; ctx.fillText(text, x + size * 0.55, y + h / 2 + 2); ctx.textBaseline = 'alphabetic'; return w; }
function websitePill(ctx, url, x, tw, pad) { const label = display(url); ctx.font = `800 ${Math.min(76, fit(ctx, label, tw - 70, 76))}px ${FONT}`; const w = ctx.measureText(label).width + 70; ctx.fillStyle = RED; roundRect(ctx, x, H - pad - 22 - 120, w, 120, 60); ctx.fill(); ctx.fillStyle = '#fff'; ctx.textBaseline = 'middle'; ctx.fillText(label, x + 35, H - pad - 22 - 56); ctx.textBaseline = 'alphabetic'; }
/** The picture of a board (profile photo or project image) as a framed square on the left; returns the x where the text starts. */
function framedImage(ctx, img, pad) {
  const ph = H - 2 * pad - 22;
  ctx.save(); roundRect(ctx, pad, pad, ph, ph, 36); ctx.clip(); drawCover(ctx, img, pad, pad, ph, ph); ctx.restore();
  ctx.lineWidth = 8; ctx.strokeStyle = YELLOW; roundRect(ctx, pad, pad, ph, ph, 36); ctx.stroke();
  return pad + ph + 90;
}

/** The identity board: the profile photo, the name and whatever of role / tagline / website / tech the profile has. */
function drawProfile(ctx, p, photo) {
  background(ctx);
  const pad = 70, x = photo ? framedImage(ctx, photo, pad) : pad;
  const tw = W - x - pad; ctx.textAlign = 'left'; ctx.fillStyle = YELLOW; ctx.font = `800 54px ${FONT}`; ctx.fillText('PORTFOLIO', x, pad + 70);
  const s = fit(ctx, p.name, tw, 190); ctx.fillStyle = '#fff'; ctx.font = `800 ${s}px ${FONT}`; ctx.fillText(p.name, x, pad + 70 + s * 1.05);
  let y = pad + 70 + s * 1.05 + 40;
  if (p.role) { ctx.fillStyle = '#e9ecf3'; ctx.font = `600 ${Math.min(86, fit(ctx, p.role, tw, 86, 600))}px ${FONT}`; ctx.fillText(p.role, x, y + 70); y += 120; }
  if (p.tagline) { ctx.fillStyle = '#aab1c2'; ctx.font = `500 52px ${FONT}`; for (const l of wrap(ctx, p.tagline, tw).slice(0, 3)) { ctx.fillText(l, x, y + 52); y += 66; } y += 20; }
  if (p.tech && p.tech.length) { let tx = x; ctx.font = '700 44px ' + FONT; for (const t of p.tech.slice(0, 8)) { const w = ctx.measureText(t).width + 50; if (tx + w > W - pad) break; pill(ctx, t, tx, y, 44, 'rgba(255,255,255,0.12)', '#fff'); tx += w + 18; } y += 100; }
  if (p.website) websitePill(ctx, p.website, x, tw, pad);
}

/** A project board: a compact advertisement. Title, tagline, the project's image when there is one, up to 3 tags, the website. The description stays in the F-key panel. */
function drawProject(ctx, p, img) {
  background(ctx);
  const pad = 70, x = img ? framedImage(ctx, img, pad) : pad + 10;
  const tw = W - x - pad; ctx.textAlign = 'left'; ctx.fillStyle = YELLOW; ctx.font = `800 54px ${FONT}`;
  ctx.fillText((p.category || (p.featured ? 'Featured project' : 'Project')).toUpperCase(), x, pad + 70);
  const s = fit(ctx, p.title, tw, 170); ctx.fillStyle = '#fff'; ctx.font = `800 ${s}px ${FONT}`; ctx.fillText(p.title, x, pad + 70 + s * 1.05);
  let y = pad + 70 + s * 1.05 + 40;
  if (p.tagline) { ctx.fillStyle = '#c4cad8'; ctx.font = `500 56px ${FONT}`; for (const l of wrap(ctx, p.tagline, tw).slice(0, 3)) { ctx.fillText(l, x, y + 56); y += 70; } y += 24; }
  if (p.tags && p.tags.length) { let tx = x; ctx.font = '700 44px ' + FONT; for (const t of p.tags.slice(0, 3)) { const w = ctx.measureText(t).width + 50; if (tx + w > W - pad) break; pill(ctx, t, tx, y, 44, 'rgba(255,255,255,0.12)', '#fff'); tx += w + 18; } }
  if (p.url) websitePill(ctx, p.url, x, tw, pad);
}

/** A list board: a title and lines (technologies, contact links). */
function drawList(ctx, title, kicker, lines) {
  background(ctx); const pad = 80; ctx.textAlign = 'left';
  ctx.fillStyle = YELLOW; ctx.font = `800 54px ${FONT}`; ctx.fillText(kicker.toUpperCase(), pad, pad + 56);
  ctx.fillStyle = '#fff'; ctx.font = `800 ${fit(ctx, title, W - 2 * pad, 150)}px ${FONT}`; ctx.fillText(title, pad, pad + 56 + 150);
  let y = pad + 56 + 150 + 60; ctx.fillStyle = '#d9dde8';
  for (const l of lines.slice(0, 5)) { ctx.font = `600 ${Math.min(64, fit(ctx, l, W - 2 * pad, 64, 600))}px ${FONT}`; ctx.fillText(l, pad, y + 60); y += 100; }
}

/** Largest size (<= max) at which `text` wraps into at most `maxLines` lines of `width`; returns { size, lines }. */
function fitLines(ctx, text, width, max, maxLines, weight = 800) {
  for (let s = max; s >= 28; s -= 4) { ctx.font = `${weight} ${s}px ${FONT}`; const lines = wrap(ctx, text, width); if (lines.length <= maxLines && lines.every((l) => ctx.measureText(l).width <= width)) return { size: s, lines }; }
  ctx.font = `${weight} 28px ${FONT}`; const lines = wrap(ctx, text, width).slice(0, maxLines); return { size: 28, lines };
}

/** A screen of any shape (tall, square, wide): picture, kicker, title and a few lines of text, in the look of the boards. `item`: { kicker, title, sub, img }. */
function drawBanner(ctx, item) {
  background(ctx);
  const portrait = W / H < 1.2, k = portrait ? W / 1100 : H / 1024, pad = Math.round(80 * k);
  let x = pad, y = pad, tw = W - 2 * pad;
  if (item.img) {
    const s = portrait ? Math.min(W - 2 * pad, Math.round(H * 0.4)) : H - 2 * pad - 22, ix = portrait ? Math.round((W - s) / 2) : pad;
    ctx.save(); roundRect(ctx, ix, pad, s, s, 30 * k); ctx.clip(); drawCover(ctx, item.img, ix, pad, s, s); ctx.restore();
    ctx.lineWidth = 8 * k; ctx.strokeStyle = YELLOW; roundRect(ctx, ix, pad, s, s, 30 * k); ctx.stroke();
    if (portrait) y = pad + s + Math.round(pad * 0.7); else { x = pad + s + Math.round(pad * 1.1); tw = W - x - pad; }
  }
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = YELLOW; ctx.font = `800 ${Math.round(54 * k)}px ${FONT}`; ctx.fillText(String(item.kicker || '').toUpperCase(), x, y + 54 * k);
  y += 54 * k + 24 * k;
  const t = fitLines(ctx, item.title, tw, Math.round(180 * k), portrait ? 4 : 3);
  ctx.fillStyle = '#fff'; ctx.font = `800 ${t.size}px ${FONT}`;
  for (const l of t.lines) { y += t.size * 1.02; ctx.fillText(l, x, y); }
  y += 36 * k;
  if (item.sub) {
    const room = Math.max(1, Math.floor((H - 22 - pad - y) / (60 * k * 1.28)));
    const sb = fitLines(ctx, item.sub, tw, Math.round(58 * k), Math.min(room, portrait ? 5 : 3), 500);
    ctx.fillStyle = '#c4cad8'; ctx.font = `500 ${sb.size}px ${FONT}`;
    for (const l of sb.lines) { y += sb.size * 1.28; ctx.fillText(l, x, y); }
  }
  let floor = H - 22 - pad * 0.5;
  if (item.url) { // the website, a red pill on the foot
    const label = display(item.url), fs = Math.min(Math.round(70 * k), fit(ctx, label, tw - 60 * k, Math.round(70 * k))); ctx.font = `800 ${fs}px ${FONT}`;
    const w = ctx.measureText(label).width + 60 * k, h = fs * 1.9, by = floor - h;
    if (by > y + 20 * k) { ctx.fillStyle = RED; roundRect(ctx, x, by, w, h, h / 2); ctx.fill(); ctx.fillStyle = '#fff'; ctx.textBaseline = 'middle'; ctx.fillText(label, x + 30 * k, by + h / 2 + 2); ctx.textBaseline = 'alphabetic'; floor = by - 24 * k; }
  }
  if (item.tags && item.tags.length) { // up to three tags in a row, if there is room
    const size = Math.round(44 * k); let tx = x; ctx.font = `700 ${size}px ${FONT}`;
    if (y + 24 * k + size * 1.7 < floor) for (const t of item.tags.slice(0, 3)) { const w = ctx.measureText(t).width + size * 1.1; if (tx + w > x + tw) break; pill(ctx, t, tx, y + 24 * k, size, 'rgba(255,255,255,0.12)', '#fff'); tx += w + 18 * k; ctx.font = `700 ${size}px ${FONT}`; }
  }
}

function loadImage(url) { return new Promise((res) => { if (!url) return res(null); const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = url; }); }

/**
 * Mounts a board of w x h metres flat on a building wall: from the street point (x, z) a horizontal ray is cast along `dir` at several heights and across the width; the wall must
 * be one flat face (same distance and normal everywhere) that goes on above the board. Returns { px, pz, nx, nz, y } or null.
 */
function mountOnWall(world, x, z, dir, w, h, yMid, maxDist = 34) {
  const tx = -dir[1], tz = dir[0], hits = [];
  for (const o of [-w * 0.48, 0, w * 0.48]) for (const y of [yMid - h / 2, yMid, yMid + h / 2]) {
    const r = world.rayFirstHit(x + tx * o, y, z + tz * o, dir[0], 0, dir[1], maxDist);
    if (!r || Math.abs(r.nx * dir[0] + r.nz * dir[1] + 1) > 0.06) return null;
    hits.push(r);
  }
  const t0 = hits[4].t; for (const r of hits) if (Math.abs(r.t - t0) > 0.35) return null;
  const up = world.rayFirstHit(x, yMid + h / 2 + 2.5, z, dir[0], 0, dir[1], maxDist); // the wall continues above the board
  if (!up || Math.abs(up.t - t0) > 0.6) return null;
  const clear = world.rayFirstHit(x, 1.6, z, dir[0], 0, dir[1], t0 - 0.5); // nothing standing between the street point and the wall
  if (clear) return null;
  return { px: x + dir[0] * (t0 - 0.1), pz: z + dir[1] * (t0 - 0.1), nx: -dir[0], nz: -dir[1], y: yMid, dist: t0 };
}

/** Looks around a street point for a wall that takes a board of the given size, avoiding `placed` boards. */
function findWall(world, sx, sz, size, prefer = null, placed = [], gap = 2) {
  let dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  if (prefer) dirs = [prefer, ...dirs.filter((d) => d[0] !== prefer[0] || d[1] !== prefer[1])];
  for (const [w, h] of [size, [size[0] * 0.75, size[1] * 0.75]]) for (const yMid of [15, 19, 23]) for (const lateral of [0, 6, -6, 12, -12, 20, -20]) for (const d of dirs) {
    const x = sx + (d[0] ? 0 : lateral), z = sz + (d[1] ? 0 : lateral);
    const m = mountOnWall(world, x, z, d, w, h, yMid);
    if (m && !overlaps(m, w, h, placed, gap)) return { ...m, w, h, street: { x, z }, dir: d };
  }
  return null;
}

/**
 * Where a visitor arrives to look at a mounted board, and where its F marker and map pin go: a point on a pedestrian sidewalk (not in the roadway, not inside a building or an
 * obstacle) in front of the board with a clear line of sight to it, at a comfortable distance (the near sidewalk is too close to see a board 15 m up; the opposite one is ideal).
 * `ground`: { onSidewalk(x, z), blocked(x, z, r), landmarks?: [{ x, z }] } from the city (main.js). Returns { x, z, d } or null.
 */
function findStandSpot(world, ground, m, ideal = 18, maxD = 38, avoid = null, avoidR = 0) {
  const ox = -m.dir[0], oz = -m.dir[1], tx = -oz, tz = ox; // away from the wall; along the wall
  let best = null;
  for (let d = 3; d <= maxD; d++) for (const lat of [0, 2, -2, 4, -4, 7, -7]) {
    const x = m.px + ox * d + tx * lat, z = m.pz + oz * d + tz * lat;
    if (!ground.onSidewalk(x, z) || ground.blocked(x, z, 1.1)) continue;
    if (avoid && avoid.some((o) => Math.hypot(o.x - x, o.z - z) < avoidR)) continue; // another board's marker is there
    const bx = m.px - x, by = m.y - 1.7, bz = m.pz - z, L = Math.hypot(bx, by, bz);
    const hit = world.rayFirstHit(x, 1.7, z, bx / L, by / L, bz / L, L + 1); // the board must be in sight, not hidden behind another building or a stand
    if (hit && hit.t < L - 1.5) continue;
    let score = Math.abs(d - ideal) + Math.abs(lat) * 0.6;
    for (const l of ground.landmarks || []) if (Math.hypot(l.x - x, l.z - z) < 55) { score += 40; break; } // keep the marker and its map pin off the landmarks' own pins
    if (!best || score < best.score) best = { x, z, d, score };
  }
  return best;
}

/** Would a board centred at (m.px, m.y, m.pz) of w x h overlap, or touch, one of `placed`? (Conservative: horizontal distance and height, whatever wall they are on.) */
function overlaps(m, w, h, placed, gap) {
  return placed.some((b) => Math.abs(b.y - m.y) < (b.h + h) / 2 + gap && Math.hypot(b.x - m.px, b.z - m.pz) < (b.w + w) / 2 + gap);
}

/**
 * Finds a place for each request. `requests`: [{ key, category, size, label }] in priority order. `sites`: { hq, project, skills, contact, decor, pool } (portfolio-sites.js).
 * A request tries its category's candidates, then the pool, taking the first with a flat, free wall that is far enough from the boards already placed (`rules.minSpacing`).
 * Returns { placements: Map(key -> { ...wall, site, w, h }), warnings }.
 */
function allocateBoards({ world, requests, sites, rules, placed = [] }) {
  const placements = new Map(), warnings = [], streets = [];
  for (const r of requests) {
    const own = sites[r.category] || [], list = [...own, ...(sites.pool || []).filter((c) => !own.some((o) => o.id === c.id))];
    let tried = 0, found = null;
    for (const c of list) {
      if (r.category !== 'hq' && streets.some((s) => Math.hypot(s.x - c.x, s.z - c.z) < (s.kind === 'hq' ? rules.hqSpacing : rules.minSpacing))) continue;
      tried++;
      const m = findWall(world, c.x, c.z, r.size, c.prefer, placed, rules.gap);
      if (m) { found = { ...m, site: c }; break; }
    }
    if (!found) { warnings.push(`${r.label}: no board placed (${tried} candidate sites tried, none with a flat free wall far enough from the other boards)`); continue; }
    placed.push({ x: found.px, y: found.y, z: found.pz, w: found.w, h: found.h });
    streets.push({ x: found.street.x, z: found.street.z, kind: r.category });
    placements.set(r.key, found);
  }
  return { placements, warnings };
}

// ---------------------------------------------------------------------------------------------------------------- Times Square
// Times Square's screens (buildings.js: userData.timesSquareSlots, { x, y, z, w, h, rotY } with the screen's front facing (sin rotY, cos rotY)) are the places of the boards:
// the boards of the profile take the best slots (a wide enough shape for the layout, low enough to read, in sight of a sidewalk and spread out so every F marker is its own
// place), every other slot gets a decor screen of the same look, and the original posters are removed.
const TS_RULES = { minArea: 60, aspectMin: 0.6, aspectMax: 3.4, wideMin: 1.7, maxY: 42, spacing: 16, ideal: 32, maxStand: 72 }; // wideMin: the board layouts need this shape, a narrower screen gets the banner layout

const slotMount = (s) => { const nx = Math.sin(s.rotY), nz = Math.cos(s.rotY); return { px: s.x, y: s.y, pz: s.z, nx, nz, dir: [-nx, -nz], w: s.w, h: s.h }; };

/**
 * Chooses a slot for each request (priority order). `centre`: { x, z } the middle of the square (the identity board wants to be there). Returns
 * { placements: Map(key -> { slot, index, ...mount, stand: { x, z } }), used: Set(index), warnings }.
 */
function allocateSlots({ world, requests, slots, ground = null, centre = null, rules = TS_RULES }) {
  const placements = new Map(), warnings = [], used = new Set(), stands = [];
  const cand = [];
  slots.forEach((s, i) => { const a = s.w / s.h; if (s.w * s.h >= rules.minArea && a >= rules.aspectMin && a <= rules.aspectMax && s.y <= rules.maxY) cand.push(i); });
  // a stand spot for slot i that is not within `spacing` of another board's (the markers open a panel within 6 m, so they only need to be apart)
  const standOf = (i) => {
    const m = slotMount(slots[i]);
    if (!ground) { const st = { x: m.px + m.nx * 22, z: m.pz + m.nz * 22 }; return stands.some((o) => Math.hypot(o.x - st.x, o.z - st.z) < rules.spacing) ? null : st; }
    return findStandSpot(world, ground, m, rules.ideal, rules.maxStand, stands, rules.spacing);
  };
  for (const r of requests) {
    const order = cand.filter((i) => !used.has(i)).map((i) => {
      const s = slots[i], dc = centre ? Math.hypot(s.x - centre.x, s.z - centre.z) : 0, a = s.w / s.h;
      return { i, score: Math.abs(Math.log(a / 2.1)) * 40 + s.y * 0.6 - Math.sqrt(s.w * s.h) * 1.2 + dc * (r.category === 'hq' ? 0.8 : 0.25) + (a < rules.wideMin ? 25 : 0) };
    }).sort((a, b) => a.score - b.score);
    let found = null;
    for (const c of order) { const st = standOf(c.i); if (st) { found = { i: c.i, st }; break; } }
    if (!found) { warnings.push(`${r.label}: no Times Square screen free (${order.length} candidate slots, none in sight of a sidewalk and away from the other boards)`); continue; }
    used.add(found.i); stands.push(found.st);
    placements.set(r.key, { slot: slots[found.i], index: found.i, ...slotMount(slots[found.i]), stand: found.st });
  }
  return { placements, used, warnings };
}

/** One merged mesh geometry of screens: `list` [{ x, y, z, w, h, rotY, uv: [u0, v0, u1, v1] }] (the uv window of the texture each screen shows). */
function screenGeometry(THREE, list) {
  const pos = [], nrm = [], uvs = [], idx = [];
  list.forEach((s, n) => {
    const c = Math.cos(s.rotY), sn = Math.sin(s.rotY), rx = c, rz = -sn, nx = sn, nz = c, hw = s.w / 2, hh = s.h / 2, [u0, v0, u1, v1] = s.uv;
    for (const [ox, oy, u, v] of [[-1, -1, u0, v0], [1, -1, u1, v0], [1, 1, u1, v1], [-1, 1, u0, v1]]) { pos.push(s.x + rx * hw * ox, s.y + hh * oy, s.z + rz * hw * ox); nrm.push(nx, 0, nz); uvs.push(u, v); }
    idx.push(n * 4, n * 4 + 1, n * 4 + 2, n * 4, n * 4 + 2, n * 4 + 3);
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(idx);
  return g;
}

/** The uv window that shows a texture of aspect `ta` on a screen of aspect `sa` like CSS object-fit: cover (cropped, never stretched). */
function coverWindow(ta, sa) {
  if (sa > ta) { const f = ta / sa; return [0, 0.5 - f / 2, 1, 0.5 + f / 2]; }
  const f = sa / ta; return [0.5 - f / 2, 0, 0.5 + f / 2, 1];
}

/**
 * @param o { THREE, scene, world, profile, sites, rules, log }
 *   profile  normalised (portfolio-content.js): profile.photoUrl, project.imageUrl are loaded here; an image that does not load is reported and dropped
 *   ground   optional { onSidewalk, blocked, landmarks } (main.js): markers and pins are put on a sidewalk in sight of the board (findStandSpot); without it, at the street point
 * @returns {{ group, pins, boards, spots, warnings }}  spots: Map(projectId | 'portfolio-contact' -> { x, z, heading, placed })
 */
async function profileBoards({ THREE, scene, world, profile, sites, rules, ground = null, timesSquare = null, log = console.warn }) {
  const group = new THREE.Group(); group.name = 'PortfolioBillboards';
  const pins = [], boards = [], spots = new Map(), warnings = [];
  const warn = (m) => { warnings.push(m); log(`[portfolio] ${m}`); };
  if (!profile || !profile.name) return { group, pins, boards, spots, warnings };

  // images: the photo and every project image, in parallel; a failure is a warning, not an error
  const photo = await loadImage(profile.photoUrl);
  if (profile.photo && !photo) warn(`profile photo "${profile.photo}" not found or not an image; the identity board is drawn without it`);
  const imgs = await Promise.all(profile.projects.map((p) => loadImage(p.imageUrl)));
  profile.projects.forEach((p, i) => { if (p.image && !imgs[i]) { warn(`project "${p.title}": image "${p.image}" not found or not an image; drawn without it`); p.imageUrl = null; p.imageFailed = true; } });

  const requests = [{ key: 'hq', category: 'hq', size: SIZE.hq, label: 'Profile (HQ)' }];
  const order = [...profile.projects].sort((a, b) => (b.featured ? 1 : 0) - (a.featured ? 1 : 0)); // featured projects first (stable otherwise)
  for (const p of order) requests.push({ key: 'p:' + p.id, category: 'project', size: SIZE.section, label: `Project "${p.title}"` });
  if (profile.tech.length) requests.push({ key: 'skills', category: 'skills', size: SIZE.section, label: 'Skills & Technologies' });
  if (profile.links.length) requests.push({ key: 'contact', category: 'contact', size: SIZE.section, label: 'Contact & Links' });
  // Times Square: when the city offers its screens, every board goes there (the city-wide sites are only the fallback for a board that finds no screen)
  const ts = timesSquare && timesSquare.slots && timesSquare.slots.length ? timesSquare : null;
  let tsAlloc = null;
  if (ts) { tsAlloc = allocateSlots({ world, requests, slots: ts.slots, ground, centre: ts.centre || null, rules: { ...TS_RULES, ...(ts.rules || {}) } }); for (const w of tsAlloc.warnings) warn(w); }
  else for (let i = 0; i < rules.decorMax; i++) requests.push({ key: 'decor' + i, category: 'decor', size: SIZE.hq, label: 'Identity board repeat' });

  const rest = tsAlloc ? requests.filter((r) => !tsAlloc.placements.has(r.key)) : requests;
  const { placements: cityPlacements, warnings: aw } = allocateBoards({ world, requests: rest, sites, rules });
  const placements = new Map([...cityPlacements, ...(tsAlloc ? tsAlloc.placements : [])]);
  // the decor repeats are optional extras: a missing one is not worth a warning
  for (const w of aw) if (!/^Identity board repeat/.test(w)) warn(w);

  const makeSized = (w, h, draw) => withSize(w, h, () => { const c = document.createElement('canvas'); c.width = w; c.height = h; const ctx = c.getContext('2d'); draw(ctx); const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; t.generateMipmaps = true; return t; });
  const make = (draw, p = null, alt = null) => { // a board on a wall: 2048 x 1024; on a Times Square screen: the shape of that screen (a narrow one gets the banner layout `alt`)
    if (!p || !p.slot) return makeSized(2048, 1024, draw);
    const a = Math.min(TS_RULES.aspectMax, Math.max(TS_RULES.aspectMin, p.w / p.h)), w = a >= 1 ? Math.round(1024 * a) : 1024, h = a >= 1 ? 1024 : Math.round(1024 / a);
    return makeSized(w, h, a < TS_RULES.wideMin && alt ? alt : draw);
  };
  const frameMat = new THREE.MeshBasicMaterial({ color: 0x15171d }), lampMat = new THREE.MeshBasicMaterial({ color: 0xfff1c2 });
  const ledMat = (tex) => (ts && ts.led ? ts.led(tex) : new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }));
  const mount = (m, tex, label) => {
    if (m.slot) { // a Times Square screen: an LED panel flush on the wall, no frame (the bezel is in the shader)
      const mesh = new THREE.Mesh(screenGeometry(THREE, [{ x: m.px, y: m.y, z: m.pz, w: m.w, h: m.h, rotY: m.slot.rotY, uv: coverWindow(tex.image.width / tex.image.height, m.w / m.h) }]), ledMat(tex));
      mesh.name = 'PortfolioScreen'; group.add(mesh);
      boards.push({ x: m.px, y: m.y, z: m.pz, w: m.w, h: m.h });
      return { x: m.stand.x, z: m.stand.z, heading: Math.atan2(m.px - m.stand.x, m.pz - m.stand.z), sidewalk: !!ground };
    }
    const panel = new THREE.Mesh(new THREE.PlaneGeometry(m.w, m.h), new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }));
    const frame = new THREE.Mesh(new THREE.BoxGeometry(m.w + 0.7, m.h + 0.7, 0.3), frameMat);
    const lamp = new THREE.Mesh(new THREE.BoxGeometry(m.w * 0.9, 0.18, 0.5), lampMat);
    const holder = new THREE.Group(); holder.position.set(m.px, m.y, m.pz); holder.rotation.y = Math.atan2(m.nx, m.nz); // the panel's front (+z) faces away from the wall
    frame.position.z = -0.12; panel.position.z = 0.05; lamp.position.set(0, m.h / 2 + 0.55, 0.15);
    holder.add(frame, panel, lamp); group.add(holder);
    boards.push({ x: m.px, y: m.y, z: m.pz, w: m.w, h: m.h });
    // arrival: standing on a sidewalk in sight of the board, looking at it (without city ground data, e.g. in tests: the street point the board was found from)
    const s = ground ? findStandSpot(world, ground, m) : null;
    if (ground && !s) warn(`${label || 'Board'}: no sidewalk position with a clear view of the board; its marker and pin use the street point`);
    const x = s ? s.x : m.street.x, z = s ? s.z : m.street.z;
    return { x, z, heading: Math.atan2(m.px - x, m.pz - z), sidewalk: !!s };
  };

  const hq = placements.get('hq');
  const profileTex = !hq || hq.slot ? null : make((ctx) => drawProfile(ctx, profile, photo)); // on a wall the identity board is drawn once and shared with its repeats
  if (hq) pins.push({ id: 'portfolio-hq', name: `${profile.name} · Portfolio HQ`, short: 'Portfolio HQ', kind: 'hq', ...mount(hq, profileTex || make((ctx) => drawProfile(ctx, profile, photo), hq, (ctx) => drawBanner(ctx, { kicker: 'Portfolio', title: profile.name, sub: [profile.role, profile.tagline].filter(Boolean).join(' · '), img: photo, tags: (profile.tech || []).slice(0, 3), url: profile.website })), 'Profile (HQ)') });
  if (!ts && profileTex) for (let i = 0; i < rules.decorMax; i++) { const m = placements.get('decor' + i); if (m) mount(m, profileTex); }

  // A project without a wall gets no pin and no F-key spot (it is reported above): a pin must never point at an unrelated place.
  profile.projects.forEach((p, i) => {
    const m = placements.get('p:' + p.id), img = imgs[i];
    if (!m) return;
    const a = mount(m, make((ctx) => drawProject(ctx, p, img), m, (ctx) => drawBanner(ctx, { kicker: p.category || (p.featured ? 'Featured project' : 'Project'), title: p.title, sub: p.tagline || '', img, tags: (p.tags || []).slice(0, 3), url: p.url })), `Project "${p.title}"`);
    spots.set(p.id, { ...a, placed: true });
    pins.push({ id: 'project-' + p.id, name: `Project · ${p.title}`, short: short(p.title), kind: 'project', projectId: p.id, ...a });
  });
  const sk = placements.get('skills');
  if (sk) pins.push({ id: 'portfolio-skills', name: 'Skills & Technologies', short: 'Skills', kind: 'skills', ...mount(sk, make((ctx) => drawList(ctx, 'Skills & Technologies', 'Toolbox', [profile.tech.slice(0, 4).join(' · '), profile.tech.slice(4, 8).join(' · ')].filter(Boolean)), sk, (ctx) => drawBanner(ctx, { kicker: 'Toolbox', title: 'Skills & Technologies', sub: profile.tech.slice(0, 8).join(' · ') })), 'Skills & Technologies') });
  const ct = placements.get('contact');
  if (ct) {
    const a = mount(ct, make((ctx) => drawList(ctx, 'Contact & Links', 'Get in touch', profile.links.map((l) => `${l.label}: ${display(l.url)}`)), ct, (ctx) => drawBanner(ctx, { kicker: 'Get in touch', title: 'Contact & Links', sub: profile.links.map((l) => `${l.label}: ${display(l.url)}`).join('  ·  ') })), 'Contact & Links');
    spots.set('portfolio-contact', { ...a, placed: true }); // the Contact F-key marker (its panel lists profile.links)
    pins.push({ id: 'portfolio-contact', name: 'Contact & Links', short: 'Contact', kind: 'contact', ...a });
  }

  // Times Square: every other screen shows the profile too (picture, kicker, title and text in the shape of the screen), and the original posters are gone
  let screens = 0;
  if (ts && tsAlloc && tsAlloc.placements.size) {
    const items = [{ kicker: 'Portfolio', title: profile.name, sub: [profile.role, profile.tagline].filter(Boolean).join(' · '), img: photo }];
    profile.projects.forEach((p, i) => items.push({ kicker: p.category || 'Project', title: p.title, sub: p.tagline || '', img: imgs[i] }));
    if (profile.tech.length) items.push({ kicker: 'Toolbox', title: 'Skills & Technologies', sub: profile.tech.slice(0, 8).join(' · ') });
    if (profile.links.length) items.push({ kicker: 'Get in touch', title: 'Contact & Links', sub: profile.links.map((l) => l.label).join(' · ') });
    const CLASSES = { tall: [768, 1152], square: [1024, 1024], wide: [1536, 768] }, cache = new Map(), batches = new Map(), nItems = Math.min(items.length, 5); // few textures: the screens repeat
    ts.slots.forEach((s, i) => {
      if (tsAlloc.used.has(i)) return;
      const a = s.w / s.h, cls = a < 0.95 ? 'tall' : a < 1.45 ? 'square' : 'wide', n = (i * 3 + Math.floor(s.y / 9)) % nItems, key = `${n}|${cls}`;
      let t = cache.get(key); if (!t) { t = makeSized(CLASSES[cls][0], CLASSES[cls][1], (ctx) => drawBanner(ctx, items[n])); cache.set(key, t); batches.set(key, []); }
      batches.get(key).push({ x: s.x, y: s.y, z: s.z, w: s.w, h: s.h, rotY: s.rotY, uv: coverWindow(CLASSES[cls][0] / CLASSES[cls][1], a) });
      screens++;
    });
    for (const [key, list] of batches) { const mesh = new THREE.Mesh(screenGeometry(THREE, list), ledMat(cache.get(key))); mesh.name = 'PortfolioScreens'; group.add(mesh); }
    const old = []; scene.traverse((o) => { if (o.isMesh && /^TimesSquareBillboards_/.test(o.name)) old.push(o); });
    for (const o of old) { if (o.parent) o.parent.remove(o); if (o.geometry) o.geometry.dispose(); }
  }

  scene.add(group);
  return { group, pins, boards, spots, warnings, timesSquare: ts ? { boards: tsAlloc.placements.size, decor: screens } : null };
}

export { profileBoards, allocateBoards, allocateSlots, screenGeometry, coverWindow, drawBanner, TS_RULES, mountOnWall, findWall, findStandSpot, overlaps, drawCover, drawProject, drawProfile, drawList };
