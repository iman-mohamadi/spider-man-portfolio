import * as THREE from 'three/webgpu';

// The visible web strand: one thin open cylinder stretched between the hand and the anchor (a single draw call). The scene's matrices
// are static (matrixWorldAutoUpdate = false), so the strand updates its own matrix whenever it changes.

class WebStrand {
  constructor(scene) {
    const geo = new THREE.CylinderGeometry(1, 1, 1, 5, 1, true);
    geo.translate(0, 0.5, 0); // base at the origin, along +Y
    const mat = new THREE.MeshBasicNodeMaterial({ color: 0xeef2ff, side: THREE.DoubleSide });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.name = 'SpiderWebStrand';
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.mesh.renderOrder = 5;
    this._up = new THREE.Vector3(0, 1, 0);
    this._dir = new THREE.Vector3();
    this.radius = 0.028;
    scene.add(this.mesh);
  }

  /** Stretches the strand from (fx, fy, fz) to (tx, ty, tz). */
  set(fx, fy, fz, tx, ty, tz) {
    const d = this._dir.set(tx - fx, ty - fy, tz - fz);
    const len = d.length();
    if (len < 0.05) { this.hide(); return; }
    d.multiplyScalar(1 / len);
    const m = this.mesh;
    m.position.set(fx, fy, fz);
    m.quaternion.setFromUnitVectors(this._up, d);
    m.scale.set(this.radius, len, this.radius);
    m.visible = true;
    m.updateMatrix();
    m.updateMatrixWorld(true);
  }

  hide() {
    if (this.mesh.visible) this.mesh.visible = false;
  }
}

export { WebStrand };
