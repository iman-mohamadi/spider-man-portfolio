// Dev-only animation probe. NOT loaded by the game. In the browser (page opened with ?spiderDebug):
//   const probe = await import('/tools/anim-probe.js'); probe.install();   // then probe.slip(8.5), probe.report([2, 4, 8.5, 15]) ...
// It drives the rig directly (constant-velocity ground motion, scripted airborne states) and measures it numerically, so animation
// claims can be backed by numbers (foot slip, reach shortfall, bone angular speed) rather than by screenshots alone.

const frac = (x) => x - Math.floor(x);

export function install() {
  const s = window.__spider;
  if (!s) throw new Error('open the page with ?spiderDebug first');
  const c = s.controller, rig = s.rig, R = rig.rig, mesh = s.entity.mesh;
  window.__spiderOrig = window.__spiderOrig || { upd: s.update, cam: s.updateCamera }; // keep the real functions across repeated installs
  const origUpd = window.__spiderOrig.upd, origCam = window.__spiderOrig.cam;
  const hold = () => { c.rig = null; c.paused = true; s.update = () => {}; s.updateCamera = () => {}; };
  const base = { speed3: 0, heading: 0, grounded: true, vy: 0, swinging: false, anchorLocal: null, crouch: 0, tension: 0, steer: 0, webSide: 1 };
  const V = (b) => b.getWorldPosition(new (s.model.root.position.constructor)());

  /** Constant-speed run: world-space slip of each ankle while its foot is in stance, and how often the leg ran out of reach. */
  function slip(speed, frames = 240, headingDeg = 0) {
    hold();
    const dt = 1 / 60, h = headingDeg * Math.PI / 180, dx = Math.sin(h), dz = Math.cos(h);
    let x = -11.6, z = 300, time = 0;
    const prev = [null, null], prevSt = [false, false], st = [{ n: 0, sum: 0, max: 0, short: 0, shortMax: 0 }, { n: 0, sum: 0, max: 0, short: 0, shortMax: 0 }];
    mesh.rotation.y = h;
    for (let i = 0; i < 90 + frames; i++) {
      x += dx * speed * dt; z += dz * speed * dt; time += dt; mesh.position.set(x, 0, z);
      rig.update(dt, { ...base, speed, speed3: speed, heading: h, time, px: x, pz: z });
      mesh.updateMatrixWorld(true);
      const ph = rig.state.phase, duty = rig.gait.duty, wg = rig.state.wGait;
      const stance = [frac(ph) < duty && wg > 0.9, frac(ph + 0.5) < duty && wg > 0.9]; // the pose of this frame was built from the already-advanced phase
      [R.L.ankle, R.R.ankle].forEach((b, k) => {
        const p = V(b);
        if (i >= 90 && prev[k] && stance[k] && prevSt[k]) {
          const d = Math.hypot(p.x - prev[k].x, p.z - prev[k].z);
          st[k].n++; st[k].sum += d; st[k].max = Math.max(st[k].max, d);
          st[k].short += rig.state.short[k]; st[k].shortMax = Math.max(st[k].shortMax, rig.state.short[k]);
        }
        prev[k] = p; prevSt[k] = stance[k];
      });
    }
    const body = speed * dt, mean = (k) => st[k].sum / Math.max(1, st[k].n);
    const pct = 100 * (mean(0) + mean(1)) / 2 / body;
    return { speed, stanceFrames: st[0].n + st[1].n, slipPct: +pct.toFixed(2), slipMs: +(((mean(0) + mean(1)) / 2) * 60).toFixed(3), worstFrameMm: +(Math.max(st[0].max, st[1].max) * 1000).toFixed(1), reachShortMm: +(Math.max(st[0].shortMax, st[1].shortMax) * 1000).toFixed(1) };
  }

  const report = (speeds, headingDeg = 0) => speeds.map((v) => { const r = slip(v, 240, headingDeg); return `${String(r.speed).padStart(4)} m/s  stance slip ${String(r.slipPct).padStart(5)}% (${r.slipMs} m/s)  worst frame ${r.worstFrameMm} mm  max reach shortfall ${r.reachShortMm} mm  [${r.stanceFrames} stance frames]`; });


  /**
   * The same measurement through the REAL controller (keys, acceleration, turning). `script(frame, keys, input)` sets the keys each frame.
   * Slip is the world-space movement of an ankle during stance as a percentage of the body's own movement that frame.
   */
  function live(label, frames, script, { warm = 60 } = {}) {
    if (c.ctrl.activeMode !== 'spider') s.activate();
    c.rig = rig; c.paused = false; s.update = origUpd; s.updateCamera = origCam;
    s.update = () => {}; s.updateCamera = () => {}; // we step by hand so the (slow, hidden) page loop cannot interleave
    const keys = c.ctrl.keys; let t = 4000;
    const dt = 1 / 60, prev = [null, null], prevSt = [false, false]; let prevBody = null; const acc = { sum: 0, n: 0, body: 0, worst: 0, short: 0 };
    c.resetMotion(); c.pos.set(-11.6, 0, 318); keys.forward = keys.backward = keys.left = keys.right = false; s.input.shift = false;
    for (let i = 0; i < warm + frames; i++) {
      script(i - warm, keys, s.input);
      origUpd(dt, t); origCam(dt); t += dt;
      mesh.updateMatrixWorld(true);
      const ph = rig.state.phase, duty = rig.gait.duty, wg = rig.state.wGait;
      const stance = [frac(ph) < duty && wg > 0.9 && c.state === 'ground', frac(ph + 0.5) < duty && wg > 0.9 && c.state === 'ground'];
      const body = { x: mesh.position.x, z: mesh.position.z };
      [R.L.ankle, R.R.ankle].forEach((b, k) => {
        const p = V(b);
        if (i >= warm && prev[k] && prevBody && stance[k] && prevSt[k]) {
          const bd = Math.hypot(body.x - prevBody.x, body.z - prevBody.z);
          if (bd > 0.02) { const d = Math.hypot(p.x - prev[k].x, p.z - prev[k].z); acc.sum += d; acc.body += bd; acc.n++; acc.worst = Math.max(acc.worst, d / bd); acc.short = Math.max(acc.short, rig.state.short[k]); }
        }
        prev[k] = p; prevSt[k] = stance[k];
      });
      prevBody = body;
    }
    keys.forward = keys.backward = keys.left = keys.right = false; s.input.shift = false;
    return `${label}: ${acc.n} stance samples, slip ${(100 * acc.sum / Math.max(1e-9, acc.body)).toFixed(2)}% of body motion, worst frame ${(100 * acc.worst).toFixed(0)}%, max reach shortfall ${(acc.short * 1000).toFixed(1)} mm, end speed ${c.entity.speed.toFixed(1)} m/s`;
  }



  // ------------------------------------------------------------------ scripted gameplay sequences with numbers
  const BONES = () => ({ hips: R.hips, spine: R.spine[R.spine.length - 1], head: R.head, thighL: R.L.thigh, kneeL: R.L.knee, ankleL: R.L.ankle, upperL: R.L.upper, foreL: R.L.fore, thighR: R.R.thigh, kneeR: R.R.knee, upperR: R.R.upper });

  /**
   * Runs `script(frame, ctx)` through the real controller at 60 fps and records, per labelled phase, the controller state, the air-pose weights and the
   * peak bone angular speed. A pop shows up as a peak far above the neighbouring phases.
   */
  function sequence(setup, script, frames, phaseOf) {
    if (c.ctrl.activeMode !== 'spider') s.activate(); // the page may still be loading: make Spider-Man the active mode
    c.rig = rig; c.paused = false; s.update = () => {}; s.updateCamera = () => {};
    const keys = c.ctrl.keys; keys.forward = keys.backward = keys.left = keys.right = keys.up = false; s.input.shift = false; s.input.webHeld = false;
    setup && setup();
    const b = BONES(), names = Object.keys(b), prev = names.map((n) => b[n].quaternion.clone()), dt = 1 / 60;
    const phases = new Map(), timeline = []; let t = 7000, worst = { w: 0 };
    for (let i = 0; i < frames; i++) {
      script(i, keys);
      origUpd(dt, t); origCam(dt); t += dt;
      const label = phaseOf ? phaseOf(i) : 'all';
      let ph = phases.get(label); if (!ph) { ph = { label, frames: 0, peak: 0, peakBone: '', states: new Set(), minY: 1e9, maxY: -1e9, maxSpeed: 0, air: {} }; phases.set(label, ph); }
      ph.frames++; ph.states.add(c.state); ph.minY = Math.min(ph.minY, c.pos.y); ph.maxY = Math.max(ph.maxY, c.pos.y); ph.maxSpeed = Math.max(ph.maxSpeed, Math.hypot(c.vel.x, c.vel.y, c.vel.z));
      names.forEach((n, k) => { const q = b[n].quaternion, p0 = prev[k]; const d = Math.min(1, Math.abs(q.x * p0.x + q.y * p0.y + q.z * p0.z + q.w * p0.w)); const w = 2 * Math.acos(d) * 60; if (i > 3 && w > ph.peak) { ph.peak = w; ph.peakBone = n; } if (i > 3 && w > worst.w) worst = { w, bone: n, frame: i, state: c.state }; p0.copy(q); });
      if (c.state === 'air') for (const k of Object.keys(rig.airWeights)) ph.air[k] = Math.max(ph.air[k] || 0, +rig.airWeights[k].toFixed(2));
      if (i % 6 === 0) timeline.push(`${(i / 60).toFixed(2)}s ${c.state}${c.state === 'swing' ? '(' + (c.webSide > 0 ? 'L' : 'R') + ')' : ''} y=${c.pos.y.toFixed(1)} v=(${c.vel.x.toFixed(1)},${c.vel.y.toFixed(1)},${c.vel.z.toFixed(1)}) ${c.state === 'air' ? 'air:' + Object.entries(rig.airWeights).filter(([, w]) => w > 0.2).map(([k, w]) => k + w.toFixed(1)).join('+') : ''}`);
    }
    keys.forward = keys.backward = keys.left = keys.right = keys.up = false; s.input.shift = false; s.input.webHeld = false;
    return { phases: [...phases.values()].map((p) => `${p.label.padEnd(16)} ${String(p.frames).padStart(3)}f states=${[...p.states].join('/')} y ${p.minY.toFixed(1)}..${p.maxY.toFixed(1)} speed<=${p.maxSpeed.toFixed(1)} peak bone ${p.peak.toFixed(0)} rad/s (${p.peakBone})${Object.keys(p.air).length ? ' air weights max ' + JSON.stringify(p.air) : ''}`), worst: `${worst.w.toFixed(0)} rad/s ${worst.bone} at frame ${worst.frame} (${worst.state})`, timeline };
  }

  const startGround = (x = -11.6, z = 318) => () => { c.resetMotion(); c.pos.set(x, 0.22, z); c.state = 'ground'; c.vel.x = c.vel.y = c.vel.z = 0; };

  /** Jump from a standstill, and a running jump: takeoff, rise, apex, fall, landing preparation, landing, recovery. */
  function jumps() {
    const stand = sequence(startGround(), (f, k) => { k.up = f >= 30 && f < 33; }, 150, (f) => (f < 30 ? 'idle' : f < 36 ? 'takeoff' : f < 150 ? 'air+landing' : ''));
    const run = sequence(startGround(), (f, k) => { k.forward = true; k.up = f >= 120 && f < 123; }, 260, (f) => (f < 120 ? 'run up' : f < 130 ? 'takeoff' : 'air+landing+run'));
    return { stand, run };
  }

  /** Walk off a roof edge (45 m up) and land on the street. */
  function rooftopFall() {
    const world = s.world, ctrl = c.ctrl;
    // find a tall building and stand on the roof near one of its walls, walking off it
    const near = ctrl.nearColliders(-11.6, 330, 120).filter((b) => b.maxY > 40 && b.polygon).sort((a, b) => b.maxY - a.maxY);
    if (!near.length) return { error: 'no tall building nearby' };
    const b = near[0], cx = (b.minX + b.maxX) / 2, cz = (b.minZ + b.maxZ) / 2;
    const edgeX = b.minX + 2; // 2 m inside the west wall, walk west
    let ok = world.insideCollider(b, edgeX, cz);
    const sx = ok ? edgeX : cx;
    const res = sequence(() => { c.resetMotion(); c.pos.set(sx, b.maxY, cz); c.state = 'ground'; c.vel.x = c.vel.y = c.vel.z = 0; c.entity.heading = -Math.PI / 2; s.camera.snap(-Math.PI / 2); }, (f, k) => { k.forward = f < 120; }, 330, (f) => (f < 20 ? 'roof idle' : 'walk off + fall + land'));
    res.roof = { height: +b.maxY.toFixed(0), start: [sx, cz] };
    return res;
  }

  /** Attach in a given look direction, swing for `holdFrames`, release (optionally pressing A/D), then fall. */
  function swingRelease(lookYaw, holdFrames, steer = 0) {
    return sequence(() => { c.resetMotion(); c.pos.set(-11.6, 0.22, 318); c.state = 'ground'; s.camera.yaw = lookYaw; s.camera.pitch = 0.14; s.input.lockFailed = true; },
      (f, k) => {
        if (f === 20) s.camera.cs.domElement.dispatchEvent(new PointerEvent('pointerdown', { button: 0, pointerId: 1, bubbles: true }));
        if (f === 20 + holdFrames) window.dispatchEvent(new PointerEvent('pointerup', { button: 0, pointerId: 1, bubbles: true }));
        k.right = steer > 0 && f > 40 && f < 20 + holdFrames; k.left = steer < 0 && f > 40 && f < 20 + holdFrames;
        s.camera.yaw = lookYaw; // keep looking where we aimed (no mouse in this script)
      }, 20 + holdFrames + 150, (f) => (f < 20 ? 'idle' : f < 20 + holdFrames ? 'attach+swing' : f < 20 + holdFrames + 40 ? 'release+0.7s' : 'freefall+land'));
  }


  /**
   * Foot slip for ANY animation (clips or procedural): a foot counts as planted when its ankle is within 6 cm of the lowest height it reaches;
   * slip = its world-space movement over body movement while planted in two consecutive frames. Also counts how many frames of the cycle are planted.
   */
  function slipGeneric(label, speedKeys, frames = 300, warm = 90) {
    if (c.ctrl.activeMode !== 'spider') s.activate();
    c.rig = rig; c.paused = false; s.update = () => {}; s.updateCamera = () => {};
    const keys = c.ctrl.keys; let t = 8000; const dt = 1 / 60;
    c.resetMotion(); c.pos.set(-11.6, 0.22, 318); c.state = 'ground'; keys.forward = keys.backward = keys.left = keys.right = false; s.input.shift = false;
    // the ball of the foot (ToeBase when the skeleton has one: ankle and ball move relative to each other during heel-to-toe roll, which is not slip), else the ankle
    const toe = (re) => { let f = null; mesh.traverse((o) => { if (!f && o.isBone && re.test(o.name)) f = o; }); return f; };
    const ank = [toe(/^mixamorig:?LeftToeBase$/) || R.L.ankle, toe(/^mixamorig:?RightToeBase$/) || R.R.ankle], H = [[], []], P = [[], []], B = [];
    for (let i = 0; i < warm + frames; i++) {
      speedKeys(i - warm, keys, s.input);
      origUpd(dt, t); origCam(dt); t += dt; mesh.updateMatrixWorld(true);
      if (i >= warm) { B.push([mesh.position.x, mesh.position.z]); ank.forEach((b, k) => { const p = V(b); H[k].push(p.y); P[k].push([p.x, p.z]); }); }
    }
    keys.forward = false; s.input.shift = false;
    // planted runs: contiguous frames with the ankle within 4 cm of its lowest height, at least 6 frames long; slip = the foot's NET world movement over the
    // run divided by the body's net movement over the same run (a foot that stays still while the body travels = 0%)
    let sum = 0, body = 0, runs = 0, worst = 0, planted = 0;
    for (let k = 0; k < 2; k++) {
      const minY = Math.min(...H[k]); let start = -1;
      for (let i = 0; i <= H[k].length; i++) {
        const low = i < H[k].length && H[k][i] < minY + 0.04;
        if (low && start < 0) start = i;
        if (!low && start >= 0) {
          const end = i - 1;
          if (end - start >= 5) {
            const d = Math.hypot(P[k][end][0] - P[k][start][0], P[k][end][1] - P[k][start][1]), bd = Math.hypot(B[end][0] - B[start][0], B[end][1] - B[start][1]);
            if (bd > 0.05) { sum += d; body += bd; runs++; worst = Math.max(worst, d / bd); planted += end - start + 1; }
          }
          start = -1;
        }
      }
    }
    return `${label}: speed ${c.entity.speed.toFixed(1)} m/s, planted runs ${runs} (${planted} frames), slip ${(100 * sum / Math.max(1e-9, body)).toFixed(1)}% of body motion (worst run ${(100 * worst).toFixed(0)}%)`;
  }


  // ------------------------------------------------------------------ contact sheets: a clip's frames side by side in the real scene and lighting
  const sheetClones = [];
  /**
   * Bakes a Mixamo FBX for the Raimi skeleton and shows `n` frames of it (from fraction a to b of its length) as clones standing in a row in front of the
   * camera, in profile (facing the right edge of the screen). The chase camera frames them; call clearSheet() afterwards.
   * `raw: true` shows the clip exactly as baked, root height included (the swing clips hang high above the ground in their own coordinates).
   */
  async function sheet(file, { n = 6, a = 0, b = 1, spacing = 1.7, zAhead = 7, yawDeg = 90, dir = '/content/spider-raimi/anims-src/', lowerRaw = 0 } = {}) {
    const { clone } = await import('three/addons/utils/SkeletonUtils.js');
    const { bakeFbxClip } = await import('/js/spider-clips.js');
    const T3 = await import('three/webgpu');
    clearSheet();
    s.update = () => {}; s.updateCamera = () => {};
    const { clip } = await bakeFbxClip(dir + encodeURI(file), s.model.root, { name: file });
    const scene = s.entity.mesh.parent, base = s.entity.position, dur = clip.duration;
    for (let i = 0; i < n; i++) {
      const t = (a + (b - a) * (n === 1 ? 0 : i / (n - 1))) * dur;
      const c = clone(s.model.root);
      c.position.set(base.x - ((n - 1) / 2) * spacing + i * spacing, base.y - lowerRaw, base.z + zAhead);
      c.rotation.y = yawDeg * Math.PI / 180;
      scene.add(c);
      const m = new T3.AnimationMixer(c);
      const act = m.clipAction(clip); act.play(); act.time = t; m.update(0);
      c.updateMatrixWorld(true); c.visible = true;
      c.traverse((o) => { if (o.isMesh) { o.frustumCulled = false; o.castShadow = false; } });
      sheetClones.push(c);
    }
    return `${file}: ${dur.toFixed(2)} s, ${n} frames from ${(a * 100).toFixed(0)}% to ${(b * 100).toFixed(0)}%`;
  }
  /** Like sheet(), but with a clip exactly as the game plays it (content/spider-raimi/anims/<name>.json) at the given times in seconds. */
  async function sheetClip(name, times, { spacing = 1.5, zAhead = 6, yawDeg = 90, lift = 0 } = {}) {
    const { clone } = await import('three/addons/utils/SkeletonUtils.js');
    const T3 = await import('three/webgpu');
    clearSheet(); s.update = () => {}; s.updateCamera = () => {};
    const j = await (await fetch(`/content/spider-raimi/anims/${name}.json`)).json(), clip = T3.AnimationClip.parse(j.clip);
    const scene = s.entity.mesh.parent, base = s.entity.position;
    times.forEach((t, i) => {
      const c = clone(s.model.root); c.position.set(base.x - ((times.length - 1) / 2) * spacing + i * spacing, base.y - lift, base.z + zAhead); c.rotation.y = yawDeg * Math.PI / 180; scene.add(c);
      const m = new T3.AnimationMixer(c), act = m.clipAction(clip); act.play(); act.time = t; m.update(0); c.updateMatrixWorld(true); c.visible = true;
      c.traverse((o) => { if (o.isMesh) { o.frustumCulled = false; o.castShadow = false; } }); sheetClones.push(c);
    });
    return `${name}: ${clip.duration.toFixed(2)} s, frames at ${times.join(', ')}`;
  }
  function clearSheet() { for (const c of sheetClones) c.parent && c.parent.remove(c); sheetClones.length = 0; }

  /** The standard ground battery: straight runs, sprint, starts, weaving (turns), stops. */
  function groundBattery() {
    const out = [];
    out.push(live('steady run 8.5', 240, (f, k) => { k.forward = true; }, { warm: 90 }));
    out.push(live('sprint 15', 240, (f, k, i) => { k.forward = true; i.shift = true; }, { warm: 90 }));
    out.push(live('start from rest', 60, (f, k) => { k.forward = true; }, { warm: 20 }));
    out.push(live('run + weave A/D (turning)', 360, (f, k) => { k.forward = true; const ph = Math.floor(f / 40) % 2; k.left = ph === 0 && f > 0; k.right = ph === 1; }, { warm: 90 }));
    out.push(live('sprint + hard weave', 360, (f, k, i) => { k.forward = true; i.shift = true; const ph = Math.floor(f / 25) % 2; k.left = ph === 0 && f > 0; k.right = ph === 1; }, { warm: 90 }));
    out.push(live('run, stop, run', 360, (f, k) => { k.forward = (Math.floor(f / 60) % 2) === 0; }, { warm: 90 }));
    return out;
  }

  /**
   * Foot slip of ANY animation at the ball of the foot, through the real controller: a planted run is a stretch of >= minRun frames in which the ToeBase stays within
   * `tol` metres of the lowest height it reaches; slip = the foot's net world movement over the body's net movement in that stretch (a foot standing still while the
   * body travels = 0%). Also the peak angular speed of the leg bones after the warm-up (a pop shows as a spike far above the ~15-40 rad/s of a running leg).
   */
  function slipToe(label, script, frames = 300, warm = 120, minRun = 3, tol = 0.04) {
    if (c.ctrl.activeMode !== 'spider') s.activate();
    c.rig = rig; c.paused = false; s.update = () => {}; s.updateCamera = () => {};
    const keys = c.ctrl.keys; let t = 9000; const dt = 1 / 60;
    c.resetMotion(); c.pos.set(-11.6, 0.22, 318); c.state = 'ground'; keys.forward = keys.backward = keys.left = keys.right = false; s.input.shift = false; if (rig.clipState) rig.clipState.peakV = 0;
    const find = (re) => { let f = null; mesh.traverse((o) => { if (!f && o.isBone && re.test(o.name)) f = o; }); return f; };
    const toes = [find(/^mixamorig:?LeftToeBase$/) || R.L.ankle, find(/^mixamorig:?RightToeBase$/) || R.R.ankle], H = [[], []], P = [[], []], B = [], SP = [];
    const legs = [R.L.thigh, R.L.knee, R.R.thigh, R.R.knee, R.hips], prev = legs.map((b) => b.quaternion.clone()); let peak = 0;
    for (let i = 0; i < warm + frames; i++) {
      script(i - warm, keys, s.input); origUpd(dt, t); origCam(dt); t += dt; mesh.updateMatrixWorld(true);
      legs.forEach((b, k) => { if (i >= warm) { const q = b.quaternion, p0 = prev[k]; peak = Math.max(peak, 2 * Math.acos(Math.min(1, Math.abs(q.x * p0.x + q.y * p0.y + q.z * p0.z + q.w * p0.w))) * 60); } prev[k].copy(b.quaternion); });
      if (i >= warm) { B.push([mesh.position.x, mesh.position.z]); SP.push(c.entity.speed); toes.forEach((b, k) => { const p = V(b); H[k].push(p.y); P[k].push([p.x, p.z]); }); }
    }
    keys.forward = keys.backward = keys.left = keys.right = false; s.input.shift = false;
    let sum = 0, body = 0, runs = 0, worst = 0, planted = 0;
    for (let k = 0; k < 2; k++) {
      const minY = Math.min(...H[k]); let st = -1;
      for (let i = 0; i <= H[k].length; i++) {
        const low = i < H[k].length && H[k][i] < minY + tol;
        if (low && st < 0) st = i;
        if (!low && st >= 0) { const e = i - 1; if (e - st >= minRun - 1) { const d = Math.hypot(P[k][e][0] - P[k][st][0], P[k][e][1] - P[k][st][1]), bd = Math.hypot(B[e][0] - B[st][0], B[e][1] - B[st][1]); if (bd > 0.03) { sum += d; body += bd; runs++; worst = Math.max(worst, d / bd); planted += e - st + 1; } } st = -1; }
      }
    }
    const v = SP.reduce((a, b) => a + b, 0) / SP.length;
    return `${label}: mean ${v.toFixed(1)} m/s, planted runs ${runs} (${planted} frames), slip ${(100 * sum / Math.max(1e-9, body)).toFixed(1)}% (worst run ${(100 * worst).toFixed(0)}%), leg peak ${peak.toFixed(0)} rad/s`;
  }
  /** The ground battery with slipToe: steady run/sprint, start, weaving, stop-and-go. */
  function groundSlip(warm = 120) {
    const w = (f, k, i, fast) => { const ph = Math.floor(f / (fast ? 25 : 40)) % 2; k.left = ph === 0 && f > 0; k.right = ph === 1; };
    const out = [
      slipToe('run steady', (f, k) => { k.forward = true; }, 300, warm), slipToe('sprint steady', (f, k, i) => { k.forward = true; i.shift = true; }, 300, warm),
      slipToe('start from rest (1 s)', (f, k) => { k.forward = true; }, 60, 0), slipToe('run weave A/D', (f, k, i) => { k.forward = true; w(f, k, i, false); }, 360, warm),
      slipToe('sprint hard weave', (f, k, i) => { k.forward = true; i.shift = true; w(f, k, i, true); }, 360, warm)
    ];
    c.ctrl.keys.left = c.ctrl.keys.right = false; return out;
  }

  // ------------------------------------------------------------------ clip-layer traces (rigs made by createClipRig)
  const wFmt = () => (rig.animator ? Object.entries(rig.animator.w).filter(([, v]) => v > 0.05).map(([k, v]) => k + v.toFixed(2)).join(' ') : '');
  /**
   * A swing (attach at frame 20, release after `hold` frames) with, per frame: peak bone angular speed around the release (`around` frames either side),
   * and while swinging the angle between the web arm (shoulder -> hand) and the direction from the shoulder to the anchor: the web arm must keep its target.
   */
  function swingTrace(lookYaw, hold, steer = 0, tail = 150, { around = 12, every = 10 } = {}) {
    const bones = { upperL: R.L.upper, upperR: R.R.upper, foreL: R.L.fore, thighL: R.L.thigh, spine: R.spine[R.spine.length - 1], hips: R.hips, head: R.head };
    const prev = {}; for (const k in bones) prev[k] = bones[k].quaternion.clone();
    const log = [], near = [], aim = []; const v1 = V(R.hips), v2 = v1.clone(), v3 = v1.clone();
    const r = sequence(() => { c.resetMotion(); c.pos.set(-11.6, 0.22, 318); c.state = 'ground'; s.camera.yaw = lookYaw; s.camera.pitch = 0.14; s.input.lockFailed = true; if (rig.clipState) rig.clipState.peakV = 0; }, (f, k) => {
      if (f === 20) s.camera.cs.domElement.dispatchEvent(new PointerEvent('pointerdown', { button: 0, pointerId: 1, bubbles: true }));
      if (f === 20 + hold) window.dispatchEvent(new PointerEvent('pointerup', { button: 0, pointerId: 1, bubbles: true }));
      k.right = steer > 0 && f > 40 && f < 20 + hold; k.left = steer < 0 && f > 40 && f < 20 + hold; s.camera.yaw = lookYaw;
      const w = {}; for (const n in bones) { const q = bones[n].quaternion, p0 = prev[n]; const d = Math.min(1, Math.abs(q.x * p0.x + q.y * p0.y + q.z * p0.z + q.w * p0.w)); w[n] = +(2 * Math.acos(d) * 60).toFixed(0); p0.copy(q); }
      if (f >= 20 + hold - around && f <= 20 + hold + around) near.push(`f${f - 20 - hold >= 0 ? '+' : ''}${f - 20 - hold} ${c.state} peak ${Math.max(...Object.values(w))} ${JSON.stringify(w)} ${rig.clipState ? 'wS=' + rig.clipState.wSwing.toFixed(2) + ' wL=' + rig.clipState.wLaunch.toFixed(2) : ''} ${wFmt()}`);
      if (c.state === 'swing' && c.anchor && f > 20) { // the web arm must point at the anchor
        const up = c.webSide > 0 ? R.L.upper : R.R.upper, hand = c.webSide > 0 ? R.L.hand : R.R.hand;
        mesh.updateMatrixWorld(true); up.getWorldPosition(v1); hand.getWorldPosition(v2); v3.set(c.anchor.x, c.anchor.y, c.anchor.z).sub(v1).normalize(); v2.sub(v1).normalize();
        aim.push(Math.acos(Math.min(1, v2.dot(v3))) * 180 / Math.PI);
      }
      if (f >= 14 && f % every === 0) log.push(`${(f / 60).toFixed(2)} ${c.state}${c.state === 'swing' ? (c.webSide > 0 ? 'L' : 'R') : ''} v=(${c.vel.x.toFixed(0)},${c.vel.y.toFixed(0)},${c.vel.z.toFixed(0)}) y=${c.pos.y.toFixed(0)} ${rig.clipState ? 'flip=' + (rig.clipState.rel.flip ? 1 : 0) + ' shot=' + (rig.clipState.shot ? rig.clipState.shot.name : '-') : ''} ${wFmt()}`);
    }, 20 + hold + tail, (f) => (f < 20 ? 'idle' : f < 20 + hold ? 'attach+swing' : f < 20 + hold + 40 ? 'release+0.7s' : 'freefall+land'));
    const sorted = aim.slice().sort((a, b) => a - b);
    return { phases: r.phases, worst: r.worst, webArmAimDeg: aim.length ? { mean: +(aim.reduce((a, b) => a + b, 0) / aim.length).toFixed(1), p95: +sorted[Math.floor(sorted.length * 0.95)].toFixed(1), max: +sorted[sorted.length - 1].toFixed(1), frames: aim.length, series: aim.filter((_, i) => i % 6 === 0).map((x) => Math.round(x)) } : null, near, log };
  }

  // ------------------------------------------------------------------ close-up views of the real game scene (front, side, back) for visual checks
  const cs = s.camera.cs, cam = cs.camera, origCsUpdate = cs.update; let shot = null;
  /** Points the game camera at the character from `view` ('front' | 'side' | 'back' | 'three') at `dist` metres; the game's camera system is bypassed until clearCloseup(). */
  function closeup(view = 'front', { dist = 3.2, height = 1.0, fov = 38, look = 1.0 } = {}) {
    s.update = () => {}; s.updateCamera = () => {};
    const yaws = { front: 0, side: Math.PI / 2, back: Math.PI, three: Math.PI / 4 };
    cs.update = () => {
      const h = mesh.rotation.y + yaws[view], x = mesh.position.x + Math.sin(h) * dist, z = mesh.position.z + Math.cos(h) * dist;
      cam.position.set(x, mesh.position.y + height, z); cam.lookAt(mesh.position.x, mesh.position.y + look, mesh.position.z); cam.fov = fov; cam.updateProjectionMatrix(); cam.updateMatrixWorld(true);
    };
    shot = true;
  }
  /** Runs the rig alone at a constant ground speed (no physics) for `frames` frames and stops there, so a pose at a chosen speed can be looked at (speed 0 = idle). */
  function stage(speed, frames = 120, { x: x0 = -11.6, z: z0 = 300, heading = 0 } = {}) {
    hold();
    const dt = 1 / 60; let x = x0, z = z0, time = 0; mesh.rotation.y = heading;
    for (let i = 0; i < frames; i++) { x += Math.sin(heading) * speed * dt; z += Math.cos(heading) * speed * dt; time += dt; mesh.position.set(x, 0, z); rig.update(dt, { ...base, speed, speed3: speed, heading, time, px: x, pz: z }); mesh.updateMatrixWorld(true); }
    return { speed, phase: rig.clipState ? +rig.clipState.phase.toFixed(3) : rig.state.phase };
  }
  /**
   * Comparison grid: one row per candidate, one column per moment of its cycle, every cell the SAME Raimi model (a clone of the game's), same scale, same lighting, same camera.
   * rows: [{ file, label?, opts?: bakeRetarget options, a?, b? }] (a..b = fraction of the clip). Rows are stacked upwards (floating) so one camera frames all of them.
   * view 'side' (characters face the right edge) or 'front'. The clip is baked exactly as the converter bakes it (opts), from the FBX, so a candidate can be judged before it
   * is converted. Returns the row labels top to bottom. clearSheet() removes the grid.
   */
  async function grid(rows, { cols = 6, view = 'side', spacing = 1.25, rowGap = 2.1, dist = 13, fov = 36, dir = '/content/spider-raimi/anims-src/', zAhead = 6, wrap = true } = {}) {
    const { clone } = await import('three/addons/utils/SkeletonUtils.js');
    const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
    const { bakeRetarget, loadFbxTolerant } = await import('/js/spider-clips.js');
    const T3 = await import('three/webgpu');
    clearSheet(); s.update = () => {}; s.updateCamera = () => {};
    const pristine = (await new GLTFLoader().loadAsync('/content/spider-raimi/spider-raimi.glb')).scene, rest = new Map();
    pristine.traverse((o) => { if (o.isBone) rest.set(o.name, [o.position.clone(), o.quaternion.clone(), o.scale.clone()]); });
    const scene = s.entity.mesh.parent, base = s.entity.position, labels = [];
    for (let r = 0; r < rows.length; r++) {
      const row = rows[r]; let baked, clip0;
      if (row.baked) { baked = T3.AnimationClip.parse((await (await fetch(`/content/spider-raimi/anims/${row.baked}.json`)).json()).clip); clip0 = baked; } // a clip as the game plays it now
      else {
        const { group } = await loadFbxTolerant(dir + encodeURI(row.file)); clip0 = group.animations[0];
        const dst = (await new GLTFLoader().loadAsync('/content/spider-raimi/spider-raimi.glb')).scene;
        baked = bakeRetarget(clip0, group, dst, { name: row.file, rootXZ: 'strip', ...(row.opts || {}) });
      }
      labels.push(`${row.label || row.file || row.baked} (${clip0.duration.toFixed(2)} s)`);
      for (let c = 0; c < cols; c++) {
        const a = row.a ?? 0, b = row.b ?? 1, f = a + (b - a) * (wrap ? c / cols : c / Math.max(1, cols - 1));
        const cl = clone(s.model.root);
        cl.traverse((o) => { if (o.isBone && rest.has(o.name)) { const [p, q, sc] = rest.get(o.name); o.position.copy(p); o.quaternion.copy(q); o.scale.copy(sc); } });
        cl.position.set(base.x + (c - (cols - 1) / 2) * spacing, base.y + (rows.length - 1 - r) * rowGap, base.z + zAhead); cl.rotation.y = (view === 'side' ? 90 : 0) * Math.PI / 180; scene.add(cl);
        const m = new T3.AnimationMixer(cl), act = m.clipAction(baked); act.play(); act.time = f * baked.duration; m.update(0); cl.updateMatrixWorld(true); cl.visible = true;
        cl.traverse((o) => { if (o.isMesh) { o.frustumCulled = false; o.castShadow = false; } }); sheetClones.push(cl);
      }
    }
    const mid = base.y + ((rows.length - 1) * rowGap) / 2 + 0.95;
    s.update = () => {}; s.updateCamera = () => {};
    cs.update = () => { cam.position.set(base.x, mid, base.z + zAhead + dist); cam.lookAt(base.x, mid, base.z + zAhead); cam.fov = fov; cam.updateProjectionMatrix(); cam.updateMatrixWorld(true); };
    return labels;
  }

  /**
   * Front / side / rear views of the same moment of each clip, in one picture: row = a clip of the game at time `t`, columns = the character turned 0, 90, 180 degrees to the camera.
   * `lean` (radians, optional per row) tilts the whole body forward about the hips like the clip layer does at speed. Floating high above the street so nothing walks into the shot.
   */
  async function turnaround(items, { spacing = 1.6, rowGap = 2.2, dist = 11, fov = 36, lift = 6, zAhead = 6, yaws = [0, 90, 180] } = {}) {
    const { clone } = await import('three/addons/utils/SkeletonUtils.js');
    const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
    const T3 = await import('three/webgpu');
    clearSheet(); s.update = () => {}; s.updateCamera = () => {};
    const pristine = (await new GLTFLoader().loadAsync('/content/spider-raimi/spider-raimi.glb')).scene, rest = new Map();
    pristine.traverse((o) => { if (o.isBone) rest.set(o.name, [o.position.clone(), o.quaternion.clone(), o.scale.clone()]); });
    const scene = s.entity.mesh.parent, base = s.entity.position;
    for (let r = 0; r < items.length; r++) {
      const it = items[r], j = await (await fetch(`/content/spider-raimi/anims/${it.baked}.json`)).json(), clip = T3.AnimationClip.parse(j.clip);
      yaws.forEach((yaw, c) => {
        const cl = clone(s.model.root);
        cl.traverse((o) => { if (o.isBone && rest.has(o.name)) { const [pp, q, sc] = rest.get(o.name); o.position.copy(pp); o.quaternion.copy(q); o.scale.copy(sc); } });
        const holder = new T3.Group(); holder.position.set(base.x + (c - (yaws.length - 1) / 2) * spacing, base.y + lift + (items.length - 1 - r) * rowGap, base.z + zAhead); holder.rotation.y = yaw * Math.PI / 180;
        holder.add(cl); scene.add(holder);
        const m = new T3.AnimationMixer(cl), act = m.clipAction(clip); act.play(); act.time = Math.min(clip.duration - 1e-3, it.t); m.update(0);
        if (it.lean) { const hips = cl.getObjectByName('mixamorigHips'); hips.updateWorldMatrix(true, false); const w = new T3.Quaternion(); hips.getWorldQuaternion(w); /* pitch the whole holder about its local x, pivot at the feet */ cl.rotation.x = it.lean; }
        holder.updateMatrixWorld(true); holder.traverse((o) => { if (o.isMesh) { o.frustumCulled = false; o.castShadow = false; } }); sheetClones.push(holder);
      });
    }
    const mid = base.y + lift + ((items.length - 1) * rowGap) / 2 + 0.95;
    cs.update = () => { cam.position.set(base.x, mid, base.z + zAhead + dist); cam.lookAt(base.x, mid, base.z + zAhead); cam.fov = fov; cam.updateProjectionMatrix(); cam.updateMatrixWorld(true); };
    return items.map((i) => i.label || i.baked);
  }

  /** Looks at a contact sheet from the side (characters face the right edge). */
  function viewSheet({ zAhead = 6, dist = 11, height = 1.1, fov = 34 } = {}) {
    s.update = () => {}; s.updateCamera = () => {};
    cs.update = () => { const b = s.entity.position; cam.position.set(b.x, b.y + height, b.z + zAhead + dist); cam.lookAt(b.x, b.y + 0.95, b.z + zAhead); cam.fov = fov; cam.updateProjectionMatrix(); cam.updateMatrixWorld(true); };
  }
  function clearCloseup() { cs.update = origCsUpdate; shot = null; }

  return { turnaround, grid, viewSheet, sheetClip, stage, closeup, clearCloseup, slip, report, live, slipGeneric, sheet, clearSheet, groundBattery, sequence, jumps, rooftopFall, swingRelease, swingTrace, slipToe, groundSlip, hold, rig, controller: c, mesh, origUpd, origCam };
}
