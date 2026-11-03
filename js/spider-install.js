import * as THREE from 'three/webgpu';
import { createContactShadowMaterial } from './tsl-materials.js';
import { loadSpiderModel } from './spider-model.js';
import { loadRaimiModel } from './spider-model-raimi.js';
import { loadBndModel } from './spider-model-bnd.js';
import { createEyeController } from './spider-eyes.js';
import { createSpiderRig } from './spider-anim.js';
import { loadClipSet, createClipRig } from './spider-clips.js';
import { createSpiderWorld } from './spider-world.js';
import { SpiderInput, LOOK_SENS } from './spider-input.js';
import { SPIDER } from './spider-physics.js';
import { GAIT } from './spider-gait.js';
import { SpiderController } from './spider-controller.js';
import { SpiderCamera, SPIDER_CAMERA } from './spider-camera.js';
import { WebTargeting, TARGETING } from './spider-targeting.js';
import { WebStrand } from './spider-web.js';
import { PortfolioInteraction } from './portfolio-interaction.js';

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
  // Which character: the Brand New Day suit (Mixamo skeleton, eye morphs) by default; ?spiderModel=raimi the Raimi model (same skeleton), ?spiderModel=ps4 the original PS4
  // model. A model whose files cannot be loaded falls back to the next one (bnd -> raimi -> ps4).
  const wantModel = new URLSearchParams(location.search).get('spiderModel');
  let model = null;
  if (wantModel !== 'ps4' && wantModel !== 'raimi') {
    try { model = await loadBndModel(); } catch (e) { console.warn('[spider] Brand New Day model unavailable, trying the Raimi model', e); }
  }
  if (!model && wantModel !== 'ps4') {
    try { model = await loadRaimiModel(); } catch (e) { console.warn('[spider] Raimi model unavailable, using the original model', e); }
  }
  if (!model) model = { ...(await loadSpiderModel({ textureSize: options.textureSize ?? 1024, hideOverlays: options.hideOverlays ?? true })), kind: 'ps4' };

  // ---- entity: the object the camera, HUD, traffic and map read
  const mesh = new THREE.Group();
  mesh.name = 'PlayerSpider';
  const visual = new THREE.Group(); // carries the body tilt (hanging from the web); the manager only ever sets mesh.position / rotation.y
  visual.add(model.root);
  mesh.add(visual);
  let rig = createSpiderRig({ root: model.root, visual }); // reads the bind pose: must run before the mesh moves
  // Real Mixamo clips on the Mixamo-skeleton model: content/spider-raimi/anims/manifest.json (production) or ?spiderClips=xbot (development: the Three.js
  // example Xbot's idle / walk / run, fetched at run time). Without clips, or with ?spiderClips=off, the procedural rig animates everything as before.
  let clipInfo = null;
  const clipMode = new URLSearchParams(location.search).get('spiderClips');
  if (rig.enabled && rig.rig.kind === 'mixamo' && clipMode !== 'off') {
    try {
      const cs = await loadClipSet(model.root, { source: clipMode === 'xbot' ? 'xbot' : 'manifest' });
      if (cs && new URLSearchParams(location.search).get('spiderRunJump') === '0') delete cs.set.runJump; // ?spiderRunJump=0: running jumps use the standing jump clip, as before
      if (cs) { rig = createClipRig({ root: model.root, visual, proc: rig, set: cs.set }); clipInfo = { source: cs.source, clips: Object.fromEntries(Object.entries(cs.set).map(([k, v]) => [k, { duration: +v.clip.duration.toFixed(2), speed: +v.info.speed.toFixed(2), contact: +v.info.contact.toFixed(2) }])) }; }
    } catch (e) { console.warn('[spider] clips unavailable, procedural animation only', e); }
  }
  // the Brand New Day eyes (morph targets "Squint" / "Open" on the eye frame) follow the same state the rig gets
  const eyes = createEyeController(model.root);
  if (eyes && rig.update) { const baseUpdate = rig.update; rig.update = (dt, st) => { baseUpdate.call(rig, dt, st); eyes.update(dt, st); }; }
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
  // the projects (one source: content/profile.json) are given to it by main.js once the billboards have found their places: portfolio.setProjects([{ project, x, z }])
  const portfolio = new PortfolioInteraction({
    scene, spawn,
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
  let toastOn = false, webOn = false;
  const handPos = new THREE.Vector3(), handDir = new THREE.Vector3(), lastHand = new THREE.Vector3();
  const api = {
    entity, controller, camera, portfolio, web, model, rig, world, input, targeting, clipInfo, eyes,
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
        // the web: starts at the real hand bone (matrices refreshed first, so the strand does not lag a frame behind the pose), ends at the anchor
        const a = controller.anchor, swinging = controller.swinging && !!a;
        if (swinging && !webOn) { web.shoot(a); webOn = true; } else if (!swinging && webOn) { web.release(); webOn = false; }
        if (web.active) {
          mesh.updateMatrixWorld(true);
          const rg = rig.rig, side = controller.webSide > 0 ? rg.L : rg.R;
          if (side && side.hand) {
            side.hand.getWorldPosition(handPos);
            side.fore.getWorldPosition(handDir); handDir.subVectors(handPos, handDir).normalize(); // forearm -> hand: where the fingers point
            handPos.addScaledVector(handDir, 0.07);
            lastHand.copy(handPos);
          }
          web.update(dt, lastHand, controller.tension, cameraSystem.camera, elapsed);
        }
        contactShadow.visible = controller.grounded; // the mesh hierarchy itself is refreshed by main.js (entity meshes are dynamic roots)
      } else { web.hide(); webOn = false; }
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
      targeting.update(dt, camera.view, entity.position, live && !controller.swinging, controller.vel, controller.grounded);
      targeting.render(cameraSystem.camera, live);
      const text = !live ? '' : input.locked ? '' : input.lockFailed ? 'Left click: web · hold right mouse button to look' : 'Click the game to capture the mouse · Esc frees it';
      if (text !== hintText) { hintText = text; hint.textContent = text; hint.classList.toggle('is-on', !!text); }
    }
  };
  if (new URLSearchParams(location.search).has('spiderTune')) { // live feel-tuning sliders: every value the game reads each frame (see spider-tuning.js)
    const { installTuning } = await import('./spider-tuning.js');
    api.tuning = installTuning({ spider: SPIDER, camera: SPIDER_CAMERA, targeting: TARGETING, look: LOOK_SENS, gait: GAIT });
  }
  if (new URLSearchParams(location.search).has('spiderDebug')) window.__spider = api; // read-only inspection handle for manual testing
  return api;
}

export { installSpider };
