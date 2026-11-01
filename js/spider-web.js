import * as THREE from 'three/webgpu';

// The web: a real 3D cord, not a line. Three thin strands twisted round each other (a braid), each a small tube with 5 sides, built along a curve from the
// hand to the anchor and rebuilt every frame in world space (one mesh, one draw call, ~600 vertices).
//  * shape:    a straight line plus a parabolic sag that follows the rope: nearly taut under tension, visibly slack when the rope is loose, and a small
//              travelling wave while the swing changes. The hand end follows the real hand bone every frame, the anchor end never moves.
//  * life:     shoots out from the hand (the tip travels to the anchor in ~0.1 s), stays while attached, and on release whips back into the hand
//              (the tip returns, the cord goes slack and thins) before disappearing.
//  * look:     slightly thicker the further it is from the camera, so a 60 m strand does not shrink to nothing; a soft off-white with real lighting
//              (roughness, a hint of emission so it never goes black in shade).
// The scene's matrices are static (matrixWorldAutoUpdate = false), so this mesh keeps an identity transform and its vertices are in world space.

const SEG = 40, SIDES = 5, STRANDS = 3;
const SHOOT_TIME = 0.11, RETRACT_TIME = 0.24;
const CORD_RADIUS = 0.0052, BRAID_RADIUS = 0.0068; // metres: each strand's radius, and the distance of the strand centres from the cord axis

const _up = new THREE.Vector3(0, 1, 0);
const smooth01 = (t) => { t = Math.max(0, Math.min(1, t)); return t * t * (3 - 2 * t); };

class WebStrand {
  constructor(scene) {
    const ringVerts = STRANDS * (SEG + 1) * SIDES;
    this.pos = new Float32Array(ringVerts * 3);
    this.nrm = new Float32Array(ringVerts * 3);
    const idx = [];
    for (let k = 0; k < STRANDS; k++) {
      for (let i = 0; i < SEG; i++) {
        for (let j = 0; j < SIDES; j++) {
          const a = ((k * (SEG + 1) + i) * SIDES) + j, b = ((k * (SEG + 1) + i) * SIDES) + (j + 1) % SIDES;
          const c = ((k * (SEG + 1) + i + 1) * SIDES) + j, d = ((k * (SEG + 1) + i + 1) * SIDES) + (j + 1) % SIDES;
          idx.push(a, c, b, b, c, d);
        }
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('normal', new THREE.BufferAttribute(this.nrm, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setIndex(idx);
    const mat = new THREE.MeshStandardNodeMaterial({ color: 0xe8ecf4, roughness: 0.42, metalness: 0.0 });
    mat.emissive = new THREE.Color(0x1b1e26); // a hint of self light: the cord stays readable in the shade of a street canyon
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.name = 'SpiderWebStrand';
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.mesh.renderOrder = 5;
    scene.add(this.mesh);
    this.mesh.updateMatrixWorld(true);
    // a small splat where the web sticks
    this.blob = new THREE.Mesh(new THREE.SphereGeometry(1, 10, 6), mat);
    this.blob.name = 'SpiderWebAnchor';
    this.blob.frustumCulled = false;
    this.blob.visible = false;
    this.blob.renderOrder = 5;
    scene.add(this.blob);

    this.state = 'idle';
    this.t = 0;
    this.anchor = new THREE.Vector3();
    this.hand = new THREE.Vector3();
    this.tipFrom = 1; // where the tip was when the retraction began
    this.slack = 0;
    this.sway = 0;
    this._lastTension = 1;
    // scratch
    this._H = new THREE.Vector3(); this._T = new THREE.Vector3(); this._d = new THREE.Vector3(); this._w = new THREE.Vector3();
    this._p = new THREE.Vector3(); this._tan = new THREE.Vector3(); this._n = new THREE.Vector3(); this._b = new THREE.Vector3(); this._tmp = new THREE.Vector3();
    this._pts = Array.from({ length: SEG + 1 }, () => new THREE.Vector3());
  }

  get active() { return this.state !== 'idle'; }

  /** The web is shot at `anchor` (world position). */
  shoot(anchor) {
    this.anchor.copy(anchor);
    this.state = 'shooting'; this.t = 0; this.slack = 0.15; this.sway = 1;
  }

  /** The web is let go: whip back into the hand. */
  release() {
    if (this.state === 'idle' || this.state === 'retracting') return;
    this.tipFrom = this.state === 'shooting' ? smooth01(this.t / SHOOT_TIME) : 1;
    this.state = 'retracting'; this.t = 0;
  }

  /** Immediately gone (teleport, mode change). */
  hide() {
    this.state = 'idle';
    this.mesh.visible = false; this.blob.visible = false;
  }

  /**
   * Call once per frame, AFTER the character's matrices are up to date.
   * @param hand world position of the web hand; @param tension rope tension 0 (slack) .. ~1 (taut) from the controller; @param camera for thickness scaling
   */
  update(dt, hand, tension, camera, time) {
    if (this.state === 'idle') return;
    this.t += dt;
    this.hand.copy(hand);
    // ---- life cycle: how far along the line the free end is, and how slack the cord is
    let tip = 1, slackWanted = 1 - Math.max(0, Math.min(1, tension)), thin = 1;
    if (this.state === 'shooting') {
      tip = smooth01(this.t / SHOOT_TIME);
      slackWanted = 0.15;
      if (this.t >= SHOOT_TIME) this.state = 'attached';
    } else if (this.state === 'retracting') {
      const k = Math.min(1, this.t / RETRACT_TIME);
      tip = this.tipFrom * (1 - k * k * (3 - 2 * k)); // eases back into the hand
      slackWanted = 1; thin = 1 - 0.6 * k;
      if (k >= 1) { this.hide(); return; }
    }
    this.slack += (slackWanted - this.slack) * Math.min(1, dt * 9);
    this.sway = this.sway * Math.exp(-dt * 2.2) + (this.state === 'retracting' ? 0.12 : 0); // a wave that dies away after the shot, whips on release
    // ---- the curve: hand -> tip with a parabolic sag and a small travelling wave
    const H = this._H.copy(this.hand), T = this._T.copy(H).lerp(this.anchor, tip);
    const d = this._d.copy(T).sub(H), len = d.length();
    if (len < 0.05) { this.mesh.visible = false; this.blob.visible = false; return; }
    const sag = len * (0.0025 + 0.07 * Math.pow(this.slack, 1.5)) * (this.state === 'retracting' ? 2.2 : 1);
    const w = this._w.copy(d).cross(_up); // horizontal sideways direction
    if (w.lengthSq() < 1e-8) w.set(1, 0, 0); else w.normalize();
    const swayAmp = len * 0.012 * this.sway + (this.state === 'retracting' ? len * 0.03 * this.slack : 0);
    const pts = this._pts;
    for (let i = 0; i <= SEG; i++) {
      const s = i / SEG, bow = 4 * s * (1 - s);
      pts[i].copy(H).addScaledVector(d, s);
      pts[i].y -= sag * bow;
      pts[i].addScaledVector(w, swayAmp * Math.sin(Math.PI * s) * Math.sin(time * 9 - s * 11));
    }
    // ---- rotation-minimising frame along the curve, then three twisted strands around it
    const turns = Math.max(5, Math.min(70, len / 0.45)); // braid pitch of ~0.45 m
    const cam = camera ? camera.position : null;
    const tan = this._tan, n = this._n, b = this._b, tmp = this._tmp, p = this._p;
    tan.copy(pts[1]).sub(pts[0]).normalize();
    n.copy(tan).cross(_up); if (n.lengthSq() < 1e-6) n.set(1, 0, 0); n.normalize();
    b.copy(tan).cross(n).normalize();
    for (let i = 0; i <= SEG; i++) {
      if (i > 0) { // parallel transport: carry n,b to the new tangent
        const t2 = tmp.copy(pts[Math.min(SEG, i + 1)]).sub(pts[Math.max(0, i - 1)]).normalize();
        const axis = p.copy(tan).cross(t2), sinA = axis.length();
        if (sinA > 1e-6) { axis.multiplyScalar(1 / sinA); const ang = Math.asin(Math.min(1, sinA)); n.applyAxisAngle(axis, ang); b.applyAxisAngle(axis, ang); }
        tan.copy(t2);
      }
      const c = pts[i];
      const dcam = cam ? cam.distanceTo(c) : 10;
      const scale = thin * Math.max(1, Math.min(3.2, 0.55 + dcam / 22)); // thicker with distance so it never vanishes
      const rs = CORD_RADIUS * scale, rb = BRAID_RADIUS * scale;
      const s = i / SEG;
      for (let k = 0; k < STRANDS; k++) {
        const a = (k / STRANDS) * Math.PI * 2 + s * turns * Math.PI * 2;
        const ca = Math.cos(a), sa = Math.sin(a);
        const base = (k * (SEG + 1) + i) * SIDES;
        for (let j = 0; j < SIDES; j++) {
          const phi = (j / SIDES) * Math.PI * 2, cp = Math.cos(phi), sp = Math.sin(phi);
          const ox = n.x * cp + b.x * sp, oy = n.y * cp + b.y * sp, oz = n.z * cp + b.z * sp; // outward direction of this tube vertex
          const o = (base + j) * 3;
          this.pos[o] = c.x + (n.x * ca + b.x * sa) * rb + ox * rs;
          this.pos[o + 1] = c.y + (n.y * ca + b.y * sa) * rb + oy * rs;
          this.pos[o + 2] = c.z + (n.z * ca + b.z * sa) * rb + oz * rs;
          this.nrm[o] = ox; this.nrm[o + 1] = oy; this.nrm[o + 2] = oz;
        }
      }
    }
    const g = this.mesh.geometry;
    g.attributes.position.needsUpdate = true; g.attributes.normal.needsUpdate = true;
    this.mesh.visible = true;
    // the splat: only once the tip has arrived (and while retracting it shrinks away)
    const arrived = tip > 0.995 || (this.state === 'retracting' && tip > 0.5);
    this.blob.visible = arrived;
    if (arrived) { this.blob.position.copy(this.anchor); const r = 0.055 * (this.state === 'retracting' ? Math.max(0, tip) : 1); this.blob.scale.set(r, r * 0.7, r); this.blob.updateMatrix(); this.blob.updateMatrixWorld(true); }
  }
}

export { WebStrand, SEG as WEB_SEGMENTS, SHOOT_TIME, RETRACT_TIME };
