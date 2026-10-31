import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// Loads the Spider-Man glTF (the original asset is never modified: every fix is applied to the loaded copy).
// Model: "Marvel Spider Man Ps4 For Blender" by Miqdad khan, CC-BY-4.0 (see marvel_spider_man_ps4_for_blender/license.txt).

const MODEL_URL = new URL('../marvel_spider_man_ps4_for_blender/scene.gltf', import.meta.url).href;
const MODEL_BUFFER_URL = new URL('../content/spider-man/scene.dat', import.meta.url).href;

// The export left these six materials without a metallicFactor, which glTF defaults to 1.0: a fully metallic suit renders almost black.
const METAL_DEFAULT = ['24_lens', '22_shoes', '22_legs', '22_head', '22_gloves', '22_body'];
// Coincident duplicate layers of other meshes. The M0 A/B test showed no visible change without them, except `27_shoeenv`
// (hides white sole patches) and `27_eyeenv` (eye gloss): those two stay. Drawn, they cost ~22K triangles x 3 passes.
const REDUNDANT_OVERLAYS = ['27_webshooterenvsilv', '27_webshooterenvred', '27_spiderenv', '27_legenv', '27_gauntletenv'];

async function downscaleTextures(root, size) {
  const textures = new Set();
  root.traverse((o) => { if (o.isMesh && o.material && o.material.map) textures.add(o.material.map); });
  for (const t of textures) {
    const img = t.image;
    if (!img || !(img.width > size) || typeof createImageBitmap !== 'function') continue;
    try {
      // Same pixel layout as the loaded bitmap (no extra flip), just fewer texels: 2048^2 -> 1024^2 is 193 MB -> ~49 MB of GPU textures
      const small = await createImageBitmap(img, { resizeWidth: size, resizeHeight: size, resizeQuality: 'high' });
      t.image = small;
      t.needsUpdate = true;
      if (img.close) img.close();
    } catch (e) {
      console.warn('[spider] texture downscale skipped', e);
    }
  }
}

/**
 * @returns {Promise<{ root: THREE.Object3D, meshes: THREE.Mesh[], skinned: THREE.SkinnedMesh[], stats: object }>}
 */
async function loadSpiderModel({ textureSize = 1024, hideOverlays = true } = {}) {
  const t0 = performance.now();
  // Download managers (IDM etc.) capture requests for .bin files, so the geometry buffer is read from a byte-identical copy named .dat;
  // the original glTF is fetched unmodified and only its in-memory buffer URI is redirected.
  const json0 = await (await fetch(MODEL_URL)).json();
  json0.buffers[0].uri = MODEL_BUFFER_URL;
  const gltf = await new GLTFLoader().parseAsync(JSON.stringify(json0), MODEL_URL.slice(0, MODEL_URL.lastIndexOf('/') + 1));
  const root = gltf.scene;
  const assoc = gltf.parser.associations, json = gltf.parser.json;
  const meshes = [], skinned = [];
  const stats = { metalFixed: [], hidden: [], textureSize };
  root.traverse((o) => {
    if (!o.isMesh) return;
    const a = assoc.get(o);
    const meshName = a && a.meshes !== undefined ? json.meshes[a.meshes].name : o.name;
    o.userData.meshName = meshName;
    meshes.push(o);
    if (o.isSkinnedMesh) { skinned.push(o); o.frustumCulled = false; } // the bind-pose bounds do not cover extended limbs
    const mat = o.material;
    if (mat && mat.metalness === 1 && !mat.metalnessMap && METAL_DEFAULT.some((n) => mat.name.startsWith(n))) {
      mat.metalness = 0;
      stats.metalFixed.push(mat.name);
    }
    if (hideOverlays && REDUNDANT_OVERLAYS.some((n) => meshName.startsWith(n))) {
      o.visible = false;
      stats.hidden.push(meshName);
      return;
    }
    o.castShadow = true;
    o.receiveShadow = true;
  });
  if (textureSize) await downscaleTextures(root, textureSize);
  root.updateMatrixWorld(true); // bind pose in model space (the root has no parent yet): the rig reads it
  stats.loadMs = performance.now() - t0;
  stats.triangles = meshes.filter((m) => m.visible).reduce((n, m) => n + (m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position.count) / 3, 0);
  return { root, meshes, skinned, stats };
}

export { loadSpiderModel, METAL_DEFAULT, REDUNDANT_OVERLAYS };
