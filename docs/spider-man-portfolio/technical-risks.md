# Spider-Man Portfolio — Technical Risk Register

Companion to [architecture-review.md](architecture-review.md) and [implementation-roadmap.md](implementation-roadmap.md).

Labels: **[V]** verified in code/asset, **[M]** measured by a script during the review, **[A]** assumption still to validate, **[R]** recommendation. Likelihood and impact (L/M/H) are judgments, not measurements.

## Final recommendation

**`slop-newyork` is a suitable foundation, conditionally.** The city data and rendering are an excellent, genuinely 1:1 NYC base; the Spider-Man model loads and is structurally usable; the existing camera, audio, map, HUD and traffic systems can be reused through the active-entity interface with a small set of additive edits (architecture review §1.12). Nothing found suggests the project should be restarted or the engine replaced.

The conditions, in the order they should be resolved:

1. **Establish a git baseline and a performance baseline.** There are no commits (R-11); without them nothing can be rolled back or benchmarked honestly.
2. **Prove the character in the city pipeline and cut its cost** (R-04, R-05): 156K triangles, 20 draw items and ~193 MB of textures **[M]** are too heavy to add as-is, and the glTF-material → SSR/MRT/shadow path is unverified in the city scene **[A]**.
3. **Decide how Spider-Man will be animated** (R-01) with a short evidence-based spike. The rig has no clips and inconsistent bone axes **[V/M]**; procedural animation keeps gameplay unblocked but may not reach the desired quality.
4. **Prototype anchors and the swing in isolation, with a debug view** (R-02, R-03). The footprint data is sufficient for a first convincing version **[V/M]** but no ray/contact/roof-landing API exists **[V]**, and landmarks, parks, bridges and roof details are not represented.
5. **Solve the camera at speed** (R-06): there is no camera collision and the auto-recentre conflicts with camera-relative controls **[V]**.

Portfolio features (M5) are low technical risk by comparison and should wait until the character and swing pass their gates.

---

## Risk register

### R-01 — Animation sourcing and quality
- **Likelihood H / Impact H**
- **Evidence:** 0 animation clips **[V]**; 259-joint A-pose rig whose bone local axes are inconsistent (pelvis flipped, thigh Y pointing down, arms skewed) **[M]**; 150 corrective bones that will not receive their original driven corrections **[A]**; existing pedestrian rig is a separate 15-bone custom system and cannot be reused **[V]**.
- **Consequence:** stiff or distorted motion on the signature poses; time sink in Euler-angle tuning if attempted bone-by-bone.
- **Mitigation [R]:** layered architecture (rig map + model-space solver + optional clip mixer, §3.2); no per-bone Euler authoring; M0 spike comparing retarget, Mixamo re-rig and hand-authored clips; procedural base kept as a permanent fallback.
- **Resolved by:** M0 decision; G3.

### R-02 — Swing physics and feel
- **Likelihood H / Impact H**
- **Evidence:** no physics engine; existing controllers are simple kinematic scalars **[V]**; frame `dt` is variable up to 50 ms **[V]** (2.25 m per step at 45 m/s).
- **Consequence:** an unsatisfying core mechanic invalidates the concept ("convincing web-swinging" is the primary goal).
- **Mitigation [R]:** fixed 1/120 s step; rope as an inequality constraint with positional projection (§4.6); all tunables in one config with a live debug panel; deterministic replay and energy-drift tests; scripted bot; playtest gate G2 with measurable criteria.
- **Resolved by:** M2.

### R-03 — Anchor availability and quality
- **Likelihood M / Impact H**
- **Evidence:** footprints give exact walls and flat roofs for 37,353 buildings **[V/M]**, but: no setbacks, parapets or roof equipment **[V]**; landmarks have a single AABB each, 11 of them, with spires uncovered **[V]**; bridge towers are AABB columns without cables **[V]**; trees, awnings, scaffolds and rooftop detail have no colliders **[A]**; anchors are plentiful where buildings are tall (≥ 30 m: 6,617 buildings, 75,260 roof-edge points **[M]**) but p50 height is only 18 m **[M]** so low-rise areas, Central Park and waterfronts will be sparse.
- **Consequence:** dead zones where the player cannot swing; visible webs attached to nothing.
- **Mitigation [R]:** two-tier query (candidate index + exact validation, §5.3); fallback cone rays; hand-placed anchor points for parks, piers and bridges; refined landmark colliders; per-district availability report; consider limiting the main play area to dense districts.
- **Resolved by:** M2 acceptance (≥ 95% in dense districts, reports elsewhere); G2.

### R-04 — Character rendering inside the city pipeline
- **Likelihood M / Impact H**
- **Evidence:** the glTF renders correctly in a bare `WebGPURenderer` scene **[V, earlier in the session]**; the city uses MRT (`output`, `normal`, `metalRough`) feeding SSR, clustered lighting, a 2-cascade shadow map, reversed-depth, `matrixWorldAutoUpdate = false`, init-time instanced storage swap and a precompile pass **[V]**. Interaction of a converted glTF `MeshStandardMaterial` with all of these is **unverified [A]**.
- **Consequence:** black or unlit character, wrong reflections, shadow artefacts, a first-use shader compile hitch, or stale bone matrices.
- **Mitigation [R]:** load and add the model during the loading stage (before precompile and the storage swap); verify bone matrix updates (entity mesh is in `dynamicRoots`, `main.js:177–186, 714`); test under all four time-of-day presets; fall back to a hand-built `MeshStandardNodeMaterial` if needed.
- **Resolved by:** M0 pipeline spike; G1.

### R-05 — Character GPU/memory cost
- **Likelihood H / Impact M**
- **Evidence:** 112,137 vertices, 156,556 triangles, 20 draw items **[M]**; ~193 MB of textures if uploaded as RGBA8 with mips **[M, calculated]**; 259 bone matrices **[M]**; seven duplicate overlay meshes totalling 24,295 triangles **[M]**; shadow passes may re-skin per cascade **[A]**.
- **Consequence:** frame-time regression on mid-range GPUs, memory pressure on integrated GPUs, slow download.
- **Mitigation [R]:** M0 optimisation targets (≤ 60K triangles LOD0, ≤ 8 draw items, ≤ 64 MB textures, ≤ 6 MB download), LOD1, restricted shadow cascades; measure, do not assume.
- **Resolved by:** M0, M4; budgets in §7.3.

### R-06 — Camera at speed
- **Likelihood H / Impact H**
- **Evidence:** the follow camera has no collision (only a minimum height) and aims along `entity.heading` while positioned behind `heading + orbitYawOffset` **[V]**; auto-recentre pulls the orbit to 0 whenever `|speed| > 0.5` **[V]**; the camera's yaw is not exposed **[V]**.
- **Consequence:** camera inside buildings at swing speeds; disorienting feedback with camera-relative controls; motion sickness.
- **Mitigation [R]:** dedicated spider camera rig: view-yaw provider, no auto-recentre for this entity, look-ahead, speed-based FOV, spring-arm collision using the same building queries, reduced-motion option; test in canyons and at corners.
- **Resolved by:** M1 (basic), M2/M3 (swing/wall), G2.

### R-07 — Regression in the four existing modes
- **Likelihood M / Impact M**
- **Evidence:** concrete hazards verified in §1.12: `findTeleportPosition` indexes `body[e.type]` and **throws** for an unknown type (`controllers.js:403`); touch controls silently reject unknown modes (`touch-controls.js:97`); traffic gives unknown modes a **car-sized hitbox** (`traffic.js:1906–1907`); audio treats any non-person entity as an engine source (`audio-sources.js:175–190`); gamepad jump only for `'person'` (`gamepad-controls.js:165`).
- **Consequence:** crashes at teleport, phantom engine noise, invisible car-sized collisions, broken controls in old modes.
- **Mitigation [R]:** characterization tests first; additive guarded edits; flag-gated registration; each edit its own commit; manual smoke of all modes at every milestone.
- **Resolved by:** M0 tests, M1 integration.

### R-08 — Load time and first-visit experience
- **Likelihood H / Impact M–H for a portfolio**
- **Evidence:** the city compiles 621 shader batches behind the loading screen **[V]**; in the in-app browser the first frame took well over 30 s from navigation **[observation, not a benchmark]**; the building data download is 440 KB but decoding is on the main thread with top-level `await` **[V]**.
- **Consequence:** recruiters and visitors leave before seeing anything; a portfolio must show content quickly.
- **Mitigation [R]:** an HTML portfolio view generated from the same content, available immediately and as the fallback; lazy-load the character and media; measure and reduce the precompile set; progress messaging already exists (`main.js:32–50`).
- **Resolved by:** M5 (fallback page), M7 (measurement and load-time work).

### R-09 — WebGPU availability, browsers and mobile
- **Likelihood M / Impact H**
- **Evidence:** `WebGPURenderer` is required; there is no capability check or error message **[V]**; the code branches on `isWebGPUBackend`, implying a WebGL2 fallback exists **[V]** but its behaviour with storage buffers, SSR and clustered lighting is untested **[A]**; WebGPU availability in Safari/Firefox/mobile browsers must be re-checked at release **[A]**.
- **Consequence:** blank page or unusable performance for a share of visitors, especially phones.
- **Mitigation [R]:** explicit capability check and message; HTML fallback; define a lite tier or desktop-only notice (decision at M6); test matrix at M7.
- **Resolved by:** M6, M7; G4.

### R-10 — Collision robustness at speed
- **Likelihood M / Impact H**
- **Evidence:** collision is a sequential push-out against polygon colliders **[V]**; the code itself notes it "can leave a player trapped between overlapping buildings" **[V, `controllers.js:391–392`]**; the 50 ms frame cap allows 2+ m steps **[V]**; there is no vertical collision or contact data **[V]**.
- **Consequence:** tunnelling through thin buildings, getting stuck, popping out onto the wrong side.
- **Mitigation [R]:** 120 Hz fixed step (≤ 0.4 m/step at 45 m/s), stuck-recovery that relocates to the nearest clear spot (reusing `findTeleportPosition` ideas), randomised impact fuzz tests, contact normal API.
- **Resolved by:** M1 (fuzz), M3 (stuck recovery).

### R-11 — No version-control baseline and no performance baseline
- **Likelihood H (it is the current state) / Impact H**
- **Evidence:** `git log` has no commits; all files untracked **[V]**; no measurements of the unmodified game exist.
- **Consequence:** no safe rollback; regressions undetectable; performance budgets unanchored.
- **Mitigation [R]:** M0 step 1 and 3, with your approval.
- **Resolved by:** M0.

### R-12 — Test harness constraints
- **Likelihood M / Impact M**
- **Evidence:** the custom `loadModule` supports only a subset of ES-module syntax (no `export default`, default imports, dynamic import or top-level `await`) and requires an explicit stub for every import **[V, `tests/helpers/module.cjs`]**; `boot.test.cjs` demands flat `./js/<name>.js` preloads whose imports are also preloaded **[V]**; two existing tests fail only because `python3` is not on PATH **[M]**; `node --test tests/` fails on Node 24 (use globs) **[M]**.
- **Consequence:** adding an import to `controllers.js`, `cameras.js` or `touch-controls.js` breaks their existing tests; tests of new modules written in unsupported syntax cannot run.
- **Mitigation [R]:** register everything from `main.js`/`spider-install.js` rather than importing into those files; write new modules in the supported subset; keep logic in pure modules; add the new modules to the preload list.
- **Resolved by:** conventions from M0.

### R-13 — Dependency on a pinned dev-branch CDN build
- **Likelihood L–M / Impact H**
- **Evidence:** `index.html` imports three.js from `cdn.jsdelivr.net/gh/mrdoob/three.js@b3396270…` (a dev commit) and all addons from the same URL **[V]**; there is no local copy and no `package.json` **[V]**.
- **Consequence:** CDN or repository changes can break the deployed site; no offline development; new addons (Meshopt/KTX2/Draco decoders) must also be fetched from the CDN.
- **Mitigation [R]:** vendor the exact build and the needed addons at M7 (or earlier if offline work is needed); keep the import map as the single switch.
- **Resolved by:** M7.

### R-14 — Licensing and brand/IP
- **Likelihood M / Impact M–H**
- **Evidence:** the model is **CC-BY 4.0** and requires visible credit to Miqdad khan **[V]**; the model depicts a Marvel character — CC-BY covers the modeller's rights, not Marvel's trademarks or copyrights **[R: not legal advice]**; project code is MIT; NYC Open Data and OpenStreetMap (ODbL) require attribution **[V, `README.md`]**.
- **Consequence:** takedown or reputational risk for a public portfolio; licence non-compliance.
- **Mitigation [R]:** in-product credits panel; "Spider-Man-inspired fan tribute" framing and disclaimer; avoid using Marvel logos on billboards; consider a non-trademarked suit variant or character; get your own legal judgement before publishing widely.
- **Resolved by:** M6 credits; your decision before M7 release.

### R-15 — Portfolio legibility, UX and accessibility
- **Likelihood M / Impact M**
- **Evidence:** the scene applies bloom, SSR and strong time-of-day lighting **[V]**; existing billboards are 512 × 256 canvases **[V, `tsl-materials.js:2292–2294`]**; the HUD is already dense **[V]**.
- **Consequence:** unreadable billboards at night or distance; panels unusable by keyboard/screen reader; touch layout problems.
- **Mitigation [R]:** 1024 × 512 textures with mipmaps, legibility test at 30 m / 1080p, day/night emissive tuning, accessible DOM panels (focus trap, Esc, `aria-modal`), HTML fallback page.
- **Resolved by:** M5.

### R-16 — Input design and conflicts
- **Likelihood H / Impact M**
- **Evidence:** `E` is already jump/ascend and `Q/C` descend **[V]**; left mouse drag is camera orbit **[V]**; touch UI has one stick and two buttons **[V]**; the keybinding table is closed **[V]**.
- **Consequence:** clumsy swing controls; accidental conflicts with existing modes; touch devices unable to swing.
- **Mitigation [R]:** `F` for interact; a separate `spider-input.js` that adds actions (web, sprint, zip) without editing the closed table; optional pointer lock only in this mode; gamepad mapping; explicit touch scope at M6.
- **Resolved by:** M1 (keyboard), M6 (touch).

### R-17 — Skinned-mesh specifics
- **Likelihood M / Impact L–M**
- **Evidence:** bind-pose bounds do not cover extended limbs **[M]**; skeleton has 259 bones, of which only 154 carry weights **[M]**; 20 skinned meshes share one skeleton, and whether the renderer updates it once or per mesh is unknown **[A]**; the global `scene-culling` ignores skinned meshes **[V]**.
- **Mitigation [R]:** `frustumCulled = false` on the character; merge meshes; prune unused joints in the optimisation step; verify skeleton update cost in the M0 spike.
- **Resolved by:** M0.

### R-18 — Collider/visual mismatch
- **Likelihood M / Impact M**
- **Evidence:** landmark colliders are single AABBs whose `maxY` stops below spires; the Empire State collider is a full-height 68 × 50 m box whereas the visible tower narrows **[V]**; roof details (water towers, HVAC) have no colliders **[V]**; the survey has one flat roof per building **[V/M]**.
- **Consequence:** invisible walls at setbacks; webs attaching to air above a tower; walking through rooftop machinery.
- **Mitigation [R]:** refine the 11 landmark colliders (setback boxes, crown proxies) during M2; suppress or ignore small roof details in landing zones; visual debug overlays to find mismatches.
- **Resolved by:** M2.

### R-19 — Shoreline clamp
- **Likelihood H / Impact L–M**
- **Evidence:** `resolveHorizontalCollision` clamps every non-helicopter mode to the island ± 8 m **[V, `controllers.js:922–933`]**.
- **Consequence:** the player cannot swing over the rivers or onto bridges; a swing arc may snap against an invisible wall at the shore.
- **Mitigation [R]:** decide the play-area scope (stay on the island vs add an `ignoreShore` option plus bridge/pier anchors); design anchors so swings never aim across the shore unless intended.
- **Resolved by:** decision before M1; implementation per choice.

### R-20 — Scope and content readiness
- **Likelihood M / Impact M**
- **Evidence:** the brief combines a character controller, physics, animation, content system, billboards and game progression.
- **Consequence:** the portfolio itself (the real goal) is delayed or never ships.
- **Mitigation [R]:** milestone gates; the HTML fallback portfolio can ship early as insurance; content schema and placeholder content independent of gameplay; supply real content before M5.
- **Resolved by:** roadmap discipline; your content delivery.

---

## Assumptions to validate (each turns an **[A]** into a **[V]** or **[M]**)

| # | Assumption | How to validate | When |
|---|---|---|---|
| A1 | The 7 `27_*env` meshes are redundant overlays | Render with/without; compare screenshots | M0 |
| A2 | glTF `MeshStandardMaterial` converts correctly under MRT/SSR/cascade shadows | Pipeline spike in 5th Ave at 4 time presets | M0 |
| A3 | Skeleton update cost is per skeleton, not per skinned mesh | CPU profile with 20 vs 8 meshes | M0 |
| A4 | Shadow cascades re-skin the character per cascade | `renderer.info` + GPU timestamps with/without `castShadow` | M0 |
| A5 | GPU timestamp queries are available at the pinned three.js commit/adapter | Probe at startup | M0 |
| A6 | Decimation to ~60K triangles preserves hands/head quality | Visual review | M0 |
| A7 | `SkeletonUtils.retargetClip` works acceptably across A-pose vs T-pose here | Spike | M0 |
| A8 | Mixamo's current terms and its polygon limit allow this mesh | Read terms; try upload (needs your account) | M0 |
| A9 | The scratch-position wall probe is accurate enough away from the shore | Fuzz vs analytic polygon distance | M1–M3 |
| A10 | Anchor availability ≥ 95% in dense districts | Sampling run, per-district report | M2 |
| A11 | Browser anchor query ≈ well under 0.25 ms p99 | Browser benchmark (Node microbenchmark was ~1.9 µs/ray on a crude version **[M]**, not transferable) | M2 |
| A12 | Mobile can run a lite tier | Device tests | M6–M7 |
| A13 | WebGL2 fallback works for this renderer configuration | Force fallback and observe | M7 |
| A14 | Trees have no colliders | Audit `trees.js` | M2 |
| A15 | Corrective `_adj_` bones cause visible artefacts at extreme poses | Screenshot test at extremes | M4 |

## Things checked and found **not** to be risks

- **The model loads** with stock `GLTFLoader` (~0.18 s) and renders with textures in a WebGPU scene **[V]**.
- **Skinning compatibility:** at most 4 influences per vertex, standard `JOINTS_0/WEIGHTS_0`, no morph targets, no non-unit joint scales **[M]**.
- **Building data completeness and consistency:** 37,353 simple polygons, no multi-polygon buildings, no zero heights **[M]**.
- **Query cost on the data:** with 32 m cells (median 2 buildings per cell) a ray touches a handful of buildings **[M]**; not the bottleneck on paper, but still to be benchmarked in the browser.
- **Culling system interference:** `scene-culling.js` ignores skinned meshes and only visits six named roots **[V]**.
- **Matrix updates:** an entity's `mesh` is already in `dynamicRoots` so bones update automatically **[V]**.
- **Save/restore** is generic over entities and tolerant of unknown modes **[V]**.

## What this review did **not** do

- No gameplay code, source edits, asset changes, dependency installation, commits or pushes.
- No benchmarks in a browser; the only measurements are static data analysis and a crude Node microbenchmark (clearly marked).
- No visual verification of the duplicate-overlay meshes, decimation quality or corrective-bone behaviour.
- No testing of WebGL2 fallback, Safari/Firefox, or mobile devices.
- No legal advice.
