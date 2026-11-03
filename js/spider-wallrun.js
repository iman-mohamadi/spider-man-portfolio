// Wall detection for Spider-Man's wall run. No three.js, no DOM: it only needs `world.rayFirstHit(ox, oy, oz, dx, dy, dz, maxT)` (spider-world.js, the building colliders), so the
// tests can run it on a fake world. The movement itself is spider-physics.js (wallVelocity / wallJumpVelocity) and the state machine is SpiderController (state 'wall').
//
// A wall is only accepted when it is a real facade, found with horizontal rays: a flat vertical face (the ray normal has no vertical part: roofs, floors and ceilings are rejected),
// flat for cfg.wallWidth to both sides of the probe at two heights (a pipe, a corner or a small obstacle is not wide enough), at the same distance and with the same normal, and
// it must go on for cfg.wallMinHeight above the body (a kerb, a shop front or a shed is not tall enough). Colliders are buildings and landmarks only: billboards and street
// furniture are not in the list, so they can never be caught.
//
// Cost: the probe runs at most 30 times a second, only while the body is airborne, fast enough, and pushing the stick. Without a wall nearby that is three
// single rays per probe (forward, left, right); only a hit starts the full check of six rays.

const PROBE_INTERVAL = 1 / 30;
const TRACK_HEIGHT = 2.2; // while running, the wall must still reach this far above the feet (the end of the wall = the top edge)

const hypot2 = Math.hypot;
const SIDE_Y = [0.5, 1.6]; // heights (above the feet) of the flatness rays
const DIRS = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]; // scratch for findWall (no allocation per probe)

/** Result record: reuse one per caller. nx, nz: unit normal pointing from the wall to the body; tx, tz: unit tangent; c: the wall plane is n . x = c; dist: perpendicular distance of the probe point. */
function newWall() { return { nx: 0, nz: 0, tx: 0, tz: 1, c: 0, dist: 0 }; }

/**
 * One flat, tall wall in front of the body along the unit horizontal direction (dx, dz), within `reach`, tall enough for `minH` above the feet. Fills `w` (n, c, dist, and a
 * default tangent) and returns true, or false when anything is wrong (nothing there, not vertical, not flat, not wide enough, too low).
 */
function probeWall(world, px, py, pz, dx, dz, reach, minH, cfg, w) {
  const r0 = world.rayFirstHit(px, py + 1.0, pz, dx, 0, dz, reach);
  if (!r0 || Math.abs(r0.ny) > 0.2) return false; // nothing, or a roof / floor / ceiling
  const nl = hypot2(r0.nx, r0.nz);
  if (nl < 0.9) return false;
  const nx = r0.nx / nl, nz = r0.nz / nl, facing = -(nx * dx + nz * dz);
  if (facing < 0.25) return false; // grazing: the ray only clipped an edge
  const dist = r0.t * facing, tx = -nz, tz = nx;
  const need = dist + 0.5, W = cfg.wallWidth;
  // flat to both sides, at the knee and at the shoulder: same distance, same normal
  for (let i = 0; i < 4; i++) {
    const o = i & 1 ? W : -W, y = SIDE_Y[i >> 1];
    const r = world.rayFirstHit(px + tx * o, py + y, pz + tz * o, -nx, 0, -nz, need);
    if (!r || Math.abs(r.t - dist) > 0.35 || r.nx * nx + r.nz * nz < 0.95) return false;
  }
  // tall: the wall is still there well above the body
  const hi = world.rayFirstHit(px, py + minH, pz, -nx, 0, -nz, need + 0.3);
  if (!hi || Math.abs(hi.t - dist) > 0.6 || hi.nx * nx + hi.nz * nz < 0.9) return false;
  w.nx = nx; w.nz = nz; w.tx = tx; w.tz = tz; w.dist = dist; w.c = nx * px + nz * pz - dist;
  return true;
}

/** The same wall (plane) as `b`? */
function sameWall(a, b) {
  const d = a.nx * b.nx + a.nz * b.nz;
  return Math.abs(d) > 0.97 && Math.abs(a.c - (d > 0 ? b.c : -b.c)) < 0.7;
}

/** Sets the tangent of `w` along the horizontal travel: sign of (v . t), else of the wish, else its default. */
function orient(w, vx, vz, wx, wz) {
  let s = vx * w.tx + vz * w.tz;
  if (Math.abs(s) < 0.5) s = wx * w.tx + wz * w.tz;
  if (s < 0) { w.tx = -w.tx; w.tz = -w.tz; }
  return w;
}

/**
 * Looks for a wall the body could run on: forward (head-on) and to both sides of the travel direction. `vel` {x, y, z}, `wish` {x, z} (camera relative, 0..1). Returns true and fills
 * `w` (with the tangent in the direction of travel) when a valid wall is in reach AND the input is toward or along it; `w.headOn` tells which.
 */
function findWall(world, pos, vel, wish, cfg, w) {
  const hs = hypot2(vel.x, vel.z);
  if (hs < cfg.wallMinSpeed) return false;
  const vx = vel.x / hs, vz = vel.z / hs, wm = hypot2(wish.x, wish.z);
  if (wm < cfg.wallInput) return false;
  const dirs = DIRS; // forward, left, right of the travel direction
  dirs[0][0] = vx; dirs[0][1] = vz; dirs[0][2] = cfg.wallReachFwd; dirs[1][0] = vz; dirs[1][1] = -vx; dirs[1][2] = cfg.wallReach; dirs[2][0] = -vz; dirs[2][1] = vx; dirs[2][2] = cfg.wallReach;
  if (wish.x * dirs[2][0] + wish.z * dirs[2][1] > wish.x * dirs[1][0] + wish.z * dirs[1][1]) { const t = dirs[1]; dirs[1] = dirs[2]; dirs[2] = t; } // (swapping rows of the scratch array is fine: the next call rewrites all of them) // the side the stick points to first
  for (let i = 0; i < 3; i++) {
    const d = dirs[i];
    if (!probeWall(world, pos.x, pos.y, pos.z, d[0], d[1], d[2], cfg.wallMinHeight, cfg, w)) continue;
    const approach = -(w.nx * vx + w.nz * vz); // 1 = straight at the wall, 0 = along it, < 0 = moving away
    if (approach < -0.05) continue;
    orient(w, vel.x, vel.z, wish.x, wish.z);
    const into = -(wish.x * w.nx + wish.z * w.nz), along = wish.x * w.tx + wish.z * w.tz;
    const headOn = approach > 0.5;
    if (!(into >= cfg.wallInput || (!headOn && along >= cfg.wallInput))) continue; // toward the wall, or along it in the direction of travel
    w.headOn = headOn; w.approach = approach;
    return true;
  }
  return false;
}

/**
 * Confirms a wall over time: probes at PROBE_INTERVAL and reports a wall only after the SAME wall was seen continuously for cfg.wallEnterGrace (no flicker from a wall that is
 * only brushed for a frame). `block` {nx, nz, c, t}: the wall that was just left (a wall jump, or the end of a run) cannot be caught again while block.t > 0.
 */
class WallDetector {
  constructor() { this.acc = PROBE_INTERVAL; this.seen = 0; this.has = false; this.cand = newWall(); this.tmp = newWall(); }
  reset() { this.acc = PROBE_INTERVAL; this.seen = 0; this.has = false; }
  /** Per frame. Returns the confirmed wall (this.cand, valid until the next call) or null. */
  update(dt, world, pos, vel, wish, cfg, block = null) {
    this.acc += dt;
    if (this.acc < PROBE_INTERVAL) return null;
    const step = this.acc; this.acc = 0;
    let ok = findWall(world, pos, vel, wish, cfg, this.tmp);
    if (ok && block && block.t > 0 && sameWall(this.tmp, block)) ok = false;
    if (!ok) { this.has = false; this.seen = 0; return null; }
    if (this.has && sameWall(this.tmp, this.cand)) this.seen += step; else this.seen = 0;
    Object.assign(this.cand, this.tmp); this.has = true;
    return this.seen >= cfg.wallEnterGrace ? this.cand : null;
  }
}

/**
 * While running: looks at the wall again from the body (straight into the current wall). True when it is still the same flat wall and reaches TRACK_HEIGHT above the feet; the plane
 * and distance are refreshed in `w` (keeping the direction of its tangent). False = the wall ended, turned (a corner) or is not flat any more.
 */
function trackWall(world, pos, w, cfg, tmp = newWall()) {
  if (!probeWall(world, pos.x, pos.y, pos.z, -w.nx, -w.nz, w.dist + 1.2, TRACK_HEIGHT, cfg, tmp)) return false;
  if (tmp.nx * w.nx + tmp.nz * w.nz < 0.93) return false; // the wall turned: a corner. Not followed; the run ends and may catch the next wall
  const s = tmp.tx * w.tx + tmp.tz * w.tz < 0 ? -1 : 1;
  w.nx = tmp.nx; w.nz = tmp.nz; w.tx = tmp.tx * s; w.tz = tmp.tz * s; w.c = tmp.c; w.dist = tmp.dist;
  return true;
}

/**
 * The body's orientation while running, for the rig: the body's up turns from the world up towards the wall normal by cfg.wallTilt (feet to the wall, head away), its forward is
 * the direction of travel (along the wall, up it, or in between) made perpendicular to that. `out` gets unit ux, uy, uz (up) and fx, fy, fz (forward); `prev` direction is kept when
 * the body is almost still. Pure maths: the rig turns it into a rotation.
 */
function wallFrame(w, vel, cfg, out) {
  const ct = Math.cos(cfg.wallTilt), st = Math.sin(cfg.wallTilt);
  let ux = st * w.nx, uy = ct, uz = st * w.nz;
  const um = hypot2(ux, uy, uz) || 1; ux /= um; uy /= um; uz /= um;
  const vt = vel.x * w.tx + vel.z * w.tz;
  let fx = w.tx * vt, fy = vel.y, fz = w.tz * vt;
  if (hypot2(fx, fy, fz) < 0.5) { if (out.fy === undefined) { fx = w.tx; fy = 0; fz = w.tz; } else { fx = out.fx; fy = out.fy; fz = out.fz; } }
  const d = fx * ux + fy * uy + fz * uz; fx -= d * ux; fy -= d * uy; fz -= d * uz;
  const fm = hypot2(fx, fy, fz) || 1;
  out.ux = ux; out.uy = uy; out.uz = uz; out.fx = fx / fm; out.fy = fy / fm; out.fz = fz / fm;
  return out;
}

export { PROBE_INTERVAL, TRACK_HEIGHT, newWall, probeWall, sameWall, findWall, WallDetector, trackWall, wallFrame, orient };
