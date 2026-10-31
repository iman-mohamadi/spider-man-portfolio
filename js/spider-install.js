import * as THREE from 'three/webgpu';
import { createContactShadowMaterial } from './tsl-materials.js';
import { loadSpiderModel } from './spider-model.js';
import { createSpiderRig } from './spider-anim.js';
import { createSpiderWorld } from './spider-world.js';
import { SpiderInput } from './spider-input.js';
import { SpiderController } from './spider-controller.js';
import { SpiderCamera } from './spider-camera.js';
import { WebTargeting } from './spider-targeting.js';
import { WebStrand } from './spider-web.js';
import { PortfolioInteraction, loadContent } from './portfolio-interaction.js';

// Installs the playable Spider-Man prototype into the running city. Everything is additive and isolated: it registers one extra
// entity ('spider') with the existing ThirdPersonControllerManager, owns its own controller / camera / web / portfolio UI, and is only
// loaded when main.js imports this module (`?spider=0` skips it). The four original modes are not modified.

function loadCss(href) {
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  document.head.append(link);
}

async function installSpider({ scene, controllerManager, cameraSystem, selectMode, options = {} }) {
  loadCss(new URL('../css/spider.css', import.meta.url).href);
  const model = await loadSpiderModel({ textureSize: options.textureSize ?? 1024, hideOverlays: options.hideOverlays ?? true });

  // ---- entity: the object the camera, HUD, traffic and map read
  const mesh = new THREE.Group();
  mesh.name = 'PlayerSpider';
  const visual = new THREE.Group(); // carries the body tilt (hanging from the web); the manager only ever sets mesh.position / rotation.y
  visual.add(model.root);
  mesh.add(visual);
  const rig = createSpiderRig({ root: model.root, visual }); // reads the bind pose: must run before the mesh moves
  const shadowGeo = new THREE.PlaneGeometry(1.0, 1.0);
  shadowGeo.rotateX(-Math.PI * 0.5);
  const contactShadow = new THREE.Mesh(shadowGeo, createContactShadowMaterial());
  contactShadow.position.y = 0.03;
  contactShadow.renderOrder = 998;
  mesh.add(contactShadow);
  scene.add(mesh);

  const person = controllerManager.entities.person.position;
  const spawn = { x: person.x, z: person.z - 6 };
  const entity = {
    type: 'spider', label: 'Spider-Man', mesh,
    position: new THREE.Vector3(spawn.x, 0.22, spawn.z), heading: 0, speed: 0, verticalVel: 0,
    cameraTargetOffset: new THREE.Vector3(0, 1.5, 0), chaseDistance: 5.4, chaseHeight: 2.2,
    onTeleport: () => { controller.resetMotion(); camera.snap(entity.heading); }
  };
  controllerManager.entities.spider = entity; // registered after the audio system was built, so it never becomes an "engine" source

  const world = createSpiderWorld(controllerManager);
  // the mouse belongs to Spider-Man only while his mode and the chase camera are active (camera.active); other modes keep the original drag controls
  const input = new SpiderInput({ canvas: cameraSystem.domElement, isActive: () => camera.active });
  const controller = new SpiderController({ controllers: controllerManager, world, entity, input, getViewYaw: () => camera.getViewYaw(), rig });
  const camera = new SpiderCamera({ cameraSystem, controllers: controllerManager, entity, controller, world, input, THREE });
  const targeting = new WebTargeting({ world });
  controller.targeting = targeting;
  const web = new WebStrand(scene);

  // ---- portfolio (UI and content stay separate from the gameplay code)
  const content = await loadContent();
  const portfolio = new PortfolioInteraction({
    scene, content, spawn,
    ground: (x, z) => controllerManager.getGroundHeight(x, z, 'person'),
    onOpen: () => { controller.paused = true; input.paused = true; controllerManager.resetInput(); input.reset(); input.releaseLock(); }, // the cursor is needed for the panel
    onClose: () => { controller.paused = false; input.paused = false; }
  });

  // ---- small gameplay UI: a toast and the mode button
  const toast = document.createElement('div');
  toast.className = 'spider-toast';
  toast.setAttribute('role', 'status');
  document.body.append(toast);
  const nav = document.getElementById('mode-switch');
  const button = document.createElement('button');
  button.className = 'mode-btn';
  button.type = 'button';
  button.dataset.mode = 'spider';
  button.title = 'Spider-Man [T]';
  button.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#i-walk"/></svg><span class="mode-label">Spidey</span><kbd>T</kbd>';
  button.addEventListener('click', () => selectMode('spider'));
  if (nav) nav.insertBefore(button, nav.querySelector('.mode-btn'));

  // a one-line hint about the mouse: pointer lock needs a click first
  const hint = document.createElement('div');
  hint.className = 'spider-hint';
  document.body.append(hint);
  let hintText = '';
  let toastOn = false;
  const api = {
    entity, controller, camera, portfolio, web, model, rig, world, input, targeting,
    /** Makes Spider-Man the active mode and places him at the start (call before the first selectMode). */
    activate() {
      controllerManager.setMode('spider');
      controllerManager.teleportActiveTo(spawn.x, spawn.z, 0);
      cameraSystem.resetForTeleport();
      camera.snap(0);
    },
    syncButton(mode) { button.classList.toggle('active', mode === 'spider'); if (mode !== 'spider') input.releaseLock(); },
    /** Before ThirdPersonControllerManager.update(): movement, web, portfolio. */
    update(dt, elapsed) {
      const active = controllerManager.activeMode === 'spider';
      mesh.visible = active;
      if (input.consumeInteract() && active) portfolio.interact();
      if (active) {
        controller.update(dt);
        const p = controller.renderPos, a = controller.anchor;
        if (a && controller.swinging) {
          const cy = p.y + 1.3 + 0.3;
          let dx = a.x - p.x, dy = a.y - cy, dz = a.z - p.z; const m = Math.hypot(dx, dy, dz) || 1; dx /= m; dy /= m; dz /= m;
          web.set(p.x + dx * 0.55, cy + dy * 0.55, p.z + dz * 0.55, a.x, a.y, a.z);
        } else web.hide();
        contactShadow.visible = controller.grounded; // the mesh hierarchy itself is refreshed by main.js (entity meshes are dynamic roots)
      } else web.hide();
      portfolio.update(dt, elapsed, entity.position, active);
      const msg = controller.noAnchorFlash > 0 ? 'No web target: aim at a building' : '';
      const on = !!msg && active;
      if (on !== toastOn) { toastOn = on; toast.classList.toggle('is-on', on); }
      if (msg) toast.textContent = msg;
    },
    /** After CameraSystem.update(): takes over the chase camera while Spider-Man is active. */
    updateCamera(dt) {
      camera.update(dt);
      const live = camera.active && !controller.paused;
      targeting.update(dt, camera.view, entity.position, live && !controller.swinging);
      targeting.render(cameraSystem.camera, live);
      const text = !live ? '' : input.locked ? '' : input.lockFailed ? 'Left click: web · hold right mouse button to look' : 'Click the game to capture the mouse · Esc frees it';
      if (text !== hintText) { hintText = text; hint.textContent = text; hint.classList.toggle('is-on', !!text); }
    }
  };
  if (new URLSearchParams(location.search).has('spiderDebug')) window.__spider = api; // read-only inspection handle for manual testing
  return api;
}

export { installSpider };
