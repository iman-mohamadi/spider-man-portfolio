# M0 Execution Report — Foundations: Baseline, Safety Net, Technical Decisions

Source of truth: [architecture-review.md](architecture-review.md), [implementation-roadmap.md](implementation-roadmap.md), [technical-risks.md](technical-risks.md). Companion: [test-baseline.md](test-baseline.md).

Date: 2026-10-31. Status: **M0 is NOT complete.** Phases A, B, D (static), E (research), F (static) and G (plan + feasibility proofs) are finished. **Update: the Git baseline (AP-1/AP-2) was approved and executed as three commits on `main` — see `git log`; nothing was pushed.** The browser performance baseline and the in-pipeline experiments are still **waiting for your approval** (§13). Sections below were written *before* the commits and still describe the baseline as "proposed". Apart from the `.gitignore` additions (AP-2) and this status update, nothing in the repository was changed, nothing was installed or uploaded.

## Labels

**[V]** verified by reading code/asset/source text · **[M]** measured by running a command or script · **[A]** assumption, not yet verified · **[R]** recommendation. Web-sourced statements are marked *(web)* and are only as reliable as their source.

---

## 1. Executive summary

**Done (verified work)**
1. Repository, Git and environment preflight; the exact staging scope for a baseline commit (121 files at dry-run time, 123 now that this report and the test report exist; no secrets, no personal data) — **commit not made, awaiting approval**.
2. Test baseline: **225 tests, 223 pass, 2 fail, 0 regressions.** Both failures are environmental *and each was shown to pass once its cause was removed outside the repo*. **One finding in the earlier review was wrong** (§4).
3. Independent re-measurement of the Spider-Man model. Most earlier numbers were **confirmed**; three were **corrected** (§6).
4. Pinned three.js (a 2026-10-28 build) was inspected at source level for skinning, material conversion, KTX2/meshopt/WebP support, timestamp queries and the retarget algorithm (§9, §8).
5. Eight scratchpad characterization proofs plus one camera proof show that the planned safety-net tests are **feasible without changing production code** for most integration points (§10).

**Most important new findings**
- **Six of the suit's main materials are fully metallic only because the export omitted `metallicFactor` (glTF default = 1.0).** This probably is not the intended look and affects lighting, SSR and the environment reflection (§6.4, new risk N-01).
- **Hands, wrists and web-shooters hold about one third of the triangles**, so they are where decimation must be careful (§6.3).
- **Merging identical materials only reaches 11–12 draw items, not ≤ 8** (§7.3). The ≤ 8 target needs texture atlasing or a revised target.
- **1024² textures are sufficient** at every game camera distance by a margin of ≥ 1.8× (§7.4), the whole texture set is **0.67 MB** as 1024² JPEG **[M]**, and uncompressed 1024² RGBA8 is **49.3 MB** — inside the 64 MB budget **without** KTX2.
- **Collapsing the 150 corrective bones into their parents is mathematically exact for FK poses** and reduces 259 joints to ~86 (§7.6).
- three.js' retarget copies source **world rotations** and does **not** compensate for rest-pose differences (the model's A-pose arms are 36° below horizontal): retargeting is feasible only with computed per-bone offsets (§8).

**G1 readiness: NOT READY** (details in §12). The main missing evidence is runtime: no performance baseline, no in-pipeline render of the character, no visual check of the overlays, no decimation result, and no retarget experiment.

---

## 2. Repository and Git state

| Item | Value |
|---|---|
| Working directory | `C:\Projects\spider-man-portfolio` **[M]** |
| Branch / HEAD | `main`; **no commits** (`git rev-parse HEAD` fails: "unknown revision") **[M]** |
| Staged / modified files | none; every file is untracked **[M]** |
| Untracked entries | `.claude/`, `.gitignore`, `LICENSE`, `README.md`, `css/`, `docs/`, `index.html`, `js/`, `marvel_spider_man_ps4_for_blender/`, `tests/`, `tools/` **[M]** |
| Remote | `origin` → `https://github.com/iman-mohamadi/spider-man-portfolio.git` (fetch + push). `.git/FETCH_HEAD` is empty. **Nothing was fetched, pushed or contacted.** **[M]** |
| Git config | `core.autocrlf=true`, `init.defaultBranch=master` (the repo is on `main`), `user.name` set, `user.email` set (not printed here) **[M]** |
| `.gitignore` | 10 bytes: `.DS_Store` only **[M]** |
| Upstream licence | `LICENSE` is MIT, "Copyright (c) 2026 Mr.doob" — must be kept **[V]** |

**Local configuration and sensitive data [M/V]**
- `.claude/launch.json` (created by me in the first session) contains only a `python -m http.server 8080` launch entry — **no personal or sensitive data**.
- Pattern search for keys/tokens/passwords/private-key headers/AWS-GitHub-Slack key formats outside the data folders: **no secrets** (the only hits were the word "token" in test-helper variable names `startToken/endToken` and inside a data line of `js/nyc-geodata.js`). Search for the user's Windows profile path, name or e-mail address in all non-binary project files: **no matches**.
- Hidden/odd files: only `.claude/` and `.gitignore`. No `.env`, key, log, `node_modules`, `Thumbs.db`, `.DS_Store` files.
- The remote URL (with a personal GitHub username) lives in `.git/config`, not in any tracked file.

**Staging scope (dry run `git add --dry-run -A`; index untouched) [M]: 121 files, 0 line-ending warnings** (`docs/` then held 3 files; it holds 5 now, so the current total is 123 = 104 + 13 + 5 + 1 for `.claude/`)

| Path | Files | Size | Notes |
|---|---:|---:|---|
| `.gitignore`, `LICENSE`, `README.md`, `index.html` | 4 | 27 KB | project root |
| `css/` | 1 | 36 KB | |
| `js/` | 47 | 3.2 MB | includes 2 gzip data blobs (`building-geodata.bin.gz` 440 KB, `tree-geodata.bin.gz`) |
| `tests/` | 29 | 364 KB | |
| `tools/` | 23 | 15 MB | `tools/data/*.json` 15 MB (largest 5.97 MB) |
| `marvel_spider_man_ps4_for_blender/` | 13 | 18.9 MB | source model (CC-BY 4.0): `scene.bin` 7.86 MB, 10 PNGs 10.4 MB |
| `docs/` | 5 | ≈ 0.2 MB | this milestone's documents |
| `.claude/` | 1 | 1 KB | local tool config |

No file exceeds GitHub's 100 MB limit (largest 7.86 MB) and total is ≈ 37 MB.

### Proposed Git baseline — **needs your approval (nothing executed)**

*What:* three commits on `main` (no branch created, nothing pushed):
1. **"Import slop-newyork baseline"** — `.gitignore`, `LICENSE`, `README.md`, `index.html`, `css/`, `js/`, `tests/`, `tools/` (104 files).
2. **"Add Spider-Man source model (CC-BY 4.0)"** — `marvel_spider_man_ps4_for_blender/` (13 files, includes `license.txt`).
3. **"Add M0 planning documents"** — `docs/` (5 files).

*Excluded:* `.claude/` (local tool config) — via a proposed `.gitignore` addition.

*Why:* it creates the rollback point the roadmap depends on (risk R-11) and separates upstream code, third-party asset and our documents so each can be reverted alone.

*Proposed `.gitignore` additions (minimal) [R]:* `.claude/`; and, preventively, `node_modules/`, `Thumbs.db`, `*.log`. Editing `.gitignore` modifies an existing (untracked) file, so it is part of the approval.

*Alternatives:* (a) one single commit; (b) leave the 19 MB model out of Git (commit only the optimised GLB later) — then the pipeline is not reproducible from the repo; (c) put the model under Git LFS (needs LFS installed — not installed); (d) include `.claude/`. *Commit identity:* the configured `user.name`; commit messages would end with the assistant co-author trailer required by this session. Pushing to `origin` is **not** part of this proposal.

---

## 3. Environment

| Item | Value |
|---|---|
| OS | Windows 11 Pro 10.0.26300 **[M]** |
| CPU / RAM | Intel Core i7-13650HX / 27.7 GB **[M]** |
| GPUs | **NVIDIA GeForce RTX 3050 6GB Laptop** (driver 32.0.15.8186) and Intel UHD Graphics (hybrid laptop); display 1920×1080 @ 119 Hz (primary) **[M]** |
| Disk | C: 14.6 GB free of 237.3 GB **[M]** |
| Node / npm / Git | v24.11.1 / 11.6.2 / 2.52.0.windows.1 **[M]** |
| Python | 3.12.10; Pillow 13.0.0 installed (read-only listing: also arabic-reshaper, python-bidi, pip). `python3` is the **Microsoft Store alias** **[M]** |
| Blender | **Not installed** (checked PATH and the three standard install folders) **[M]** |
| gltf-transform, gltfpack, toktx, basisu, ffmpeg, magick, FBX2glTF, obj2gltf | **None on PATH** (`convert` is the Windows disk utility, not ImageMagick) **[M]** |
| npm globals (read-only) | `@mimo-ai/cli`, `@nestjs/cli`, `@openai/codex`, corepack, npm, `opencode-ai`, pnpm, `raya-ui`, yarn — none relevant **[M]** |
| Test scripts | None (`package.json` absent). Working commands in §4 **[M]** |

Hardware fits tier **T2** (mid discrete GPU, 1080p) of the performance plan **[R]**. Caveat for measurement: a hybrid laptop may run the browser on the Intel GPU unless forced; the adapter in use must be logged **[R]**.

---

## 4. Test baseline (details in [test-baseline.md](test-baseline.md))

| Command | Result |
|---|---|
| `node --test "tests/**/*.test.cjs" "tests/**/*.test.mjs"` | **225 tests, 223 pass, 2 fail, 0 skipped**, 2.35 s **[M]** |
| `node --test` (no args) | identical, 2.44 s **[M]** |
| `node --test tests/` | fails: `Cannot find module '…\tests'`, 0 tests **[M]** (finding confirmed) |

**Both failures are environmental, and the earlier review mis-described one of them:**

| # | Test | Cause | Verified how |
|---|---|---|---|
| F1 | `tests/geodata.test.mjs:10` | `EPERM` creating a **directory symlink** on Windows (**not** python) | Scratchpad copy of the same test with `'junction'` instead of `'dir'` **passed** (29.6 s) **[M]** |
| F2 | `tests/tree-geodata.test.cjs:54` | `python3` resolves to the Store stub | Same file with a temporary `python3.exe` shim on a temporary `PATH`: **4/4 pass** **[M]** |

**Actual regressions: 0.** No test, source or system setting was changed.

---

## 5. Performance baseline and measurement limitations

**Status: NOT MEASURED.** Collecting it needs a browser session (and possibly a served instrumentation copy), which this milestone's rules gate behind your approval. What follows is what was established by inspection, and the exact plan.

### 5.1 What exists today **[V]**

| Capability | State |
|---|---|
| FPS | HUD `#hud-fps`, recomputed every ≥ 0.25 s from wall time (`main.js:754–778`); coarse, rounded, no percentiles |
| Start-up timing | Existing console line `[init] renderer …ms, lighting …ms, cityGrid, boroughs, landmarks, blocks, streetDetails, traffic, roadPaint, controllers, culling, ui, postFX, compile, warmup, firstFrame, gpu` (`main.js:66–73, 746`) — **S1 is measurable with no code change** |
| Shader compile progress | Loading-screen text "Compiling scene shaders… n / 621 batches" (`main.js:656`) |
| `renderer.info` | **Exists in the pinned build** with `render.drawCalls`, `frameCalls`, `triangles`, `points`, `lines`, `timestamp`, and `memory.geometries`, `textures`, `texturesSize`, `total`… **[V, source]**. But `renderer` is a local variable of `initApp()` — **not reachable from the page** without a source change |
| GPU timestamps | Supported by the pinned build: constructor option `trackTimestamp` (default **false**) enabled only if the adapter exposes `timestamp-query` **[V, source]**. `main.js` does not set it. Whether this GPU/driver exposes it: **unknown [A]** |
| JS update time per phase | Not instrumented |
| Frame-time percentiles | Not instrumented |

### 5.2 Measurement ladder (all keep the repository untouched)

- **L0 — no change:** load the page, read the `[init]` console line and the HUD FPS. Gives S1 only, plus coarse FPS.
- **L1 — injected page script via a throw-away static server in the scratchpad** (serves the repo files unmodified and injects one `<script>` into the served `index.html`): wraps `requestAnimationFrame` to record frame intervals (p50/p95/p99) and the CPU time of each frame callback; wraps `GPURenderPassEncoder.draw*`/`createTexture`/`createBuffer` to count **draw calls, triangles (index count × instances) and GPU allocation bytes** from the WebGPU API itself — independent of three's counters. Logs `adapter.info`, browser version, canvas size.
- **L2 — optional patched *served copy* of `main.js`** (repository file unchanged): exposes `renderer` on `window`, enables `trackTimestamp`, so `renderer.info` and GPU timestamps become available. Needed only if L1 counters look inconsistent or GPU time is wanted.

### 5.3 Scenarios (scripted, identical each run) **[R]**

| ID | Scenario | Input method |
|---|---|---|
| S1 | Cold load to first meaningful frame (loading overlay hidden) | read `[init]` timings; run cold + warm cache |
| S2 | Pedestrian standing still, dense Midtown (spawn at 5th Ave/37th St or teleport "Times Square") | key `1`; 30 s idle |
| S3 | Pedestrian walking south on 5th Ave | synthetic `keydown`/`keyup` for `KeyW` on `window` (the controller listens on `window` and reads `e.code`), 60 s |
| S4 | Taxi, driving along an avenue | key `2`, `KeyW`, 60 s |
| S5 | Helicopter at altitude 380 m (draw-distance worst case) | key `4`, `Space` held until the cap, then forward 60 s |

Each scenario ≥ 3 repetitions, a fresh `localStorage['nyc-player-state']` before each run (it affects the spawn), the same time-of-day preset, same viewport. Report median and p95 across runs.

### 5.4 Known limitations to disclose with the numbers **[A]**
- The in-app browser is **not** the user's Chrome; its frame pacing, GPU selection (hybrid laptop) and background throttling may differ.
- A 119 Hz display / `requestAnimationFrame` cap changes the available frame budget; the harness must record the refresh interval.
- Browser measurements, API-level counters, and `renderer.info` are three different things and will be labelled separately; static calculations (e.g. model bytes) never mix with them.
- GPU time is available only if the adapter supports `timestamp-query` and L2 is used; otherwise it is **not reported**, never estimated.
- During the earlier session the first frame took well over 30 s in the in-app browser **[observation]**; repeated runs will show whether that is typical.

---

## 6. Original Spider-Man model measurements (independently re-measured)

All numbers come from parsing `scene.gltf`/`scene.bin` directly with scripts (read-only); nothing in the model folder was modified **[M]**.

### 6.1 Verification of previously reported values

| Claim in the review | Re-measured | Verdict |
|---|---|---|
| 112,137 vertices | 112,137 | ✅ confirmed |
| 156,556 triangles | 156,556 | ✅ confirmed |
| 20 draw items | 20 meshes, 20 materials, one primitive each, all double-sided | ✅ confirmed |
| 259 bones | 259 joints | ✅ confirmed |
| ≈ 193 MB texture memory | 193.3 MB (formula: 9 × 2048² + 1 × 512² RGBA8 with mip chain) — **calculated, not measured on a GPU** | ✅ confirmed as an estimate |
| Seven `27_*env` overlay meshes totalling 24,295 triangles | **Six** are duplicates totalling **23,971** triangles; the seventh (`27_eyeenv`, 324 tri) is a **distinct** overlay | ❌ **corrected** (§7.1) |
| 154 of 259 joints carry weights | 154 | ✅ |
| Max 4 influences per vertex | 4 (histogram 1→13,134; 2→33,819; 3→21,643; 4→43,541) | ✅ |
| 10 images, 10.4 MB PNG; scene.bin 7.9 MB | 10.37 MB; 7.86 MB | ✅ |
| 14 meshes carry `TEXCOORD_1` | **10** (already corrected in the review's text) and **no material references a second UV set** (`"texCoord"` occurs 0 times) | ✅ / → removable |
| Skeleton update cost "per skeleton or per mesh" (assumption A3) | `skeleton.update()` is guarded by a per-frame `_skeletonsUpdated` map: **once per skeleton per frame** **[V, three source]** | ✅ resolved |

### 6.2 Draw order and layering **[V/M]**
Meshes are drawn in scene order 0…19: the seven `27_*env` meshes come first, base meshes after. All 20 share one skin.

### 6.3 Triangles by body region (dominant-joint classification of the 132,261 non-overlay triangles; approximate)

| Region | Triangles | Share |
|---|---:|---:|
| Hands + wrist (gloves 24,410; gauntlet 9,324; web-shooter 7,799; body 2,928) | 44,461 | **33.6%** |
| Legs | 20,180 | 15.3% |
| Torso | 19,440 | 14.7% |
| Arms | 17,290 | 13.1% |
| Head (mask incl. eye-shutter 7,744) | 16,234 | 12.3% |
| Feet | 14,656 | 11.1% |

### 6.4 Materials **[M]** — new finding
- Only `baseColorTexture` is used: **no normal, occlusion, metallic-roughness or emissive maps** anywhere.
- Roughness is 0.82 on base suit materials; 0.6 on overlay materials; 0.10 on the eye overlay.
- **Six main materials have no `metallicFactor` and therefore default to metallic = 1.0:** `22_body`, `22_legs`, `22_gloves`, `22_head`, `22_shoes`, `24_lens`. Seven others set it to 0 explicitly (`22_spider`, `22_shoewhite`, `22_legwhite`, `22_gauntlet`, `24_webshooter`, `24_eyeshutter`, `24_eye`). The overlay `27_spiderenv`, `27_gauntletenv` and `27_eyeenv` also default to 1.0.
- A suit that is 100% metal with no metal map is almost certainly an **export artefact** **[A]**: in a lit scene it reads dark and reflects the environment heavily. The city has a PMREM environment (`lighting.js:188`) and SSR (below), so this matters.

### 6.5 Textures **[M]**

| Format | 10 images total |
|---|---:|
| Original PNG (9 × 2048², 1 × 512²; RGB or palette; no alpha) | 10.37 MB |
| 1024² PNG (optimised) | 4.96 MB |
| 1024² JPEG q85 | **0.67 MB** |
| 1024² WebP q85 | **0.34 MB** |
| 2048² JPEG q85 | 2.13 MB |

(Lossy encodings are sizes only; no visual comparison was made. Encoded in memory, nothing written to disk.)

GPU memory formula **[calculated]**: RGBA8 + mips: 2048² set 193.3 MB; **1024² set 49.3 MB**; 512² set 13.3 MB. BC7/ASTC (8 bpp): 48.3 / 12.3 / 3.3 MB. BC1/ETC2 (4 bpp): 24.2 / 6.2 / 1.7 MB.

### 6.6 Skeleton **[M]**
259 joints = 84 main, 150 corrective `_adj_`, 25 plain tips (mutually exclusive categories); 154 weighted (75 main + 79 `_adj_`). **48.1% of all skin weight is on corrective bones.** Of the 150 corrective bones, 59 are direct children of a main bone and 91 are children of another corrective bone.

---

## 7. Optimization investigation

Original asset untouched; **no optimised GLB was generated** (rule), so every item says what is established and what is not.

### 7.1 Are the `27_*env` meshes redundant overlays? — *partly proven, visual check outstanding*
- **Proven [M]:** four overlays (`27_spiderenv`, `27_shoeenv`, `27_legenv`, `27_gauntletenv`) are **bit-identical** to a base mesh in positions, indices, UVs and skin (`22_spider`, `22_shoewhite`, `22_legwhite`, `22_gauntlet`). The two web-shooter overlays together **split exactly the surface** of `24_webshooter` (4,129 identical unique positions, 6,302 + 1,497 = 7,799 triangles = its 7,799). That is **6 meshes / 23,971 triangles (15.3%)** that coincide with another mesh.
- **Not a duplicate [M]:** `27_eyeenv` has the same counts as `24_eye` but different positions (bounds ±0.066 vs ±0.065 m: about 1% larger), its own texture (the only user of image 5) and a glossy `KHR_materials_specular` material (roughness 0.10) — a distinct eye-gloss layer. **Keep.**
- **Why "redundant" is not yet certain:** the overlays differ in material values (two — `27_spiderenv` and `27_gauntletenv` — have metallic 1.0 where the base has 0.0; the other four are metallic 0 like their base; all overlays have roughness 0.6 vs the base's 0.82). With identical vertices and skinning the depth values are identical; the later-drawn base mesh should win a depth tie in scene order **[A]** — but that is exactly the kind of thing that must be seen, not assumed. **Needs experiment E2** (render with and without each layer, compare).
- Removing them does **not** save texture memory: all nine 2048² images are used by non-overlay meshes; only the small eye image (512²) is overlay-only **[M]**. The "27_…env" names are the **base-colour maps of base meshes**; they must not be deleted with the overlays.

### 7.2 Does merging preserve materials and skinning?
- **Skinning: yes [V]** — all 20 meshes use skin 0 and the same node hierarchy; merging primitives with the same skin is valid glTF.
- **Materials: only where parameters match.** Unique `(image, metallic, roughness)` groups among the 13 non-overlay, non-eye-gloss meshes: **11**. After dropping the 6 duplicates the model has 14 meshes → **12 draw items by exact-material merging; 11** if the metallic default is normalised to 0 (`22_legs`+`22_legwhite` then merge).
- **The ≤ 8 draw-item target is therefore NOT reachable by merging alone.** Reaching it needs texture atlasing / re-baking small parts (web-shooter, eye-shutter, eye, lens) into shared textures — Blender-class work **[R]**.

### 7.3 Can decimation preserve hands, head, face and suit detail? — *not testable yet*
- **Required reduction [M calc]:** from 132,585 triangles (after dropping duplicates) to a 55K LOD0 is **−58.5%**; to 20K LOD1 **−85%**.
- **Where to take it [M]:** gloves (24,410 tri = 18% of the model; all hands), gauntlet (9,394), legs mesh (26,696; 5,250 on the feet), `24_eyeshutter` (7,744). Hands/wrist ≈ 34% of the total but also the most visible part during web-swinging — decimate by edge-collapse with attribute/skin-weight preservation and **boundary locking at UV seams**.
- **Tool path without Blender:** the pinned three.js ships `examples/jsm/libs/meshopt_simplifier.module.js` (and `meshopt_clusterizer`, `meshopt_decoder`) **[V, directory listing]**. A small Node script using it (plus my glTF reader) could produce candidate meshes in the scratchpad **[A]** — needs a download (§13, AP-4). Quality on this model is **unknown** until viewed.

### 7.4 Are 1024px textures sufficient? — **Yes at all game distances** **[M, calculated]**
Area-weighted texel density per metre of surface at 2048 vs the on-screen density of a 1080p, 56° vertical-FOV camera (the chase preset):

| Mesh | texels/m @2048 | @1024 | @512 |
|---|---:|---:|---:|
| 22_body (largest, lowest density) | 1,898 | **949** | 474 |
| 22_legs | 2,182 | 1,091 | 546 |
| 22_head | 4,118 | 2,059 | 1,030 |
| 22_gloves | 5,190 | 2,595 | 1,298 |
| 22_gauntlet | 7,391 | 3,695 | 1,848 |
| 22_spider (emblem) | 3,470 | 1,735 | 868 |

| Camera distance | 1.9 m (closest orbit zoom, 0.45×4.3) | 4.3 m (default chase) | 8 m | 15 m | 30 m |
|---|---:|---:|---:|---:|---:|
| on-screen px/m | 535 | 236 | 127 | 68 | 34 |

At 1024² the body texture (949/m) exceeds even the closest zoom (535/m) by 1.8×; 512² (474/m) would be marginally soft at the closest zoom but fine from the default distance. **Recommendation:** 1024² for LOD0; 512² is a candidate for LOD1. Caveat: RMS-averaged density; individual UV islands may be sparser; a visual check is still required. The first-person camera was not evaluated.

### 7.5 Is KTX2/Basis supported by the pinned build? — **Supported, but not required**
- `KTX2Loader` exists and has an explicit **WebGPU path**: `renderer.isWebGPURenderer` → capability checks `hasFeature('texture-compression-astc' | 'texture-compression-bc' | 'texture-compression-etc2' | 's3tc')` **[V, source]**; the Basis transcoder (`basis_transcoder.js` 57 KB, `.wasm` 527 KB) is in `examples/jsm/libs/basis` **[V]**; `GLTFLoader` has `KHR_TEXTURE_BASISU`, `EXT_TEXTURE_WEBP`, `EXT_MESHOPT_COMPRESSION`, `KHR_DRACO_MESH_COMPRESSION`, `KHR_MESH_QUANTIZATION`, `setKTX2Loader`, `setMeshoptDecoder`, `setDRACOLoader` **[V]**.
- But 1024² RGBA8 is 49.3 MB (within the 64 MB budget) and JPEG/WebP 1024² is 0.34–0.67 MB total. **KTX2 is a later GPU-memory optimisation, not an M0 requirement.** Encoding KTX2 needs a tool not installed (`toktx`/`basisu`/`gltf-transform`). Support is hardware-dependent at runtime, so a fallback texture must always exist.

### 7.6 Can unused joints and attributes be removed safely?
- **Attributes:** `TEXCOORD_1` is present on 10 meshes and referenced by no material (`"texCoord"` count = 0) → removable. No tangents, no morphs.
- **Joints [M]:** 105 joints carry no weights. **Collapsing every weight on an `_adj_` bone onto its nearest non-`_adj_` ancestor** leaves **81 deforming joints (86 with the hierarchy ancestors)** instead of 259; the maximum influences per vertex stays 4.
- **Why this is exact [A → reasoning verified for FK]:** a corrective bone is a child of a main bone and its local transform stays at bind unless something animates it, so it moves rigidly with its parent; moving its weight to that parent is identical for any pose that only rotates main bones. It is **not** exact if the original DCC drove the corrective bones with constraints (not representable in glTF anyway) or if a future clip targets them.
- Effect: smaller bone texture (259 → 86), cheaper skinning, simpler `RigMap`. **Not validated visually.**

### 7.7 Can one optimised GLB keep the skeleton and skinning? — **Yes in principle [V of format/loader support]**; not generated.

### 7.8 Do the corrective bones cause visible problems? — **Cannot be determined without rendering.** Given §7.6 they behave as rigid children under FK, so the original rig's twist-correction is already absent in the plain glTF; no *new* defect is introduced by collapsing them **[A]**.

### 7.9 Visual quality at three distances — **Not verified.** Texel analysis supports textures (§7.4); nothing supports or refutes geometry decimation until experiment E4.

### 7.10 Budgets: target vs established

| Target | Current | Established path | Gap |
|---|---|---|---|
| LOD0 ≈ 50–60K tri | 156,556 | 132,585 after duplicates; needs −58% more | decimation unproven |
| LOD1 ≈ 20K | — | −85% | unproven |
| ≤ 8 draw items | 20 | 11–12 by merging | needs atlasing or a revised target (suggest ≤ 12, stretch ≤ 8) |
| ≤ 64 MB GPU textures | 193 MB | 49.3 MB at 1024² RGBA8 **[calc]**; 12.3 MB BC7 | ✅ reachable |
| ≤ 6 MB download | 18.3 MB (10.4 + 7.9) | textures 0.34–0.67 MB; geometry estimate ≈ 1–2 MB **[A]** | ✅ very likely |
| Bones | 259 | 86 | ✅ reachable |

### 7.11 Required tooling
No tool is **required** to continue the investigation. For production optimisation a tool is needed (§13, AP-5): the least intrusive candidate is the meshopt simplifier module already shipped with the pinned three.js plus Pillow (already installed) — i.e. **zero installs** — with Blender or `gltf-transform` as heavier alternatives.

---

## 8. Animation-path comparison

### 8.1 Evidence collected
- **[V]** The rig has no clips; bone local axes are inconsistent (review §2.4); A-pose arms droop **36°**; 7 spine bones; full finger bones; 150 corrective bones that follow their parents.
- **[V, three source]** `SkeletonUtils.retarget` resets the target pose, then for each mapped bone copies the **source bone's world matrix rotation**, expressed relative to the target root, and applies an optional manual per-bone `localOffsets[bone.name]`. It has **no automatic rest-pose compensation** (only `localOffsets` and `useTargetMatrix`); `names` is a 1:1 target→source dictionary; `hip`, `hipInfluence`, `scale` are options. `retargetClip` bakes the result into a new clip.
  - Consequence: because it works in **world space**, this rig's odd *local* axes do **not** matter; but the **A-pose vs T-pose** difference (and any other rest-orientation difference) **must** be supplied through `localOffsets` — which can be **computed** automatically as the rotation between each pair of rest world orientations **[R]**. The rig's 7 spine bones vs the usual 3 means a many-to-one spine mapping needs custom code (the 1:1 `names` map leaves extra spine bones at rest).
- **[V, directory listings]** The pinned three.js has `FBXLoader` and ships `Xbot.glb` (2,930,032 B) and `Soldier.glb` (2,160,468 B) — Mixamo-rigged characters with animation clips — so a retarget experiment needs **no Mixamo account and no upload**.
- **[M]** Tooling gap: no Blender, no FBX/OBJ conversion tool. The model is glTF; Mixamo accepts **FBX, OBJ or ZIP** *(web, Adobe help)* — so Path C needs a converter or a custom exporter (`OBJ` is trivial to write from the data; textures would not travel).
- *(web)* Mixamo: characters and animations are royalty-free for personal, commercial and non-profit use; **raw character/animation files may not be redistributed** (older community post; dated). The auto-rigger needs a single humanoid mesh in a neutral pose, no helper objects, origin at 0,0,0. **No source confirmed a polygon or file-size limit** (older sources mention 30–50 MB; a "150,000 polygon" figure is **unconfirmed**). The current mesh is 156K triangles before decimation.

### 8.2 Comparison

| Criterion | **B** Retarget standard clips onto the existing rig | **C** Mixamo re-rig | **D** Hand-author in Blender | **A** Procedural only (reference) |
|---|---|---|---|---|
| Visual quality | Good for locomotion if offsets are right; web poses still need procedural layers | Best locomotion fidelity; native clips | Best, fully controllable | Lowest for run/jump |
| Technical feasibility | Algorithm exists and is world-space; needs offsets + spine mapping **[V]** | Needs mesh conversion/upload; polygon limit unconfirmed; weights regenerated | Needs Blender (not installed) | Works today **[V]** |
| Effort | Medium (spike, offset solver, bake step) | Medium–high (toolchain + re-skin + texture remap) | High (every clip) | Medium (tuning) |
| Compatibility with this model | Keeps skeleton, weights, face/finger bones | Replaces skeleton; loses weights/finger corrections | Keeps skeleton | Keeps skeleton |
| Licensing | Source clips from Mixamo/Xbot: fine in a built game, **do not commit raw clips** *(web)* | Same; requires uploading a Marvel-derived mesh to an external service (approval + IP caution) | None (self-authored) | None |
| Runtime performance | Mixer + same 86–259 bones | ~65 bones: cheapest | Mixer | Solver per frame (CPU) |
| Maintainability | Rig abstraction (`RigMap`) isolates it | Standard names, easiest | Needs the DCC file | Highest code ownership |
| External dependency | Mixamo/Xbot clips as inputs | Adobe account + service | Blender | none |

### 8.3 Recommendation **[R, evidence-based but untested]**
- **Primary: Path B — retarget standard humanoid clips (locomotion, jump, fall, land, climb) onto the existing rig with world-space retargeting, computed rest-pose `localOffsets` and a custom spine/finger map — layered with the procedural IK/lean/web-pose solver for swing, zip and wall poses.** Reasons: it keeps the model's skeleton, weights and fingers; it needs no upload of a Marvel-derived mesh and no tool beyond what the pinned three.js ships; the retarget algorithm is already in the build and axis irregularities do not matter in world space; the A-pose offset is a computable quantity.
- **Fallback: Path A — procedural-only animation on the existing rig** (model-space deltas + IK), which is already the plan for M1–M3 and needs nothing external. Path C is third (use only if B fails *and* you accept the upload/toolchain), D fourth (needs Blender and skill).
- **Confidence: moderate.** B is *feasible by source analysis* but **quality is unproven**; this is exactly what experiment E3 decides (§13, AP-4).

---

## 9. City rendering pipeline compatibility

Status key: **CV** = verified by reading production code and pinned three.js source; **UV** = **unverified at runtime**.

| Interaction | Finding | Basis | Status |
|---|---|---|---|
| Material conversion | `GLTFLoader` produces `MeshStandardMaterial`; the WebGPU renderer's `StandardNodeLibrary` maps `'MeshStandardMaterial'` → `MeshStandardNodeMaterial` and `NodeLibrary.fromMaterial` copies the source properties (`for … in`). `KHR_materials_specular` is supported by the loader | three source | CV |
| MRT outputs | `main.js:210–217` defines the MRT `output / normal / metalRough` at the **pass** level, applying to every material rendered in `scenePass`; `metalRough = (roughness < 0.75) ? metalness·ssrFade : 0` | `main.js:203–217` | CV that it applies; **UV** that a converted standard material writes all three correctly |
| Normals when skinned | Skinning assigns `positionLocal`, `normalLocal` and `tangentLocal` **after** skinning, so `normalView` uses skinned normals | `Skinning.js` | CV |
| SSR | The character is SSR-reflective only where roughness < 0.75 and metalness > 0. Base suit materials (roughness 0.82) are **excluded**; the overlays (0.6, some metallic 1.0) and the eye gloss (0.10) are not. **If the overlays are the visible layer the suit will receive SSR reflections** | `main.js:209–213` + glTF values | CV (logic), **UV** (visual) |
| Clustered lighting | `renderer.lighting = new ClusteredLighting(256, 32, 28, 48)` applies to lit materials generally; no per-object registration | `main.js:63` | CV (no integration step), **UV** at runtime |
| Cascaded shadows | `SunLight` 2 cascades share an atlas; far plane 260 + 1.6·altitude (300–720) clamp; the shadow-proxy cascade cameras `enable(SHADOW_PROXY_LAYER)`, which **adds** layer 3 and keeps layer 0, so a default-layer character is rendered into both cascades | `lighting.js:192–204, 299–304`; `scene-culling.js:337` | CV; skinned depth rendering **UV** |
| Reversed depth | Renderer option `reversedDepthBuffer: true`; independent of materials | `main.js:58` | No issue expected **[A]** |
| Shader precompile | `precompileShaders()` compiles `scene.traverseVisible` objects with the scene MRT, 16 concurrent jobs; a skinned mesh must be **in the scene and visible** by then. The warm-up first frame compiles the shadow-pass pipelines for visible objects | `main.js:593–667, 717–735` | CV |
| `matrixWorldAutoUpdate = false` | Set at `main.js:186`. A character parented under `entity.mesh` is refreshed by `root.updateMatrixWorld()` because `entity.mesh` is in `dynamicRoots` (`main.js:177–183, 714`) and the call recurses into bones. `skeleton.update()` runs once per skeleton per frame inside the skinning node | `main.js`; `Skinning.js` | CV |
| `dynamicRoots` | Built from `Object.values(controllerManager.entities).map(e => e.mesh)` **before** line 185 — an entity registered before that line is included automatically | `main.js:177–185` | CV |
| Instanced storage swap | Applies only to `InstancedMesh` at init (`main.js:192–198`); a skinned character is unaffected; later web/collectible instanced meshes must exist before it | `main.js` | CV |
| Culling | `isStaticMesh` excludes skinned meshes and only six roots are walked | `scene-culling.js:54–56`; `main.js:170` | CV |
| First-frame hitch | A character created after the precompile/warm-up passes would compile on first use | `main.js` | CV (reasoning) |

### 9.1 Safest integration point **[R]**
Load and attach the character in `initApp()` **after** `controllerManager` is created and `markInit('controllers')` (`main.js:165`) and **before** `setupSceneCulling` (170) / `scene.updateMatrixWorld(true)` (185) / the instanced-storage swap (192) / `precompileShaders()` (667) — as a new `showLoadingStage('Loading character…')` step. Register the entity before line 177 so `dynamicRoots` includes it. Needs `renderer` already initialised (it is: line 75) for KTX2 support detection.

### 9.2 Remaining uncertainty (to be validated by experiment E1/E2)
Runtime correctness of: converted-material rendering under MRT/SSR/clustered lighting; skinned depth in both shadow cascades; overlay depth ties; metallic-default appearance under the PMREM environment; shader compile cost of 14–20 new pipelines; GPU cost of 20 skinned draws × (main + 2 cascades).
**E1** is an isolated test: a throw-away static server in the scratchpad serves the repo unmodified plus **one served copy** of `main.js` that loads the *original* GLB at the integration point above; nothing is written to the repository and no production file changes.

---

## 10. Characterization test plan

"Fifth entity" = a hypothetical new mode/type (`'spider'`) added to `controllerManager.entities`.

| # | Integration point | Existing behaviour | Failure when adding a fifth type | Source (function, line) | Proposed characterization test | Possible without production change? |
|---|---|---|---|---|---|---|
| 1 | `findTeleportPosition` | Uses a 4-key `body` table `{person, car, cyclist, helicopter}`; `body[entity.type][1]` and `body[e.type][0]` | **Throws `TypeError: Cannot read properties of undefined`** for the active entity or any other entity of an unknown type | `controllers.js:403` (table), `:404–407` (others), `:426–431` | Known type finds a position; unknown type throws (documents current behaviour; flip after the guard is added). Existing tests already cover the 4 modes (`controllers.test.cjs:483–700`) | **Yes — proven T1/T1b ✅** |
| 2 | `ThirdPersonControllerManager.update` | Runs `updatePerson/Car/Cyclist/Helicopter` by `activeMode`; syncs `mesh.position/rotation.y` for all entities | A new active mode runs no updater (the person auto-walks); no crash | `controllers.js:1076–1125` | Static: dispatch branches exist and no custom-mode hook; behavioural: assert `mesh.position/rotation.y` sync for any entity; after the hook is added, assert the updater is called | **Partly** — static proven (T1c); the behavioural sync test needs a larger stub of the entity set (feasible, not yet proven) |
| 3 | Touch mode handling | `setMode` returns early for anything not in the 4-name list | Mode silently ignored | `touch-controls.js:96–98` | Unknown mode is a no-op; `Jump`/`Ascend` labels and the descend button visibility per known mode | **Yes — proven T2 ✅** (the existing test covers helicopter/car/cyclist only) |
| 4 | Touch labels | `up` label `Ascend` only for helicopter else `Jump`; `up` visible only for person & helicopter; `down` only for helicopter | A fifth mode keeps the previous mode's labels and buttons (stale UI) | `touch-controls.js:100–107` | Stale-label test (documented in T2) + labels for `person` | **Yes — proven T2 ✅** |
| 5 | Camera follow | Chase: camera behind `heading + orbitYawOffset` at `chaseDistance`, look-up bias 1.55 (person/cyclist), 0.52 (car), 0.2 (helicopter); `abs(speed)` pull-back; auto-recentre when `abs(speed) > 0.5` | Unknown type is framed like a person (no crash) — acceptable; **no building collision** | `cameras.js:169–209, 178–181, 333–352` | Framing per type for a stub entity, auto-recentre threshold, ground clamp ≥ 0.65 | **Yes — proven T7 ✅** (existing tests cover pointer/orbit only, not follow math) |
| 6 | Traffic player hitbox | `halfW/halfL` = cyclist 0.35/0.85, person 0.32/0.32, **else 0.86/2.18**; `player.active` if not helicopter and `y < 2.6` | A fifth mode gets a **car-sized** hitbox | `traffic.js:1894, 1906–1907` | Static assertion of the expression (T5 ✅). **Behavioural** test needs `update()`'s closure state | **Static only.** A behavioural test requires extracting a pure helper (production change) |
| 7 | Audio player-source filtering | `players = Object.values(entities)`; for non-person entities (except an inactive cyclist) a **motor** voice of `kind = entity.type` | A fifth entity becomes an engine sound source named after its type | `audio-sources.js:87, 170–190` | `collect()` on a stub: assert the voice list for person/car/cyclist/helicopter and (documented) for an unknown type | **Yes — proven T4 ✅** (`CityAudioSources` imports only `city-config.js`) |
| 8 | Gamepad jump | Button 0 → `up` **only** when `mode === 'person'`; `up` from triggers only in helicopter | A fifth mode gets no jump | `gamepad-controls.js:151–165` | Drive `update()` with a fake pad per mode; assert `setGamepadInput('up', …)` | **Yes — proven T3 ✅** |
| 9 | Save / restore | Restores per-mode positions generically over `Object.keys(entities)`; an unknown saved mode falls back to `'car'` (`Object.hasOwn`); saved with version 1 | Safe; but the logic is **inline in `initApp()`** | `main.js:121–141` | Static assertions (T6 ✅). Behavioural tests need the logic extracted into functions | **Static only** (extraction = production change) |

**Feasibility proofs (scratchpad only, real production sources via the repo's own `loadModule` harness) [M]:** `characterization-feasibility.test.cjs` — **8/8 pass** (T1, T1b, T1c, T2, T3, T4, T5, T6); `camera-feasibility.test.cjs` — **1/1 pass** (T7). They are **not** in `tests/`, and no production file changed. Full paths in the Appendix.

**Not yet covered by any test and not coverable without production change:** traffic hitbox behaviour, save/restore behaviour, `main.js` wiring (mode arrays, key map, HUD).
**Proposal [R]:** when approved, copy these as `tests/characterization-*.test.cjs` (new files only), run them with the suite, and flip the "documents a hazard" assertions only in the same commit that adds each guard.

---

## 11. Updated risk register

### 11.1 Resolved or reduced

| Item | Outcome |
|---|---|
| A3 skeleton update per mesh? | **Resolved**: once per skeleton per frame **[V, source]** |
| A5 GPU timestamp availability at the pinned build | **Partly resolved**: supported, opt-in `trackTimestamp`, requires adapter `timestamp-query` (adapter support unknown) |
| KTX2/Basis in the pinned build | **Resolved**: supported incl. WebGPU feature checks; not needed to meet budgets |
| Texture size / download budget | **Resolved**: 1024² is enough; 49.3 MB GPU (RGBA8) and 0.34–0.67 MB download |
| Joint reduction | **Resolved on paper**: 259 → 86 with exact FK equivalence |
| Test baseline | **Resolved**: 225/225 effective; 0 regressions |
| R-07 integration hazards | **Confirmed and now test-proven** (T1–T7) |
| Retarget mechanism understood | **Resolved on paper** (§8.1); quality unproven |
| A1 overlay redundancy | **Partly resolved**: geometry proven coincident (6 meshes), visual still open |

### 11.2 Corrections to the earlier documents (errata) — originals untouched

| Where | Statement | Correction |
|---|---|---|
| architecture-review §0, technical-risks R-12 | "Both failures call `python3`" | Only F2 does; **F1 is a Windows symlink `EPERM`** |
| architecture-review §2.2/2.6, risks R-05 | "Seven `27_*env` meshes, 24,295 triangles, identical to a base mesh" | **Six** coincide with a base mesh (**23,971** triangles); `27_eyeenv` is a distinct glossy layer to **keep** |
| architecture-review §2.6 | "Merge to ≈ 8 draw items" | **11–12** by exact-material merging; ≤ 8 needs atlasing |
| roadmap M0 / review §2.6 | "≤ 8 draw items" target | Suggest ≤ 12 with ≤ 8 as a stretch |
| architecture-review assumption A3 | open | resolved (once per skeleton) |

**Approval needed to edit the original three documents** (they are existing files); until then this report is the authoritative correction.

### 11.3 Still unresolved (carried from the register)
R-01 animation quality (path B unproven), R-02 swing feel, R-03 anchor availability, R-04 pipeline rendering (now narrowed to the list in §9.2), R-05 cost (no baseline yet), R-06 camera at speed, R-08 load time, R-09 browser/mobile, R-10 collision at speed, R-11 **no commit baseline (still open until approved)**, R-13 CDN dependency, R-14 licensing/IP, R-15–R-20 as before.

### 11.4 Newly discovered

| ID | Risk | Evidence | Mitigation |
|---|---|---|---|
| N-01 | **Suit materials are metallic by default** (6 main materials) → wrong look, odd SSR/environment behaviour | §6.4 **[M]** | Override at load: set `metalness = 0` on the suit materials (runtime, not in the original asset); verify in E1 |
| N-02 | Decimation target touches the most visible region (hands/wrists ≈ 34% of triangles) | §6.3 **[M]** | Allocate budget per region; lock seams; judge at the swing pose |
| N-03 | Draw-item target unreachable by merging | §7.2 **[M]** | Atlas small parts or relax to ≤ 12 |
| N-04 | Retarget does not compensate rest-pose differences; the spine maps many-to-one | §8.1 **[V]** | Computed `localOffsets`; custom spine distribution; E3 |
| N-05 | Mixamo path has a toolchain gap (no Blender/FBX tools; glTF → FBX/OBJ) and a raw-file redistribution restriction *(web)* | §8.1 | Keep raw clips out of the repo; bake only derived clips |
| N-06 | Test environment issues on Windows (symlink privilege, `python3` alias) | §4 **[M]** | Developer Mode + real `python3`, or document; never alter tests to hide them |
| N-07 | Hybrid GPU laptop and 119 Hz display can skew measurements | §3 | Log adapter; force the discrete GPU; record the frame interval |
| N-08 | A remote `origin` is configured | §2 **[M]** | No push without explicit approval |
| N-09 | `node --test tests/` fails on Node 24 | §4 **[M]** | Use the glob or bare form |
| N-10 | Save/restore and traffic hitbox cannot be behaviour-tested without extraction | §10 | Small, reviewed extractions when M1 starts |

---

## 12. G1 readiness: **NOT READY**

| G1 / M0 criterion | Evidence now | Met? |
|---|---|---|
| Git baseline safely established | **Executed after approval**: three commits on `main`, no push (verify with `git log`) | ✅ |
| Test baseline documented | 225 tests, 0 regressions, causes proven | ✅ |
| Performance baseline documented | **None measured**; plan and limits written | ❌ awaiting AP-3 |
| Original model measurements verified | Verified and corrected (§6) | ✅ |
| Optimization workflow understood and approved | Understood; **not approved**; decimation unproven; ≤ 8 draw items not reachable by merging | ⚠️ partial |
| Animation strategy selected on evidence | Primary B / fallback A selected on source evidence; **quality unproven** | ⚠️ conditional |
| City rendering compatibility validated | Code-level analysis complete; **runtime unvalidated** | ⚠️ documented uncertainty |
| Characterization coverage planned | Plan complete; 9/9 points classified; feasibility proven for 7 | ✅ |
| G1 evaluable with measurable evidence | Cannot yet: no baseline, no in-pipeline render | ❌ |

**Why not "conditionally ready":** G1 asks whether the optimised character renders correctly *and cheaply* in the city pipeline. Neither has been observed: there is no baseline to compare against and the character has never been rendered inside the real pipeline. Those two pieces of evidence are obtainable in a small, isolated step (AP-3 + AP-4/E1) without touching production code.

---

## 13. Approvals still required and exact next actions

I stopped at each of these gates. Nothing below has been done.

### AP-1 — Git baseline (blocks R-11 and the whole rollback story) — **APPROVED AND EXECUTED**
- **Intend:** make the three commits described in §2 on `main`, no branch, no push.
- **Why:** rollback point and reproducible history.
- **Affects:** `.git` only (index + 3 commits); working-tree files unchanged.
- **Alternatives:** single commit; exclude or LFS the 19 MB model; include `.claude/`; create a working branch first.

### AP-2 — Modify the existing `.gitignore` — **EXECUTED with AP-1** (added `Thumbs.db`, `*.log`, `node_modules/`, `.claude/`)
- **Intend:** add `.claude/` (+ optional `node_modules/`, `Thumbs.db`, `*.log`).
- **Why:** keep local tool config out of Git. **Alternative:** commit `.claude/`, or leave `.gitignore` alone.

### AP-3 — Browser performance baseline (S1–S5)
- **Intend:** run a scratchpad static server (not in the repo), open the game **once** in the in-app browser pane, inject the L1 measurement script via the served `index.html`, run S1–S5 × 3, and write results to `docs/spider-man-portfolio/baseline.md`. L2 (patched served `main.js`) only if you also want GPU time/`renderer.info`.
- **Why:** nothing else in G1 can be judged without a baseline.
- **Affects:** one browser tab (about 15–25 minutes of interaction on this machine), `localStorage` of `localhost:<port>` in that browser profile, the scratchpad. No repository file.
- **Alternatives:** you run the page in your own Chrome and read the console `[init]` line (S1 only); skip scenarios S3–S5; use L0 only.

### AP-4 — Isolated experiments E1–E4 (scratchpad, served copies only)
- **E1** original GLB in the real city pipeline (integration point §9.1). **E2** per-layer on/off render of the 6 coincident overlays and the metallic default. **E3** retarget feasibility: load `Xbot.glb` (clips) → retarget onto the Spider-Man rig with computed offsets. **E4** decimation candidates with `meshopt_simplifier` at 55K/20K, viewed at 3 distances.
- **Downloads needed (to the scratchpad only):** `examples/models/gltf/Xbot.glb` (2.93 MB), `examples/jsm/libs/meshopt_simplifier.module.js` (size to be confirmed; small), `examples/jsm/loaders/FBXLoader.js` only if needed — all from the pinned commit `b3396270…` on jsDelivr/GitHub, the same source the game already uses. **Not** added to the repo; Xbot is a Mixamo asset and must not be committed.
- **Needs:** the browser pane (same as AP-3).
- **Alternatives:** do only E1+E2 (the G1 evidence) and defer E3/E4; do E3 in a node-only harness (needs `three` locally → another download).

### AP-5 — Tooling decision (only if E4 fails)
- None needed now. If meshopt-based decimation looks poor: Blender (≈ 400 MB install, GUI skills needed) or `gltf-transform` via `npx` (downloads from npm at run time; no repo dependency). **I am not proposing an install yet.**

### AP-6 — Mixamo upload
- **Not proposed.** Only if Path B fails and you accept uploading a Marvel-derived mesh to an external service and the FBX/OBJ conversion toolchain.

### AP-7 — Amend the earlier three documents with the errata of §11.2
- **Intend:** small edits to the existing review/risks/roadmap files. **Alternative:** leave them untouched and treat this report as authoritative (current state).

### AP-8 — Optional: fix the two environmental test failures
- Enable Windows Developer Mode and install a real `python3`/disable the Store alias. System settings: **not touched**.

### Exact recommended order
1. AP-1 + AP-2 → create the baseline (5 minutes).
2. AP-3 → performance baseline.
3. AP-4 with E1 + E2 first (G1 evidence), then E3, E4.
4. Re-evaluate G1 with real numbers; then decide AP-5/AP-7.
5. Only then close M0 and ask for M1 approval.

---

## Appendix — evidence artefacts (scratchpad, not in the repo)

Directory: `C:\Users\EnzO\AppData\Local\Temp\claude\C--Projects-spider-man-portfolio\2b2bbbbe-e517-4200-be11-dab0b4b172ad\scratchpad\`

| File | Purpose |
|---|---|
| `model_audit.py`, `model_audit2.py`, `materials.py`, `eye_check.py` | model measurements (read-only on the original asset) |
| `model_audit_out.txt`, `model_audit2_out.txt` | their outputs |
| `characterization-feasibility.test.cjs`, `camera-feasibility.test.cjs` | proofs for §10 |
| `geodata-junction.test.mjs`, `geodata-junction-result.txt` | F1 verification |
| `test-run-1.txt`, `test-dir-form.txt`, `test-noargs.txt` | raw test output |
| `dryrun.txt` | `git add --dry-run -A` list (121 files) |

These files are temporary. If you want them kept, I can copy them into the repo under `docs/spider-man-portfolio/evidence/` (new files only) — say so.

Key commands (reproducible):
```bash
node --test                                  # test baseline
git add --dry-run -A                         # staging scope, index untouched
python model_audit.py && python model_audit2.py && python materials.py   # model facts
```

Web sources used *(web)*: Adobe Mixamo FAQ and upload help pages, and an Adobe community FAQ post (licensing, upload requirements). Source files read at the pinned three.js commit `b3396270682287470d161658ac01084d25e8dba6` (committed 2026-10-28): `Info.js`, `Renderer.js`, `WebGPUBackend.js`, `SkeletonUtils.js`, `KTX2Loader.js`, `GLTFLoader.js`, `Skinning.js`, `NodeLibrary.js`, `StandardNodeLibrary.js`, plus directory listings.
