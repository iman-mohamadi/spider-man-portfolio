# Spider-Man Portfolio — Architecture Review

Pre-implementation review of `slop-newyork` (three.js / WebGPU / TSL) as the foundation for a Spider-Man-inspired portfolio game.
Companion documents: [implementation-roadmap.md](implementation-roadmap.md), [technical-risks.md](technical-risks.md).

- Review date: 2026-10-31
- Scope: documentation only. No source file, asset, dependency or configuration was modified by this review.
- One housekeeping note: earlier in the session (before this review's rules) a preview config `.claude/launch.json` was added to the repo. It is not used by the game; keep or delete it as you prefer.

## How to read this document

Every statement carries one of these labels.

| Label | Meaning |
|---|---|
| **[V]** | **Verified** against the current code or asset in this review. File and line references are given. |
| **[M]** | **Measured** by a script run during this review (the script is described; numbers are real but environment-specific). |
| **[A]** | **Assumption** — plausible but not verified. Must be validated before it is relied on. |
| **[R]** | **Recommendation** — a design decision proposed here. |

Line numbers refer to the repository as it stood during this review and will drift once code changes.

## 0. Repository state and baseline

- **[V]** The git repository has **no commits**; every file is untracked. There is no baseline to roll back to yet.
- **[V]** There is **no `package.json`**, no bundler and no npm dependency. The app is static files plus an ES-module import map (`index.html`, top of file) that pins three.js to a dev-branch commit served by jsDelivr: `mrdoob/three.js@b3396270682287470d161658ac01084d25e8dba6`. Addons (`GLTFLoader`, etc.) resolve through the same `three/addons/` mapping.
- **[V]** About 35K lines of JS in `js/`, 1,442 lines of CSS, one HTML file.
- **[M]** Baseline tests: `node --test "tests/**/*.test.cjs" "tests/**/*.test.mjs"` → **225 tests, 223 pass, 2 fail**. Both failures call `python3`, which resolves to the Microsoft Store stub on this machine (`geodata builds with default paths…`, `tree generator filters and deduplicates…`). They are environmental, not code defects. Note `node --test tests/` (a directory argument) fails on Node 24; use the globs.
- **[V]** Licenses: project code MIT (`LICENSE`); geographic data NYC Open Data + OpenStreetMap ODbL (`README.md`); Spider-Man model **CC-BY 4.0**, credit required (`marvel_spider_man_ps4_for_blender/license.txt`).

---

## 1. Repository architecture audit

### 1.1 Application initialization and render lifecycle

Single entry point: `js/main.js` (`initApp()`, line 25), loaded by `<script type="module" src="./js/main.js">`.

Order of operations **[V]**:

| Step | Lines | What happens |
|---|---|---|
| Renderer | 55–64 | `new THREE.WebGPURenderer({ antialias, powerPreference:'high-performance', reversedDepthBuffer:true })`, pixel ratio fixed at **1.0**, shadows on, `renderer.lighting = new ClusteredLighting(256, 32, 28, 48)`. `await renderer.init()` at 75. |
| Sky/lighting | 80–82 | `new LightingSystem(scene, renderer)` (`js/lighting.js`). |
| World build | 86–112 | In order: `buildCityGrid` → `buildBoroughs` → `buildLandmarks` → `buildCityBlocks(scene, landmarkColliders)` → `buildStreetDetails(scene, allColliders)` → `createTrafficSystem` → `createHighwayTraffic` → `buildRoadPaint`. `allColliders` is assembled at line 97 from landmark + city-block + borough + city-grid colliders. |
| Players | 119 | `new ThirdPersonControllerManager(scene, allColliders)`. Saved position restore at 121–132 (`localStorage['nyc-player-state']`, version 1). |
| Camera, input, audio | 143–165 | `CameraSystem`, `TouchControls`, `CityAudioSystem`. |
| Culling | 170–173 | `setupSceneCulling(scene, roots, sunLight.shadow)` over six named roots. |
| Matrix policy | 177–186 | `dynamicRoots` list, `scene.updateMatrixWorld(true)`, then **`scene.matrixWorldAutoUpdate = false`** (186). |
| Instanced storage | 192–198 | On the WebGPU backend, every `InstancedMesh` in the scene has its `instanceMatrix` swapped for a `StorageInstancedBufferAttribute` **once, at init**. |
| Post-processing | 203–243 | `pass(scene, camera)` with MRT (`output`, `normal`, `metalRough`), half-resolution SSR (`ssr(...)`, 224–237), bloom/grade via `createPostProcessing`, wrapped in `THREE.RenderPipeline`. |
| UI wiring | 246–587 | Mode/camera/time buttons, popovers, keyboard shortcuts, map. |
| Shader precompile | 593–667 | Traverses visible objects, builds one job per shared material/instanced mesh, runs 16 concurrent `renderer.compileAsync` workers. `COMPILE_POOL = 16` (591). |
| Frame loop | 681–779 | `renderer.setAnimationLoop`. |

Frame loop order **[V]** (`main.js:688–735`): `gamepadControls.update` → `controllerManager.update(dt, elapsed, cameraPos)` → `cameraSystem.update` → `trafficSystem.update(..., activeEntity, activeMode, camera)` → `highwayTraffic.update` → `boroughs.update` → `cityBlocks.update(camX, camZ)` (streams architectural details) → `cityBlocks.updateLights` → `streetDetails.update` → `lightingSystem.update` → `mapSystem.update` → `audioSystem.update` → `updateSceneCulling` → `root.updateMatrixWorld()` for each of `dynamicRoots` → `renderPipeline.render()`. `dt = min(max(rawDt, 0.001), 0.05)` (684): a **variable** step capped at 50 ms.

Observation **[observation, not a benchmark]**: in the in-app browser on this machine, the city took well over 30 s from navigation to first rendered frame (621 shader batches compiled behind the loading screen at the time of observation). This matters for a portfolio that recruiters open once; see risks R-08.

**Integration consequence [R]:** anything created after init is outside three of the init-time passes: the instanced-storage swap (192), shader precompile (593) and the matrix policy (186). New objects must either be created *before* those steps (during the loading stage) or replicate their treatment explicitly.

### 1.2 Scene and world construction

- **[V] Coordinate frame** (`js/city-config.js:3–10`): 1 unit = 1 m; +x grid-east, +z grid-south (north = −z); origin at 5th Ave × 42nd St centreline; axes turned 29° from true north. Heading convention everywhere: forward = `(sin h, cos h)`, so heading 0 faces +z.
- **[V]** Ground is y = 0 on roadways, `ISLAND_BOUNDS.sidewalkHeight = 0.22` on sidewalks (`city-config.js:610–616`), 1.24 inside Central Park (`controllers.js:865`), `bryantParkLawn.top` on Bryant Park's lawn.
- **[V]** Detailed island runs from about 129th St (`GEO.frame.cutZ`) to the Battery (z ≈ 6560); beyond that boroughs are low-detail (`boroughs.js`).
- **[V]** Landmarks are *authored procedural models* fitted onto real OSM outlines (`landmarks.js`, `fitToSite` 132–168). 11 landmarks have hand-written colliders (AABBs; `colliders.push` count in `landmarks.js`).
- **[V]** `getLocationLabel(x, z)` (`city-config.js:647`) gives the street-corner label used by the HUD.

### 1.3 Building geometry generation and spatial organisation

- **[V] Source data:** `js/building-geodata.js` decodes `building-geodata.bin.gz` (440,558 bytes, "NYB1" format with zig-zag varint deltas, top-level `await fetch`) into `REAL_BUILDINGS`: `{ height, year, polygons:[{outer, holes}], minX, maxX, minZ, maxZ, cx, cz }`.
- **[M]** Decoded statistics: **37,353 buildings = 37,353 polygons** (no multi-polygon buildings), **279,930 vertices**, 661 hole rings (courtyards), zero zero-height buildings, only **257 distinct heights** at 1 m quantisation. Outer-ring vertex count: median 6, p90 14, p99 26, max 125. Height quantiles: p50 18 m, p90 47 m, p99 133 m, max 472 m. Buildings > 60 m: 2,114; > 100 m: 753; > 150 m: 251; > 200 m: 88.
- **[V] One height per building. Roofs are flat.** `building-footprints.js:31` sets `top = height + 0.22`; walls are vertical quads from y = 0.22 to `top`; the roof is a triangulated polygon at `top` (66–74). There are no setbacks, parapets, pitched roofs or roof geometry in the survey data. The facade windows are drawn by a shader (`WALL_KINDS`, `createPreWarBuildingMaterial`, `createCurtainWallMaterial`), not by geometry, so every wall is a perfectly planar quad.
- **[V] Mesh organisation:** `createBuildingFootprints` (`building-footprints.js:24`) merges buildings into **one mesh per 1 km cell per facade material** (key at line 28; five facade materials). Chunks opt in to shadow stand-ins (`userData.shadowStandIn = true`, line 94).
- **[V] Facade assignment** (`buildings.js:343–356`): by construction year and a deterministic hash (pre-1945 → limestone/brick; 1945–1980 → limestone/dark glass; later → curtain-wall glass).
- **[V] Authored-landmark exclusion** (`buildings.js:243–259`): surveyed buildings overlapping a landmark reserve or landmark collider are *removed*; the authored landmark replaces them.
- **[V] Streamed details** (`buildings.js:493–836`): cornices, rooftop water towers, HVAC, fire escapes, awnings, fascia signs, scaffold sheds are instanced from per-building `detail` records stored in a **quadtree** (`Quadtree` class, line 57; capacity 6, depth 9) queried in a 560 m radius around the focus, re-queried after the focus moves more than 18 m (`update`, line 700). Pools have fixed capacities (`MAX_CORNICES = 7000`, `MAX_WATER_TOWERS = 1400`, …). **None of these details has a collider.**
- **[V] Existing billboards** (`buildings.js:415–489`): Times Square only. Billboard quads are placed along street-facing walls of surveyed buildings near the 7th Ave / Broadway bowtie, tiered from 7.5 m up to 62 m, merged per theme variant into `TimesSquareBillboards_<n>` meshes using `createBillboardMaterial(variant)` (`tsl-materials.js:2599`): six canvas-drawn posters with animated LED shader. Plain `PlaneGeometry` with `MeshBasicNodeMaterial`.
- **[V] Colliders** (`buildings.js:361–366`): one collider per building polygon: `{ minX, maxX, minZ, maxZ, minY: 0, maxY: height + 0.22, polygon }`.

Other collider sources **[V]**:

| Source | Shape | Notes |
|---|---|---|
| Landmarks (`landmarks.js`, e.g. 303–309, 1026–1032) | AABB with `maxY` only | Single box per landmark, scaled with `fitToSite` (159–170). E.g. Empire State: one 68 × 50 box × 245·(fit scale) m; the visual tower above the base is narrower, and spires/antennas are not covered. |
| City grid viaducts/tunnels/ramps (`city-grid.js:3322, 3371, 3525`) | AABBs with `maxY` | Columns, ramps, parapets. |
| Boroughs/bridges/tram (`boroughs.js:2247, 2836`) | AABBs with `maxY` | Towers/piers; **no cable or deck geometry**. |
| Subway entrances (`street-details.js:708`) | AABB + `obb` | `minY: 0.22`. |

### 1.4 Existing controller architecture

`ThirdPersonControllerManager` (`controllers.js:193`) owns four entities (209–214): `person`, `car`, `cyclist`, `helicopter`.

- **[V] Entity contract** (what other systems read): `type`, `label`, `mesh` (a `Group`), `position` (`Vector3`, feet/ground), `heading` (radians), `speed` (scalar along heading), `cameraTargetOffset` (`Vector3`), `chaseDistance`, `chaseHeight`. Optional: `vx`/`vz` (car drift), `verticalVel` (person), `rig`/`crowd` (person).
- **[V] Per-frame** (`update`, 1076–1125): person walks automatically when inactive (1084–1091); the active mode's `updateX(dt)` runs; **every** entity then gets `mesh.position.copy(position)` and `mesh.rotation.y = heading` (1102–1106); headlights modulated; `poseCharacters` runs (1007–1074).
- **[V] Person model:** *not* a glTF/SkinnedMesh. It is a custom GPU-skinned instanced "crowd" (`pedestrians.js`: `PersonCrowd` line 967, `PersonRig` line 1184), **15 bones**, poses in a storage buffer, procedurally-lofted geometry, planted-foot two-bone IK (comments at 31–33, `ride` at 1772). It cannot host the Spider-Man glTF.
- **[V] Physics style:** kinematic. Person (`updatePerson`, 1127–1157): `maxSpeed 8.2`, `turnRate 2.6`, `jump 5.2 m/s`, gravity `14.5`, collision radius 0.48, ground clamp via `getGroundHeight`. Car runs in 120 Hz substeps (1178–1183). No shared physics engine.
- **[V] Controls are tank-style, not camera-relative:** W/S = speed along heading, A/D = rotate heading.
- **[V] Mode switch:** `setMode(mode)` (325–338), `teleportActiveTo` (344–389; per-mode reset branches), `findTeleportPosition` (393–451).

### 1.5 Input handling

- **[V] Keyboard** (`controllers.js:250–281`): a closed binding table, `forward W/↑`, `backward S/↓`, `left A/←`, `right D/→`, `up Space/E`, `down Q/C`, written into `this.keys`. `_setAnalogInput` rejects any action not already a key of `this.keys` (293). The three sources (keyboard, touch, gamepad) are merged by `_blendInput` (283–290), supporting analog 0..1 values.
- **[V] Listeners are per-window**; typing into an `INPUT`/`SELECT` is ignored (`isTypingInField`, `city-config.js:703`).
- **[V] Global shortcuts** in `main.js:523–569`: `1–4` modes, `5–9,0` cameras, `V`, `H`, `N`, `B`, `M`. **`E` is already "up"** (jump/ascend), so it cannot be the interact key without conflict.
- **[V] Mouse/touch on the canvas** (`cameras.js:55–115`): left-button drag orbits (`orbitYawOffset`, `orbitPitchOffset`), wheel/pinch zooms. No pointer lock. Left mouse is therefore already used.
- **[V] Touch** (`touch-controls.js`): a virtual stick plus up/down buttons; **`setMode` returns early for any mode not in `['person','car','cyclist','helicopter']`** (line 97).
- **[V] Gamepad** (`gamepad-controls.js:143–168`): mode-specific mapping; jump (button 0) is wired to `up` **only when `mode === 'person'`** (165).

### 1.6 Collision detection and resolution

- **[V] Index:** `nearColliders(x, z, r)` (`controllers.js:879–914`) lazily indexes all colliders into a hash of **48 m cells** keyed by each collider's AABB, stamps visited colliders to dedupe, and sorts results by original order. It returns **a shared array (`this._nearList`)** that is overwritten by the next call (898–900): results must be consumed before any other call (including `resolveHorizontalCollision`).
- **[V] Resolution:** `resolveHorizontalCollision(pos, radius, carEntity, entity)` (916–1002):
  1. clamps `pos` into `ISLAND_BOUNDS` and (non-helicopter) to the shoreline ± 8 m via `getIslandBoundsAtZ` — **Spider-Man could not swing over the rivers without a change**;
  2. builds a body via `collisionBody(this.activeMode, …)` (70–81): circle for non-car modes; vertical extent `bottom 0 / top 1.9` (helicopter −0.25 / 3.2);
  3. for each near collider calls `buildingContact` (85–134), which skips a collider when `y + body.bottom >= c.maxY` or `y + body.top <= (c.minY ?? 0)`, applies AABB/OBB/polygon tests (`polygonContact` from `building-collision.js`), and pushes the position out along the contact normal.
- **[V] Vertical collision does not exist.** Buildings are only horizontal blockers filtered by a y-range. A body above `maxY` passes over a roof but nothing lands it; ground support is `getGroundHeight` only.
- **[V] No contact data is returned.** The normal/depth are written into a private scratch (`this._buildingContact`) and only forwarded to a collision listener for non-person entities (950–957).
- **[V] No raycast API** exists anywhere (searched `controllers.js`, `building-collision.js`, `buildings.js`, `scene-culling.js`); the only ray-like helper is `polygonSegmentFraction` (`building-collision.js:191`), a low-rate audio probe.
- **[V] Known weakness acknowledged in code:** "Sequential collision pushes can leave a player trapped between overlapping buildings" (`controllers.js:391–392`), motivating whole-footprint teleport placement. The same risk grows with speed.

### 1.7 Ground-height queries

- **[V]** `getGroundHeight(x, z, mode)` (861–876): 2D only. Central Park rectangle → 1.24; Bryant Park lawn → `lawn.top`; for `mode === 'person'` sidewalk → 0.22 else 0; all other modes → 0. It knows nothing about rooftops, bridges, ramps or the FDR viaduct.

### 1.8 Camera architecture

`CameraSystem` (`cameras.js:20`).

- **[V]** `PerspectiveCamera(56°, aspect, near 0.35, far 60000)` with reversed float depth.
- **[V]** 11 presets (`cameras.js:6–18`): three `follow` (`chase`, `action`, `pov`), eight `scenic`. `setCameraPreset` writes `camera.fov` from the preset (121).
- **[V]** `update` (169–362): the follow cameras place the camera at `entity.position − (sin,cos)(heading + orbitYawOffset)·dist` and look 5.2 m ahead along **`entity.heading`** (196–207) — the camera is behind the *orbit* yaw but aims along *heading*. It reads `entity.type` (202, 212–213, 232–240), `chaseDistance`, `chaseHeight`, `cameraTargetOffset`, and `Math.abs(entity.speed)`.
- **[V]** Smoothing is done in the entity's frame (333–352): offset lerp `k = 1 − exp(−8.5 dt)`, and the ground height is eased separately.
- **[V]** **Auto-recentre** (178–181): when not dragging and `|entity.speed| > 0.5`, `orbitYawOffset` decays to 0 (rate 2.2 /s). This fights camera-relative controls (see §4.9).
- **[V]** **No camera collision.** The camera can pass through buildings; only `y ≥ 0.55/0.65` is enforced (198, 352).
- **[V]** Camera yaw is not exposed. `currentPos` / `currentLookAt` are public and can be used to derive a view direction.

### 1.9 Dynamic object management

- **[V]** `scene.matrixWorldAutoUpdate = false` (`main.js:186`). Only objects under `dynamicRoots` (traffic, highway traffic, store/street clustered lights, every `entity.mesh`, `cyclist.helmet`) have matrices refreshed (`main.js:714`). **Spider-Man's `entity.mesh` is covered automatically if it is in `controllerManager.entities`**, including child bones, because `Object3D.updateMatrixWorld()` recurses.
- **[V]** Entities are added to the scene in their `create…Entity` methods; `castShadow/receiveShadow` are set by a traversal in the constructor (216–230), so a glTF loaded *later* needs its own shadow flags.
- **[V]** Soft contact shadow quad for the person (`createContactShadowMaterial`, 466–471) is reusable.

### 1.10 Culling and rendering optimisations

- **[V] `scene-culling.js`** (362 lines): (1) chunks large instanced meshes spatially and hides chunks beyond a size-derived distance (`updateSceneCulling`, 352); (2) builds position-only **shadow stand-ins** on layer 3 (`SHADOW_PROXY_LAYER`) cut into 500 m cells for big static casters; (3) chunks remaining large batches at 1 km.
- **[V]** `isStaticMesh` excludes `isSkinnedMesh` (54–56), and it only walks six named roots, so Spider-Man's meshes are untouched.
- **[V]** Shadows: 2-cascade sun shadow (`lighting.js:195–204, 299–304`), far plane 260 + 1.6·altitude clamped 300–720.
- **[V]** `ClusteredLighting(256, …)` for many point/spot lights (store spotlights are pooled, `buildings.js:669`).
- **[V]** SSR MRT requires materials that output `normal` and `metalRough`; standard node materials do. Whether a **glTF `MeshStandardMaterial` converted by the renderer** participates correctly in this MRT/SSR/cascade pipeline has **not** been verified in the city scene **[A]**. (A bare-scene render of the glTF worked earlier in this session.)

### 1.11 UI and HUD architecture

- **[V]** Plain DOM, no framework. `index.html`: brand panel (121–132), toolbar (135–166; time of day, teleport, map, sound, HUD toggle), teleport popover (169–179), radar minimap + street-name signs (182–189), **mode switch** (194–208; four `<button class="mode-btn" data-mode="…">`), speed/camera cluster (213–234), touch controls (237–254), camera popover (257–271), full map dialog (274–329).
- **[V]** `main.js` wiring uses `querySelectorAll('[data-mode]')` (246), a **hard-coded `modes` array** for the gamepad cycle (264), `controlHints` (273–278), `topSpeedMph` (280), and `selectMode` (309–327). CSS `.mode-switch` is a flex row; a JS-positioned pill (`--ind-x`/`--ind-w`) tracks the active button (301–307; `style.css:789–808`).
- **[V]** DOM text is set through `textContent`; the repo convention avoids `innerHTML` (comment at `main.js:245`).
- **[V]** `nyc-map.js` reads only `getActiveEntity().position` (520, 699, 968, 1097), so it is mode-agnostic.

### 1.12 Other consumers of the active entity — coupling table

This is the main source of regression risk when adding a fifth mode. **[V]** each row.

| File:line | Behaviour with an unknown mode/type | Required action |
|---|---|---|
| `controllers.js:403` `findTeleportPosition` | `body[e.type][0]` — **throws** for an entity whose `type` is not in the 4-key table | Add a body entry (or a guard). |
| `controllers.js:70–81` `collisionBody` | Unknown mode → treated as a non-car circle, top 1.9 | Acceptable. |
| `controllers.js:344–389` `teleportActiveTo` | Mode-specific resets; unknown mode just sets speed 0 | Add a reset hook for the new mode. |
| `controllers.js:1081–1106` `update` | Unknown mode: person auto-walks, no updater runs, mesh synced | Needs a dispatch for the new mode's updater. |
| `touch-controls.js:97` | **Rejects** the mode silently; button labels stay stale | Extend the whitelist and labels. |
| `gamepad-controls.js:151–165` | Non-driving → left stick maps to move; jump only for `person` | Add the new mode to the jump/action mapping. |
| `traffic.js:1894` | `player.active` = not helicopter and `y < 2.6` → Spider-Man at ground level is hit by cars | Desired; verify. |
| `traffic.js:1906–1907` | Unknown mode gets the **car hitbox** (0.86 × 2.18 m) | Map the new mode to person-sized dims. |
| `traffic.js:1442, 1472` | Mass 80 and `reportCollision` unless `type === 'person'` | Decide intended behaviour. |
| `audio-sources.js:87, 170–190` | `players = Object.values(entities)`; a non-`person` entity becomes a **motor** sound source of `kind = entity.type` | Skip or handle the new type, or the player would emit engine noise. |
| `audio-sources.js:167` | Speed source for `person` is `rig.speed` | New type falls to `hypot(speed, …)` — fine. |
| `cameras.js:202, 212–213, 232–240` | Unknown type → default offsets | Works, but needs tuned values. |
| `main.js:264, 273, 280, 523–569` | Hard-coded mode list / hints / speed scale / keys | Edit. |
| `main.js:134–141, 121–132` | Saved state is generic over `entities` | Safe. Old builds ignore an unknown saved mode (`Object.hasOwn`, line 130). |
| `index.html:194–208`, `style.css:789+, 1263–1270, 1412` | Fixed four-button nav and touch sizing | Edit. |

### 1.13 Test and tooling constraints

- **[V]** Tests use Node's built-in runner and a custom loader, `tests/helpers/module.cjs`: it rewrites static `import … from '…'` / `export …` text and evaluates modules in a `vm` context with **explicit import stubs**; an import with no stub throws `Missing import stub` (line 13). It supports only `import {…}`, `import * as X`, `export {…}` and `export const|let|var|function|class` — **no `export default`, no default imports, no dynamic `import()`, and no top-level `await`** in tested modules.
  - Consequence: adding any new `import` line to `controllers.js`, `cameras.js` or `touch-controls.js` breaks the existing tests for those files until their stubs are updated. These are loaded by `controllers.test.cjs`, `teleports.test.cjs`, `pedestrians.test.cjs`, `cameras.test.cjs`, `touch-controls.test.cjs`.
- **[V]** `tests/boot.test.cjs:36–43`: every `<link rel="modulepreload">` href must match `^\.\/js\/[\w-]+\.js$` (flat paths only), and every relative import inside a preloaded module must itself be preloaded. A *dynamic* `import('./x.js')` is not matched by the test's regex.
- **[V]** Naming convention: flat prefix families (`audio-*.js`, `building-*.js`, `pedestrian-*.js`).

---

## 2. Spider-Man character audit

Source: `marvel_spider_man_ps4_for_blender/scene.gltf` + `scene.bin`, Sketchfab export "Marvel Spider Man Ps4 For Blender", CC-BY 4.0.

### 2.1 Structure **[V/M]**

- glTF 2.0; `extensionsUsed: ["KHR_materials_specular"]` (used by one material; ignorable). No Draco/meshopt/KTX2.
- **20 meshes, 20 materials, one skin with 259 joints, 304 nodes, 0 animations.** Sampler: linear, mipmapped (`9987`), repeat.
- Net scale is 1.0: nodes `Sketchfab_model` (−90° X) → `…fbx` (0.01) → `Armature` (100) cancel out. Bind-pose bounds: x ±0.722 (arms), **y −0.002 … 1.808**, z −0.197 … 0.221. **Origin = feet; height ≈ 1.81 m** — the same convention as the project's entities (`position` = ground contact).
- **Faces +Z** (chest emblem visible to a camera on +Z in the earlier bare-scene render). This matches heading 0 → +Z, so no yaw offset is needed **[V, observed earlier in this session]**.

### 2.2 Meshes, triangles and materials **[M]**

Totals: **112,137 vertices, 156,556 triangles** across 20 draw items (one primitive each, double-sided material).

| Group | Meshes | Triangles |
|---|---|---|
| Suit body / legs / gloves / head / shoes | `22_body` 36,914; `22_legs` 26,696; `22_gloves` 24,410; `22_gauntlet` 9,394; `22_head` 3,510; `22_shoes` 7,564; `22_shoewhite` 1,836; `22_legwhite` 398; `22_spider` 4,544 | 115,266 |
| Web-shooters, lens, eyes | `24_webshooter` 7,799; `24_lens` 1,128; `24_eyeshutter` 7,744; `24_eye` 324 | 16,995 |
| **"27_*env" overlay meshes** | webshooter silver 6,302; webshooter red 1,497; spider 4,544; shoe 1,836; leg 398; gauntlet 9,394; eye 324 | **24,295** |

- **[M] All seven `27_*env` meshes duplicate surfaces that another mesh already draws.** Five have vertex and triangle counts identical to a `22_*`/`24_*` mesh (`27_spiderenv` = `22_spider` 4,313 v / 4,544 t; `27_shoeenv` = `22_shoewhite` 1,180 / 1,836; `27_legenv` = `22_legwhite` 262 / 398; `27_gauntletenv` = `22_gauntlet` 6,917 / 9,394; `27_eyeenv` = `24_eye` 202 / 324). The two web-shooter layers together split the same surface as `24_webshooter`: 6,302 + 1,497 = 7,799 triangles, equal to `24_webshooter`'s 7,799. The image used by `27_spiderenv` is also referenced by `22_spider`. **[A]** They are specular/environment overlay layers from the original DCC scene (coincident, double-sided surfaces). Drawn naively they cost ~15% extra triangles and risk z-fighting. Needs a visual check before removal.
- **[M]** Two materials have no base-colour texture (`24_eye`, `22_shoewhite`): flat colours.
- **[M]** Vertex attributes: `POSITION, NORMAL, TEXCOORD_0, JOINTS_0, WEIGHTS_0`; 10 meshes also carry `TEXCOORD_1` (the materials only use a base-colour map, so this is likely removable **[A]**). No tangents, no morph targets.
- **[M]** Influence histogram per vertex: 1 → 13,134; 2 → 33,819; 3 → 21,643; **4 → 43,541; none above 4**. This fits three.js's standard skinning (`skinIndex`/`skinWeight` vec4).

### 2.3 Textures **[M]**

Ten PNGs, 10.4 MB on disk, `scene.bin` 7.9 MB. Nine are **2048 × 2048**, one (`27_eyeenv`) 512 × 512; 8-bit RGB or palette. No alpha channel used.

Estimated GPU memory if uploaded as RGBA8 with a full mip chain: **~21.3 MB per 2048² texture → ~193 MB total [M, calculated, not measured on a GPU]**; ~48 MB at 1024²; ~12 MB at 512². The city has no comparable single-asset cost, so this is the single biggest memory item the character adds.

### 2.4 Skeleton **[V/M]**

- 259 joints, max hierarchy depth 23. Categories by name: **84 main** (hips, 7 spine, neck/head/jaw, 10 "lens" face bones, legs, arms, 19 finger bones per hand, two chest bones), **150 `_adj_` corrective bones**, **25 `_end` tips**. Only **154** joints actually carry skin weights.
- Root chain: `_rootJoint` → `root_ground_05` (at the floor) → `root_hips_06` (y = 1.021) → `pelvis_07` → legs; `spine_1…7` rise to the neck at y ≈ 1.515, head at 1.646.
- Bind-pose key points (metres, character space): hips (0, 1.021, −0.052); left thigh (0.080, 0.949, −0.047); knee (0.104, 0.491, −0.070); ankle (0.125, 0.090, −0.101); toe (0.138, 0.026, 0.032); left shoulder (0.170, 1.431, −0.087); elbow (0.377, 1.278, −0.078); wrist (0.589, 1.121, 0.067).
- **Bind pose: A-pose.** Upper arms droop **36°** below horizontal (forearms 31°, bent forward), legs splay only 3° from vertical.
- **Bone local axes are inconsistent.** Examples (local axes expressed in model space): `pelvis_07` Y → (0, −1, 0.07) (flipped 180° vs `root_hips_06`); thigh Y → (0.05, −1, −0.05) (points down); upper-arm Y → (0.80, −0.59, 0.03) while its X and Z are skewed diagonally; spine bones are Y-up. No joint uses non-unit scale. The bones were exported from an FBX with Blender-style "Y along the bone" and arbitrary rolls.
  - **Consequence:** writing Euler angles to individual local bone rotations ("raise the arm by 40° about X") would need a hand-measured axis table per bone and breaks if the rig is replaced. See §3.

### 2.5 Suitability for procedural animation — conclusion

| Question | Answer |
|---|---|
| Is the skeleton complete enough? | Yes: full limbs, 7-bone spine, per-finger bones, jaw. |
| Is it convenient to pose directly? | **No**, because of inconsistent bone axes. |
| Can it be posed reliably some other way? | **Yes**, by working in **model space**: compute each bone's bind world rotation once, apply a model-space delta, and convert back to the parent's local frame (§3.2). Two-bone IK for limbs needs only joint positions, not axes. |
| Do the corrective `_adj_` bones matter? | They are children of main bones, so they follow their parent. They will not receive the dynamic corrections the original rig computed (twist distribution), so extreme forearm/shoulder twists may show candy-wrapper artefacts. **[A]** Validate visually at the extreme poses (swing reach, wall climb). |
| Facial/lens bones | Leave static. |

### 2.6 Optimisation opportunities **[R]**

| Action | Expected effect | Basis |
|---|---|---|
| Remove or merge the 7 duplicate `27_*env` layers after a visual check | −24,295 triangles (−15%), −7 draw items | [M] counts; [A] visual equivalence |
| Decimate to ≈ 50–60K triangles for LOD0, ≈ 20K for LOD1 | Cuts vertex-skinning work ~3× | [A] — quality must be inspected on the hands/head |
| Textures → 1024² (body/gloves may stay 2048²); ideally KTX2/Basis | ~193 MB → ≈ 48 MB (1024²), less with GPU compression | [M] formula; KTX2 [A] |
| Merge meshes sharing a texture into one primitive (legs/legwhite/legenv; shoes/shoewhite/shoeenv; gauntlet/gauntletenv) | ~20 → ~8 draw items | [M] texture sharing |
| Drop `TEXCOORD_1`, drop unused joints (105 of 259 carry no weights; the corrective subset can be baked away) | Smaller GLB and bone texture | [M] |
| Meshopt or Draco geometry compression into a single `.glb` | 18 MB → well under 6 MB transfer | [A] |
| Set `frustumCulled = false` on the skinned meshes | The bind-pose bounding sphere is wrong once limbs extend | [R] standard practice |

Tools such as `gltf-transform` or Blender can do this; both would be new tooling or dependencies and **were not installed or run here**.

---

## 3. Animation architecture

### 3.1 Options assessed

| Path | What it is | Pros | Cons |
|---|---|---|---|
| **A. Procedural on the PS4 rig** | Model-space deltas + two-bone IK, authored in code | No external dependency; fully parametric (speed, slope, rope direction); unblocks gameplay immediately | Stiff for run/jump quality; time-consuming to tune; corrective-bone artefacts possible |
| **B. Retarget Mixamo (or other) clips onto the PS4 rig** | `SkeletonUtils.retargetClip` or an offline Blender bake | Real motion for locomotion | The PS4 rig is A-pose with arbitrary bone axes; three.js retargeting assumes comparable rest poses **[A]** and needs a bone-name map and a T/A-pose reconciliation step; Mixamo requires an Adobe account and its current terms must be checked **[A]** |
| **C. Re-rig the mesh (e.g. Mixamo auto-rig) then use its clips** | Replace the skeleton with a standard ~65-bone one | Consistent axes, standard names, cheaper skinning (65 vs 259 bones), huge clip library | Loses the original weights, corrective bones and face-lens bones; the auto-rigger has an input polygon limit that the current mesh is at or over **[A]** (decimation is needed anyway); needs the user to run the upload |
| **D. Hand-animate in Blender** | Keyframe clips on the PS4 rig, export as glTF animations | Best quality and full control (swing, wall-run) | Highest labour, needs Blender skill; Blender availability here is unknown **[A]** |

### 3.2 Recommended architecture **[R]** — a layered hybrid with a rig abstraction

```
RigMap (semantic joint → bone)           ← the only code that knows PS4 vs Mixamo names
   │
AnimationMixer (clips, crossfade)        ← base locomotion, when clips exist (B/C/D)
   │
PoseSolver (model-space)                 ← procedural base when no clips exist; also additive layers
   │       ├─ torso lean / spine distribution (7 spine bones)
   │       ├─ head look-at
   │       ├─ arm IK: wrist → web anchor, free arm trailing
   │       ├─ leg IK: feet → ground/wall plane (foot planting)
   │       └─ secondary motion (springs for trailing legs, landing compression)
   ▼
Skeleton write (bones in topological order, local = inv(parentWorld) · delta · bindWorld)
```

Key points:

1. **Model-space deltas, not Euler angles.** After load, cache each bone's bind world quaternion and its parent. To pose bone *b* with a desired model-space orientation `Q`, write `b.quaternion = inverse(parentWorldQuat) × Q`, processing bones root-to-leaf. Authoring "rotate the upper arm so it points at this direction" then needs no knowledge of the bone's local axes. Limb IK takes joint positions and a pole direction.
2. **RigMap isolates the skeleton.** Semantic names (`hips`, `spineChain[]`, `head`, `armL.upper/lower/hand`, `legL.upper/lower/foot`, `fingers…`) map to bone names. The solver and clip layer never reference `leg_left_thigh_08`. Replacing the rig later (path C) changes only the map and bind cache.
3. **A visual child group** under `entity.mesh` carries pitch/roll/wall-plane orientation. `controllers.js:1102–1106` writes `mesh.position` and `mesh.rotation.y` for every entity every frame, so the entity's own mesh can only carry yaw; extra orientation must live on a child.
4. **The solver runs in the frame loop after the physics step** (not per physics substep), and only updates bones when the entity is visible.
5. **Frustum culling is disabled** on the skinned meshes (§2.6).
6. **Procedural now, clips later:** milestones M1–M3 use the procedural base so gameplay is not blocked; an M0 spike decides between B, C and D for the final pass. The `PoseSolver` layers (IK, lean, landing) are needed in every path.

### 3.3 Per-animation recommendation

| Animation | Method | Driven by | Procedural-only feasibility | Needs authored data? |
|---|---|---|---|---|
| **Idle** | Base clip loop (or procedural breath: ±0.01 rad spine delta, slow weight shift) + head look-at | time, camera target | Good | Optional |
| **Walk** | Speed-parametrised locomotion blend; foot IK to ground samples | horizontal speed | Acceptable (IK gait with planted feet, as `PersonRig` does for the pedestrian — `pedestrians.js:31–33, 1287+`) | Clips improve it a lot |
| **Run / sprint** | Blend space at ~1.5 / 4 / 8 / 14 m/s, stride-length matching, torso lean into acceleration, foot IK | speed, acceleration, turn rate | Acceptable but stiff | **Yes for quality** |
| **Jump** | Three beats: anticipation (≈ 0.08 s crouch), launch pose, ascent pose | `vy`, time since takeoff | Good (static poses + springs) | No |
| **Fall** | Blend between "arms-out fall" and "dive" by `vy` and horizontal speed; additive limb noise | `vy`, speed | Good | No |
| **Landing** | Additive crouch layer; weight from impact velocity; spring-damper recovery (0.1–0.35 s); optional roll for high impact | impact speed | Good | Roll clip optional |
| **Wall run** | Base side-run loop (authored) or procedural alternating-leg cycle; hands and feet IK to the wall plane; visual group rotated so character-up = wall normal | tangent speed, wall normal | Fair | Loop strongly preferred |
| **Wall climb** | Hand-over-hand loop; playback direction/rate from climb velocity; IK to plane | climb velocity | Poor without a loop | **Yes** |
| **Web swing** | A pose, not a cycle: body hangs along the rope direction; reaching arm IK to the anchor; trailing leg springs; pose blend between "back-swing tuck" and "forward-swing extension" by swing phase; release extension | rope vector, swing phase, speed | **Good** — the signature pose is a handful of procedural poses | 2–3 reference poses help |
| **Web zip** | Superhero-style stretch: arm IK to target, body aligned to velocity, legs trailing; arrival blends into vault/cling | velocity direction, distance remaining | Good | No |
| **Web-shooter hand** | Per-finger curl presets (middle/ring closed, index/pinky extended) | web-attached state | Needs a measured finger-axis table, or the model-space method | No |

### 3.4 Decision required before M4 **[R]**

Run an M0 spike on 3–5 representative clips (run, jump, fall, a climb) through paths B and C, judged on (a) visual quality at the shoulders/hips, (b) effort, (c) licensing clarity, (d) skinning cost. Do not commit to a path before this spike.

---

## 4. Movement and physics architecture

### 4.1 Principles **[R]**

1. **Spider-Man is a new entity in the existing manager, but its logic lives in new modules.** Camera, audio, traffic, map, teleport, save/restore and HUD already consume `controllerManager.getActiveEntity()`. Reusing it avoids duplicating those hooks (§1.12 lists exactly what must be touched).
2. **Additive, flag-gated edits to existing files** (a generic custom-mode hook and the coupling fixes of §1.12); no refactors of the car/person/cyclist/helicopter logic.
3. **A velocity-based, fixed-timestep kinematic controller** in pure functions where possible, so it can be unit-tested with the existing `loadModule` harness.
4. **Reuse, don't modify, the existing collision functions** — see §4.7 and §5 for what is available.
5. **No allocations in the step loop**: preallocated scratch vectors (the codebase already does this: `scene-culling.js:22–27`, `controllers.js:937`).

### 4.2 State machine

```
            ┌────────────── jump / walk off edge ──────────────┐
            ▼                                                    │
GROUNDED ─────────► AIR ◄────── release ────── SWING             │
   ▲  ▲               │  │                       ▲               │
   │  └── land ───────┘  └─ web press+anchor ───┘               │
   │                      │                                     │
   │                      ├─ zip press+target ──► ZIP ──arrive──►┤(vault→AIR / cling→WALL / perch→GROUNDED)
   │                      │
   │                      └─ wall contact + conditions ──► WALL (run / climb) ── exit ──► AIR / vault→GROUNDED
   └──── (LANDING is a short timer overlay on GROUNDED, not a separate physics state)
```

One `velocity` vector persists across all states (momentum preservation, §4.8).

### 4.3 Fixed timestep

The frame loop passes a variable `dt` capped at 50 ms (`main.js:684`). At the proposed speeds (up to ~45 m/s while swinging) a 50 ms step moves 2.25 m, enough to tunnel through thin buildings or overshoot a rope constraint. **[R]** Run the controller at a fixed **1/120 s** with an accumulator (the car already does 120 Hz substeps, `controllers.js:1178`), at most 6 steps per frame, rendering from the last state. At 45 m/s that is 0.375 m per step.

### 4.4 Parameters (starting values — all **[R]**, to be tuned by feel)

| Parameter | Start | Notes |
|---|---|---|
| Run / sprint speed | 9 / 15 m/s | The existing pedestrian maxes at 8.2 m/s. |
| Ground acceleration / deceleration | 38 / 55 m/s² | Snappy but not instant. |
| Heading turn rate | 14 rad/s toward velocity | Visual only; velocity follows input. |
| Gravity | 24 m/s² | Heavier than the pedestrian's 14.5 for a comic feel; exposed in a debug panel. |
| Jump velocity | 10 m/s (≈ 2.1 m apex) | Variable height: cut `vy` by 55% on early release. |
| Coyote time / jump buffer | 0.12 s / 0.12 s | |
| Air acceleration | 14 m/s² | Cannot exceed `max(current, 15)` m/s horizontally by input alone; extra input only steers. |
| Terminal velocity | 55 m/s | |
| Web range | 12–95 m | Min/max attach distance. |
| Swing speed soft cap | 45 m/s | Excess is bled by drag. |
| Rope pump | 14 m/s² tangential | While moving down-swing. |
| Zip speed | up to 38 m/s | Accelerate 60 m/s², brake in the last 5 m. |
| Wall-run | tangent 8–16 m/s, ~1.6 s budget | Gravity ×0.15 while attached. |
| Wall-climb | 6 m/s | |
| Body radius | 0.45 m | Existing person: 0.48. |

### 4.5 Camera-relative movement

**[V]** the existing modes are tank-style and the camera does not expose its view yaw (§1.5, §1.8).

**[R]**
- Derive the view yaw from the camera's `currentLookAt − currentPos` (public fields), passed into the controller as a function (no new import in `controllers.js`).
- Move direction = input vector rotated by that yaw; character **heading follows velocity**, not input.
- **Disable the auto-recentre for the Spider-Man entity** (`cameras.js:178`) via a small additive guard (e.g. `entity.cameraAutoCenter !== false`). With camera-relative controls, auto-recentre creates a feedback loop (turn → camera follows heading → input frame rotates).
- Latch the camera yaw once per fixed step so input direction is stable within a frame.

### 4.6 Core pseudocode

**Fixed-step driver**

```js
update(frameDt):
  acc = min(acc + frameDt, 6 * STEP)              // STEP = 1/120
  while acc >= STEP:
    sampleInput()                                  // held keys; edge flags (jumpPressed...) consumed once
    stepState(STEP)
    acc -= STEP
  syncEntity()                                     // entity.position/heading/speed for camera, audio, traffic, map
  solvePose(frameDt)                               // animation after physics
```

**Ground step**

```js
groundStep(h):
  wish   = viewRelative(input.move)                // |wish| <= 1, XZ
  target = wish * (input.sprint ? V_SPRINT : V_RUN)
  rate   = dot(target, vel.xz) >= 0 ? ACCEL : BRAKE        // braking when reversing / no input
  vel.xz = moveToward(vel.xz, target, rate * h)             // vector approach: carries momentum through turns
  vel.y  = 0
  pos   += vel * h
  resolveHorizontal(pos)                                    // existing resolveHorizontalCollision, see 4.7
  floorY = queryFloor(pos.x, pos.z, pos.y, STEP_UP)         // see 5.5
  if jumpBuffered && (coyote > 0):  vel.y = JUMP_V; state = AIR; return
  if floorY < pos.y - STEP_DOWN:    state = AIR; coyote = COYOTE; return   // walked off an edge
  pos.y = floorY
  if |vel.xz| > 0.5: heading = turnToward(heading, atan2(vel.x, vel.z), TURN * h)
```

**Air step**

```js
airStep(h):
  vel.y = max(vel.y - G * h, -V_TERMINAL)
  steerAir(vel, viewRelative(input.move), AIR_ACCEL, h)     // may rotate velocity freely, may add speed only below AIR_MAX
  prev = pos.y;  pos += vel * h
  resolveHorizontal(pos)
  floorY = queryFloor(pos.x, pos.z, prev, 0.0)              // highest support at or below where the feet were
  if vel.y <= 0 && pos.y <= floorY:                          // crossed a surface downward this step
     impact = -vel.y;  pos.y = floorY;  vel.y = 0
     vel.xz *= impact > 20 ? 0.6 : 0.9                       // hard landings scrub speed; momentum otherwise kept
     landTimer = landDuration(impact); state = GROUNDED
```

**Swing step (rope as an inequality constraint)**

```js
swingStep(h):
  p = pos + CHEST;  a = web.anchor;  L = web.length
  vel.y -= G * h
  r = p - a;  d = |r|;  rhat = r / d
  if d >= L * 0.995 && rhat.y < 0:                            // taut and below the anchor: apply player forces
     tangent = normalize(vel - rhat * dot(vel, rhat))
     vel += tangent * (PUMP * input.forward) * h              // pump along the arc
     vel += lateralDir(rhat, viewRight) * (STEER * input.strafe) * h
  vel *= 1 - DRAG * h                                          // tiny; extra bleed above SPEED_SOFT_CAP
  p += vel * h
  d = |p - a|
  if d > L:                                                    // rope is taut: project back to the sphere
    rhat = (p - a) / d
    p = a + rhat * L
    vn = dot(vel, rhat)
    if vn > 0: vel -= rhat * vn                                // remove only the outward component; tangential energy preserved
  pos = p - CHEST
  resolveHorizontal(pos)
  if contact with normal n and -dot(vel, n) > WALL_SPEED:  -> WALL (cling/run) else vel = reflect_partial(vel, n)
  if !input.webHeld:                                           // release
     vel += releaseBoost(vel, rhat);  state = AIR;  clearWeb()
  if floor contact below: state = GROUNDED or AIR depending on |vel.y|
```

Rope may go slack (`d < L`), at which point the body is in free flight, which is physically correct and gives natural "catch" at the end of the slack. Projection by positional correction with 120 Hz steps is stable for these speeds; verification is by an energy-drift unit test (§ roadmap M2).

**Web zip**

```js
zipStep(h):
  to = target - (pos + CHEST);  dist = |to|;  dir = to / dist
  speed = min(V_ZIP, speed + A_ZIP * h)
  if dist < BRAKE_DIST: speed = max(V_ZIP_MIN, dist * K_BRAKE)   // smooth arrival
  vel = dir * speed;  pos += vel * h
  resolveHorizontal(pos);  if blocked against vel: abort -> AIR
  if dist < 0.8: arrive(target.kind)                              // roof edge -> vault; wall -> cling; perch -> GROUNDED
```

**Wall attach / run / climb**

```js
// entry (checked in AIR and GROUNDED, and while swinging)
n = wallNormalNear(pos, radius + PROBE)              // see 4.7; null when no wall within ~0.4 m
if n && |n.y| < 0.2 && ((horizSpeed >= 6 && -dot(velXZ, n) > 3) || input.towardWall):  state = WALL

wallStep(h):
  t   = normalize(cross(UP, n)); t = (dot(vel, t) >= 0 ? t : -t)
  vt  = clamp(dot(vel, t), WALL_MIN, WALL_MAX)
  vu  = approach(vel.y, input.climb ? CLIMB_V : WALL_UP, 20 * h) - G * 0.15 * h
  vel = t * vt + UP * vu - n * STICK                   // small push keeps contact
  pos += vel * h;  resolveHorizontal(pos)
  budget -= h
  top = queryFloor(pos + (-n) * 0.6, pos.y)
  if top within [pos.y - 0.5, pos.y + 1.2]:  vault onto roof
  if budget <= 0 || lostContact(0.15 s):  state = AIR
  if jumpPressed: vel = n * KICK + UP * JUMP_V + viewRelative(input.move) * 3;  state = AIR
```

### 4.7 Reusing the existing collision without changing it

Facts **[V]** and how to use them:

| Need | Existing capability | How to reuse |
|---|---|---|
| Push out of buildings | `controllerManager.resolveHorizontalCollision(pos, radius, null, entity)` | Call per fixed step. It mutates `pos`, honours the `y` range, and uses `collisionBody(this.activeMode, …)`; a new mode string behaves as a non-car circle (top 1.9). |
| Wall normal | Not returned | **Zero-edit probe:** copy `pos` to a scratch vector, call `resolveHorizontalCollision(scratch, radius + PROBE)`, take `scratch − pos` as `normal × depth`. Subtract shore clamping (compare against `getIslandBoundsAtZ`). A later, clean API is preferable (§5.7). |
| Candidate colliders | `nearColliders(x, z, r)` | Beware the shared array: consume before any other call. |
| Polygon tests | `polygonContains`, `polygonBoxOverlaps`, `polygonContact`, `polygonSegmentFraction` exported from `building-collision.js:214` | Import directly into new modules; the file has no dependencies. |
| Sidewalk/park/lawn ground | `getGroundHeight(x, z, 'person')` | Use `'person'` so sidewalks (0.22) apply. |
| Roof height | `collider.maxY` where `polygon` contains the point | New `queryFloor` (§5.5). |

**Shoreline constraint:** `resolveHorizontalCollision` clamps to the island ± 8 m for every non-helicopter mode (922–933). Swinging over the East/Hudson rivers or onto bridges therefore needs either a deliberate decision to keep the player on the island (simplest, and probably desirable for a portfolio that lives in Manhattan) or an additive `ignoreShore` flag.

### 4.8 Momentum preservation **[R]**

- A single `vel` vector persists across every state transition. Only specific events scale it: ground friction (GROUNDED only), hard landing scrub, wall collision, rope projection (removes the outward radial component only), and the soft speed cap.
- Release boost: `vel += normalize(vel) * 0.08 * |vel| + UP * (releaseUpward ? 3 : 0)` (tunable); releasing near the arc's apex preserves almost all speed.
- Landing from a swing keeps ~90% horizontal speed so running continues.

### 4.9 Regression strategy for the existing modes **[R]**

1. **Flag-gated.** Register the Spider-Man entity only when enabled (`?spider=1` during development). With the flag off, behaviour must be byte-for-byte the same path as today.
2. **Characterization tests first** (roadmap M0): freeze today's behaviour for `findTeleportPosition`, `update` mode dispatch, `touch-controls` mode handling, and the camera follow math before touching them.
3. **Minimal edits, each additive and individually reversible:** a generic custom-mode dispatch in `controllers.js:update` (e.g. `this.modeUpdaters[this.activeMode]?.(dt, elapsed)`), the `body[e.type]` guard (403), the touch whitelist (97), the traffic hitbox mapping (1906–1907), the audio player-loop guard (175–190), the camera auto-recentre guard (178). **New imports are avoided in these files** — registration happens from `main.js` — so the existing test stubs keep working.
4. **No shared constants edited.** Spider-Man gets its own parameter object.

---

## 5. Web attachment and building geometry

### 5.1 Can the existing data support realistic web attachment?

| Requirement | Supported today? | Evidence |
|---|---|---|
| Ray vs building walls | **Data yes, query no.** Every building is an extruded polygon with exact planar walls | 37,353 polygons, flat roofs **[M]**; no ray API **[V]** |
| Facade detection (which wall, its normal) | Derivable from the ring edges | polygon vertices **[V]**; winding must be tested with `polygonContains` (outer rings are not guaranteed a fixed winding — `building-footprints.js:40` normalises them locally) |
| Rooftop anchor detection | Roof edge points and roof plane derivable | one height per building **[M]** |
| Realistic roof silhouettes (parapets, bulkheads, water towers, antennas) | **No.** Details are decoration only | `buildings.js:493+`, no colliders; landmark spires have no collider |
| Landmarks | **Coarse.** One AABB each, with `maxY` below the spire | `landmarks.js:303–309, 1026–1032` |
| Bridges, towers, cables | **No** usable data | `boroughs.js:2247, 2836` AABB columns only |
| Trees, street furniture, awnings, scaffolds | **No** colliders | **[A]** (trees not exhaustively audited) |
| Occlusion tests (is the line to the anchor clear?) | **Only against the same collider set** | — |
| Anchor candidates near typical swing heights | Plentiful in Midtown/FiDi; sparse over Central Park, waterfront, Chelsea Piers, low-rise areas | height quantiles **[M]** |

**Conclusion:** the footprint data is *sufficient for a convincing first version* (buildings are the only large things you swing between) but **not sufficient** for realism at roof detail, landmarks, bridges or park areas, and it provides **no query layer at all**. Both a query layer and a few data additions are required.

### 5.2 Missing systems and data

1. **A spatial ray/segment query** against building prisms (walls and roofs) — new.
2. **A collider-independent anchor candidate set** — new, precomputed from footprints.
3. **A vertical floor query** (roof landing, §5.5) — new.
4. **Wall contact data** (normal, depth) as a first-class query — currently private.
5. **Landmark refinement:** per-landmark boxes for setbacks and a crown/spire proxy (e.g. extra AABB entries) so the Empire State, Chrysler, One WTC, etc. can be swung from convincingly.
6. **Optional anchor "furniture":** hand-authored anchor points for places with no tall buildings (bridges, Central Park, piers) — e.g. a small JSON list of lamp/pylon positions.
7. **Debug visualisation** (draw candidates, rays, hits) — essential to tune this.

### 5.3 Proposed spatial-query architecture **[R]**

A **two-tier design**: cheap candidate selection, then exact validation.

**Tier 1 — Anchor candidate index (built once at load, ~tens of ms).**
- For each building above a minimum height, sample points every ~12 m along the roof perimeter (plus every corner), storing `x, y(=roof), z, nx, nz`. Wall faces are the sides of the same edges.
- **[M]** Counts from the real data: buildings ≥ 15 m → 27,690 buildings, 205,816 points (~4.1 MB as 5 float32); ≥ 20 m → 14,104 / 131,480 (~2.6 MB); **≥ 30 m → 6,617 / 75,260 (~1.5 MB)**. Recommended starting threshold ≥ 20 m.
- Store in a flat typed array plus a uniform 2D grid (32–48 m cells), reusing the same `cell → indices` pattern as `nearColliders`.
- Query: gather cells inside a forward **cone/arc** (range 12–95 m, elevation 20°–80° relative to the player's chest), score, sort a bounded shortlist.

**Tier 2 — Exact validation by ray/segment test.**
- 3D DDA over a 32 m XZ grid of building indices (can be the same grid, storing building indices). For each building whose AABB the ray enters: wall hit = segment/edge intersection in XZ with the hit height tested against `[0.22, roof]`; roof hit = crossing of `y = roof` followed by `polygonContains` at that point (this respects courtyard holes).
- A candidate is *visible* if the first hit along the segment from the hand to the candidate lies within ~0.6 m of the candidate.
- Landmark/bridge AABBs join as slab tests.

**Measured feasibility [M, Node v24 on this machine, crude test]:** 20,000 random 80 m rays in Midtown took **~1.9 µs per ray**, testing on average **6.0 buildings per ray**; 32 m cells hold a median of 2 buildings (p99 11, max 18). This test only did wall/edge intersection (no roof test, no normals, no point-in-polygon) with crude stepping, so it is a *lower bound on the work* and **not** a browser benchmark. The conclusion supported is only that the approach is nowhere near a bottleneck on the data; the real cost must be benchmarked in the browser (roadmap M2).

**Why not a mesh BVH over rendered geometry?** The rendered buildings are merged 1 km chunks with shader-generated windows; the collision polygons are already the exact walls and roofs. A triangle BVH adds memory and an extra dependency for no gain. **Why not Three.js `Raycaster`?** It would test merged chunk meshes (thousands of triangles each) and is far slower; keep it for hover/UI only.

### 5.4 Anchor validity rules **[R]**

An anchor candidate `c` for player chest position `p` and aim direction `d` is valid if:
1. `12 ≤ |c − p| ≤ 95` m (attachment distance limits).
2. `c.y ≥ p.y + 8` m (never anchor below you; below ~8 m produces ground-scraping swings), and `c.y ≥ 12` m absolute above ground.
3. Elevation of `c − p` between 20° and 80°.
4. Direction within ±70° of the blended aim (camera forward projected, velocity direction) — "ahead of me".
5. Segment `p → c` unoccluded (Tier 2).
6. Not the building the player is touching unless within the wall-cling rules.
7. Hysteresis: once a good anchor is chosen, keep it for ≥ 0.2 s and require a clear score margin to switch (prevents flicker in the reticle).

Score (lower is better), e.g.: `w1·angleToAim + w2·|dist − 45| + w3·max(0, 18 − (c.y − p.y)) + w4·behindPenalty`. Weights tuned in the debug panel.

If no candidate qualifies, **fallback cone raycasts** (e.g. 12 rays) find walls/roof tops so the player can still attach to something.

### 5.5 Roof landing — vertical floor query **[R]**

```js
queryFloor(x, z, feetY, stepUp):
  best = getGroundHeight(x, z, 'person')                       // sidewalk / park / lawn / street
  for c of nearColliders(x, z, R):                              // consume immediately (shared array)
    top = c.maxY
    if top <= feetY + stepUp && top > best && insideCollider(c, x, z): best = top
  return best

insideCollider(c, x, z):  c.polygon ? polygonContains(c.polygon, x, z)
                        : c.obb     ? pointInOBB(c.obb, x, z)
                        :             (x >= c.minX && x <= c.maxX && z >= c.minZ && z <= c.maxZ)
```

**Compatible with the existing horizontal resolver:** `buildingContact` skips a collider when `y + body.bottom >= c.maxY` (`controllers.js:86`). Standing exactly at `y = c.maxY` (equal) is therefore not blocked. Because the collider's `maxY` equals the visible roof height (`building-footprints.js:31`) there is no visual gap. Roof-mounted details have no colliders, so the player walks through water towers/HVAC (acceptable; can be hidden from the landing zone if it looks bad).

### 5.6 Anchor reticle and feedback **[R]**

Show a reticle (DOM element, projected each frame) on the best valid anchor *before* the player presses the web button, so the swing is predictable; cap the query rate at ~15–20 Hz and run it only while airborne or when the web button is held.

### 5.7 Cleaner collision API (optional, later) **[R]**

An additive module `spider-world-query.js` exposing `queryFloor`, `queryWall(pos, radius)`, `rayFirstHit(a, b)` and `anchorCandidates(...)` built on `colliders` (passed in from `main.js`) and `building-collision.js`. It keeps `controllers.js` untouched. If later desired, `buildingContact` can be exported so the wall probe no longer needs the scratch-position trick.

---

## 6. Portfolio integration architecture

### 6.1 Principles **[R]**

1. **Content is data** (JSON + media files) and contains no gameplay or coordinates.
2. **World placement is a separate layer** (`world-layout.json`), generated by a tool and hand-overridable.
3. **Gameplay emits generic events** (`enter`, `focus`, `interact`, `collect`); **UI listens**. Neither imports the other.
4. **Everything user-facing is also available without WebGL** (an HTML portfolio view generated from the same JSON) for accessibility, search engines and slow devices.

### 6.2 Files and ownership

```
content/
  portfolio.json        profile, skills, experience, projects, collectibles, objectives (human-edited)
  world-layout.json     slotId -> world transform/building (tool-generated + hand overrides)
  media/                screenshots, photo, CV PDF, project covers
js/portfolio-*.js       loader, validator, layout, triggers, billboards, progress
js/ui-*.js              DOM panels (project, profile, CV, toast, reticle)
```

### 6.3 Data schema (`portfolio.json`) **[R]**

```jsonc
{
  "schemaVersion": 1,
  "profile": {
    "name": "…", "headline": "…", "location": "…",
    "bio": ["paragraph", "paragraph"],
    "photo": { "src": "media/me.jpg", "alt": "…" },
    "links": [{ "label": "GitHub", "url": "https://…", "kind": "github" }],
    "cv": { "file": "media/cv.pdf", "label": "Download CV", "updated": "2026-10" },
    "contact": { "email": "…", "note": "…" }
  },
  "skills": [
    { "group": "Graphics", "items": [{ "name": "WebGPU", "level": 4, "years": 2 }] }
  ],
  "experience": [
    { "id": "exp-1", "org": "…", "role": "…", "start": "2022-03", "end": null,
      "summary": "…", "highlights": ["…"], "tech": ["…"] }
  ],
  "projects": [
    {
      "id": "proj-realtime-city",
      "title": "…", "tagline": "…", "year": 2026, "role": "…", "status": "live",
      "description": "markdown-lite string",
      "highlights": ["…"],
      "tech": ["three.js", "WebGPU"],
      "tags": ["graphics", "web"],
      "media": {
        "cover": "media/p1/cover.jpg",
        "screenshots": [{ "src": "media/p1/1.jpg", "alt": "…", "caption": "…" }],
        "video": null
      },
      "links": { "live": "https://…", "repo": "https://github.com/…", "writeup": null },
      "billboard": { "slot": "slot-times-sq-01", "theme": "neon", "layout": "cover+title", "priority": 1 },
      "interaction": { "radius": 28, "prompt": "View project" }
    }
  ],
  "collectibles": [
    { "id": "web-1", "kind": "token", "slot": "slot-park-03", "group": "skills", "reveals": "skill:webgpu" }
  ],
  "objectives": [
    { "id": "visit-all", "type": "visitAll", "of": "projects", "title": "See all projects" },
    { "id": "gather", "type": "collect", "group": "skills", "count": 8, "title": "Collect 8 web caches" }
  ]
}
```

`world-layout.json` maps slot IDs to world positions:

```jsonc
{ "schemaVersion": 1,
  "slots": { "slot-times-sq-01": { "x": 0, "y": 0, "z": 0, "yaw": 0, "w": 20, "h": 10, "buildingIndex": 1234, "district": "Theater District" } } }
```

Validation: a small hand-written validator (no dependency) run in a Node test and at load; errors surface in the console and fall back to skipping the entry. IDs are stable strings (used by progress persistence). Text is rendered with `textContent` only (repo convention); link `rel="noopener noreferrer"`.

### 6.4 World ↔ UI interaction

```
TriggerSystem (spatial hash of trigger volumes: slot + radius + optional facing cone)
   ├─ player enters radius         → event 'near'   {id}
   ├─ best target in view/in range → event 'focus'  {id}     (shows prompt: "F – View project")
   └─ interact key pressed         → event 'interact' {id}

PortfolioUI (DOM)
   subscribes → opens panel with the item's data; calls controller.resetInput() on open (same pattern as the map: main.js:486)
              → on close, restores input
```

- **Interact key:** `E` is taken (`controllers.js:257`); use `F` or `Enter` **[R]**.
- **Panels:** project (title, tagline, tags, tech chips, screenshot carousel, links), profile (photo, bio, links), CV (preview + download), skills grid, experience timeline, progress/objectives. Keyboard-operable, focus-trapped, `aria-modal`, Esc closes (the existing map dialog is a model: `index.html:274`).
- **Billboards in the world:** canvases are rendered from the content at load (like `createBillboardCanvasTexture`, `tsl-materials.js:2290`), uploaded as `CanvasTexture`s and mapped to the existing emissive style (`createBillboardMaterial`-like `MeshBasicNodeMaterial`), 1024 × 512 per project with mipmaps. Screenshots load lazily when the player is within a distance threshold. A billboard is a plane on a building wall using the same wall-placement approach as Times Square (`buildings.js:420–450`) but driven by `world-layout.json`.
- **Collectibles:** instanced meshes created *before* the init-time instanced-storage swap (`main.js:192`), pooled; collection tested against the player's chest position via the trigger hash.
- **Progress:** `localStorage['spidey-portfolio-progress']`, versioned, wrapped in try/catch (as `main.js:121–141` does).
- **Map/HUD:** show project markers on the minimap/full map and a small objective tracker.

### 6.5 Layout generation **[R]**

A Node tool (`tools/`) chooses slots using the same decoded building data: tall facades facing streets, spaced across districts, avoiding landmark reserves, then writes `world-layout.json`. Hand overrides win. A debug overlay (`?layout=1`) draws slots.

---

## 7. Performance and compatibility

All numbers below that are not labelled **[M]** are targets or estimates to be **confirmed by benchmark**. No performance improvement is claimed anywhere in this review.

### 7.1 WebGPU and compatibility

- **[V]** The renderer is `WebGPURenderer`. The code checks `renderer.backend.isWebGPUBackend` (`main.js:192`) and comments on WebGL2 behaviour, so the author anticipated three.js's WebGL2 fallback backend. **[A]** The fallback has not been tested here; storage buffers (pedestrian poses, instanced storage), SSR and clustered lighting may behave differently or not at all on it.
- **[V]** There is no `navigator.gpu` check and no unsupported-browser message anywhere in `index.html` or `js/` (grep for `navigator.gpu`, "not supported", "unsupported": no matches). If WebGPU and the fallback both fail, the user presumably sees the loading screen indefinitely **[A]**.
- **[R]** Treat **desktop Chromium with WebGPU** as the supported baseline. Add an explicit capability check with a friendly message **and** the HTML fallback portfolio (§6.1.4).
- **Mobile: [A] low feasibility for the full city as-is** (pixel ratio forced to 1.0 already helps; but 621 shader batches, 2-cascade shadows, SSR, MSAA, heavy instancing, 37K buildings). The project has touch and gamepad support (`touch-controls.js`, `gamepad-controls.js`), so mobile was considered by the original author. Decide at M6 whether to ship a "lite" tier (SSR off, shadow cascade 1, reduced draw distance, simpler character) or a portfolio-only mobile view.

### 7.2 Costs the character adds

| Item | Estimate | Basis |
|---|---|---|
| Triangles in the view pass | 156,556 (unoptimised) | [M] |
| Triangles incl. 2 shadow cascades if the character casts | ≈ 3× → 470K | [M] arithmetic; whether three re-skins per pass is **[A]** |
| Draw items | 20 per pass → up to 60 per frame with shadows | [M] mesh count |
| Bone matrices | 259 per skeleton (bone texture) | [M] |
| Texture memory | ~193 MB uncompressed (RGBA8 + mips) | [M] formula |
| Per-frame JS | Pose solver: ~25 bones driven + 4 IK chains | [A] must be measured |
| Allocation | Must be zero per frame | [R] |

### 7.3 Proposed budgets **[R]** (to be validated against a measured baseline)

Because no baseline exists, budgets are stated as **deltas versus the unmodified city measured on the same machine**, plus absolute targets for confirmation.

| Metric | Budget |
|---|---|
| Frame time on tier T2 (mid discrete GPU ~GTX 1660 / RTX 3050 class, 1080p) | p95 ≤ 20 ms (≥ 50 fps), p50 ≤ 16.7 ms — confirm the baseline first |
| Character cost | ≤ +1.0 ms GPU, ≤ +1.5 ms JS (physics + anchors + pose) per frame, vs baseline |
| Character draw items per pass | ≤ 8 (LOD0), ≤ 3 (LOD1) |
| Character triangles | LOD0 ≤ 60K, LOD1 ≤ 20K |
| Character texture memory | ≤ 64 MB |
| Character download | ≤ 6 MB |
| Anchor query | ≤ 0.25 ms p99 per query; ≤ 0.5 ms on frames that run one |
| Added load time | ≤ 1.5 s on top of current startup |
| JS heap growth | 0 over a 10-minute scripted swing run (no per-frame allocation) |
| Draw calls added by portfolio billboards | ≤ 12 (billboards share a few merged meshes) |
| Shadow cost | Character shadow: cascade 0 only unless benchmarks justify more |

### 7.4 Testing strategy **[R]**

1. **Benchmark harness first (M0):** an opt-in `?perf=1` overlay recording per-frame timings (p50/p95/p99 over a 10 s window), JS time per phase (`performance.now()` around controller/camera/traffic/streaming/render), `renderer.info.render` (calls, triangles) and, if available, GPU timestamps **[A]** (verify support in the pinned three.js commit and adapter).
2. **Scripted scenarios** (camera path/bot, same on every run): (S1) street-level idle on 5th Ave; (S2) Times Square billboards; (S3) a 60-second swing line across Midtown; (S4) night; (S5) helicopter at 380 m (draw-distance worst case).
3. **Hardware tiers:** T1 integrated (Intel Iris Xe / Apple M-series), T2 mid discrete, T3 high-end; T4 phone exploratory. Record the browser version and WebGPU adapter info.
4. **Method:** ≥ 3 runs per scenario, report median and p95; compare before/after on the same machine and browser.
5. **Unit-test the pure logic** (physics, anchors, schema) with the repo's harness; no GPU needed.
6. **Soak test:** 10-minute scripted run watching heap and frame-time drift.
7. **Regression guard:** the existing 223 passing tests must stay green at every milestone; add characterization tests for each file touched.

---

## 8. Proposed project structure

Minimal and consistent with the repo (flat `js/` with prefix families, because `boot.test.cjs` requires flat `./js/<name>.js` preload paths and preloaded-only imports, §1.13). Avoids rewriting anything that already works. All new files are additive.

```
docs/spider-man-portfolio/        (this folder)
content/                          portfolio.json, world-layout.json, media/
assets/spiderman/                 spiderman.glb (optimised), SOURCE.md, LICENSE-CC-BY.txt
marvel_spider_man_ps4_for_blender/  (original, untouched)
tools/
  optimize-spiderman.*            model pipeline (later; may need a dev tool)
  build-world-layout.mjs          slot generator from building data
js/
  # character control (no THREE imports where avoidable; testable)
  spider-config.js                parameters (single source of tunables)
  spider-input.js                 extra actions: web, sprint, zip, interact (own listeners)
  spider-controller.js            state machine, fixed-step driver, entity adapter
  spider-physics.js               pure math: moveToward, rope projection, wall tangent, release
  # world queries & web mechanics
  spider-world.js                 queryFloor, queryWall, rayFirstHit
  spider-anchors.js               candidate index, cone query, scoring, hysteresis
  spider-web.js                   web strand rendering and web state
  # camera
  spider-camera.js                follow rig, speed FOV, collision, view-yaw provider
  # animation
  spider-rig.js                   RigMap, bind cache, model-space solver, IK helpers
  spider-anim.js                  pose layers, clip mixer integration, state→pose mapping
  spider-model.js                 glTF load, optimisation hooks, material setup
  # portfolio & UI
  portfolio-data.js               load + validate
  portfolio-layout.js             slots → transforms
  portfolio-billboards.js         canvas textures, meshes
  portfolio-triggers.js           spatial hash, events
  portfolio-progress.js           persistence, objectives
  ui-portfolio.js                 DOM panels
  ui-spider-hud.js                reticle, momentum, objectives
  # integration
  spider-install.js               called from main.js: registers entity/mode, wires camera/UI
tests/
  spider-physics.test.cjs  spider-world.test.cjs  spider-anchors.test.cjs
  portfolio-data.test.cjs  portfolio-triggers.test.cjs  spider-integration.test.cjs
```

Edits to existing files (all small and additive): `main.js` (call `spider-install`), `controllers.js` (generic custom-mode dispatch + the `body[e.type]` guard), `cameras.js` (auto-recentre guard + a spider preset), `touch-controls.js` (whitelist), `gamepad-controls.js` (jump mapping), `traffic.js` (hitbox), `audio-sources.js` (type guard), `index.html` / `css/style.css` (mode button, panels, reticle), `tests/boot.test.cjs` unchanged except it will start validating the new preloads.

Alternative considered: put new modules in `js/spider/` and import them dynamically (`import()`); that avoids preload bookkeeping and keeps a flag-off build identical, but deviates from the flat convention. Either is workable; the flat prefix approach is recommended for consistency.

---

## 9. Final recommendation

**The repository is a suitable foundation, with conditions.**

Strong points: real 1:1 NYC geometry with exact building footprints, an existing collision index, mode-agnostic camera/map/audio hooks, an established pattern for billboards, a working culling/shadow strategy, a disciplined static (no-build) deployment, and a Spider-Man model that loads cleanly.

What is **not** there and must be built: any vertical collision or roof landing, any raycast or contact query, an anchor candidate system, camera-relative controls, camera collision, a glTF character pipeline (the existing person is a bespoke 15-bone system), and the animation content itself.

**Resolve these first, in this order (details in technical-risks.md):**

1. **Create a git baseline and capture a performance baseline** — nothing can be rolled back or benchmarked otherwise.
2. **Prove the character renders correctly and cheaply inside the city pipeline** (shadows, SSR MRT, post-processing, `matrixWorldAutoUpdate = false`) and optimise the model (≈193 MB of textures and 156K triangles are too heavy).
3. **Decide the animation path** with the M0 spike (procedural vs retarget vs re-rig); gameplay can proceed procedurally meanwhile.
4. **Prototype the anchor query + swing physics in isolation** (pure modules, unit tested, with a debug view) — this is the core "feel" risk and the most valuable thing to de-risk before any portfolio features.
5. **Camera behaviour at speed** (collision and the auto-recentre conflict) — a swing that cannot be watched is not a swing.

Portfolio features, collectibles and game progression should wait until a playable character and convincing web-swinging exist, which is how the roadmap is ordered.
