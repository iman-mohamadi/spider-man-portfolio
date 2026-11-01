import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// Loads the Sam Raimi era Spider-Man (Mixamo skeleton), converted from the downloaded FBX to GLB with tools/model-lab.html (Three.js FBXLoader and
// GLTFExporter): skeleton and skin weights are the FBX's, verified identical to ~1e-7 m after conversion; the triangles are regrouped into one range per
// material (10 draw calls instead of 374) and identical vertices are welded; materials are MeshStandardMaterial with the 4K maps downsized (suit 2048).
// The skeleton keeps its native centimetre units under one root node scaled to metres (1.82 m tall). The original FBX / zip are never modified.
// Provenance: see content/spider-raimi/README.md (the licence of this model has still to be confirmed by the owner of the project).

const MODEL_URL = new URL('../content/spider-raimi/spider-raimi.glb', import.meta.url).href;

/**
 * @returns {Promise<{ root: THREE.Object3D, meshes: THREE.Mesh[], skinned: THREE.SkinnedMesh[], stats: object, kind: 'raimi' }>}
 */
async function loadRaimiModel() {
  const t0 = performance.now();
  const res = await fetch(MODEL_URL);
  if (!res.ok) throw new Error(`Raimi model request failed: ${res.status}`);
  const buf = await res.arrayBuffer();
  // a download manager can answer a fetch with an empty or foreign body (it did for the geodata files): say so instead of failing inside the parser
  if (buf.byteLength < 1000 || new Uint32Array(buf, 0, 1)[0] !== 0x46546c67) throw new Error(`Raimi model: ${buf.byteLength} bytes and not a GLB (a download manager or proxy may have intercepted ${MODEL_URL})`);
  const gltf = await new GLTFLoader().parseAsync(buf, MODEL_URL.slice(0, MODEL_URL.lastIndexOf('/') + 1));
  const root = gltf.scene;
  const meshes = [], skinned = [];
  root.traverse((o) => {
    if (!o.isMesh) return;
    meshes.push(o);
    if (o.isSkinnedMesh) { skinned.push(o); o.frustumCulled = false; } // the bind-pose bounds do not cover extended limbs
    const glass = o.material && o.material.transparent;
    o.castShadow = !glass;
    o.receiveShadow = true;
    if (glass) o.renderOrder = 3;
  });
  root.updateMatrixWorld(true); // bind pose in model space: the rig reads it
  const stats = { loadMs: performance.now() - t0, triangles: meshes.reduce((n, m) => n + (m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position.count) / 3, 0), drawObjects: meshes.length, kind: 'raimi' };
  return { root, meshes, skinned, stats, kind: 'raimi', clips: gltf.animations };
}

export { loadRaimiModel, MODEL_URL as RAIMI_MODEL_URL };
