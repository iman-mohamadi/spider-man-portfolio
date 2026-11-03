import {
  SPIDER, clamp, turnToward, groundVelocity, airVelocity, projectRope, swingForces, releaseVelocity, airJump, wallVelocity, wallJumpVelocity, clingJumpVelocity
} from './spider-physics.js';
import { PROBE_INTERVAL, WallDetector, newWall, trackWall, wallFrame } from './spider-wallrun.js';
import {
  CLING_INTERVAL, CORNER_CONCAVE, CORNER_CONVEX, CORNER_MANTLE, newSurface, copySurface, sameSurface, probeCeiling, findSurface, stickDirection, crawlVelocity, turnHead, projectHead, clingFrame, trackSurface, probeCorner
} from './spider-cling.js';

// Spider-Man's movement: ground / air / web-swing states on a fixed 120 Hz step, camera-relative, with rooftop landing.
// It drives the `entity` that ThirdPersonControllerManager exposes to the camera, HUD, traffic and map (position = feet,
// heading, speed), but never edits the existing controllers: collision reuses controllers.resolveHorizontalCollision().
//
// Controls: W A S D move (relative to the camera), Shift sprint, Space jump, mouse look.
// Web (left mouse button), as a small state machine:
//   idle  --press, a valid target is selected-->  swinging   (from the ground this is a web launch: a hop, then the rope)
//   idle  --press, no target-->  stays idle; the press is remembered for ~0.2 s so a target found a moment later still attaches
//   swinging --button released-->  idle, momentum kept (a little boost)
//   swinging --Space-->  idle with a hop; swinging --rope far side / reached the anchor / landed-->  idle
// A held button never re-attaches by itself: every web is a new press. While swinging, W A S D steer (spider-physics.swingForces).
//
// Double jump and wall run (spider-physics.js airJump / wallVelocity / wallJumpVelocity, spider-wallrun.js for the wall detection). States: ground, air, swing, wall.
//   ground --Space--> air (first jump)         air --Space, once per airborne cycle, not about to land--> air (second jump: vertical speed raised, horizontal kept, small push)
//   air --a flat tall wall is confirmed, fast enough, stick toward / along it--> wall    wall --Space--> air (wall jump: away from the wall and up)
//   wall --max time / wall ended / input released / too slow / corner / landed--> air or ground    wall --web press with a target--> swing (the web is the only owner of the velocity then)
//   The air jump is refilled by landing and by attaching a web; Space on the rope still means "release with a hop" (it is not an air jump), and a wall run never starts on the rope.
//
// Wall traversal. There is no key for it: the movement itself catches a wall (_traverseProbe), and two states share the work.
//   wall  (the run: fast, momentum; spider-wallrun.js finds the wall)   Sprinting (Shift) straight at a facade from the ground, or flying at one in the air (a jump, a web release) with the
//         stick toward or along it, or just hitting it at speed: he runs along or up it with the speed he had (an impact keeps its momentum). Space = wall jump.
//   cling (the crawl: slow, exact; spider-cling.js finds and follows the surface)   Pushing the stick straight into a wall for a moment (on the ground or in the air), rising into the underside
//         of a slab, or any run that is over. W A S D crawl up / down / left / right along the surface as the camera sees it (Shift = faster); with no stick he stays where he is (the cling),
//         no gravity. Shift pressed while crawling along a wall launches a run. Space = jump off. Round corners and over the top edge onto the roof; down to the floor stands him up again.
//   ground / air --stick into a wall for a moment (or a fast approach)--> cling / wall        wall --stick released, time or speed gone, corner, top--> cling (the same velocity, never a drop)
//   cling --Shift pressed--> wall        wall / cling --Space--> air (jump away; the air jump is back)        wall / cling --left click with a target--> swing        cling --floor--> ground
//   cling --top edge--> mantle (a staged climb over the edge, then ground)

const STEP = 1 / 120;
const SUBSTEPS = 4; // rope constraint sub-steps per tick (keeps the pendulum's energy within 1%)
const PRESS_BUFFER = 0.22; // s a web press stays valid while waiting for a target
const RELEASE_HOP = 3.5; // m/s of extra lift when letting go with Space
const MIN_HOLD = 0.18; // s a web stays up after it was shot, whatever the button does (a twitchy tap must not destroy the swing)
const TAP_GRACE = 0.12; // s a press counts as held even if the button is already up again (press and release inside one frame)

class SpiderController {
  constructor({ controllers, world, entity, input, getViewYaw, rig, config = SPIDER }) {
    this.ctrl = controllers;
    this.world = world;
    this.entity = entity;
    this.input = input;
    this.getViewYaw = getViewYaw;
    this.rig = rig;
    this.cfg = config;
    this.targeting = null; // set by the installer: provides the selected web target
    this.pos = entity.position;
    this.renderPos = { x: entity.position.x, y: entity.position.y, z: entity.position.z }; // the simulation extrapolated to the frame time
    this.vel = { x: 0, y: 0, z: 0 };
    this.state = 'air';
    this.paused = false;
    this.acc = 0;
    this.time = 0;
    this.coyote = 0;
    this.jumpBuf = 0;
    this.crouch = 0;
    this.anchor = null;
    this.webLength = 0;
    this.webTarget = 0;
    this.webCooldown = 0;
    this.pressBuffer = 0;
    this.tapGrace = 0;
    this.swingTime = 0;
    this.noAnchorFlash = 0;
    this.lastSafe = { x: entity.position.x, y: entity.position.y, z: entity.position.z };
    this.safeTimer = 0;
    this._prevUp = false;
    this._jumpEdge = false;
    this._webPress = false;
    this._wish = { x: 0, z: 0, fwd: 0, str: 0 };
    this._chest = { x: 0, y: 0, z: 0 };
    this._anchorLocal = { x: 0, y: 1, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; } };
    this._fwd = { x: 0, y: 0, z: 1 };
    this._right = { x: -1, y: 0, z: 0 };
    this.tension = 0.6;
    this.webSide = 1;
    this.stats = { swings: 0, lastSwingSpeed: 0, launches: 0, airJumps: 0, wallRuns: 0, wallJumps: 0 };
    // double jump
    this.airJumps = 0;     // air jumps used in this airborne cycle
    this.airTime = 0;      // s since the body left the ground / the web / the wall
    this.airJumpId = 0;    // counts air jumps (the rig restarts its jump pose when it changes)
    this.airJumpT = -1;    // s since the last air jump, -1 = none in this cycle (the rig's somersault)
    // wall run
    this.wall = newWall(); // the wall being run on: unit normal (towards the body), tangent (in the direction of travel), plane constant c, distance
    this.wallTime = 0; this.wallLost = 0; this.wallInputLost = 0; this.wallSlow = 0; this.wallTrackT = 0;
    this.wallBlock = { nx: 0, nz: 0, c: 0, t: 0 }; // the wall just left: not caught again for cfg.wallBlock s
    this.wallDetector = new WallDetector();
    this._wallTmp = newWall();
    this.wallPose = { active: false, cling: false, rate: 12, ux: 0, uy: 1, uz: 0, fx: 0, fy: 0, fz: 1 }; // the body's orientation for the rig while running / clinging
    // wall cling and crawl
    this.surf = newSurface(); this._surfTmp = newSurface();      // the surface being clung to; a scratch one for the probes
    this._corner = { nx: 0, ny: 0, nz: 1, c: 0, dist: 0, kind: 'wall', gx: 0, gy: 0, gz: 0 };
    this.clingHead = { x: 0, y: 1, z: 0 };                       // where the head points on the surface (it turns towards the direction of travel)
    this._dir = { x: 0, y: 0, z: 0 };                            // the stick on the surface (stickDirection)
    this.clingTurnT = 0; this.turnDir = { x: 0, y: 0, z: 0 }; this.turnWx = 0; this.turnWz = 0; // after a corner: the stick that went round it keeps going round (see _clingTurn)
    this.clingTime = 0; this.clingLost = 0; this.clingTrackT = 0; this.clingProbeT = CLING_INTERVAL; this.clingGoalT = 0; this.clingSpeed = 0;
    this.clingIntentT = 0; this._intentSurf = newSurface(); this._shiftPrev = false; this.clingResumeT = 0; this.clingResumeArm = false; this._wishV = { x: 0, z: 0 };
    this.mantle = { active: false, t: 0, dur: 1, u: 0, u1: 0.5, x0: 0, y0: 0, z0: 0, x1: 0, y1: 0, z1: 0, x2: 0, y2: 0, z2: 0 }; // the staged climb over a roof edge
    this.clingGoal = { x: 0, y: 0, z: 0 };
    this._cand = new Float64Array(12);
    this.stats.clings = 0;
  }

  get swinging() { return this.state === 'swing'; }
  get grounded() { return this.state === 'ground'; }
  get wallRunning() { return this.state === 'wall'; }
  get clinging() { return this.state === 'cling'; }

  /** Called when the player is teleported / respawned: forget all motion. */
  resetMotion() {
    this.vel.x = this.vel.y = this.vel.z = 0;
    this.state = 'air';
    this.anchor = null;
    this.crouch = 0;
    this.jumpBuf = 0;
    this.coyote = 0;
    this.pressBuffer = 0;
    this._webPress = false;
    this.acc = 0;
    this.airJumps = 0; this.airTime = 0; this.airJumpT = -1;
    this.wallPose.active = false; this.wallBlock.t = 0; this.wallDetector.reset();
    this.clingGoalT = 0; this.clingSpeed = 0; this.clingIntentT = 0; this.clingResumeT = 0; this.mantle.active = false;
  }

  _readWish() {
    const k = this.ctrl.keys, w = this._wish;
    if (this.paused) { w.x = w.z = w.fwd = w.str = 0; return w; }
    const fwd = (+k.forward || 0) - (+k.backward || 0), str = (+k.right || 0) - (+k.left || 0);
    const yaw = this.getViewYaw(), fx = Math.sin(yaw), fz = Math.cos(yaw), rx = -Math.cos(yaw), rz = Math.sin(yaw);
    let x = fx * fwd + rx * str, z = fz * fwd + rz * str;
    const m = Math.hypot(x, z);
    if (m > 1) { x /= m; z /= m; }
    w.x = x; w.z = z; w.fwd = fwd; w.str = str;
    return w;
  }

  // Pushes the body out of buildings (existing collision) and removes the velocity that points into the obstacle.
  _collide() {
    const p = this.pos, px = p.x, pz = p.z;
    this.ctrl.resolveHorizontalCollision(p, this.cfg.radius, null, null);
    const dx = p.x - px, dz = p.z - pz, m = Math.hypot(dx, dz);
    if (m > 1e-6) {
      const nx = dx / m, nz = dz / m, vn = this.vel.x * nx + this.vel.z * nz;
      if (vn < 0) { this.vel.x -= nx * vn; this.vel.z -= nz * vn; }
    }
    return m;
  }

  _face(h) {
    if (Math.hypot(this.vel.x, this.vel.z) > 1.2) this.entity.heading = turnToward(this.entity.heading, Math.atan2(this.vel.x, this.vel.z), this.cfg.turnRate * h);
  }

  _land(impact) {
    this.state = 'ground';
    this.airJumps = 0; this.airJumpT = -1; this.wallPose.active = false; // landing refills the air jump
    this.vel.y = 0;
    if (impact > 5) this.crouch = clamp(impact / 20, 0.2, 1);
    if (impact > 22) { this.vel.x *= 0.6; this.vel.z *= 0.6; } // a hard landing costs speed
  }

  _stepGround(h, w) {
    const cfg = this.cfg, p = this.pos;
    groundVelocity(this.vel, w.x, w.z, this.input.shift && !this.paused, h, cfg);
    this.vel.y = 0;
    p.x += this.vel.x * h; p.z += this.vel.z * h;
    this._collide();
    this._face(h);
    const floor = this.world.floorAt(p.x, p.z, p.y, cfg.stepUp);
    if (floor < p.y - cfg.stepDown) { this.state = 'air'; this.coyote = cfg.coyote; this.airTime = 0; }
    else p.y = floor;
    if (this.jumpBuf > 0 && this.state === 'ground') {
      this.vel.y = cfg.jumpSpeed; this.state = 'air'; this.jumpBuf = 0; this.coyote = 0; p.y += 0.02; this.airTime = 0;
    }
    this._webInput();
  }

  _stepAir(h, w) {
    const cfg = this.cfg, p = this.pos;
    this.airTime += h;
    airVelocity(this.vel, w.x, w.z, h, cfg);
    if (this.jumpBuf > 0 && this.coyote > 0) { this.vel.y = cfg.jumpSpeed; this.jumpBuf = 0; this.coyote = 0; }
    else if (this.jumpBuf > 0 && this._canAirJump()) this._airJump(w);
    const prevY = p.y;
    this.vel.y = Math.max(this.vel.y - cfg.gravity * h, -cfg.terminal);
    p.x += this.vel.x * h; p.z += this.vel.z * h;
    this._collide();
    p.y += this.vel.y * h;
    this._face(h);
    // landing: the highest support that the feet were above during this step (street, sidewalk, park or ROOFTOP)
    const floor = this.world.floorAt(p.x, p.z, prevY, 0.3);
    if (this.vel.y <= 0 && p.y <= floor) { const impact = -this.vel.y; p.y = floor; this._land(impact); return; }
    this._webInput();
    if (p.y < -25) this._respawn();
  }

  /** A second jump is allowed: one per airborne cycle, not in the first moments (a double press is one jump), not while paused, and not when the ground is about to arrive (that press is a buffered ground jump). */
  _canAirJump() {
    const cfg = this.cfg, p = this.pos, vy = this.vel.y;
    if (this.state !== 'air' || this.paused || this.airJumps >= cfg.airJumps || this.airTime < cfg.airJumpDelay) return false;
    if (vy < 0) {
      const hAbove = Math.max(0, p.y - this.world.floorAt(p.x, p.z, p.y, 0.3));
      if ((vy + Math.sqrt(vy * vy + 2 * cfg.gravity * hAbove)) / cfg.gravity < cfg.airJumpMinLandIn) return false;
    }
    return true;
  }

  _airJump(w) {
    airJump(this.vel, w.x, w.z, this.cfg);
    this.airJumps++; this.airJumpId++; this.airJumpT = 0; this.jumpBuf = 0; this.coyote = 0; this.stats.airJumps++;
  }

  // ------------------------------------------------------------------------------------------------------------------ wall traversal
  /** Once per frame on the ground or in the air: does the way he moves catch a wall (a run), does he walk into one (a crawl), or rise into the underside of a slab? */
  _traverseProbe(dt, w) {
    const cfg = this.cfg, p = this.pos, v = this.vel, air = this.state === 'air';
    if (this.paused || (air && this.airTime < 0.05)) { this.wallDetector.reset(); this.clingIntentT = 0; this.clingProbeT = CLING_INTERVAL; return; }
    const hs = Math.hypot(v.x, v.z), wm = Math.hypot(w.x, w.z);
    // the run: fast enough (Shift and 7.5 m/s straight at a facade from the ground; any fast flight in the air), the stick toward or along the wall; in the air, hitting a facade at speed
    // counts with no stick at all: an impact keeps its momentum
    let rw = w;
    if (air && wm < cfg.wallInput && hs >= cfg.wallImpactSpeed) { rw = this._wishV; rw.x = v.x / hs; rw.z = v.z / hs; }
    if ((air && hs >= cfg.wallMinSpeed) || (!air && this.input.shift && hs >= cfg.wallGroundMin)) {
      const found = this.wallDetector.update(dt, this.world, p, v, rw, cfg, this.wallBlock);
      // with no stick only a real impact counts (the facade is hit at more than about 17 degrees: flying along a wall is not a reason to stick to it)
      if (found && (air ? p.y - this.world.floorAt(p.x, p.z, p.y, 0.3) > 0.5 && (rw !== this._wishV || found.approach >= 0.3) : found.headOn)) { this._enterWall(found); return; }
    } else this.wallDetector.reset();
    this._crawlProbe(dt, w, wm, air);
  }

  /** The crawl: the stick pushes straight into a wall (within 45 degrees) for a moment. 30 probes a second, one ray each until a wall is in reach. */
  _crawlProbe(dt, w, wm, air) {
    const cfg = this.cfg, p = this.pos, t = this._surfTmp, c = this._cand;
    this.clingProbeT += dt;
    if (this.clingProbeT < CLING_INTERVAL) return;
    const step = this.clingProbeT; this.clingProbeT = 0;
    let hit = false;
    if (wm >= cfg.clingInto) {
      c[0] = w.x / wm; c[1] = w.z / wm;
      if (findSurface(this.world, p, c, 1, cfg, t, this._wallTmp, false, air ? cfg.clingReach : cfg.clingReachGround, cfg.clingApproach)) {
        const b = this.wallBlock, d = t.nx * b.nx + t.nz * b.nz;
        if (!(b.t > 0 && Math.abs(d) > 0.97 && Math.abs(t.c - (d > 0 ? b.c : -b.c)) < 0.7)) { // not the wall just left
          hit = true;
          this.clingIntentT = this.clingIntentT > 0 && sameSurface(t, this._intentSurf) ? this.clingIntentT + step : step;
          copySurface(this._intentSurf, t);
          if (this.clingIntentT >= (air ? cfg.clingIntentAir : cfg.clingIntentGround)) { this.clingIntentT = 0; this._enterCling(t); return; }
        }
      }
    }
    if (!hit) this.clingIntentT = 0;
    if (air && this.vel.y > 0.5 && probeCeiling(this.world, p.x, p.y + 1, p.z, cfg.clingReachUp, cfg, t)) this._enterCling(t); // a rising body catches an underside
  }

  _enterWall(found) {
    const W = this.wall, v = this.vel, cfg = this.cfg;
    W.nx = found.nx; W.nz = found.nz; W.tx = found.tx; W.tz = found.tz; W.c = found.c; W.dist = found.dist; W.headOn = found.headOn;
    const into = -(v.x * W.nx + v.z * W.nz); // speed into the wall becomes climb speed (capped), the rest of the horizontal speed stays along the wall
    if (into > 0) v.y = Math.min(Math.max(v.y, 0) + into * cfg.wallConvert, cfg.wallClimb * 1.3);
    const vt = v.x * W.tx + v.z * W.tz; v.x = W.tx * vt; v.z = W.tz * vt;
    this.state = 'wall';
    this.wallTime = 0; this.wallLost = 0; this.wallInputLost = 0; this.wallSlow = 0; this.wallTrackT = 0; this.clingIntentT = 0; this.mantle.active = false;
    this.jumpBuf = 0; this.coyote = 0; this.pressBuffer = 0; this.stats.wallRuns++;
    this.wallDetector.reset();
    this.wallPose.cling = false; this.wallPose.rate = 12; wallFrame(W, v, cfg, this.wallPose); this.wallPose.active = true;
  }

  /** Leaves the wall for the air (a jump, a pause). `block`: the wall cannot be caught again for a moment. */
  _exitWall(top = false, block = true) {
    const W = this.wall, v = this.vel, cfg = this.cfg;
    if (top && v.y > 1) { v.y = Math.max(v.y, cfg.wallTopHop); v.x -= W.nx * cfg.wallTopPush; v.z -= W.nz * cfg.wallTopPush; }
    if (block) { const b = this.wallBlock; b.nx = W.nx; b.nz = W.nz; b.c = W.c; b.t = cfg.wallBlock; }
    this.state = 'air'; this.airTime = 0; this.coyote = 0; this.pressBuffer = 0;
    this.wallPose.active = false; this.wallDetector.reset();
  }

  /** A run that is over (stick released, time or speed gone, a corner, the top edge): the crawl takes over with the same velocity and handles the corner, the roof or the end of the wall. */
  _wallToCling(resume = false) {
    const W = this.wall, t = this._surfTmp;
    t.nx = W.nx; t.ny = 0; t.nz = W.nz; t.c = W.c; t.dist = W.dist; t.kind = 'wall';
    this.wallPose.active = false; this._enterCling(t);
    this.clingResumeArm = !!resume; // a run that only met a corner goes on running (while Shift is held) once the corner has really been turned (never when the wall is simply gone)
  }

  _stepWall(h, w) {
    const cfg = this.cfg, p = this.pos, v = this.vel, W = this.wall;
    this.wallTime += h;
    if (this.paused) { this._exitWall(false); return; }
    if (this.jumpBuf > 0) { // wall jump: away from the wall and up, most of the speed along the wall kept; the wall is blocked for a moment
      this.jumpBuf = 0; wallJumpVelocity(v, W, cfg); this.stats.wallJumps++;
      p.x += W.nx * 0.1; p.z += W.nz * 0.1;
      this.airJumps = 0; this.airJumpT = -1; // the air jump is back (a wall is something to push off)
      this._exitWall(false); return;
    }
    const into = -(w.x * W.nx + w.z * W.nz), along = w.x * W.tx + w.z * W.tz;
    this.wallInputLost = into >= cfg.wallInput || Math.abs(along) >= cfg.wallInput ? 0 : this.wallInputLost + h; // the stick must keep pointing toward / along the wall
    if (this.wallInputLost > cfg.wallExitGrace || this.wallTime >= cfg.wallMaxTime) { this._wallToCling(); return; }
    const vt = wallVelocity(v, W, w.x, w.z, this.wallTime / cfg.wallMaxTime, h, cfg);
    this.wallSlow = Math.abs(vt) < cfg.wallMinSpeed * 0.45 && v.y < 1 ? this.wallSlow + h : 0; // no speed and no climb left: it is over
    if (this.wallSlow > cfg.wallExitGrace) { this._wallToCling(); return; }
    const prevY = p.y;
    p.x += v.x * h; p.y += v.y * h; p.z += v.z * h;
    const corr = (cfg.wallOffset - (W.nx * p.x + W.nz * p.z - W.c)) * Math.min(1, 12 * h); // a stable distance from the wall plane, reached smoothly
    p.x += W.nx * corr; p.z += W.nz * corr;
    const pushed = this._collide();
    if (pushed > 0.05) { this._wallToCling(true); return; } // something else is in the way (an inside corner): the crawl turns the corner
    this._face(h);
    // follow the wall: the plane is measured again at 30 Hz; a wall that ended (top edge), turned (corner) or is not flat any more hands over to the crawl, which knows corners and roofs
    this.wallTrackT += h;
    if (this.wallTrackT >= PROBE_INTERVAL) {
      this.wallTrackT = 0;
      if (trackWall(this.world, p, W, cfg, this._wallTmp)) this.wallLost = 0;
      else if ((this.wallLost += PROBE_INTERVAL) >= 2 * PROBE_INTERVAL) { this._wallToCling(true); return; }
    }
    this._webInput(); // a web press with a target leaves the wall for the rope (_attach)
    if (this.state !== 'wall') return;
    const floor = this.world.floorAt(p.x, p.z, prevY, 0.3);
    if (v.y <= 0 && p.y <= floor) { const impact = -v.y; p.y = floor; this._exitWall(false); this._land(impact); }
  }

  // ------------------------------------------------------------------------------------------------------------------ the crawl and the cling
  _enterCling(surface) {
    const S = this.surf, v = this.vel;
    copySurface(S, surface);
    this.state = 'cling';
    this.clingTime = 0; this.clingLost = 0; this.clingTrackT = 0; this.clingGoalT = 0; this.clingSpeed = 0; this.clingIntentT = 0; this.clingResumeT = 0; this.clingResumeArm = false; this.clingTurnT = 0; this.mantle.active = false;
    this._shiftPrev = !!this.input.shift; // a Shift that was already down is not a new press
    this.airJumps = 0; this.airJumpT = -1; this.jumpBuf = 0; this.coyote = 0; this.pressBuffer = 0; this.stats.clings++; // a surface refills the air jump, like a web
    const vn = v.x * S.nx + v.y * S.ny + v.z * S.nz; v.x -= S.nx * vn; v.y -= S.ny * vn; v.z -= S.nz * vn; // only what lies in the plane is kept (and is let go gently: clingCoast)
    if (S.kind === 'wall') { this.clingHead.x = 0; this.clingHead.y = 1; this.clingHead.z = 0; } // head up
    else { const yaw = this.getViewYaw(); this.clingHead.x = Math.sin(yaw); this.clingHead.y = 0; this.clingHead.z = Math.cos(yaw); } // a ceiling: head where the camera looks
    this.wallDetector.reset();
    this.wallPose.cling = true; this.wallPose.rate = 10; clingFrame(S, this.clingHead, this.wallPose); this.wallPose.active = true;
  }

  /** Leaves the surface for the air (no impulse). `block`: it cannot be grabbed again for a moment. */
  _exitCling(block = true) {
    const S = this.surf, cfg = this.cfg;
    if (block) { const b = this.wallBlock; b.nx = S.nx; b.nz = S.nz; b.c = S.c; b.t = cfg.wallBlock; }
    this.state = 'air'; this.airTime = 0; this.coyote = 0; this.pressBuffer = 0;
    this.wallPose.active = false; this.clingGoalT = 0; this.clingResumeArm = false; this.mantle.active = false; this.wallDetector.reset();
  }

  /** Shift pressed while crawling along a wall: the run, starting at least at cfg.clingRunSpeed in the direction of the stick. */
  _clingToRun(w) {
    const S = this.surf, B = this._dir, v = this.vel, cfg = this.cfg;
    const dx = B.x, dy = B.y, dz = B.z, m = Math.hypot(dx, dy, dz) || 1;
    const sp = Math.max(cfg.clingRunSpeed, cfg.wallMinSpeed + 0.5, this.clingSpeed);
    v.x = dx / m * sp; v.y = dy / m * sp; v.z = dz / m * sp;
    const f = this._wallTmp; f.nx = S.nx; f.nz = S.nz; f.c = S.c; f.dist = S.dist; f.headOn = false;
    let tx = -S.nz, tz = S.nx; if (tx * v.x + tz * v.z < 0 || (Math.abs(v.x) + Math.abs(v.z) < 0.5 && tx * w.x + tz * w.z < 0)) { tx = -tx; tz = -tz; }
    f.tx = tx; f.tz = tz;
    this.state = 'air'; this.airTime = 0; this._enterWall(f);
  }

  /**
   * Moves onto the next surface (an inside or outside corner): the new plane at once, the body glides to its new place in cfg.clingGoal seconds, the head is kept in the new plane. The
   * stick that took him to the corner keeps taking him round it: while it is held unchanged he goes on along the new face, away from the corner (the direction the old normal gave:
   * outside corner = away from the old wall, inside corner = out along the old wall's normal), whatever the camera sees.
   */
  _clingTurn(c, convex) {
    const S = this.surf, v = this.vel, g = this.clingGoal, cfg = this.cfg, w = this._wish, wm = Math.hypot(w.x, w.z) || 1, sgn = convex ? -1 : 1;
    this.turnDir.x = sgn * S.nx; this.turnDir.y = sgn * S.ny; this.turnDir.z = sgn * S.nz; this.turnWx = w.x / wm; this.turnWz = w.z / wm; this.clingTurnT = 60; // until the stick changes by more than ~37 degrees (turning the camera does that) or lets go
    copySurface(S, c);
    if (this.clingResumeArm) { this.clingResumeT = cfg.clingGoal + 0.8; this.clingResumeArm = false; }
    g.x = c.gx; g.y = c.gy; g.z = c.gz; this.clingGoalT = cfg.clingGoal;
    const vn = v.x * S.nx + v.y * S.ny + v.z * S.nz; v.x -= S.nx * vn; v.y -= S.ny * vn; v.z -= S.nz * vn;
    const yaw = this.getViewYaw();
    if (S.kind === 'wall') projectHead(this.clingHead, S, 0, 1, 0); else projectHead(this.clingHead, S, Math.sin(yaw), 0, Math.cos(yaw));
    this.clingLost = 0;
  }

  /**
   * Over a roof edge: a staged climb, not a glide. First the body rises along the wall until its chest is `mantleRise` under the roof (the hands on the edge), then it goes over the edge
   * onto the roof. The duration follows from the length of that path and cfg.mantleSpeed; the motion eases in and out of both stages. `c` = the roof position (c.gx, c.gy, c.gz: the feet).
   */
  _startMantle(c) {
    const m = this.mantle, p = this.pos, cfg = this.cfg, v = this.vel;
    m.x0 = p.x; m.y0 = p.y; m.z0 = p.z;
    m.x1 = p.x; m.y1 = Math.max(p.y, c.gy - cfg.mantleRise); m.z1 = p.z;
    m.x2 = c.gx; m.y2 = c.gy; m.z2 = c.gz;
    const l1 = m.y1 - m.y0, l2 = Math.hypot(m.x2 - m.x1, m.y2 - m.y1, m.z2 - m.z1);
    m.dur = Math.max(cfg.mantleMin, (l1 + l2) / cfg.mantleSpeed); m.u1 = Math.min(0.85, Math.max(0.15, (l1 + 0.001) / (l1 + l2 + 0.002))); m.t = 0; m.u = 0; m.active = true;
    v.x = v.y = v.z = 0; this.clingSpeed = 0;
  }

  _stepMantle(h) {
    const m = this.mantle, p = this.pos, v = this.vel, ox = p.x, oy = p.y, oz = p.z;
    m.t += h; const u = Math.min(1, m.t / m.dur); m.u = u;
    const ease = (a) => a * a * (3 - 2 * a);
    if (u < m.u1) { const a = ease(u / m.u1); p.x = m.x0 + (m.x1 - m.x0) * a; p.y = m.y0 + (m.y1 - m.y0) * a; p.z = m.z0 + (m.z1 - m.z0) * a; }
    else { const a = ease((u - m.u1) / (1 - m.u1)); p.x = m.x1 + (m.x2 - m.x1) * a; p.y = m.y1 + (m.y2 - m.y1) * a; p.z = m.z1 + (m.z2 - m.z1) * a; }
    v.x = (p.x - ox) / h; v.y = (p.y - oy) / h; v.z = (p.z - oz) / h; this.clingSpeed = Math.hypot(v.x, v.y, v.z); // the speed of the climb, for the camera and the gait
    if (m.t >= m.dur) { // on the roof: standing again, with a little of the crouch of the push-up
      m.active = false; this._exitCling(false); v.x = v.y = v.z = 0; p.set(m.x2, m.y2, m.z2); this._land(0); this.crouch = 0.45;
    }
  }

  _stepCling(h, w) {
    const cfg = this.cfg, S = this.surf, p = this.pos, v = this.vel, B = this._dir;
    this.clingTime += h;
    if (this.paused) { this._exitCling(false); return; }
    if (this.mantle.active) { this.jumpBuf = 0; this._stepMantle(h); return; }
    if (this.jumpBuf > 0) { // jump off the surface (the wall jump of a cling): away from it and up
      this.jumpBuf = 0; clingJumpVelocity(v, S.nx, S.ny, S.nz, cfg); this.stats.wallJumps++;
      p.x += S.nx * 0.1; p.y += S.ny * 0.1; p.z += S.nz * 0.1;
      this._exitCling(true); return;
    }
    // the stick, on the surface: W up, S down, A left, D right as the camera sees it; Shift crawls faster, and pressing it starts a run
    const live = Math.hypot(w.x, w.z) > cfg.clingDeadzone;
    stickDirection(S, w.x, w.z, B);
    if (this.clingTurnT > 0) { // a corner was just turned: the same stick goes on round it (until it changes or lets go)
      this.clingTurnT -= h; const wm = Math.hypot(w.x, w.z) || 1;
      if (live && (w.x * this.turnWx + w.z * this.turnWz) / wm > 0.8) { const k = Math.min(1, wm); B.x = this.turnDir.x * k; B.y = this.turnDir.y * k; B.z = this.turnDir.z * k; } else this.clingTurnT = 0;
    }
    const shift = !!this.input.shift, edge = shift && !this._shiftPrev;
    this._shiftPrev = shift;
    if (!shift) this.clingResumeT = 0; else if (this.clingResumeT > 0) this.clingResumeT -= h;
    if (S.kind === 'wall' && live && this.clingGoalT <= 0 && (edge || this.clingResumeT > 0)) { this.clingResumeT = 0; this._clingToRun(w); return; }
    const speed = crawlVelocity(v, S, live ? B.x : 0, live ? B.y : 0, live ? B.z : 0, shift ? cfg.clingFast : cfg.clingCrawl, cfg.clingAccel, cfg.clingBrake, h, cfg.clingCoast);
    this.clingSpeed = speed;
    if (live) turnHead(this.clingHead, S, B.x, B.y, B.z, cfg.clingTurn * h); // the head leads where the stick sends him (not where he happens to be falling or coasting), and never snaps
    p.x += v.x * h; p.y += v.y * h; p.z += v.z * h;
    if (this.clingGoalT > 0) { // round a corner: glide to the place on the new surface
      const g = this.clingGoal, k = h / Math.max(h, this.clingGoalT);
      p.x += (g.x - p.x) * k; p.y += (g.y - p.y) * k; p.z += (g.z - p.z) * k;
      this.clingGoalT -= h;
    } else {
      const d = S.nx * p.x + S.ny * (p.y + 1) + S.nz * p.z - S.c, corr = (cfg.clingOffset - d) * Math.min(1, cfg.clingFollow * h); // a stable distance, reached smoothly
      p.x += S.nx * corr; p.y += S.ny * corr; p.z += S.nz * corr;
    }
    if (S.kind === 'wall') {
      this._collide(); // anything else in the way (the horizontal collision; the wall itself is further away than the collision radius)
      const floor = this.world.floorAt(p.x, p.z, p.y + 0.3, 0.3); // a floor under the feet: standing on it, or, crawling down, back to the ground
      if (p.y <= floor + 1e-3) {
        p.y = floor;
        if (v.y < -0.05 || (live && B.y < -0.3)) { this._exitCling(false); this._land(0); return; }
        if (v.y < 0) v.y = 0;
      }
    }
    if (this.clingGoalT <= 0) { // follow the surface at 30 Hz; look ahead for a corner while moving
      this.clingTrackT += h;
      if (this.clingTrackT >= CLING_INTERVAL) {
        this.clingTrackT = 0;
        const moving = speed > 0.5, mx = v.x / (speed || 1), my = v.y / (speed || 1), mz = v.z / (speed || 1);
        if (moving && probeCorner(this.world, p, S, mx, my, mz, cfg, false, this._corner) === CORNER_CONCAVE) { this._clingTurn(this._corner, false); return; }
        const tr = trackSurface(this.world, p, S, cfg); // 0 gone, 1 good, 2 on it but within the patch radius of an edge
        if (tr) this.clingLost = 0;
        if (tr !== 1) { // an edge is near (or passed): the next surface round it, or the roof above
          const type = moving ? probeCorner(this.world, p, S, mx, my, mz, cfg, true, this._corner) : 0;
          if (type === CORNER_CONVEX) { this._clingTurn(this._corner, true); return; }
          if (type === CORNER_MANTLE) { this._startMantle(this._corner); return; }
          if (!tr) {
            this.clingLost += CLING_INTERVAL;
            if (this.clingLost > cfg.clingLost) { this._exitCling(true); return; } // the surface is gone: fall (with the velocity he had)
          }
        }
      }
    }
    this._webInput(); // a web press with a target leaves the surface for the rope (_attach)
  }

  /** The press / buffer part of the web state machine for a body that is not on the rope. */
  _webInput() {
    if (this._webPress) {
      this._webPress = false;
      this.pressBuffer = PRESS_BUFFER;
      if (!this.targeting || !this.targeting.current()) { this.noAnchorFlash = 0.45; this.targeting?.flash('miss'); }
    }
    if (this.pressBuffer <= 0 || this.webCooldown > 0 || this.paused) return;
    if (!this.input.webHeld && this.tapGrace <= 0) { this.pressBuffer = 0; return; } // let go before a target appeared: the press is void
    const t = this.targeting && this.targeting.current();
    if (!t) return;
    this.pressBuffer = 0;
    this._attach(t);
  }

  _attach(t) {
    const p = this.pos, v = this.vel, cfg = this.cfg;
    if (this.state === 'cling') this._exitCling(true);
    if (this.state === 'wall') this._exitWall(false); // the web takes over the velocity: the wall is let go first (and cannot be caught again at once)
    this.airJumps = 0; this.airJumpT = -1; // hanging from a web refills the air jump
    if (this.state === 'ground') { // web launch: a hop first, so the rope does not start from the street
      v.y = Math.max(v.y, cfg.jumpSpeed * 0.9); p.y += 0.05; this.state = 'air'; this.stats.launches++;
    }
    const cy = p.y + cfg.chest;
    const ground = this.world.floorAt(p.x, p.z, p.y, 0.3);
    this.anchor = { x: t.x, y: t.y, z: t.z };
    const d = Math.hypot(p.x - t.x, cy - t.y, p.z - t.z);
    this.webLength = clamp(d, 1, cfg.webMax); // starts at the current distance (no jerk) and is reeled in towards webTarget
    this.webTarget = clamp(Math.min(d * 0.97, t.y - ground - cfg.swingClearance), cfg.webMin, cfg.webMax);
    this.state = 'swing';
    this.swingTime = 0;
    this.stats.swings++;
    this.targeting?.flash('hit');
    // which hand holds the web: the side the anchor is on (alternating when it is straight ahead), so successive swings look different
    const ch = Math.cos(this.entity.heading), sh = Math.sin(this.entity.heading), lx = (t.x - p.x) * ch - (t.z - p.z) * sh;
    this.webSide = Math.abs(lx) < 4 ? (this.stats.swings % 2 ? 1 : -1) : lx > 0 ? 1 : -1;
  }

  _endSwing(letGo) {
    if (letGo) releaseVelocity(this.vel, this.cfg);
    this.stats.lastSwingSpeed = Math.hypot(this.vel.x, this.vel.y, this.vel.z);
    this.state = 'air';
    this.anchor = null;
    this.coyote = 0;
    this.pressBuffer = 0;
    this.webCooldown = 0.12;
    this.airTime = 0;
  }

  _stepSwing(h, w) {
    const cfg = this.cfg, p = this.pos, v = this.vel, a = this.anchor, c = this._chest;
    this._webPress = false; // a second click while on the rope is not a new web
    this.swingTime += h;
    if (this.paused || !a || (!this.input.webHeld && this.swingTime > MIN_HOLD)) { this._endSwing(true); return; } // button released: let go, momentum is kept
    if (this.jumpBuf > 0) { this.jumpBuf = 0; this._endSwing(true); v.y += RELEASE_HOP; return; } // Space: release with a hop
    const prevY = p.y;
    c.x = p.x; c.y = p.y + cfg.chest; c.z = p.z;
    const yaw = this.getViewYaw(), f = this._fwd, r = this._right;
    f.x = Math.sin(yaw); f.z = Math.cos(yaw); r.x = -Math.cos(yaw); r.z = Math.sin(yaw);
    swingForces(v, c, a, f, r, w.fwd, w.str, h, cfg);
    // reel in: a smooth pull that eases in over the first reelRamp seconds (no yank the instant the web hits)
    if (this.webLength > this.webTarget) {
      const ease = cfg.reelRamp > 0 ? Math.min(1, this.swingTime / cfg.reelRamp) : 1;
      // too close to the street on the way down: pull harder, so the arc clears the ground instead of scraping it
      const low = p.y < this.world.floorAt(p.x, p.z, p.y, 0.3) + 6 && v.y < 0 ? 2.6 : 1;
      this.webLength = Math.max(this.webTarget, this.webLength - cfg.reelSpeed * ease * ease * low * h);
    }
    const hh = h / SUBSTEPS;
    for (let s = 0; s < SUBSTEPS; s++) {
      v.y -= cfg.swingGravity * hh * 0.5;
      c.x += v.x * hh; c.y += v.y * hh; c.z += v.z * hh;
      projectRope(c, a, this.webLength, v);
      v.y -= cfg.swingGravity * hh * 0.5;
    }
    p.x = c.x; p.y = c.y - cfg.chest; p.z = c.z;
    { // rope tension per unit mass (v^2 / L - g * r_y) relative to twice the swing gravity: 0 slack at the top of the arc .. ~1 at the bottom of a fast swing
      const rl = Math.max(1, this.webLength), ry = (c.y - a.y) / rl, sp2 = v.x * v.x + v.y * v.y + v.z * v.z;
      this.tension = clamp((sp2 / rl - cfg.swingGravity * ry) / (2 * cfg.swingGravity), 0, 1.3);
    }
    const vx0 = v.x, vz0 = v.z;
    const pushed = this._collide();
    this._face(h);
    // ran into a wall at speed (a swing straight at a facade): the web lets go and the body slides down the wall instead of being pinned to it
    if (pushed > 0.02 && Math.hypot(vx0, vz0) - Math.hypot(v.x, v.z) > 6) { this._endSwing(false); return; }
    const floor = this.world.floorAt(p.x, p.z, prevY, 0.3);
    if (v.y <= 0 && p.y <= floor) { const impact = -v.y; p.y = floor; this.anchor = null; this._land(impact); this.webCooldown = 0.12; this.pressBuffer = 0; return; }
    const toX = a.x - c.x, toY = a.y - c.y, toZ = a.z - c.z, dist = Math.hypot(toX, toY, toZ);
    if (dist < 3) this._endSwing(false); // swung right up to the anchor
    // far side of the arc: moving away from the anchor with the rope more than ~74 degrees from vertical: let go and carry the momentum
    else if (toY / dist < 0.28 && (v.x * toX + v.z * toZ) < 0) this._endSwing(true);
  }

  _respawn() {
    const s = this.lastSafe;
    this.pos.set(s.x, s.y + 0.5, s.z);
    this.resetMotion();
  }

  _step(h, w) {
    this.time += h;
    this.jumpBuf = Math.max(0, this.jumpBuf - h);
    this.coyote = Math.max(0, this.coyote - h);
    this.webCooldown = Math.max(0, this.webCooldown - h);
    this.pressBuffer = Math.max(0, this.pressBuffer - h);
    this.tapGrace = Math.max(0, this.tapGrace - h);
    this.noAnchorFlash = Math.max(0, this.noAnchorFlash - h);
    this.crouch = Math.max(0, this.crouch - h * 3.2);
    if (this._jumpEdge) { this.jumpBuf = this.cfg.jumpBuffer; this._jumpEdge = false; }
    if (this.state === 'ground') this._stepGround(h, w);
    else if (this.state === 'air') this._stepAir(h, w);
    else if (this.state === 'wall') this._stepWall(h, w);
    else if (this.state === 'cling') this._stepCling(h, w);
    else this._stepSwing(h, w);
    this.safeTimer += h;
    if (this.airJumpT >= 0) this.airJumpT += h;
    if (this.wallBlock.t > 0) this.wallBlock.t -= h;
    if (this.state === 'ground' && this.safeTimer > 0.5) { this.safeTimer = 0; this.lastSafe.x = this.pos.x; this.lastSafe.y = this.pos.y; this.lastSafe.z = this.pos.z; }
  }

  /** Once per frame, while Spider-Man is the active mode. */
  update(dt) {
    const k = this.ctrl.keys, up = !!k.up && !this.paused;
    if (up && !this._prevUp) this._jumpEdge = true;
    this._prevUp = up;
    if (this.input.consumeWebPress() && !this.paused) { this._webPress = true; this.tapGrace = TAP_GRACE; }
    const w = this._readWish();
    if (this.state === 'air' || this.state === 'ground') this._traverseProbe(dt, w); // the movement itself may catch a wall (a run or a crawl) before this frame's steps
    this.acc = Math.min(this.acc + dt, 0.1);
    let n = 0;
    while (this.acc >= STEP && n < 12) { this._step(STEP, w); this.acc -= STEP; n++; }

    // what the rest of the game reads. The mesh and the camera use the simulation extrapolated by the leftover time, so a render frame
    // that falls between two 120 Hz steps does not jitter.
    const e = this.entity, v = this.vel, rp = this.renderPos, lead = this.acc;
    rp.x = this.pos.x + v.x * lead; rp.y = this.pos.y + v.y * lead; rp.z = this.pos.z + v.z * lead;
    if (this.state === 'ground') rp.y = this.pos.y;
    e.speed = Math.hypot(v.x, v.z);
    e.verticalVel = v.y;
    e.mesh.position.set(rp.x, rp.y, rp.z);
    e.mesh.rotation.y = e.heading;
    if (this.rig) {
      let al = null;
      if (this.anchor) {
        const cy = rp.y + this.cfg.chest;
        let dx = this.anchor.x - rp.x, dy = this.anchor.y - cy, dz = this.anchor.z - rp.z;
        const m = Math.hypot(dx, dy, dz) || 1; dx /= m; dy /= m; dz /= m;
        const ch = Math.cos(e.heading), sh = Math.sin(e.heading); // world -> the body's local frame
        al = this._anchorLocal.set(dx * ch - dz * sh, dy, dx * sh + dz * ch);
      }
      // air timing for the animation: time to impact (from the height above the floor and the vertical speed) and how close the end of the swing is
      let landIn = 9, releaseSoon = 0;
      if (this.state === 'air') {
        const h = Math.max(0, rp.y - this.world.floorAt(rp.x, rp.z, rp.y, 0.3)), g = this.cfg.gravity;
        landIn = (v.y + Math.sqrt(v.y * v.y + 2 * g * h)) / g;
      } else if (this.state === 'swing' && this.anchor) {
        const a = this.anchor, cy = rp.y + this.cfg.chest, tx = a.x - rp.x, ty = a.y - cy, tz = a.z - rp.z, d = Math.hypot(tx, ty, tz) || 1;
        const away = (v.x * tx + v.z * tz) < 0; // moving away from the anchor on the far side of the arc
        releaseSoon = away ? clamp((0.62 - ty / d) / 0.34, 0, 1) : 0; // 0 at 52 degrees from vertical, 1 at the auto-release angle
      }
      const onWall = this.state === 'wall', onCling = this.state === 'cling';
      if (onWall) wallFrame(this.wall, v, this.cfg, this.wallPose);
      else if (onCling) clingFrame(this.surf, this.clingHead, this.wallPose);
      this.rig.update(dt, {
        landIn, releaseSoon,
        speed: onWall ? Math.hypot(e.speed, v.y) : onCling ? this.clingSpeed : e.speed, speed3: Math.hypot(v.x, v.y, v.z), heading: e.heading, px: rp.x, pz: rp.z, grounded: this.state === 'ground' || onWall, vy: v.y, swinging: this.state === 'swing',
        wallRun: onWall, cling: onCling, clingOffset: this.cfg.clingOffset, mantle: this.mantle.active ? this.mantle.u : -1, mantleSplit: this.mantle.u1, wall: onWall || onCling ? this.wallPose : null, airJumpId: this.airJumpId, airJumpT: this.airJumpT,
        anchorLocal: al, crouch: this.crouch, time: this.time, tension: this.tension, steer: this.state === 'swing' ? this._wish.str : 0, webSide: this.webSide
      });
    }
  }
}

export { SpiderController, STEP, PRESS_BUFFER, MIN_HOLD };
