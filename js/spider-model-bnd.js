import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// Loads the "Spider-Man: Brand New Day" suit, converted by tools/bnd-lab.html from the downloaded FBX (static, unskinned meshes) into content/spider-bnd/spider-bnd.glb:
// welded and decimated (~170k triangles), UDIM textures packed into two atlases (suit, accessories), and every mesh skinned to the SAME Mixamo skeleton as the Raimi model
// (skeleton node names, bind pose and hierarchy are the Raimi file's), so the Mixamo clips and the procedural rig drive it unchanged. The eye frame (BndFrame) carries the
// suit's two morph targets, "Squint" and "Open"; js/spider-eyes.js animates them. Provenance and licence: content/spider-bnd/README.md (the licence has NOT been confirmed).

const MODEL_URL = new URL('../content/spider-bnd/spider-bnd.glb', import.meta.url).href;

/**
 * @returns {Promise<{ root: THREE.Object3D, meshes: THREE.Mesh[], skinned: THREE.SkinnedMesh[], stats: object, kind: 'bnd' }>}
 */
async function loadBndModel() {
  const t0 = performance.now();
  const res = await fetch(MODEL_URL);
  if (!res.ok) throw new Error(`Brand New Day model request failed: ${res.status}`);
  const buf = await res.arrayBuffer();
  if (buf.byteLength < 1000 || new Uint32Array(buf, 0, 1)[0] !== 0x46546c67) throw new Error(`Brand New Day model: ${buf.byteLength} bytes and not a GLB (a download manager or proxy may have intercepted ${MODEL_URL})`);
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
    if (glass) o.renderOrder = 3; // the eye lenses
  });
  root.updateMatrixWorld(true); // bind pose in model space: the rig reads it
  const stats = { loadMs: performance.now() - t0, triangles: meshes.reduce((n, m) => n + (m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position.count) / 3, 0), drawObjects: meshes.length, kind: 'bnd' };
  return { root, meshes, skinned, stats, kind: 'bnd', clips: gltf.animations };
}

export { loadBndModel, MODEL_URL as BND_MODEL_URL };
