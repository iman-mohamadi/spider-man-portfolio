import { SPIDER, clamp, projectRope } from './spider-physics.js';

// Predicts the first moments of a swing from an anchor, with the SAME rope maths the controller uses (projectRope, swing gravity, the eased
// reel-in), and tells targeting whether the arc is usable. Anchors on a facade straight ahead of the player are the classic failure: the
// pendulum's lowest point is right under the anchor, on the wall, so the swing ends in the building after a few metres. Candidates whose
// predicted arc runs into a wall or the street are ranked below those that travel past or around buildings.
//
// `world` needs floorAt(x, z, feetY, stepUp) and lineClear(ax, ay, az, bx, by, bz, endPad). Pure apart from those calls.

const STEP = 1 / 30, SUB = 2, DURATION = 3.6, BODY_RADIUS = 0.5, GOOD_TRAVEL = 45; // a swing that carries the body 45 m before it ends is a good one

/**
 * @param body   { x, y, z } feet position; @param vel { x, y, z } current velocity; @param grounded whether the click would be a web launch (a hop first)
 * @returns { quality, ok, hitWall, hitGround, travel, minClear, t }: travel = horizontal distance covered when the swing ended (far side of the arc, a wall or the
 *   street); quality 0..1 = travel / 45 m; ok = quality is full, or the swing ended on its own side of the arc without hitting anything
 */
function simulateSwing(world, body, vel, anchor, grounded, cfg = SPIDER) {
  const c = { x: body.x, y: body.y + cfg.chest + (grounded ? 0.05 : 0), z: body.z };
  const v = { x: vel.x, y: grounded ? Math.max(vel.y, cfg.jumpSpeed * 0.9) : vel.y, z: vel.z };
  const ground0 = world.floorAt(body.x, body.z, body.y, 0.3);
  const d0 = Math.hypot(c.x - anchor.x, c.y - anchor.y, c.z - anchor.z);
  let length = clamp(d0, 1, cfg.webMax);
  const target = clamp(Math.min(d0 * 0.97, anchor.y - ground0 - cfg.swingClearance), cfg.webMin, cfg.webMax);
  const out = { quality: 0, ok: false, hitWall: false, hitGround: false, travel: 0, minClear: 99, t: 0 };
  const h = STEP, hh = h / SUB;
  let px = c.x, py = c.y, pz = c.z;
  for (let t = 0; t < DURATION; t += h) {
    if (length > target) { const ease = cfg.reelRamp > 0 ? Math.min(1, t / cfg.reelRamp) : 1; length = Math.max(target, length - cfg.reelSpeed * ease * ease * h); }
    for (let s = 0; s < SUB; s++) {
      v.y -= cfg.swingGravity * hh * 0.5;
      c.x += v.x * hh; c.y += v.y * hh; c.z += v.z * hh;
      projectRope(c, anchor, length, v);
      v.y -= cfg.swingGravity * hh * 0.5;
    }
    out.t = t + h;
    // a wall: the step's segment (extended by the body radius) must stay clear of every building
    let sx = c.x - px, sy = c.y - py, sz = c.z - pz;
    const sl = Math.hypot(sx, sy, sz);
    if (sl > 1e-6) {
      const k = (sl + BODY_RADIUS) / sl;
      if (!world.lineClear(px, py, pz, px + sx * k, py + sy * k, pz + sz * k, 0)) { out.hitWall = true; break; }
    }
    // the street
    const floor = world.floorAt(c.x, c.z, c.y - cfg.chest, 0.3), clear = c.y - cfg.chest - floor;
    out.minClear = Math.min(out.minClear, clear);
    if (t > 0.3 && clear < 0.6) { out.hitGround = true; break; }
    px = c.x; py = c.y; pz = c.z;
    // far side of the arc (the controller lets go here): the swing has done its job
    const tx = anchor.x - c.x, ty = anchor.y - c.y, tz = anchor.z - c.z, dist = Math.hypot(tx, ty, tz);
    if (dist < 3 || (ty / dist < 0.28 && v.x * tx + v.z * tz < 0)) break;
  }
  out.travel = Math.hypot(c.x - px, c.z - pz) < 1e-6 ? Math.hypot(px - body.x, pz - body.z) : Math.hypot(c.x - body.x, c.z - body.z);
  out.quality = clamp(out.travel / GOOD_TRAVEL, 0, 1);
  out.ok = out.quality >= 1 || (!out.hitWall && !out.hitGround && out.travel >= 12);
  return out;
}

export { simulateSwing };
