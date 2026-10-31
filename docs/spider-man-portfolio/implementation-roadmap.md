# Spider-Man Portfolio — Implementation Roadmap

Companion to [architecture-review.md](architecture-review.md) (design and evidence) and [technical-risks.md](technical-risks.md) (risk register). Section references like "§4.7" point into the architecture review. Labels **[V] [M] [A] [R]** have the same meaning as there (verified / measured / assumption / recommendation).

Nothing in this roadmap has been started. Every milestone is a proposal awaiting your approval.

## Ordering principles

1. **A playable character and convincing web-swinging come before any portfolio feature** (as requested). Portfolio content is M5, after the swing has passed its feel gate.
2. **Every milestone is shippable behind a flag** (`?spider=1` during development). With the flag off, the game must behave exactly as today.
3. **Risk first:** unknowns that can invalidate the plan (character cost inside the city pipeline, swing feel, camera at speed, animation sourcing) are attacked in M0–M2.
4. **Small, additive, reversible edits** to existing files, one concern per commit, each protected by a characterization test written *before* the edit.
5. **Pure, testable logic** in new modules (no `three` import where avoidable) so it runs under the repo's `loadModule` test harness (§1.13).

Relative sizes (S/M/L/XL) are rough **[A]** guesses of effort, not schedules.

## Gates

| Gate | After | Question | If it fails |
|---|---|---|---|
| **G1** | M0 | Does the optimised character render correctly and cheaply inside the city pipeline, and is the animation path decided? | Reduce character fidelity (LOD, fewer lights/shadows) or switch animation path before building gameplay on it. |
| **G2** | M2 | Does swinging feel good enough to build a game on, and are anchors reliably available over the target districts? | Narrow the play area to dense districts, add auto-aim/auto-attach, hand-placed anchors; do not proceed to M3 until fixed. |
| **G3** | M4 | Does the character look good enough to represent the portfolio at 3 camera distances? | Re-do the weak animations by the alternative path; ship with simpler poses. |
| **G4** | M7 | Are the performance and compatibility budgets met on T1–T3? | Ship a lite tier or the HTML fallback as primary entry. |

---

## M0 — Foundations: baseline, safety net, decisions (no gameplay)

**Size:** M

**Scope**
1. **Git baseline** (needs your approval): the repository has no commits (§0). One initial commit of the current state, then a working branch. All later "rollback" statements depend on this.
2. **Document the test command** (`node --test "tests/**/*.test.cjs" "tests/**/*.test.mjs"`; the directory form fails on Node 24). Record the 2 environmental failures (no `python3` on PATH) so they are not mistaken for regressions.
3. **Performance baseline harness** (`?perf=1`): frame-time percentiles, per-phase JS timings, `renderer.info`, optional GPU timestamps **[A]**. Scripted scenarios S1–S5 (§7.4). Record the baseline of the *unmodified* game on the target machine(s) in a `baseline.md`.
4. **Characterization tests** for every existing touchpoint listed in §1.12: `findTeleportPosition` per mode, `ThirdPersonControllerManager.update` mode dispatch, touch-controls mode handling and labels, camera follow framing per entity type, traffic player hitbox, audio player-source filtering.
5. **Model pipeline:** decide on the 7 duplicate `27_*env` layers (visual comparison), decimate to LOD0 ≈ 50–60K / LOD1 ≈ 20K, textures to 1024² (body/gloves optionally 2048²) or KTX2, merge by shared texture to ≈ 8 draw items, strip unused attributes/joints, export a single compressed `.glb`. Keep the original untouched. Add `SOURCE.md` and the CC-BY credit text.
6. **Animation-path spike** (§3.4): evaluate 3–5 clips (run, jump, fall, a climb) through retarget (B), Mixamo re-rig (C) and hand-authoring (D); score by quality, effort, licensing, skinning cost.
7. **Pipeline spike:** under the flag, load the GLB during the loading stage, place it standing in 5th Ave, and verify shadows, SSR, post-processing, `matrixWorldAutoUpdate = false`, shader precompile, and time-of-day lighting. Measure cost against the baseline.

**Files expected to change**
- New: `tools/optimize-spiderman.*` (may require a dev tool: `gltf-transform` or Blender — **not installed; needs your decision**), `assets/spiderman/spiderman.glb`, `assets/spiderman/SOURCE.md`, `js/perf-overlay.js`, `tests/*-characterization.test.cjs`, `docs/spider-man-portfolio/baseline.md`.
- Modified (small): `main.js` (flag read, perf overlay hook, GLB load in the loading stage), `index.html` (modulepreload line for each new module).

**Dependencies:** your approval of the git baseline and of any tool installation; access to a T2-class machine for baseline numbers; if path C is evaluated, a Mixamo account.

**Acceptance criteria**
- Baseline numbers recorded for S1–S5, ≥ 3 runs each, with browser/GPU details.
- All previously passing tests still pass (223/225 with the 2 documented environmental failures).
- Optimised GLB: ≤ 6 MB transfer; ≤ 60K triangles (LOD0); ≤ 8 draw items; ≤ 64 MB texture memory (computed); side-by-side screenshots at 3 angles judged equivalent to the original.
- Character stands in 5th Ave under all four time-of-day presets with correct lighting and shadow, zero console errors, and the added frame cost measured (target ≤ +1.0 ms GPU / +0.3 ms JS for a static pose).
- A written decision for the animation path with the evidence.

**Automated tests:** the characterization tests above; a script test that the GLB has ≤ N draw items, ≤ M triangles, ≤ K MB, and all joints named in the planned `RigMap`.

**Manual playtesting:** inspect the character in the city at 3 times of day and 3 camera distances; check the hands, head and shoulders for skinning and z-fighting.

**Risks and rollback:** all changes are additive and flag-gated. Revert the M0 commits. Risk: the glTF material conversion misbehaves with the SSR MRT → fall back to a hand-built node material for the character (see R-04).

---

## M1 — Playable character: ground, air, roofs, camera

**Size:** XL

**Scope**
- Register a **Spider-Man entity** behind the flag through a generic custom-mode hook in `ThirdPersonControllerManager` (§4.9). The mode appears in the mode switch, HUD hints, touch/gamepad handling, teleport and save/restore.
- **Coupling fixes** from §1.12 (teleport body table guard, traffic hitbox mapping, audio player-source guard, touch whitelist, gamepad jump mapping).
- **Fixed 120 Hz controller** with camera-relative movement, acceleration/deceleration, sprint, jump with coyote time and buffering, gravity, air control, terminal velocity.
- **Vertical collision:** `queryFloor` (street, sidewalk, parks, **rooftops**), landing, walking off edges, the shore decision (§4.7: stay on the island vs. an `ignoreShore` flag).
- **Spider camera rig:** view-yaw provider, auto-recentre disabled for this entity, look-ahead, speed-based FOV, **camera collision** against the building set, smoothing.
- **Procedural base pose** through the `RigMap` + model-space solver (§3.2): idle breath, run cycle with foot IK, jump/fall/landing poses. No external clips yet.
- **Debug tools:** a tunable parameter panel and a "teleport to roof N" command (needed because web-swinging does not exist yet).
- Spider-Man HUD mode button and minimal controls hint.

**Files expected to change**
- New: `spider-config.js`, `spider-input.js`, `spider-controller.js`, `spider-physics.js`, `spider-world.js`, `spider-camera.js`, `spider-rig.js`, `spider-anim.js`, `spider-model.js`, `spider-install.js`, plus their tests.
- Modified (additive): `main.js`, `controllers.js` (mode dispatch hook, `body[type]` guard), `cameras.js` (auto-recentre guard, spider follow hook), `touch-controls.js`, `gamepad-controls.js`, `traffic.js`, `audio-sources.js`, `index.html`, `css/style.css`.

**Dependencies:** M0 (model, baseline, characterization tests, GLB pipeline).

**Acceptance criteria**
- Spider-Man runs, sprints, jumps and lands on street, sidewalk, Central Park (1.24 m) and Bryant Park lawn without clipping or floating (±1 cm of `getGroundHeight`).
- Stands on, walks across and falls off the roofs of ≥ 20 chosen buildings (various heights, polygons with courtyards, plus Empire State, Chrysler and One WTC); lands correctly on a lower neighbouring roof.
- Never ends inside a building in 1,000 randomised teleport + impact tests (bot).
- The four existing modes behave exactly as before: characterization tests pass; manual smoke: drive, cycle, fly, walk, teleport in each, save/restore across reload.
- Cars hit Spider-Man with a person-sized hitbox; Spider-Man emits no engine sound.
- Controller runs deterministically: same input recording → same final state (unit test); no NaN for `dt` ∈ [0.001, 0.1] and for teleports.
- Zero per-frame allocations in the controller path (heap-growth check over 5 minutes).
- Cost vs baseline: character ≤ +1.0 ms GPU and ≤ +1.5 ms JS at T2.
- The camera never shows the inside of a building during a 5-minute scripted run through Midtown.

**Automated tests:** `spider-physics.test.cjs` (moveToward, gravity, coyote/jump buffer, air control cap, terminal velocity, determinism), `spider-world.test.cjs` (queryFloor with polygon/obb/AABB colliders and holes; the real decoded building data for a sample), `spider-integration.test.cjs` (the §1.12 touchpoints with the new type), updated stubs where unavoidable.

**Manual playtesting:** 30-minute pass covering every surface; roof exploration across 10 districts; camera stress (corners, canyons, under bridges); gamepad and touch sanity; the four old modes.

**Risks and rollback:** camera feedback with camera-relative input; tunnelling at sprint speed; collisions trapping the character. Rollback by turning the flag off or reverting the integration commits one by one (each integration edit is its own commit).

---

## M2 — Web anchors and swinging (core feel) → **Gate G2**

**Size:** XL

**Scope**
- **Anchor candidate index** from the decoded building data (§5.3; start threshold ≥ 20 m, ~131K points ≈ 2.6 MB **[M]**) and the **exact ray/segment query** (`rayFirstHit`) with wall and roof tests including courtyard holes and landmark/AABB slabs.
- **Selection and validity rules** (§5.4): range, elevation, direction, occlusion, hysteresis, fallback cone rays, scoring weights in the debug panel.
- **Swing state** with the rope inequality constraint (§4.6), pump, steering, release boost, momentum preservation, soft speed cap, ground-avoidance assist.
- **Web strand rendering** (one draw call: a ribbon or line from the wrist bone to the anchor) and **anchor reticle** (DOM).
- **Swing pose** (§3.3): hanging body aligned to the rope, arm IK to the anchor, trailing legs, release extension.
- **Swing camera behaviour:** look-ahead, FOV kick, collision.
- **Landmark data refinement** for the 11 authored landmarks: setback boxes and crown/spire proxies so their silhouettes can be swung from (§5.2).
- **Debug visualisations:** candidates, rays, hits, rope, velocity, energy.
- A **bot** that performs scripted swing chains for tests and benchmarks.

**Files expected to change**
- New: `spider-anchors.js`, `spider-web.js`, `ui-spider-hud.js`, tests.
- Modified: `spider-controller.js`, `spider-physics.js`, `spider-world.js`, `spider-camera.js`, `spider-anim.js`, `spider-rig.js`, `landmarks.js` (collider additions only), `main.js`, `index.html`, `css/style.css`.

**Dependencies:** M1.

**Acceptance criteria**
- **Physics:** an ideal pendulum with no input conserves energy within 2% over 10 s; the rope never exceeds its length by more than 1 cm; no NaN; deterministic replay.
- **Anchors:** across ≥ 2,000 sampled airborne positions at 15–120 m height, a valid anchor is found in ≥ 95% for Midtown, FiDi, Upper West and East Sides; results for Central Park, the waterfronts and low-rise areas are reported separately with a plan (fallback anchors or hand-placed points).
- **Performance in the browser:** anchor query p99 ≤ 0.25 ms; no per-frame allocation; no frame hitch from index build (< 100 ms or spread over loading).
- **Feel gate (playtest):** a defined route (Empire State → Times Square → Columbus Circle, ≈ 3 km) is completable by ≥ 3 of 5 testers with ≤ 2 ground touches, and ≥ 4 of 5 rate swinging ≥ 4 on a 5-point "feels good" scale.
- The existing four modes still pass their tests.

**Automated tests:** `spider-anchors.test.cjs` (index build counts against the known data: 37,353 buildings; ≥ 30 m → 75,260 points per the §5.3 measurement; candidate filtering; scoring; hysteresis), `spider-world.test.cjs` (ray vs wall/roof/hole/landmark), `spider-physics.test.cjs` (pendulum energy, constraint, release), property tests with random seeds.

**Manual playtesting:** repeated swing runs by several people; swing near corners, avenue canyons, over parks; edge cases (anchor behind, anchor occluded, very low and very high starts); controller and keyboard.

**Risks and rollback:** feel is subjective and may take several iterations; anchors may be sparse in places. Keep all tunables in `spider-config.js` and the debug panel. If G2 fails, narrow the play area, add auto-attach and hand-placed anchors; otherwise revert the milestone's commits (flag-gated).

---

## M3 — Traversal depth: wall run/climb, zip, vault, momentum polish

**Size:** L

**Scope**
- A proper **`queryWall`** (contact normal and depth) replacing the scratch-position probe (§4.7), optionally by exporting `buildingContact`.
- **WALL state:** attach rules, wall-run, climb, jump-off, corner handling, top-out/vault onto roofs.
- **Web zip** to a point (roof edge, wall, perch) with arrival transitions.
- Collision at speed: stuck-recovery, swing-into-wall transition to wall-run, hard-landing scrub, chain-swing assists.
- Visual-orientation child group for wall planes (§3.2.3); procedural wall poses.
- Camera behaviour on walls.

**Files expected to change:** `spider-controller.js`, `spider-physics.js`, `spider-world.js`, `spider-anim.js`, `spider-camera.js`, tests; optionally a one-word `export` in `controllers.js`.

**Dependencies:** M2 (anchors and rays), M1 (floor query).

**Acceptance criteria**
- Wall-run along 10 sampled facades (straight and concave, including a courtyard) without incorrect detaching.
- Top-out succeeds onto ≥ 95% of 20 sampled roofs of height 20–120 m.
- Zip reaches roof-edge, wall and perch targets and ends in the correct state.
- 1,000 randomised high-speed impacts end with the player outside all buildings.
- Momentum tests: speed conserved or scrubbed exactly as specified across every state transition.

**Automated tests:** state-machine transition table tests; wall tangent/normal geometry tests against synthetic polygons and decoded real data; stuck-recovery fuzz.

**Manual playtesting:** wall-run corners, courtyards, glass towers; zip to billboards (preview of M5); long mixed traversals.

**Risks and rollback:** wrapping around convex corners and concave courtyards is the hardest geometry **[A]**; if unreliable, restrict wall-run to straight facade segments longer than 8 m. Revert by milestone commits (flag-gated).

---

## M4 — Animation and visual polish → **Gate G3**

**Size:** L

**Scope**
- Execute the path decided in M0: import/retarget clips, or re-rig, or hand-authored clips, for idle, walk, run, jump, fall, landing.
- **Layers** (§3.2): foot IK to ground samples, torso lean, landing compression, head look-at.
- Refine **swing, zip, wall-run, wall-climb** poses and transitions; **web-shooter hand** pose.
- **Web FX** (strand shimmer, attach impact), **audio** (swing whoosh, thwip, landings; the project already has procedural audio synthesis, `audio-synthesis.js`).
- **LOD1** character beyond a distance threshold; shadow policy.
- Final materials/lighting tuning across the four time-of-day presets.

**Files expected to change:** `spider-rig.js`, `spider-anim.js`, `spider-model.js`, `spider-web.js`, `audio-*.js` (additive), assets; `index.html` for any new preload.

**Dependencies:** M0 decision; M2/M3 states (to animate).

**Acceptance criteria**
- A visual checklist for each animation at 3 camera distances signed off by you.
- Foot sliding while running measured on a test course: ≤ 5 cm/s residual at steady speeds (to be calibrated).
- No visible skinning collapse (candy-wrapper) at the extreme poses: swing reach, wall climb, full sprint (screenshot comparison at fixed frames).
- Budgets from §7.3 met (draw items, triangles, texture memory, GPU/JS cost).

**Automated tests:** `RigMap` completeness (every semantic joint resolves); solver invariants (bone lengths preserved, IK reaches/clamps correctly, no NaN); clip metadata validation.

**Manual playtesting:** animation review in a rig test scene and in-game; frame-by-frame checks of transitions; GPU timing at T1/T2.

**Risks and rollback:** quality may not reach expectation by procedural means; mitigations in technical-risks.md R-01. Keep the procedural base as a working fallback; clips layer on top and can be disabled.

---

## M5 — Portfolio core

**Size:** L

**Scope**
- **Content system** (§6): `portfolio.json` schema, validator, loader, stable IDs, media handling.
- **World layout:** `build-world-layout.mjs` slot generator and `world-layout.json`, hand overrides, debug overlay.
- **Billboards:** per-project canvas textures (cover + title + tech), merged meshes, day/night emissive style, lazy screenshot loading, distance LOD.
- **Trigger system** and **interaction** (`F`), UI panels: project, profile, CV (download), skills, experience; focus management; reduced-motion respect.
- **Progress persistence** (versioned `localStorage`, try/catch).
- **HTML fallback portfolio** page generated from the same JSON (also for no-WebGPU browsers and search engines).
- Minimap/map markers for projects.

**Files expected to change**
- New: `content/*`, `portfolio-data.js`, `portfolio-layout.js`, `portfolio-billboards.js`, `portfolio-triggers.js`, `portfolio-progress.js`, `ui-portfolio.js`, `tools/build-world-layout.mjs`, `portfolio.html`, tests.
- Modified: `main.js`, `index.html`, `css/style.css`, `nyc-map.js` (marker drawing only).

**Dependencies:** M2 (swing to billboards) and preferably M3 (zip/wall to reach them); your content (projects, photo, CV). Placeholder content can be used until supplied.

**Acceptance criteria**
- Schema validator rejects malformed content with precise errors; all IDs unique; links are well-formed.
- Every project is reachable on foot or by swinging from a defined start point; each billboard is readable (title ≥ 24 px tall on screen at 30 m, 1080p) — checked by screenshot test.
- Interact opens the correct panel; the game input is suspended while open and restored after; Esc closes; keyboard focus returns correctly.
- CV downloads the correct file; external links open with `noopener noreferrer`.
- Added draw calls ≤ 12; no frame hitch when billboards or media load.
- Content changes require editing only `content/` (demonstrated by adding a project without touching JS).
- The HTML fallback shows the same content with no WebGPU.

**Automated tests:** `portfolio-data.test.cjs` (schema, referential integrity, bad input), `portfolio-triggers.test.cjs` (hash queries, radius, facing cone, events), progress persistence tests with a mocked storage, layout tests on decoded buildings (slots on valid facades, no overlap, no landmark reserve overlaps).

**Manual playtesting:** visit every billboard at day and night; panel usability with keyboard, mouse, touch; screen reader smoke test; slow-network behaviour.

**Risks and rollback:** billboard legibility under bloom/SSR/night; text and media layout on small screens. Content/layout live in separate files, so removal is a matter of not loading `portfolio-*` modules.

---

## M6 — Game layer: objectives, onboarding, settings, credits

**Size:** M

**Scope**
- **Collectibles and objectives** (§6.3) with persistence and a HUD tracker.
- **Onboarding:** a short guided first swing; controls hints per input method.
- **Settings:** quality tier (shadow cascades, SSR, draw distance, character LOD), reduced motion (disable FOV kick and camera shake), key hints; remember choices.
- **Touch and gamepad swing controls** (design and implement, or consciously scope out).
- **Credits/legal:** CC-BY attribution for the model in a visible place, data licences (NYC Open Data, OpenStreetMap ODbL), original project MIT notice, and a disclaimer that this is a fan-inspired tribute, not affiliated with Marvel (**legal review is your decision; this is not legal advice**).
- **Mobile decision** (§7.1): lite tier, portfolio-only view, or desktop-only notice.

**Files expected to change:** `portfolio-progress.js`, `ui-spider-hud.js`, `ui-portfolio.js`, `touch-controls.js`, `gamepad-controls.js`, `lighting.js` (quality hooks only, if needed), `index.html`, `css/style.css`, a credits panel.

**Dependencies:** M5.

**Acceptance criteria:** a first-time player can complete the onboarding and open a project within 2 minutes in an unassisted test with 3 people; objectives persist across reload; reduced-motion is honoured via `prefers-reduced-motion`; attribution is reachable from the UI; quality tiers change measured cost as expected.

**Automated tests:** objective logic, persistence, settings serialisation.

**Manual playtesting:** unassisted first-run tests; all input devices; accessibility pass.

**Risks and rollback:** scope creep; keep features data-driven so they can be dropped without touching physics.

---

## M7 — Hardening and release → **Gate G4**

**Size:** M

**Scope**
- Performance pass against §7.3 budgets on T1–T3, including a soak test.
- Compatibility matrix (Chrome/Edge/Firefox/Safari, desktop and mobile); explicit WebGPU capability check and friendly fallback (HTML portfolio).
- **Load-time work:** lazy-load the character and media, measure shader-compile time, consider reducing the precompile set **[A]**.
- Dependency decision: **vendor the pinned three.js build** instead of relying on a dev-branch commit through jsDelivr (supply-chain and availability), plus the GLTF/Meshopt/KTX2 addons actually used.
- Error handling and logging; final regression sweep; deployment (static hosting, e.g. GitHub Pages); licence and attribution review.

**Files expected to change:** `index.html` (import map if vendoring), `main.js`, `README.md`, deployment config; vendored files under a `vendor/` folder.

**Dependencies:** M5, M6.

**Acceptance criteria:** budgets met on T1–T3 (or a lite tier documented); heap flat over a 10-minute soak; no console errors across S1–S5; all tests green; first meaningful interaction available within a target load time to be set from the M0 baseline.

**Automated tests:** the full suite; the boot-test rules; a smoke script that loads the page headlessly if a headless WebGPU environment is available **[A]**.

**Manual playtesting:** full-run on each target browser/GPU; cold-cache and warm-cache loads; slow-network throttling.

**Risks and rollback:** Safari/Firefox WebGPU maturity **[A]**; keep the HTML fallback as the guaranteed experience.

---

## Cross-cutting conventions

- **Branching:** one branch per milestone; one commit per integration edit to an existing file so each can be reverted alone.
- **Definition of done for every milestone:** characterization + new tests green; budgets re-measured; flag-off behaviour unchanged; docs updated; known issues listed.
- **Tunables:** all in `spider-config.js` with a debug panel; no magic numbers in logic.
- **No per-frame allocation** in controller, anchors, web, pose solver (scratch objects only).
- **Text rendering** through `textContent` only; no `innerHTML` (repo convention).

## Decisions and approvals needed from you before M0 starts

1. **Create the initial git commit** (baseline) and a working branch?
2. **Tooling:** may a dev-only tool (`gltf-transform` via `npx`, or Blender if installed) be used for the model pipeline? Nothing is installed now.
3. **Animation path:** are you willing to use Mixamo (Adobe account) and/or hand-author in Blender? Until then M0 evaluates all options and M1–M3 use the procedural base.
4. **Scope of the play area:** stay on Manhattan island (simplest; shore clamp stays) or allow crossing rivers/bridges (needs anchor data for bridges, §5.2)?
5. **Keep the four existing modes** (taxi, bike, helicopter, pedestrian) as part of the final product, or retire them later?
6. **Interact key:** `F` (since `E` is already "jump/ascend")?
7. **Target hardware:** which GPU/browser do you want as the baseline "mid-range desktop"?

Content (project list, photo, CV) is not needed until M5; placeholders will be used.
