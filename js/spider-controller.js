import {
  SPIDER, clamp, turnToward, groundVelocity, airVelocity, projectRope, swingForces, releaseVelocity
} from './spider-physics.js';

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
    this.stats = { swings: 0, lastSwingSpeed: 0, launches: 0 };
  }

  get swinging() { return this.state === 'swing'; }
  get grounded() { return this.state === 'ground'; }

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
    if (floor < p.y - cfg.stepDown) { this.state = 'air'; this.coyote = cfg.coyote; }
    else p.y = floor;
    if (this.jumpBuf > 0 && this.state === 'ground') {
      this.vel.y = cfg.jumpSpeed; this.state = 'air'; this.jumpBuf = 0; this.coyote = 0; p.y += 0.02;
    }
    this._webInput();
  }

  _stepAir(h, w) {
    const cfg = this.cfg, p = this.pos;
    airVelocity(this.vel, w.x, w.z, h, cfg);
    if (this.jumpBuf > 0 && this.coyote > 0) { this.vel.y = cfg.jumpSpeed; this.jumpBuf = 0; this.coyote = 0; }
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
    if (this.webLength > this.webTarget) this.webLength = Math.max(this.webTarget, this.webLength - cfg.reelSpeed * h); // reel in: a smooth pull, not a snap
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
    this._collide();
    this._face(h);
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
    else this._stepSwing(h, w);
    this.safeTimer += h;
    if (this.state === 'ground' && this.safeTimer > 0.5) { this.safeTimer = 0; this.lastSafe.x = this.pos.x; this.lastSafe.y = this.pos.y; this.lastSafe.z = this.pos.z; }
  }

  /** Once per frame, while Spider-Man is the active mode. */
  update(dt) {
    const k = this.ctrl.keys, up = !!k.up && !this.paused;
    if (up && !this._prevUp) this._jumpEdge = true;
    this._prevUp = up;
    if (this.input.consumeWebPress() && !this.paused) { this._webPress = true; this.tapGrace = TAP_GRACE; }
    const w = this._readWish();
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
      this.rig.update(dt, {
        speed: e.speed, speed3: Math.hypot(v.x, v.y, v.z), heading: e.heading, grounded: this.state === 'ground', vy: v.y, swinging: this.state === 'swing',
        anchorLocal: al, crouch: this.crouch, time: this.time, tension: this.tension, steer: this.state === 'swing' ? this._wish.str : 0, webSide: this.webSide
      });
    }
  }
}

export { SpiderController, STEP, PRESS_BUFFER, MIN_HOLD };
