// Pure movement maths for the Spider-Man controller: no three.js, no DOM, so the tests can run it directly
// (tests/spider-physics.test.cjs). Units: metres, seconds. Heading 0 faces +z, forward = (sin h, cos h).

const SPIDER = {
  run: 8.5, sprint: 15, accel: 38, brake: 55,
  airAccel: 8, airMax: 12, gravity: 26, jumpSpeed: 10.5, terminal: 55,
  coyote: 0.1, jumpBuffer: 0.12, stepUp: 0.55, stepDown: 0.6,
  radius: 0.45, chest: 1.3, turnRate: 14,
  // web swinging
  swingGravity: 22, webMin: 10, webMax: 95, targetRange: 72, reelLimit: 0.5, reelSpeed: 16, swingClearance: 8, swingPump: 10, swingBrake: 9, swingSteer: 12, swingTurn: 0.75, swingDrag: 0.03, swingMax: 42,
  releaseBoost: 0.06, releaseLift: 2.5
};

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function approach(value, target, maxDelta) {
  if (value < target) return Math.min(target, value + maxDelta);
  return Math.max(target, value - maxDelta);
}

/** Smallest signed difference b - a between two angles (radians), in (-PI, PI]. */
function angleDiff(a, b) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d <= -Math.PI) d += Math.PI * 2;
  return d;
}

function turnToward(angle, target, maxStep) {
  const d = angleDiff(angle, target);
  return angle + clamp(d, -maxStep, maxStep);
}

/** Moves the horizontal velocity `vel` {x, z} towards (tx, tz) by at most maxDelta (a vector approach: momentum bends, it does not snap). */
function moveToward2D(vel, tx, tz, maxDelta) {
  const dx = tx - vel.x, dz = tz - vel.z, d = Math.hypot(dx, dz);
  if (d <= maxDelta || d < 1e-9) { vel.x = tx; vel.z = tz; return vel; }
  vel.x += dx / d * maxDelta; vel.z += dz / d * maxDelta;
  return vel;
}

/** Ground locomotion: wish is a vector with length 0..1 in world xz. */
function groundVelocity(vel, wishX, wishZ, sprinting, dt, cfg = SPIDER) {
  const mag = Math.min(1, Math.hypot(wishX, wishZ));
  const top = sprinting ? cfg.sprint : cfg.run;
  const tx = mag > 1e-6 ? wishX / Math.hypot(wishX, wishZ) * top * mag : 0;
  const tz = mag > 1e-6 ? wishZ / Math.hypot(wishX, wishZ) * top * mag : 0;
  const speed = Math.hypot(vel.x, vel.z), targetSpeed = Math.hypot(tx, tz);
  const rate = targetSpeed < 0.01 ? cfg.brake : speed > targetSpeed ? cfg.brake * 0.5 : cfg.accel;
  return moveToward2D(vel, tx, tz, rate * dt);
}

/** Air control: steer and add speed up to airMax, but never speed up beyond the speed the body already had. */
function airVelocity(vel, wishX, wishZ, dt, cfg = SPIDER) {
  const before = Math.hypot(vel.x, vel.z);
  const m = Math.hypot(wishX, wishZ);
  if (m > 1e-6) {
    const k = Math.min(1, m);
    vel.x += wishX / m * cfg.airAccel * k * dt;
    vel.z += wishZ / m * cfg.airAccel * k * dt;
  }
  const after = Math.hypot(vel.x, vel.z), limit = Math.max(cfg.airMax, before);
  if (after > limit) { vel.x *= limit / after; vel.z *= limit / after; }
  return vel;
}

/**
 * Rope as an inequality constraint. pos / vel / anchor are {x, y, z}. If the body is further than `length` from the anchor it is
 * moved back onto the sphere and only the OUTWARD radial velocity is removed, so tangential momentum is kept.
 * Returns the distance that was corrected (0 when the rope is slack).
 */
function projectRope(pos, anchor, length, vel) {
  const rx = pos.x - anchor.x, ry = pos.y - anchor.y, rz = pos.z - anchor.z, d = Math.hypot(rx, ry, rz);
  if (d <= length || d < 1e-9) return 0;
  const nx = rx / d, ny = ry / d, nz = rz / d;
  pos.x = anchor.x + nx * length; pos.y = anchor.y + ny * length; pos.z = anchor.z + nz * length;
  const vn = vel.x * nx + vel.y * ny + vel.z * nz;
  if (vn > 0) { vel.x -= nx * vn; vel.y -= ny * vn; vel.z -= nz * vn; }
  return d - length;
}

/**
 * Steering while on the rope. The wish direction (camera forward * forward + camera right * strafe) is projected into the plane tangent
 * to the rope sphere, then split relative to the direction of travel:
 *  - the part ALONG the velocity pumps (speeds up) or brakes, with a fixed acceleration;
 *  - the part ACROSS the velocity turns the swing, with an acceleration that grows with speed (a turn rate, not a fixed push), so
 *    steering stays responsive at 40 m/s. A force at right angles to the velocity does no work, so it cannot add energy or spike speed.
 * Everything stays in the tangent plane: the rope constraint (projectRope) still decides the path, so this cannot become free flight.
 */
function swingForces(vel, pos, anchor, fwdDir, rightDir, forward, strafe, dt, cfg = SPIDER) {
  const rx = pos.x - anchor.x, ry = pos.y - anchor.y, rz = pos.z - anchor.z, d = Math.hypot(rx, ry, rz) || 1;
  const nx = rx / d, ny = ry / d, nz = rz / d;
  const mag = Math.min(1, Math.hypot(forward, strafe));
  if (mag > 1e-6) {
    let wx = fwdDir.x * forward + rightDir.x * strafe, wy = fwdDir.y * forward + rightDir.y * strafe, wz = fwdDir.z * forward + rightDir.z * strafe;
    const k = wx * nx + wy * ny + wz * nz;
    wx -= nx * k; wy -= ny * k; wz -= nz * k;
    const wm = Math.hypot(wx, wy, wz);
    if (wm > 1e-6) {
      wx /= wm; wy /= wm; wz /= wm;
      const speed = Math.hypot(vel.x, vel.y, vel.z);
      if (speed > 2) {
        const vx = vel.x / speed, vy = vel.y / speed, vz = vel.z / speed;
        const par = wx * vx + wy * vy + wz * vz;
        const lx = wx - vx * par, ly = wy - vy * par, lz = wz - vz * par; // across the travel direction (length = sin of the angle)
        const taper = 1 - 0.85 * Math.min(1, Math.max(0, (speed - 20) / (cfg.swingMax - 20))); // pumping fades out towards the speed cap
        const aPar = par * mag * (par > 0 ? cfg.swingPump * taper : cfg.swingBrake), aLat = (cfg.swingSteer + cfg.swingTurn * speed) * mag;
        vel.x += (vx * aPar + lx * aLat) * dt; vel.y += (vy * aPar + ly * aLat) * dt; vel.z += (vz * aPar + lz * aLat) * dt;
      } else { // nearly at rest (just attached): push straight towards the wish
        const a = cfg.swingPump * mag * dt;
        vel.x += wx * a; vel.y += wy * a; vel.z += wz * a;
      }
    }
  }
  const drag = 1 - cfg.swingDrag * dt; vel.x *= drag; vel.y *= drag; vel.z *= drag;
  const speed = Math.hypot(vel.x, vel.y, vel.z);
  if (speed > cfg.swingMax) { const k = cfg.swingMax / speed; vel.x *= k; vel.y *= k; vel.z *= k; }
  return vel;
}

/** Velocity after letting go of the web: momentum is kept, with a small forward boost and a lift when moving upwards. */
function releaseVelocity(vel, cfg = SPIDER) {
  const speed = Math.hypot(vel.x, vel.y, vel.z);
  if (speed < 1e-6) return vel;
  const b = 1 + cfg.releaseBoost;
  vel.x *= b; vel.z *= b; vel.y = vel.y * b + (vel.y > 0 ? cfg.releaseLift : 0);
  return vel;
}

export { SPIDER, clamp, approach, angleDiff, turnToward, moveToward2D, groundVelocity, airVelocity, projectRope, swingForces, releaseVelocity };
