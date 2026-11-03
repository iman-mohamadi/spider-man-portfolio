import { clamp, angleDiff } from './spider-physics.js';

// Dedicated third-person action camera for Spider-Man. It only takes over while Spider-Man is the active mode AND the "3rd-Person Chase"
// preset is selected; every other camera (scenic, action, cockpit) and every other mode keeps using CameraSystem untouched.
//
// Design:
//  * the player owns yaw and pitch (mouse look through SpiderInput). The camera only ever drifts towards the direction of travel while the
//    player is NOT touching the mouse, never past ~100 degrees and never fighting a deliberate turn;
//  * the camera looks exactly along the orbit direction, so the crosshair ray (used for web targeting) is the camera's centre line;
//  * the pivot (a point above the head) follows with smoothing, leads the motion (look-ahead along the velocity) and rises more slowly than
//    it falls, so jumps and swings keep the character in a good place in the frame;
//  * distance and FOV grow smoothly with speed; buildings pull the camera in quickly and let it go slowly;
//  * everything is frame-rate independent (exponential smoothing with dt).

const CFG = {
  distance: 5.2, distanceSpeed: 3.4, distanceFall: 1.2, shoulder: 0.5, pivotHeight: 1.5, frameUp: 0.28,
  pitchMin: -1.0, pitchMax: 1.15, pitchDefault: 0.14,
  baseFov: 60, fovBoost: 10, speedLo: 8, speedHi: 45,
  lookAhead: 0.16, maxLookAhead: 5.5, maxLookAheadSwing: 8,
  followRateSwing: 1.2, followIdle: 0.6, followMinSpeed: 6, followMaxAngle: 0.55,
  minDistance: 1.1, wallPad: 0.55, groundPad: 0.45,
  pivotRate: 14, pivotRateSpeed: 10, // pivot follow rate; it tightens with speed so the character stays near the frame centre at 40 m/s
  frameUpSwing: 0.75, // while swinging the character sits lower in the frame, leaving room above for the next anchor
  // on a wall (running or crawling): a little further back so the wall and where he is going can be seen, lower in the frame like a swing (room above for a climb), and a gentle turn
  // towards the wall (crawling) or the direction of the run, only while the mouse is idle and only when the camera already looks roughly that way (never against the player)
  wallDistance: 1.2, wallFrameUp: 0.6, wallYawRate: 0.7, wallYawMax: 1.25, wallBlend: 3
};

const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const damp = (cur, target, rate, dt) => cur + (target - cur) * (1 - Math.exp(-rate * dt));

class SpiderCamera {
  constructor({ cameraSystem, controllers, entity, controller, world, input, THREE }) {
    this.cs = cameraSystem;
    this.controllers = controllers;
    this.entity = entity;
    this.controller = controller;
    this.world = world;
    this.input = input;
    this.THREE = THREE;
    this.active = false;
    this.yaw = 0;
    this.pitch = CFG.pitchDefault;
    this.dist = CFG.distance;
    this.fov = CFG.baseFov;
    this.pivot = new THREE.Vector3();
    this.ahead = new THREE.Vector3();
    this.vyBias = 0;
    this.frameUp = CFG.frameUp;
    this.wallK = 0; // 0..1: how much of the wall behaviour is on (eased in and out, so a wall jump or a landing gives the camera back smoothly)
    this.pos = new THREE.Vector3();
    this.look = new THREE.Vector3();
    this.view = { px: 0, py: 0, pz: 0, fx: 0, fy: 0, fz: 1 }; // camera position and unit forward (the crosshair ray), for web targeting
    this.snapNext = true;
    this._look = { yaw: 0, pitch: 0 };
    this._sinceLook = 1e9; // seconds since the player last moved the mouse
  }

  /** Yaw the movement keys are relative to: the camera looks along (sin yaw, cos yaw). */
  getViewYaw() { return this.yaw; }

  snap(heading) {
    if (heading !== undefined) this.yaw = heading;
    this.snapNext = true;
  }

  _enter() {
    this.active = true;
    this.input?.rearm?.();
    this.cs.dragEnabled = false; // Spider-Man looks with the locked mouse; the generic drag-to-orbit must not run beside it
    this.cs._clearPointers?.(); this.cs.isDragging = false;
    this.yaw = this.entity.heading;
    this.pitch = CFG.pitchDefault;
    this.snapNext = true;
  }

  _exit() {
    this.active = false;
    this.cs.dragEnabled = true; // hand the mouse back to the other characters' drag-to-orbit, from a clean state
    this.cs._clearPointers?.(); this.cs.isDragging = false; this.cs.userOrbitTimer = 0;
    const p = this.cs.getActivePreset(), cam = this.cs.camera;
    cam.fov = p.fov;
    cam.updateProjectionMatrix();
    this.input?.releaseLock?.();
  }

  /** Call right after CameraSystem.update(). */
  update(dt) {
    const cs = this.cs, e = this.entity, cam = cs.camera;
    const want = this.controllers.activeMode === 'spider' && cs.activePresetId === 'chase';
    if (want && !this.active) this._enter();
    else if (!want && this.active) this._exit();
    if (!this.active) return;
    dt = clamp(dt, 1e-4, 0.1);

    // ----- player look. CameraSystem's own drag / gamepad offsets are discarded (they would move other cameras), only its zoom is used.
    cs.orbitYawOffset = 0; cs.orbitPitchOffset = 0.09;
    const look = this.input ? this.input.consumeLook(this._look) : this._look;
    this._sinceLook = look.yaw || look.pitch ? 0 : this._sinceLook + dt;
    this.yaw += look.yaw;
    this.pitch = clamp(this.pitch + look.pitch, CFG.pitchMin, CFG.pitchMax);
    const zoom = cs.zoomMultiplier;

    const c = this.controller, v = c.vel, speed3 = Math.hypot(v.x, v.y, v.z), hs = Math.hypot(v.x, v.z);
    const swinging = c.swinging, speedK = smoothstep(CFG.speedLo, CFG.speedHi, speed3);
    const onWall = c.state === 'wall', onCling = c.state === 'cling', onSurface = onWall || onCling;
    this.wallK = this.snapNext ? (onSurface ? 1 : 0) : damp(this.wallK, onSurface ? 1 : 0, CFG.wallBlend, dt);

    // ----- follow: the camera never turns by itself on the ground or in the air (that is how a camera ends up fighting the aim). The only
    // automatic yaw is while swinging, and only a gentle nudge towards the travel direction when it is already within ~30 degrees of where the
    // player is looking and the mouse has been still for a moment: a swing you aimed at stays centred, a swing you are looking away from is left alone.
    const idle = this._sinceLook > CFG.followIdle && !cs.isDragging;
    if (swinging && idle && hs > CFG.followMinSpeed) {
      const diff = angleDiff(this.yaw, Math.atan2(v.x, v.z));
      if (Math.abs(diff) < CFG.followMaxAngle) this.yaw += diff * (1 - Math.exp(-CFG.followRateSwing * clamp((hs - CFG.followMinSpeed) / 10, 0, 1) * dt));
    }

    // ----- on a wall: turn gently to see it. Crawling: towards the wall (it ends up in front of the camera, the crawl keys match the screen); running: along the run. Never while the mouse is
    // moving, never more than wallYawMax from where the player is looking, and eased by wallK (rate wallYawRate per second)
    if (this.wallK > 0.05 && idle) {
      let target = null;
      if (onWall && hs > CFG.followMinSpeed) target = Math.atan2(v.x, v.z);
      else if (onCling && Math.abs(c.surf.ny) < 0.7) target = Math.atan2(-c.surf.nx, -c.surf.nz);
      else if (onWall) target = Math.atan2(-c.wall.nx, -c.wall.nz);
      if (target !== null) { const diff = angleDiff(this.yaw, target); if (Math.abs(diff) < CFG.wallYawMax) this.yaw += diff * (1 - Math.exp(-CFG.wallYawRate * this.wallK * dt)); }
    }

    // ----- pivot: above the head, smoothed, leading the motion
    const rp = c.renderPos;
    const tx = rp.x, ty = rp.y + CFG.pivotHeight, tz = rp.z;
    const pv = this.pivot;
    const laMax = swinging ? CFG.maxLookAheadSwing : CFG.maxLookAhead;
    let lx = v.x * CFG.lookAhead, lz = v.z * CFG.lookAhead;
    const lm = Math.hypot(lx, lz);
    if (lm > laMax) { lx *= laMax / lm; lz *= laMax / lm; }
    const vyT = clamp(v.y * 0.09, -3.2, 1.6); // look a little below when falling fast, a little above when launching
    if (this.snapNext) { pv.set(tx, ty, tz); this.ahead.set(0, 0, 0); this.vyBias = 0; }
    else {
      this.ahead.x = damp(this.ahead.x, lx, 4, dt); this.ahead.z = damp(this.ahead.z, lz, 4, dt);
      this.vyBias = damp(this.vyBias, vyT, 2.6, dt);
      const pr = CFG.pivotRate + CFG.pivotRateSpeed * speedK;
      pv.x = damp(pv.x, tx, pr, dt); pv.z = damp(pv.z, tz, pr, dt);
      pv.y = damp(pv.y, ty, ty > pv.y ? 5.5 : 9, dt); // rises slower than it falls: a jump leaves the frame centre, a fall is followed closely
    }
    this.frameUp = this.snapNext ? CFG.frameUp : damp(this.frameUp, swinging ? CFG.frameUpSwing : this.wallK > 0.5 ? CFG.wallFrameUp : CFG.frameUp, 2.5, dt);
    const ax = pv.x + this.ahead.x * 0.6, ay = pv.y + this.frameUp + this.vyBias, az = pv.z + this.ahead.z * 0.6;

    // ----- view direction and desired camera position
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    const fx = Math.sin(this.yaw) * cp, fy = -sp, fz = Math.cos(this.yaw) * cp;
    const rx = -Math.cos(this.yaw), rz = Math.sin(this.yaw); // camera right (horizontal)
    const fall = smoothstep(6, 30, -v.y);
    const wantDist = (CFG.distance + CFG.distanceSpeed * speedK + CFG.distanceFall * fall + (swinging ? 0.5 : 0) + CFG.wallDistance * this.wallK) * zoom;
    this.dist = this.snapNext ? wantDist : damp(this.dist, wantDist, 2.4, dt);
    const sh = CFG.shoulder * clamp(this.dist / CFG.distance, 0.4, 1.4) * (this.dist < 2 ? this.dist / 2 : 1);
    let d = this.dist;

    // ----- collision: the pull-in is immediate, the release slow (so the camera does not pump along a wall)
    const ox = -fx * d + rx * sh, oy = -fy * d, oz = -fz * d + rz * sh, ol = Math.hypot(ox, oy, oz) || 1;
    const hit = this.world.rayFirstHit(ax, ay, az, ox / ol, oy / ol, oz / ol, ol + CFG.wallPad);
    const allowed = hit ? clamp(hit.t - CFG.wallPad, CFG.minDistance, ol) : ol;
    this._allowed = this.snapNext || allowed < (this._allowed ?? allowed) ? allowed : damp(this._allowed, allowed, 2.8, dt);
    const k = Math.min(1, this._allowed / ol);
    let cx = ax + ox * k, cy = ay + oy * k, cz = az + oz * k;
    // keep above whatever is underneath (street, sidewalk, park, roof)
    const floor = this.world.floorAt(cx, cz, ay - 1.2, 1.6);
    if (cy < floor + CFG.groundPad) cy = floor + CFG.groundPad;
    this.pos.set(cx, cy, cz);

    // ----- FOV: wider with speed, bounded to avoid distortion
    const fovT = CFG.baseFov + CFG.fovBoost * speedK;
    this.fov = this.snapNext ? fovT : damp(this.fov, fovT, 3, dt);
    cam.position.copy(this.pos);
    this.look.set(cx + fx * 20, cy + fy * 20, cz + fz * 20);
    cam.lookAt(this.look);
    if (Math.abs(cam.fov - this.fov) > 0.02) { cam.fov = this.fov; cam.updateProjectionMatrix(); }
    cam.updateMatrixWorld(true);
    const vw = this.view; vw.px = cx; vw.py = cy; vw.pz = cz; vw.fx = fx; vw.fy = fy; vw.fz = fz;
    vw.vHalf = this.fov * Math.PI / 360; vw.hHalf = Math.atan(Math.tan(vw.vHalf) * (cam.aspect || 1.6)); // half field of view, for targeting
    // keep everything that follows the camera (streaming, culling, audio, traffic) consistent with the real view
    cs.currentPos.copy(cam.position);
    cs.currentLookAt.copy(this.look);
    cs.initialized = true;
    this.snapNext = false;
  }
}

export { SpiderCamera, CFG as SPIDER_CAMERA };
