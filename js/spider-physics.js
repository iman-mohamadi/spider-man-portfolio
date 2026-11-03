// Pure movement maths for the Spider-Man controller: no three.js, no DOM, so the tests can run it directly
// (tests/spider-physics.test.cjs). Units: metres, seconds. Heading 0 faces +z, forward = (sin h, cos h).

const SPIDER = {
  run: 8.5, sprint: 15, accel: 38, brake: 55,
  airAccel: 8, airMax: 12, gravity: 26, jumpSpeed: 10.5, terminal: 55,
  coyote: 0.1, jumpBuffer: 0.12, stepUp: 0.55, stepDown: 0.6,
  radius: 0.45, chest: 1.3, turnRate: 14,
  // web swinging
  swingGravity: 22, webMin: 10, webMax: 95, targetRange: 72, reelLimit: 0.5, reelSpeed: 16, reelRamp: 0.3, swingClearance: 8, swingPump: 10, swingBrake: 9, swingSteer: 14, swingTurn: 0.9, swingDrag: 0.03, swingMax: 42,
  releaseBoost: 0.06, releaseLift: 2.5,
  // double jump: one extra jump per airborne cycle (reset by landing and by attaching a web). The vertical speed is raised to airJumpSpeed (never lowered),
  // the horizontal velocity is kept and a small push is added along the wish (or travel) direction, capped at airJumpMaxSpeed (or the speed already had)
  airJumps: 1, airJumpSpeed: 9, airJumpForward: 3, airJumpMaxSpeed: 16, airJumpDelay: 0.12, airJumpMinLandIn: 0.22,
  // wall running (spider-wallrun.js finds the wall, wallVelocity / wallJumpVelocity below move the body). Distances in m, speeds in m/s, times in s, angles in rad.
  wallMinSpeed: 5.5,      // horizontal speed needed to catch a wall
  wallReach: 1.7,         // a wall at the side must be this close (to the body axis); head-on walls: wallReachFwd
  wallReachFwd: 2.6,
  wallMinHeight: 5,       // the wall must reach this far above the body (no kerbs, shop fronts or sheds)
  wallWidth: 1.3,         // the wall must be flat this far to both sides of the probe (no pipes, corners, tiny surfaces)
  wallInput: 0.35,        // how much of the wish must point into / along the wall
  wallEnterGrace: 0.06,   // the same wall must be confirmed for this long before the run starts (no flicker)
  wallExitGrace: 0.15,    // the wall or the input may be lost for this long before the run ends
  wallRun: 11,            // speed along the wall at full input
  wallAccel: 30, wallDrag: 6, // speed along the wall: acceleration towards the target, and the friction that takes away a speed above it
  wallClimb: 10, wallLift: 40, wallDown: 14, wallSlide: 3.5, // vertical: climb speed, how fast it is reached, how fast it falls to the target, and the slide down at the end
  wallMaxTime: 2.0,       // a wall run never lasts longer; the climb and the speed fade out over it
  wallOffset: 0.95,       // distance from the body axis to the wall (about sin(wallTilt) * 1 m + the foot): the feet touch the wall
  wallTilt: 1.2,          // how far the body turns towards the wall (0 = upright, pi/2 = feet flat on the wall)
  wallConvert: 0.8,       // share of the speed into the wall that becomes climb speed when a wall is hit head-on
  wallJumpOut: 6.5, wallJumpUp: 9.5, wallJumpKeep: 0.8, // wall jump: speed away from the wall, vertical speed, share of the speed along the wall that is kept
  wallBlock: 0.45,        // time during which the wall just left cannot be caught again
  wallTopPush: 2.5,       // speed towards the wall when running off its top edge (the body arcs onto the roof)
  wallTopHop: 8,          // and the vertical speed it leaves with, at least
  // wall traversal: there is no key for it, the movement itself catches a wall (SpiderController._traverseProbe). Two states share the work:
  //   run   (state 'wall'): fast and momentum-driven. Sprinting straight at a facade from the ground, or flying at one (a jump, a web release) with the stick toward / along it, or just hitting
  //         it at speed: he runs along or up it with the speed he had. When the run is over (time, speed, stick released, a corner) it hands over to the crawl: he never just drops.
  //   crawl (state 'cling'): slow and exact. Walking into a wall for a moment, or any run that runs out. With no stick he stays where he is (the cling), no gravity.
  // Distances in m, speeds in m/s, times in s, angles in rad.
  clingReach: 1.5,        // in the air: a wall must be this close (from the body axis) to be caught by the crawl; on the ground: clingReachGround (he is pressed against it)
  clingReachGround: 1.0,
  clingReachUp: 1.4,      // the underside of a slab above the chest (a rising body catches it)
  clingMinHeight: 3.5,    // the wall must reach this far above the feet (no kerbs, shop fronts, sheds)
  clingPatch: 0.5,        // the surface must be flat this far around the contact point (no pipes, no small obstacles)
  clingInto: 0.6,         // how hard the stick must push (0..1) for a crawl attach at all
  clingApproach: 0.7,     // and how straight at the wall (cos of the angle: 0.7 = within 45 degrees). Walking along or past a wall never attaches
  clingIntentGround: 0.3, // s the push must last on the ground (a brush does nothing) ...
  clingIntentAir: 0.1,    // ... and in the air
  clingOffset: 0.5,       // distance from the chest to the surface (more than the collision radius, so the wall never pushes the body)
  clingFollow: 16,        // how strongly the body is drawn to that distance (per second)
  clingCrawl: 2.4, clingFast: 4.8, // crawl speed, and with Shift held; an analog stick scales it (slow, exact movement)
  clingAccel: 24, clingBrake: 40,  // acceleration towards the stick, and braking when it is released
  clingCoast: 14,         // slowing down from a speed above the target (a wall run that turns into a crawl keeps its speed for a moment)
  clingDeadzone: 0.15,    // stick magnitude below which there is no crawl
  clingTurn: 9,           // rad/s: how fast the head turns towards the direction of travel on the surface
  clingLost: 0.2,         // the surface may be missing this long before the body lets go
  clingCorner: 0.9,       // how far ahead / round the corner the next surface is looked for
  clingCornerDot: 0.35,   // the next surface must be this close to perpendicular (|n1 . n2| below it)
  clingGoal: 0.28,        // s the body takes to move round a corner
  clingJumpOut: 6, clingJumpUp: 8.5, clingJumpKeep: 0.6, // the jump off a surface: away from it, up (walls), and the share of the crawl speed kept
  clingRunSpeed: 9,       // Shift pressed while crawling along a wall: the run starts at (at least) this speed (momentum, then it hands back to the crawl)
  wallGroundMin: 7.5,     // from the ground a run needs Shift and at least this speed, straight at the facade (running past a wall does nothing)
  wallImpactSpeed: 8,     // in the air, hitting a facade at this speed starts a run with no stick at all: an impact keeps its momentum
  mantleSpeed: 3.2,       // climbing over a roof edge: the speed along the path (the duration follows from the length), ...
  mantleMin: 0.55,        // ... at least this long
  mantleRise: 0.5         // the body first rises until its chest is this far under the roof, then goes over the edge
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

/**
 * The second jump. `vel` {x, y, z} is changed in place: the vertical speed is RAISED to cfg.airJumpSpeed (a faster rise is kept), the horizontal velocity stays and a small
 * push cfg.airJumpForward is added along the wish direction (or, with no input, the direction of travel), so the speed never exceeds max(cfg.airJumpMaxSpeed, the speed
 * the body already had). The wish is camera-relative, length 0..1. Nothing else of the velocity is reset.
 */
function airJump(vel, wishX, wishZ, cfg = SPIDER) {
  const before = Math.hypot(vel.x, vel.z), m = Math.hypot(wishX, wishZ);
  let dx = 0, dz = 0, k = 0;
  if (m >= 0.2) { dx = wishX / m; dz = wishZ / m; k = Math.min(1, m); }
  else if (before > 1) { dx = vel.x / before; dz = vel.z / before; k = 1; }
  if (k > 0) {
    vel.x += dx * cfg.airJumpForward * k; vel.z += dz * cfg.airJumpForward * k;
    const after = Math.hypot(vel.x, vel.z), limit = Math.max(cfg.airJumpMaxSpeed, before);
    if (after > limit) { vel.x *= limit / after; vel.z *= limit / after; }
  }
  vel.y = Math.max(vel.y, cfg.airJumpSpeed);
  return vel;
}

/**
 * One step of a wall run. `wall` = { nx, nz (unit, pointing from the wall towards the body), tx, tz (unit tangent along the wall) }, `wish` camera-relative (length 0..1),
 * `k` = elapsed / cfg.wallMaxTime (0..1). The speed along the wall goes towards the input (cfg.wallRun, fading by a third over the run; a speed above it is taken away by
 * cfg.wallDrag); the vertical speed towards a climb (pushing into the wall, fading to nothing over the run) minus a slide that grows towards the end. The speed into the wall
 * is removed. Returns the speed along the wall (signed, along `t`).
 */
function wallVelocity(vel, wall, wishX, wishZ, k, h, cfg = SPIDER) {
  k = clamp(k, 0, 1);
  const along = clamp(wishX * wall.tx + wishZ * wall.tz, -1, 1), into = -(wishX * wall.nx + wishZ * wall.nz);
  let vt = vel.x * wall.tx + vel.z * wall.tz;
  const tgt = along * cfg.wallRun * (1 - 0.35 * k);
  vt = approach(vt, tgt, ((Math.abs(tgt) > Math.abs(vt) || tgt * vt < 0) ? cfg.wallAccel : cfg.wallDrag) * h);
  const climb = clamp((into - 0.2) / 0.8, 0, 1), vyT = cfg.wallClimb * (1 - k) * climb - cfg.wallSlide * k * k;
  vel.y = approach(vel.y, vyT, (vyT > vel.y ? cfg.wallLift : cfg.wallDown) * h);
  vel.x = wall.tx * vt; vel.z = wall.tz * vt;
  return vt;
}

/** Wall jump: away from the wall (cfg.wallJumpOut) and up (cfg.wallJumpUp + half of any rise), keeping cfg.wallJumpKeep of the speed along the wall. */
function wallJumpVelocity(vel, wall, cfg = SPIDER) {
  const vt = vel.x * wall.tx + vel.z * wall.tz;
  vel.x = wall.tx * vt * cfg.wallJumpKeep + wall.nx * cfg.wallJumpOut;
  vel.z = wall.tz * vt * cfg.wallJumpKeep + wall.nz * cfg.wallJumpOut;
  vel.y = Math.max(vel.y, 0) * 0.5 + cfg.wallJumpUp;
  return vel;
}

/** Jump off a surface with unit normal n = (nx, ny, nz): away from it by cfg.clingJumpOut, up by cfg.clingJumpUp on a wall (a ceiling just lets go: down), and cfg.clingJumpKeep of the crawl speed. */
function clingJumpVelocity(vel, nx, ny, nz, cfg = SPIDER) {
  const vn = vel.x * nx + vel.y * ny + vel.z * nz, k = cfg.clingJumpKeep;
  vel.x = (vel.x - nx * vn) * k + nx * cfg.clingJumpOut; vel.y = (vel.y - ny * vn) * k + ny * cfg.clingJumpOut; vel.z = (vel.z - nz * vn) * k + nz * cfg.clingJumpOut;
  if (ny > -0.5) vel.y += cfg.clingJumpUp;
  return vel;
}

export { SPIDER, clamp, approach, angleDiff, turnToward, moveToward2D, groundVelocity, airVelocity, projectRope, swingForces, releaseVelocity, airJump, wallVelocity, wallJumpVelocity, clingJumpVelocity };
