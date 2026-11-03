import { probeWall } from './spider-wallrun.js';

// Wall clinging and crawling: the geometry. No three.js, no DOM: it only needs `world.rayFirstHit(ox, oy, oz, dx, dy, dz, maxT)` (spider-world.js, the building colliders). The movement
// state is SpiderController (state 'cling'); the parameters are SPIDER (spider-physics.js, the cling* keys); this module finds and follows the surface, maps the input onto it and finds
// the way round corners.
//
// Surfaces. `surface` = { nx, ny, nz (unit normal, pointing from the surface to the body), c (the plane is n . x = c), dist (distance of the contact point to it), kind }.
//   wall     a flat tall vertical face. Found with the wall-run probe (probeWall: flat, wide enough, tall enough, vertical normal), so a pipe, a sign, a kerb or a narrow pier is refused.
//   ceiling  the underside of a flat slab (a bridge deck, an overhang): found with a ray straight up. The collision data only has such undersides for the box colliders that start above
//            the ground (landmark parts, bridge decks); the building prisms have no underside, so a building's own overhang is never seen. Roofs and floors are not clung to (you stand on them).
// The body clings with its chest against the surface: the contact point C is the chest (the feet position + 1 m up), and its distance to the plane is cfg.clingOffset.
//
// Cost: while the cling key is held and the body is not on a surface: at most 30 probes a second of up to four rays (one per candidate direction) plus one up. While clinging: one probe
// of four rays at 30 Hz, and three more rays ahead while moving. Nothing else; no allocation (scratch objects are module-level or owned by the caller).

const CLING_INTERVAL = 1 / 30;
const hypot = Math.hypot;
const DIR = { x: 0, z: 0 };

function newSurface() { return { nx: 0, ny: 0, nz: 1, c: 0, dist: 0, kind: 'wall' }; }
function copySurface(d, s) { d.nx = s.nx; d.ny = s.ny; d.nz = s.nz; d.c = s.c; d.dist = s.dist; d.kind = s.kind; return d; }
/** The wall record of spider-wallrun.js as a surface. */
function surfaceFromWall(w, out) { out.nx = w.nx; out.ny = 0; out.nz = w.nz; out.c = w.c; out.dist = w.dist; out.kind = 'wall'; return out; }
const sameSurface = (a, b) => { const d = a.nx * b.nx + a.ny * b.ny + a.nz * b.nz; return d > 0.97 && Math.abs(a.c - b.c) < 0.7; };

/** A flat underside straight above the chest (cx, cy, cz) within `reach`: the normal points down. Fills `out` and returns true. */
function probeCeiling(world, cx, cy, cz, reach, cfg, out) {
  const r = world.rayFirstHit(cx, cy, cz, 0, 1, 0, reach);
  if (!r || r.ny > -0.9) return false;
  const P = cfg.clingPatch;
  for (let i = 0; i < 4; i++) {
    const ox = i === 0 ? P : i === 1 ? -P : 0, oz = i === 2 ? P : i === 3 ? -P : 0;
    const q = world.rayFirstHit(cx + ox, cy, cz + oz, 0, 1, 0, reach + 0.4);
    if (!q || q.ny > -0.9 || Math.abs(q.t - r.t) > 0.25) return false;
  }
  out.nx = 0; out.ny = -1; out.nz = 0; out.c = -(cy + r.t); out.dist = r.t; out.kind = 'ceiling';
  return true;
}

/**
 * A surface to cling to. `cand` = flat [dx, dz, ...] unit horizontal directions to look along (the caller decides: the stick), `n` of them. A wall must be within `reach` (from the body
 * axis) and seen within `facing` (cos) of straight on; with `ceiling` the underside above the chest within cfg.clingReachUp is tried last. Returns true and fills `out`.
 */
function findSurface(world, p, cand, n, cfg, out, tmpWall, ceiling = true, reach = cfg.clingReach, facing = 0.5) {
  for (let i = 0; i < n; i++) {
    const dx = cand[2 * i], dz = cand[2 * i + 1];
    let dup = false; for (let j = 0; j < i; j++) if (dx * cand[2 * j] + dz * cand[2 * j + 1] > 0.97) { dup = true; break; }
    if (dup) continue;
    if (!probeWall(world, p.x, p.y, p.z, dx, dz, reach, cfg.clingMinHeight, cfg, tmpWall)) continue;
    if (-(tmpWall.nx * dx + tmpWall.nz * dz) < facing) continue; // not facing the wall: a corner or a wall seen at a glancing angle
    return surfaceFromWall(tmpWall, out);
  }
  return ceiling ? probeCeiling(world, p.x, p.y + 1, p.z, cfg.clingReachUp, cfg, out) : false;
}

/**
 * The stick on the surface. `wx, wz` is the stick in the WORLD (camera relative, length 0..1, as the controller reads it). On a wall its direction is flattened onto the wall, and the part
 * that pushes INTO the wall (away from it) becomes "up" ("down"): with the camera looking at the wall W is up, S down, A / D left / right as it sees them; with the camera looking along
 * the wall W goes along it; and a stick that held its direction when a run turned into a crawl simply goes on in that direction. The length is kept (a rotation of the stick, never faster).
 * On a ceiling the stick is flattened onto it (the camera's forward and right). `out` gets x, y, z.
 */
function stickDirection(s, wx, wz, out) {
  const dot = wx * s.nx + wz * s.nz;
  if (Math.abs(s.ny) < 0.7) { out.x = wx - dot * s.nx; out.y = -dot; out.z = wz - dot * s.nz; } // a wall: the stick flattened onto it, and the push into it as up
  else { out.x = wx - dot * s.nx; out.y = -dot * s.ny; out.z = wz - dot * s.nz; } // a ceiling: just flattened
  return out;
}

/**
 * Crawling: `vel` {x, y, z} follows the stick on the surface (the direction (dx, dy, dz) from stickDirection, length 0..1) at up to `top` m/s: it accelerates towards the target with `accel`
 * and brakes with `brake` when there is no input (above the target speed it only slows down with `coast`), and it never has a part along the normal (no falling, no pushing into the
 * surface). Returns the speed in the plane.
 */
function crawlVelocity(vel, s, dx, dy, dz, top, accel, brake, h, coast = brake) {
  const vn = vel.x * s.nx + vel.y * s.ny + vel.z * s.nz; vel.x -= s.nx * vn; vel.y -= s.ny * vn; vel.z -= s.nz * vn;
  const m = hypot(dx, dy, dz);
  let tx = 0, ty = 0, tz = 0;
  if (m > 1e-6) { const k = top * Math.min(1, m) / m; tx = dx * k; ty = dy * k; tz = dz * k; }
  const ex = tx - vel.x, ey = ty - vel.y, ez = tz - vel.z, e = hypot(ex, ey, ez), cur = hypot(vel.x, vel.y, vel.z), want = hypot(tx, ty, tz);
  // above the target speed (a run that turns into a crawl) the speed is let go gently; otherwise accelerate towards the stick, or brake when there is none
  const rate = (cur > want + 0.5 && cur > top * 0.9 ? coast : m > 1e-6 ? accel : brake) * h;
  if (e <= rate || e < 1e-9) { vel.x = tx; vel.y = ty; vel.z = tz; } else { const k = rate / e; vel.x += ex * k; vel.y += ey * k; vel.z += ez * k; }
  return hypot(vel.x, vel.y, vel.z);
}

/** Turns the unit vector `head` (in the plane of `s`) about the normal towards (dx, dy, dz) by at most maxStep radians. The body's head leads the travel; it never snaps. */
function turnHead(head, s, dx, dy, dz, maxStep) {
  const cx = head.y * dz - head.z * dy, cy = head.z * dx - head.x * dz, cz = head.x * dy - head.y * dx;
  const sin = cx * s.nx + cy * s.ny + cz * s.nz, cos = head.x * dx + head.y * dy + head.z * dz;
  let a = Math.atan2(sin, cos); if (a > maxStep) a = maxStep; else if (a < -maxStep) a = -maxStep;
  const ca = Math.cos(a), sa = Math.sin(a);
  const nx = s.ny * head.z - s.nz * head.y, ny = s.nz * head.x - s.nx * head.z, nz = s.nx * head.y - s.ny * head.x; // n x head
  const x = head.x * ca + nx * sa, y = head.y * ca + ny * sa, z = head.z * ca + nz * sa, m = hypot(x, y, z) || 1;
  head.x = x / m; head.y = y / m; head.z = z / m;
  return a;
}

/** Puts `head` into the plane of `s` (after the surface changed); a vector with no part in the plane becomes the given fallback. */
function projectHead(head, s, fx, fy, fz) {
  const d = head.x * s.nx + head.y * s.ny + head.z * s.nz; let x = head.x - d * s.nx, y = head.y - d * s.ny, z = head.z - d * s.nz, m = hypot(x, y, z);
  if (m < 0.2) { const e = fx * s.nx + fy * s.ny + fz * s.nz; x = fx - e * s.nx; y = fy - e * s.ny; z = fz - e * s.nz; m = hypot(x, y, z) || 1; }
  head.x = x / m; head.y = y / m; head.z = z / m;
  return head;
}

/** The body's orientation for the rig: its up is the head direction (in the plane), its forward is into the surface (the chest on it). Same shape as wallFrame (spider-wallrun.js). */
function clingFrame(s, head, out) {
  out.ux = head.x; out.uy = head.y; out.uz = head.z; out.fx = -s.nx; out.fy = -s.ny; out.fz = -s.nz; out.cling = true;
  return out;
}

/**
 * Tracking: the chest looks again into the surface (centre ray plus one to each side along the plane, and one a little above the chest). The plane and distance are refreshed in `s`.
 * Returns 0 = the surface is gone under the chest (ended, turned, not flat: a corner, a gap) or too narrow (both sides missing); 1 = a good patch; 2 = the chest is still on it but
 * within `clingPatch` of an edge (one side or the top is missing): fine to stay, and the place to look for the next surface when moving that way.
 */
function trackSurface(world, p, s, cfg) {
  const cx = p.x, cy = p.y + 1, cz = p.z, P = cfg.clingPatch, reach = Math.max(s.dist, 0.3) + 0.9;
  // two in-plane axes: T1 horizontal (walls) / x (ceilings), T2 up (walls) / z (ceilings)
  let t1x, t1y, t1z, t2x, t2y, t2z;
  if (s.kind === 'wall') { t1x = -s.nz; t1y = 0; t1z = s.nx; t2x = 0; t2y = 1; t2z = 0; } else { t1x = 1; t1y = 0; t1z = 0; t2x = 0; t2y = 0; t2z = 1; }
  const r0 = world.rayFirstHit(cx, cy, cz, -s.nx, -s.ny, -s.nz, reach);
  if (!r0 || r0.nx * s.nx + r0.ny * s.ny + r0.nz * s.nz < 0.95) return 0;
  let missed = 0, sides = 0;
  for (let i = 0; i < 3; i++) {
    const o = i === 0 ? P : i === 1 ? -P : 0, q = i === 2 ? P : 0;
    const r = world.rayFirstHit(cx + t1x * o + t2x * q, cy + t1y * o + t2y * q, cz + t1z * o + t2z * q, -s.nx, -s.ny, -s.nz, reach + 0.3);
    if (!r || Math.abs(r.t - r0.t) > 0.3 || r.nx * s.nx + r.ny * s.ny + r.nz * s.nz < 0.95) { missed++; if (i < 2) sides++; }
  }
  if (sides === 2) return 0; // a pier or a pipe: not a surface to hold on to
  s.c = s.nx * (cx - s.nx * r0.t) + s.ny * (cy - s.ny * r0.t) + s.nz * (cz - s.nz * r0.t); s.dist = r0.t;
  return missed ? 2 : 1;
}

/** Is there a flat patch ahead? Three rays along (dx, dy, dz) from the chest and from points either side of it; the same normal and distance. Fills the hit in `h`. */
function flatAhead(world, cx, cy, cz, dx, dy, dz, reach, ox, oy, oz, h) {
  const r0 = world.rayFirstHit(cx, cy, cz, dx, dy, dz, reach);
  if (!r0) return false;
  for (let i = 0; i < 2; i++) {
    const k = i ? -1 : 1, r = world.rayFirstHit(cx + ox * k, cy + oy * k, cz + oz * k, dx, dy, dz, reach + 0.3);
    if (!r || Math.abs(r.t - r0.t) > 0.25 || r.nx * r0.nx + r.ny * r0.ny + r.nz * r0.nz < 0.95) return false;
  }
  h.t = r0.t; h.nx = r0.nx; h.ny = r0.ny; h.nz = r0.nz;
  return true;
}

const HIT = { t: 0, nx: 0, ny: 0, nz: 0 };
const CORNER_NONE = 0, CORNER_CONCAVE = 1, CORNER_CONVEX = 2, CORNER_MANTLE = 3;

/**
 * What lies beyond the end of the surface in the travel direction m (unit, in the plane)?
 *   mode 'ahead'  (every tracking tick while moving): a flat surface straight ahead at an angle of about 90 degrees to this one (an inside corner, or a wall running into an overhang)
 *   mode 'edge'   (when tracking has failed: the surface ended): a roof to climb onto (moving up a wall), or the next face round an outside corner
 * Returns CORNER_*; for the first two `out` holds the new surface and (gx, gy, gz) the new feet position (where the chest will end up, one metre down); for CORNER_MANTLE (gx, gy, gz)
 * is the roof position. Surfaces that are not walls or ceilings (a roof seen from above, a floor) are never clung to.
 */
function probeCorner(world, p, s, mx, my, mz, cfg, edge, out) {
  const cx = p.x, cy = p.y + 1, cz = p.z, off = cfg.clingOffset;
  const px = s.ny * mz - s.nz * my, py = s.nz * mx - s.nx * mz, pz = s.nx * my - s.ny * mx, pm = hypot(px, py, pz) || 1; // n x m: in the plane, across the travel
  const S = 0.35 / pm;
  if (!edge) {
    if (!flatAhead(world, cx, cy, cz, mx, my, mz, cfg.clingCorner, px * S, py * S, pz * S, HIT)) return CORNER_NONE;
    if (HIT.ny > 0.2 || Math.abs(HIT.nx * s.nx + HIT.ny * s.ny + HIT.nz * s.nz) > cfg.clingCornerDot || HIT.nx * mx + HIT.ny * my + HIT.nz * mz > -0.5) return CORNER_NONE;
    const hx = cx + mx * HIT.t, hy = cy + my * HIT.t, hz = cz + mz * HIT.t;
    out.nx = HIT.nx; out.ny = HIT.ny; out.nz = HIT.nz; out.c = HIT.nx * hx + HIT.ny * hy + HIT.nz * hz; out.dist = off; out.kind = HIT.ny < -0.7 ? 'ceiling' : 'wall';
    out.gx = hx + HIT.nx * off; out.gy = hy + HIT.ny * off - 1; out.gz = hz + HIT.nz * off;
    return CORNER_CONCAVE;
  }
  if (s.kind === 'wall' && my > 0.5) { // up and over the top edge: a roof above the building
    const ox = cx - s.nx * 0.8, oy = cy + 1.3, oz = cz - s.nz * 0.8;
    const r = world.rayFirstHit(ox, oy, oz, 0, -1, 0, 2.6);
    if (r && r.ny > 0.9) { const ry = oy - r.t; if (ry > cy - 0.4 && ry < cy + 1.4) { out.gx = cx - s.nx * 0.65; out.gy = ry; out.gz = cz - s.nz * 0.65; return CORNER_MANTLE; } }
  }
  // round an outside corner: from a point past the edge and a little behind the plane, look back along -m
  const D = cfg.clingCorner, bx = cx + mx * D - s.nx * (s.dist + 0.25), by = cy + my * D - s.ny * (s.dist + 0.25), bz = cz + mz * D - s.nz * (s.dist + 0.25);
  if (!flatAhead(world, bx, by, bz, -mx, -my, -mz, D + 0.5, px * S, py * S, pz * S, HIT)) return CORNER_NONE;
  if (HIT.ny > 0.2 || Math.abs(HIT.nx * s.nx + HIT.ny * s.ny + HIT.nz * s.nz) > cfg.clingCornerDot || HIT.nx * mx + HIT.ny * my + HIT.nz * mz < 0.5) return CORNER_NONE;
  const hx = bx - mx * HIT.t, hy = by - my * HIT.t, hz = bz - mz * HIT.t;
  out.nx = HIT.nx; out.ny = HIT.ny; out.nz = HIT.nz; out.c = HIT.nx * hx + HIT.ny * hy + HIT.nz * hz; out.dist = off; out.kind = HIT.ny < -0.7 ? 'ceiling' : 'wall';
  out.gx = hx + HIT.nx * off; out.gy = hy + HIT.ny * off - 1; out.gz = hz + HIT.nz * off;
  return CORNER_CONVEX;
}

export { CLING_INTERVAL, CORNER_NONE, CORNER_CONCAVE, CORNER_CONVEX, CORNER_MANTLE, newSurface, copySurface, surfaceFromWall, sameSurface, probeCeiling, findSurface, stickDirection, crawlVelocity, turnHead, projectHead, clingFrame, trackSurface, probeCorner };
