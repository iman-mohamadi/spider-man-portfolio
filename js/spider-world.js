import { polygonContains } from './building-collision.js';

// Spider-Man's view of the city: where the floor is (ground, sidewalk, park, ROOFTOPS), ray casts against the building
// colliders, and candidate web anchors on the upper facades. Everything is built on the existing collider list through
// `controllers.nearColliders()` (a shared array: results are consumed before the next call) and `getGroundHeight()`.

const ANCHOR_MIN_HEIGHT = 16; // buildings lower than this offer no anchors
const ANCHOR_EDGE_STEP = 9;   // m between anchor candidates along a facade
const ANCHOR_ROW_STEP = 13;   // m between rows of anchors down a facade (roof edge, then lower rows), so a building can be aimed at anywhere on its face
const ANCHOR_MIN_ROW = 20;    // lowest row (m above the street)
const ANCHOR_MAX_ROWS = 4;

function insideCollider(c, x, z) {
  if (x < c.minX || x > c.maxX || z < c.minZ || z > c.maxZ) return false;
  if (c.polygon) return polygonContains(c.polygon, x, z);
  if (c.obb) {
    const o = c.obb, dx = x - o.cx, dz = z - o.cz;
    return Math.abs(dx * o.cs - dz * o.sn) <= o.hx && Math.abs(dx * o.sn + dz * o.cs) <= o.hz;
  }
  return true;
}

// Facade anchors of one building, computed once: flat [x, y, z, nx, nz] per candidate, just below the roof edge and 0.35 m outside it
function anchorsOf(c) {
  if (c._spiderAnchors) return c._spiderAnchors;
  const out = [];
  const top = c.maxY - 0.8;
  const rows = [];
  for (let y = top; y >= ANCHOR_MIN_ROW && rows.length < ANCHOR_MAX_ROWS; y -= ANCHOR_ROW_STEP) rows.push(y);
  if (!rows.length) rows.push(top);
  if (c.polygon && c.maxY >= ANCHOR_MIN_HEIGHT) {
    const ring = c.polygon.outer;
    let area2 = 0;
    for (let i = 0; i < ring.length; i++) { const a = ring[i], b = ring[(i + 1) % ring.length]; area2 += a.x * b.z - b.x * a.z; }
    const sign = area2 > 0 ? 1 : -1;
    const edges = [];
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      const ex = b.x - a.x, ez = b.z - a.z, len = Math.hypot(ex, ez);
      if (len < 3) { edges.push(null); continue; }
      const nx = sign * ez / len, nz = -sign * ex / len;
      edges.push({ nx, nz });
      const n = Math.max(1, Math.floor(len / ANCHOR_EDGE_STEP));
      for (let k = 0; k < n; k++) {
        const t = (k + 0.5) / n;
        for (const y of rows) out.push(a.x + ex * t + nx * 0.35, y, a.z + ez * t + nz * 0.35, nx, nz);
      }
    }
    // building corners: where two real walls meet (more than ~35 degrees apart); the anchor sits on the corner's outward bisector
    for (let i = 0; i < ring.length; i++) {
      const e0 = edges[(i + ring.length - 1) % ring.length], e1 = edges[i];
      if (!e0 || !e1) continue;
      const bx = e0.nx + e1.nx, bz = e0.nz + e1.nz, bm = Math.hypot(bx, bz);
      if (bm < 0.2 || bm > 1.64) continue; // walls (nearly) parallel or opposite: not a corner
      const nx = bx / bm, nz = bz / bm, v = ring[i];
      for (const y of rows) out.push(v.x + nx * 0.4, y, v.z + nz * 0.4, nx, nz);
    }
  } else if (!c.polygon && !c.obb && c.maxY >= ANCHOR_MIN_HEIGHT) { // authored landmark boxes
    const cx = (c.minX + c.maxX) / 2, cz = (c.minZ + c.maxZ) / 2;
    for (const y of rows) out.push(cx, y, c.minZ - 0.35, 0, -1, cx, y, c.maxZ + 0.35, 0, 1, c.minX - 0.35, y, cz, -1, 0, c.maxX + 0.35, y, cz, 1, 0);
  }
  c._spiderAnchors = out;
  return out;
}

function createSpiderWorld(ctrl) {
  /** Height of the highest support under (x, z) that is at most `stepUp` above feetY: roofs first, otherwise the street/sidewalk/park. */
  function floorAt(x, z, feetY, stepUp = 0.55) {
    let best = ctrl.getGroundHeight(x, z, 'person');
    const near = ctrl.nearColliders(x, z, 1.5);
    for (let i = 0; i < near.length; i++) {
      const c = near[i], top = c.maxY;
      if (top > best && top <= feetY + stepUp && insideCollider(c, x, z)) best = top;
    }
    return best;
  }

  /** First hit of the segment o + d*t, t in [0, maxT] (d must be unit length) against building walls and roofs. Returns { t, nx, ny, nz } or null. */
  function rayFirstHit(ox, oy, oz, dx, dy, dz, maxT) {
    const mx = ox + dx * maxT * 0.5, mz = oz + dz * maxT * 0.5;
    const near = ctrl.nearColliders(mx, mz, maxT * 0.5 + 14);
    const yLo = Math.min(oy, oy + dy * maxT), yHi = Math.max(oy, oy + dy * maxT);
    let best = maxT, nx = 0, ny = 0, nz = 0, found = false;
    for (let i = 0; i < near.length; i++) {
      const c = near[i], minY = c.minY ?? 0;
      if (yHi < minY || yLo > c.maxY) continue;
      // horizontal bounds of the segment against the collider's box
      const x1 = ox + dx * maxT, z1 = oz + dz * maxT;
      if (Math.max(ox, x1) < c.minX || Math.min(ox, x1) > c.maxX || Math.max(oz, z1) < c.minZ || Math.min(oz, z1) > c.maxZ) continue;
      // a start point inside the footprint below the roof is "inside the building": ignore that collider (spawned in a doorway)
      if (oy < c.maxY && oy > minY && insideCollider(c, ox, oz)) continue;
      if (c.polygon) {
        const rings = [c.polygon.outer, ...(c.polygon.holes || [])];
        for (const ring of rings) {
          for (let k = 0, n = ring.length; k < n; k++) {
            const a = ring[k], b = ring[(k + 1) % n], ex = b.x - a.x, ez = b.z - a.z;
            const den = dx * ez - dz * ex;
            if (Math.abs(den) < 1e-9) continue;
            const qx = a.x - ox, qz = a.z - oz;
            const t = (qx * ez - qz * ex) / den, u = (qx * dz - qz * dx) / den;
            if (t > 1e-3 && t < best && u >= 0 && u <= 1) {
              const y = oy + dy * t;
              if (y >= minY && y <= c.maxY) {
                best = t; found = true; const len = Math.hypot(ex, ez) || 1;
                nx = -ez / len; nz = ex / len; ny = 0;
                if (nx * dx + nz * dz > 0) { nx = -nx; nz = -nz; }
              }
            }
          }
        }
        if (Math.abs(dy) > 1e-9) {
          const t = (c.maxY - oy) / dy;
          if (t > 1e-3 && t < best && polygonContains(c.polygon, ox + dx * t, oz + dz * t)) { best = t; found = true; nx = 0; ny = dy > 0 ? -1 : 1; nz = 0; }
        }
      } else { // AABB (landmarks, bridge parts, OBB by its bounds): slab test
        let t0 = 0, t1 = best, hitAxis = -1, hitSign = 0;
        const lo = [c.minX, minY, c.minZ], hi = [c.maxX, c.maxY, c.maxZ], o = [ox, oy, oz], d = [dx, dy, dz];
        let ok = true;
        for (let a = 0; a < 3 && ok; a++) {
          if (Math.abs(d[a]) < 1e-9) { if (o[a] < lo[a] || o[a] > hi[a]) ok = false; continue; }
          let ta = (lo[a] - o[a]) / d[a], tb = (hi[a] - o[a]) / d[a], sgn = -1;
          if (ta > tb) { const s = ta; ta = tb; tb = s; sgn = 1; }
          if (ta > t0) { t0 = ta; hitAxis = a; hitSign = sgn; }
          if (tb < t1) t1 = tb;
          if (t0 > t1) ok = false;
        }
        if (ok && t0 > 1e-3 && t0 < best) { best = t0; found = true; nx = hitAxis === 0 ? hitSign : 0; ny = hitAxis === 1 ? hitSign : 0; nz = hitAxis === 2 ? hitSign : 0; }
      }
    }
    return found ? { t: best, nx, ny, nz } : null;
  }

  /**
   * Best web anchor for a body at (px, py, pz) heading roughly along (aimX, aimZ): upper facade points 10-85 m away and 8-75 m above,
   * preferring the direction of travel and ~45 degrees of elevation, and only if the line to them is not blocked.
   */
  function findAnchor(px, py, pz, aimX, aimZ, opts = {}) {
    const minH = opts.minHoriz ?? 10, maxH = opts.maxHoriz ?? 85, minUp = opts.minUp ?? 8, maxUp = opts.maxUp ?? 75, minDot = opts.minDot ?? 0.3;
    const minY = opts.minY ?? -Infinity; // absolute: anchors lower than this make a swing that scrapes the street
    const am = Math.hypot(aimX, aimZ) || 1; aimX /= am; aimZ /= am;
    const near = ctrl.nearColliders(px, pz, maxH + 20);
    const best = []; // keeps the 6 lowest scores
    for (let i = 0; i < near.length; i++) {
      const c = near[i];
      if (c.maxY < py + minUp) continue;
      const pts = anchorsOf(c);
      for (let k = 0; k < pts.length; k += 5) {
        const dx = pts[k] - px, dy = pts[k + 1] - py, dz = pts[k + 2] - pz;
        const h = Math.hypot(dx, dz);
        if (h < minH || h > maxH || dy < minUp || dy > maxUp || pts[k + 1] < minY) continue;
        const dot = (dx * aimX + dz * aimZ) / h;
        if (dot < minDot) continue;
        // the facade must face the player (its outward normal points back towards the body)
        if ((pts[k + 3] * (px - pts[k]) + pts[k + 4] * (pz - pts[k + 2])) < 0) continue;
        const elev = Math.atan2(dy, h) * 57.29578;
        const score = (1 - dot) * 40 + Math.abs(h - 38) * 0.45 + Math.abs(elev - 42) * 0.35;
        if (best.length < 6 || score < best[best.length - 1].score) {
          best.push({ score, x: pts[k], y: pts[k + 1], z: pts[k + 2], nx: pts[k + 3], nz: pts[k + 4], dist: Math.hypot(h, dy) });
          best.sort((a, b) => a.score - b.score); if (best.length > 6) best.pop();
        }
      }
    }
    for (const cand of best) { // only now the (more expensive) line-of-sight test, best first; rayFirstHit uses the shared collider list
      const dx = cand.x - px, dy = cand.y - py, dz = cand.z - pz, len = cand.dist;
      const hit = rayFirstHit(px, py, pz, dx / len, dy / len, dz / len, len);
      if (!hit || hit.t > len - 1.2) return cand;
    }
    return null;
  }

  /**
   * Calls cb(x, y, z, nx, nz, horizontalDistance, dy) for every anchor point a body at (px, py, pz) could use: facade / corner points that
   * face the body, between minHoriz and maxHoriz away horizontally, minUp..maxUp above it and not lower than minY. No line-of-sight test
   * (see lineClear); that is only done for the few points the caller keeps.
   */
  function forEachAnchor(px, py, pz, opts, cb) {
    const minH = opts.minHoriz ?? 8, maxH = opts.maxHoriz ?? 90, minUp = opts.minUp ?? 6, maxUp = opts.maxUp ?? 80, minY = opts.minY ?? -Infinity;
    const near = ctrl.nearColliders(px, pz, maxH + 20);
    for (let i = 0; i < near.length; i++) {
      const c = near[i];
      if (c.maxY < py + minUp) continue;
      const pts = anchorsOf(c);
      for (let k = 0; k < pts.length; k += 5) {
        const dx = pts[k] - px, dy = pts[k + 1] - py, dz = pts[k + 2] - pz, h = Math.hypot(dx, dz);
        if (h < minH || h > maxH || dy < minUp || dy > maxUp || pts[k + 1] < minY) continue;
        if ((pts[k + 3] * (px - pts[k]) + pts[k + 4] * (pz - pts[k + 2])) < 0) continue; // the facade must face the body
        cb(pts[k], pts[k + 1], pts[k + 2], pts[k + 3], pts[k + 4], h, dy);
      }
    }
  }

  /** True when the straight segment between two points is not blocked by a building (the end point may touch the wall it hangs on). */
  function lineClear(ax, ay, az, bx, by, bz, endPad = 1.2) {
    const dx = bx - ax, dy = by - ay, dz = bz - az, len = Math.hypot(dx, dy, dz);
    if (len < 1e-3) return true;
    const hit = rayFirstHit(ax, ay, az, dx / len, dy / len, dz / len, len);
    return !hit || hit.t > len - endPad;
  }

  return { floorAt, rayFirstHit, findAnchor, forEachAnchor, lineClear, insideCollider };
}

export { createSpiderWorld, insideCollider };
