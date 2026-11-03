# Real gameplay checklist (manual, ~25 minutes)

Written from the source as it is now (branch `m0-foundations`). Controls and numbers below were read from the code, not from older docs; the file is named next to each one so you can re-check it. Nothing here was run in a real browser at normal speed: that is what this checklist is for.

**Automated baseline:** `node --test tests/*.test.cjs` → 347/348 (the failing one is the tree-generator test that needs `python3`).

## 0. Setup (2 min)

```bash
python tools/serve.py 8130
```

Open `http://localhost:8130/index.html` in a desktop Chromium browser with a mouse and keyboard, **DevTools console open** (filter: Errors + Warnings). Window at least 1280×720. Watch the FPS number in the top-left HUD (`three.js · WebGPU · TSL · NN fps`).

| URL | Use |
|---|---|
| `index.html` | the normal game: starts as Spider-Man on 5th Ave |
| `?spider=0` | original four modes only (regression R1) |
| `?spiderModel=ps4` | original Spider-Man model (regression R2) |
| `?portfolioTs=0` | the portfolio boards on city walls and the original Times Square posters (before the move into Times Square) |
| `?spiderModel=raimi` | the Raimi model (the Brand New Day suit is the default; same skeleton and clips) |
| `?spiderDebug` | exposes `window.__spider` (only if you want to inspect) |
| `?spiderTune` | live tuning sliders (exploratory only; it persists values in localStorage, so clear it afterwards) |

## 1. Controls found in the source

| Action | Input | Source |
|---|---|---|
| Select mode | `1` Person · `2` Car · `3` Cyclist · `4` Helicopter · `T` Spider-Man (also the HUD buttons) | `main.js` ~577 |
| Move (Spider-Man) | `W A S D` / arrows, relative to the camera | `spider-controller.js` `_readWish` |
| Sprint (Spider-Man, ground) | `Shift` (run 8.5 m/s, sprint 15 m/s) | `spider-input.js`, `spider-physics.js` |
| Jump | `Space` (also `E` in the key table); jump speed 10.5 m/s, gravity 26 → about 2 m high; 0.1 s coyote time, 0.12 s buffer. **Second `Space` in the air = double jump; `Space` on a wall = wall jump** | `spider-physics.js` |
| Look (Spider-Man) | mouse, through **pointer lock**. The **first click only captures the mouse**; `Esc` frees it. If the browser refuses the lock: left click still shoots, **right-button drag looks**, and the hint says so | `spider-input.js`, `spider-install.js` |
| Web | **left mouse**: press = shoot at the selected target, hold = swing, release = let go (momentum kept, small boost) | `spider-controller.js` header |
| Swing steering | `W` pump (faster), `S` brake, `A`/`D` steer; the keys are relative to the camera | `spider-physics.js` `swingForces` |
| Release with a hop | `Space` while swinging | `spider-controller.js` |
| Auto-release | rope past about 74° on the far side, reaching the anchor (<3 m), or a fast hit on a wall; touching the ground ends the swing | `_stepSwing` |
| Web range | targets up to 72 m; rope 10–95 m; swing speed cap 42 m/s | `SPIDER` |
| Web target | reticle follows the **camera centre line**; "No web target: aim at a building" toast on a miss | `spider-targeting.js` |
| Interact | `F` (Spider-Man mode only): opens/closes the panel when within 6 m of a gold marker | `spider-input.js`, `portfolio-interaction.js` |
| Close panel | `F`, `Esc`, the × button, or a click outside it. Opening it pauses movement and releases the mouse lock | `portfolio-interaction.js`, `spider-install.js` |
| Cameras | `5` 3rd-Person Chase · `6` Low-Angle Action · `7` First-Person/Cockpit · `8` `9` `0` scenic · `V` / `Shift+V` cycle | `main.js` |
| Person | `W`/`S` walk/run, **`A`/`D` turn** (not strafe), `Space` jump, left-drag orbit, wheel zoom | `main.js` hints, `controllers.js` |
| Car | `W`/`S` drive/reverse, `A`/`D` steer, `B` horn, left-drag orbit | same |
| Cyclist | `W`/`S` pedal/brake, `A`/`D` lean & turn, left-drag orbit | same |
| Helicopter | `W`/`S` pitch, `A`/`D` yaw, `Space`/`E` ascend, `Q`/`C` descend | same |
| Map | `M` or the Map button/minimap toggles; `Esc` closes; click = teleport (pin = go to the board); drag = pan; wheel = zoom (about the cursor); buttons: zoom in/out, centre on player, fit Manhattan; search box | `nyc-map.js` |
| Other | `H` hide HUD, `N` sound, time-of-day buttons, Teleport menu | `main.js`, `index.html` |

**Things the code says that are easy to trip over (treat as expected, not bugs, unless noted):**
- Spider-Man's mouse look and the **web only work on camera preset `5` (3rd-Person Chase)**. On `6`/`7`/scenic cameras the generic camera runs and left click does not shoot.
- The **F panel exists only in Spider-Man mode**. The map pins work in every mode.
- Boards are visual only (no collider); web anchors and the camera collide with the buildings, not the boards.
- **Opening the map does not release pointer lock** (`toggleFullMap` has no unlock). Test M13 checks what really happens.

## 2. MUST-PASS (about 15 min)

Mark each: ☐ pass ☐ fail. "Fail" is the thing to report.

### M1 · Load and start (Spider-Man; none)
1. Load the page. Wait for the loading screen to finish.
2. **Expect:** you are Spider-Man on 5th Ave (the **Spidey T** button is active), 3rd-Person Chase, hint "Click the game to capture the mouse · Esc frees it", a small reticle in the middle. HUD FPS is a number, not frozen.
3. **Fail:** stuck loading, black canvas, model in a T-pose or invisible, red errors in the console, **any `[portfolio]` line** (the real `profile.json` should produce none).

### M2 · Character switching (all modes; keyboard)
1. Press `1`, `2`, `3`, `4`, then `T`. Also click each mode button once.
2. **Expect:** each switch is immediate; the bottom hint bar changes to that mode's keys; the right character is visible and controllable; `T` brings Spider-Man back.
3. **Fail:** wrong/missing model, controls from the previous mode still active, a stuck key (the character keeps moving after release), an error in the console.

### M3 · Camera and mouse after every switch (all modes; mouse + keyboard)
Do this in the order **T → 1 → 2 → 3 → 4 → T → 2 → T** (`5` chase camera each time).
- **Spider-Man:** click the canvas once (captures; cursor disappears), move the mouse, camera turns, reticle stays centred; click again = web shot attempt. `Esc` frees the cursor.
- **Person / Car / Cyclist / Helicopter:** cursor must be visible and free. Left-drag on the canvas orbits the camera; the wheel zooms; release stops it. A left click must not shoot a web.
- **Expect:** each mode gets its own mouse behaviour right after the switch, and Spider-Man's look works again every time you come back (a click re-captures).
- **Fail:** drag does nothing or **keeps orbiting after release**; cursor stays hidden/locked in a non-Spider mode; Spider mouse look dead after returning; camera snaps or jitters on the switch.

### M4 · Walk, run, sprint, jump (Spider-Man; keyboard + mouse look)
1. Capture the mouse. Hold `W`: he runs; add `Shift`: sprint (clearly faster); release: he brakes quickly. Turn with the mouse while running; strafe with `A`/`D`.
2. Tap `Space` while standing and while running (a running jump has its own animation).
3. Walk into a building and along a wall; step on and off the kerb.
4. **Expect:** speed changes smoothly; legs match the speed (no sliding feet); he stops at walls without sticking; the jump clears roughly 2 m and lands on the same spot.
5. **Fail:** foot sliding, T-pose/pop between walk/run/sprint, getting stuck on kerbs/walls, falling through the street, double jump.

### M5 · Web targeting (Spider-Man; mouse)
1. Look at a tall building (≥16 m; lower ones offer no anchors) at 20–60 m. A ring marks the selected anchor.
2. Sweep the crosshair along the facade, then to another building.
3. Aim at the sky or at a low shop and click.
4. **Expect:** the marker follows where you look, does not flicker between neighbouring points, is never drawn through a wall; the sky/low-building click shows "No web target: aim at a building".
5. **Fail:** marker flickering, selected through a wall, target far from the crosshair, no miss toast.

### M6 · Attach, swing, steer, release (Spider-Man; mouse + keyboard)
1. From the street: aim at a high facade, **press and hold** left mouse: a small hop, then the strand attaches and he swings.
2. While holding: `W` (faster), `S` (slower), `A`/`D` (steer). Look where you want to go.
3. Release the button at the bottom of an arc: **momentum is kept** (he flies on). Repeat and end one swing with `Space` (release with a hop).
4. Let one swing run until it ends by itself (far side of the arc).
5. Tap-click quickly; click again while already on the rope.
6. **Expect:** strand runs from his hand to the anchor and stays attached; steering is smooth; release does not stop him dead; the camera stays behind and does not jerk; a second click on the rope does nothing; a tap does not destroy the swing (web stays at least 0.18 s).
7. **Fail:** strand detached/flickering/stretching, rope length jumps ("yank"), speed collapses on release, swing ends randomly, camera jitter, body clipping through a facade.

### M7 · Roof jump, fall, landing, back to running (Spider-Man)
1. Swing up and land on a roof (aim at the roof line, release over it) or approach one by web.
2. Walk off the edge; fall freely, then land on the street. Then jump off a **higher** roof for a hard landing.
3. Immediately hold `W` + `Shift`.
4. **Expect:** falling animation, a landing crouch (bigger for a higher drop; a very hard landing also costs speed), then a smooth return to run without a pop; the camera follows the fall without clipping into the roof.
5. **Fail:** falling through a roof, sticking on the edge, landing animation never ends, input dead after landing, camera under the ground.
- Optional: fall below the map (water): he should respawn at the last safe ground spot (code: below y = −25).

### M8 · Visit all 8 project locations (map + Spider-Man)
For each pin: press `M`, click the pin. The 8 project pins are labelled **Raya UI, Woodcoder, Hotelyar, Tricup, TinyHub, Rizo Tools, Rizo Weather, 3D Car Portfolio** (yellow squares; also HQ, Skills, Contact).
- **Expect:** the map closes, you arrive **on the pavement** (not in the road), facing the board, board visible on the wall about 15 m up, 13–26 m away; the prompt "View project: *name*" is already showing.
- **Fail:** arrival in the roadway or inside a building, facing away, board missing/floating off the wall, a different project's board, prompt missing.

Reference positions at the time of writing (x, z): Raya UI (−9, 681) · Woodcoder (−322, −125) · Hotelyar (147, 282) · Tricup (−9, −602) · TinyHub (−575, 203) · Rizo Tools (315, −208) · Rizo Weather (−301, 517) · 3D Car Portfolio (147, −363) · Contact (−8, 497).

### M9 · Every project F-panel (Spider-Man; keyboard)
At each marker press `F`. Check the table, then `F` again to close.

| Project | Image | Website link must open |
|---|---|---|
| Raya UI | yes | https://raya-ui.com/ |
| Woodcoder | yes | https://woodcoder.com/ |
| Hotelyar | yes | https://hotelyar.com/ |
| Tricup | **none (single column; its site returned 502)** | https://tricup.ir/ |
| TinyHub | yes | https://tinyhub.ir/ |
| Rizo Tools | yes | https://tools.rizo.top/ |
| Rizo Weather | yes | https://weather.rizo.top/ |
| 3D Car Portfolio | yes | https://car.iman-mhmdi.ir/ |

- **Expect per panel:** the category, title, one-line tagline, full description, tags, a **Website** button that opens the right site in a **new tab**; the screenshot is shown whole (not cropped), sharp and not stretched; movement is frozen and the cursor is free while open; after closing, you move again (click once to re-capture the mouse).
- **Fail:** wrong title/image/link for a marker, broken or blurry image, panel overflowing the screen (check at your normal window size), keys still moving him, F/Esc/× not closing it, stuck frozen after close.
- Tricup may be live by now: that is fine, its image is still intentionally missing.

### M10 · Contact panel and links (Spider-Man; keyboard + mouse)
1. `M` → click the **Contact** pin. Arrive; the prompt reads "Contact & Links". Press `F`.
2. **Expect:** "Get in touch / Contact & Links", name and role, two buttons: **LinkedIn** (https://www.linkedin.com/in/iman-mohammadiii/) and **Website** (https://iman-mhmdi.ir). Each opens in a new tab.
3. **Fail:** missing buttons, wrong URL, link opens in the same tab and leaves the game. (LinkedIn may show a login wall: that is LinkedIn, not the game.)

### M11 · Map pins at different zoom levels (map; mouse)
Open the map (`M`). Check at **three zoom levels**: the whole island (button "Fit all of Manhattan"), the default, and street level (wheel in; `centre on player` gives 0.9 px/m; the maximum is 3.0).
- **Expect:** all 11 yellow pins (HQ, 8 projects, Skills, Contact) exist; pin icons never overlap each other; labels move to a free side or disappear instead of covering another pin or a landmark name (Empire State, Bryant Park); hovering a pin shows "*name* · Click to go there"; a click within a pin square goes there. Typing a project name in the search box pans the map to it.
- **Fail:** a pin missing or on the wrong place, a label drawn over another pin/landmark at any zoom, a click on a pin teleporting to the street behind it, pan/zoom lag, pan stuck after release.

### M12 · Boards in the world, near swinging (Spider-Man; mouse + keyboard) — about 2 min
1. Stand at a board, look up. Then swing past/along the facade the board is on, at speed, and pass over it.
2. **Expect:** the board is flat on the wall, readable from the street, with its screenshot, title, tags and website; no collision with the board; web and camera behave as on any other facade; the FPS number does not visibly drop near boards.
3. **Fail:** flicker/z-fighting on the board, board floating, camera or web catching on the board, FPS clearly lower in front of a board than elsewhere.

### M13 · Map while the mouse is captured (Spider-Man; mouse)
1. Click the canvas (cursor captured), then press `M`.
2. **Expect:** the cursor is usable and you can click a pin. **Fail:** the cursor stays hidden/locked and the map cannot be clicked (you need `Esc` first; then check whether `Esc` closes the map or only frees the cursor). *The source suggests this may happen (map open does not release the lock); please report exactly what you saw.*

### M14 · Back to the original modes (modes 1–4)
1. In each of Person, Car, Cyclist, Helicopter: drive/walk/fly for 20 s, orbit with a drag, zoom with the wheel, switch time of day, open the Teleport menu and teleport once, open the map and click a project pin (they work in every mode).
2. **Expect:** behaviour as before the Spider-Man work; the board is visible from there; no F prompt (F is Spider-Man only).
3. **Fail:** broken controls in any original mode, camera wrongly locked, teleport landing in the road/inside a building.

### M15 · Double jump and wall run (Spider-Man; keyboard + mouse) — about 3 min
Controls (from `spider-controller.js` / `spider-physics.js`): `Space` in the air = one **double jump** per airborne cycle (refilled by landing or by attaching a web); `Space` on a wall = **wall jump**; a wall run starts by itself.
1. **Double jump:** jump, then press `Space` again at the top. **Expect:** a second, lower push (about 9 m/s up), your sideways speed kept, a small extra push toward the stick, a forward somersault, then falling and a normal landing. A third press does nothing. **Fail:** a second jump on the ground-contact frame, more than one air jump, speed lost, a body that lands upside down or pops.
2. **Wall run, sideways:** sprint along a tall flat facade, jump (`Space`) while holding forward, steer so the wall is within about 1.5 m. **Expect:** after a moment he turns feet-to-wall and runs along it at a steady distance for up to about 2 s, slowing a little; releasing the stick or running out of wall drops him cleanly. **Fail:** sticking to a wall from far away, to a low wall, a kerb or a pole; jitter at window ledges or corners; the body inside the wall.
3. **Wall run, up:** run at a tall wall, jump into it holding forward. **Expect:** he runs up it, slowing, for about 8 m at most, then drops or hops over a low roof edge. **Fail:** climbing forever, shaking at the top.
4. **Wall jump:** press `Space` during either run. **Expect:** he leaves the wall away from it and upward, keeping most of the speed along it, and does not stick to the same wall again for about half a second.
5. **With the web:** wall run, then left click with a target: he leaves the wall for the rope. Swing, release near a wall: he can start a wall run. **Fail:** a wall run starting while hanging on the rope, a snap or pop at either switch.
6. **Animation:** the running legs and arms continue during the wall run (no T-pose, no sliding); the double-jump somersault is one smooth turn.

### M16 · Wall traversal: run, crawl, cling (Spider-Man; keyboard + mouse) — about 5 min
Controls: no key. Push the stick **into** a wall to crawl on it; **Shift + straight at a facade** (or flying at one) to run; W/A/S/D move on it as the camera sees it; **Space** jumps off; left click for the web. Mark every line as what you saw, not what should happen.
1. **Walk into a wall** (a tall plain facade). **Expect:** after a moment he sticks, facing it, hands and feet on it; letting go of the keys leaves him still, without sliding or shaking. **Fail:** attaching when you only walk past a wall, to low or narrow things, or not at all.
2. **Crawl:** W, S, A, D, diagonals; stop and restart. **Expect:** the direction on screen matches the key, the speed is slow, the head turns smoothly towards the travel, hands and feet alternate and stay on the wall.
3. **Sprint at a facade** (Shift + W straight at it from the street). **Expect:** he runs up it with his speed, faster than any crawl; let go of the keys and he settles into a cling instead of falling. **Fail:** stopping dead at the wall, falling when the run ends.
4. **Jump at a facade from the air or after a web release.** **Expect:** he catches it and runs along or up it with the speed he had. Flying past a wall does nothing.
5. **Shift pressed while crawling along the wall** starts a run; **corners:** crawl or run round a building corner, inside and outside. **Expect:** the body turns smoothly onto the next face, the held key goes on round the corner, a run goes on running.
6. **Roof:** crawl up to the top. **Expect:** he rises to the edge, then climbs over it onto the roof and stands. **Fail:** a hop or a pop, falling back, being stuck at the edge. Then crawl down to the street: he stands up.
7. **Space** off the wall, then **Space** again (double jump), then catch another wall. **Web** from the wall; swing into a wall. **Expect:** no pause and no loss of speed at any hand-over.
8. **Camera:** it stays behind, a little further back, turns gently towards the wall when you are not using the mouse, never into the building, never against the mouse.
9. **Ceiling:** only under bridge decks and similar slabs: jump up into one. **Expect:** he hangs from it and crawls along it; Space drops him.

## 3. VISUAL QUALITY (about 4 min)

- **V1 Boards:** text readable at street level, screenshot sharp (not stretched or blurry), colours not washed out in all four time-of-day settings (Golden Hour, Midday, Blue Hour, Night). Check the Car-portfolio and Woodcoder boards: their screenshots should show no cookie banner and no "No GPU detected" notice.
- **V2 Panel images:** whole screenshot visible with sensible padding; a dark Raya UI image still readable; no gap or cut at 1280×720 and at your full-screen size.
- **V3 Markers:** gold beam, rings and gem visible, not buried in the pavement, no clipping with lamp posts.
- **V4 Character animation:** idle (breathing, look-around), walk→run→sprint blends, jump, fall, landing, swing start/loop/land; arms/web hand match the web side; no T-pose frames, no popping at the release.
- **V5 Web strand:** continuous line from the hand to the anchor, no gaps, no shaking at the anchor, disappears on release.
- **V6 Camera:** no jitter while sprinting or swinging; no clipping through walls when running along a facade; field of view widens with speed, then settles.

## 4. REGRESSION (about 3 min)

- **R1 `?spider=0`:** four modes only (no Spidey button), no console errors, map and pins still work, teleport from a pin works in car/person.
- **R2 `?spiderModel=ps4`:** Spider-Man mode loads with the original model; movement, web and F panel still work.
- **R5 Freefall dive:** jump off a tall roof (>= 20 m) and let go: after about 0.4 s the body turns head first (0.4-0.6 s), chest to the ground, arms back along the sides with slightly bent elbows, legs trailing with a small gap and pointed toes, the head following the body; it stays steady with small movements for the whole fall (check a 100 m drop); the fall at terminal speed is tighter than at 10 m/s; about half a second before the ground the body comes upright and lands in the usual crouch with no snap. Then check the exits: press the web mid-dive, steer into a wall mid-dive, double-jump mid-dive (it must not start a dive during the somersault), land on a roof 15 m below (no dive at all), and `?spiderModel=ps4` / `?spiderModel=raimi`.
- **R4 Times Square:** every portfolio board is on a Times Square screen (LED look), no original poster is left, every screen of the square shows the profile; each F marker is on the plaza or sidewalk in sight of its board and opens its panel; the map pins are in the square with readable labels; check the frame rate in the square.
- **R3 default (Brand New Day suit):** look at the face in a sprint (eyes narrow), a long fall (eyes widen), a swing (narrow) and standing still (a blink every few seconds); check the shoulders and elbows in a swing and on a wall for stretching; `?spiderModel=raimi` loads the Raimi model.
- **R3 Time of day and Teleport menu:** all four presets change the lighting; every Teleport item moves the active character.
- **R4 HUD:** `H` hides/shows the HUD; `N` toggles sound; mode buttons highlight correctly.
- **R5 Reload:** reload the page: it starts as Spider-Man again without a stuck loading screen or stale pointer lock.

## 5. OPTIONAL EXPLORATORY (only if time remains)

- **X1** Press `6`/`7`/`8` while Spider-Man: mouse look and web stop working (expected: they need preset `5`); press `5` and they return.
- **X2** Open a panel mid-swing or mid-air; close it: no stuck input, the swing state is sane.
- **X3** Hold a movement key while pressing `T`/`1`–`4`; hold `Shift` while switching.
- **X4** Alt-tab away while holding keys or the web button: on return nothing should be stuck.
- **X5** Swing for 5 minutes through Midtown: note any frame-time growth, memory growth, or a rope that starts to behave differently.
- **X6** Resize the window small and large with a panel open; open the map while a panel is open.
- **X7** Browser without pointer lock (or deny it): left click should still shoot and right-button drag should look.
- **X8** `?spiderTune` sliders: change one value, confirm it takes effect immediately; clear `localStorage` afterwards.

## 6. What to watch while playing

**Targets that exist in the repository** (and nothing more):
- The HUD FPS number is coloured by code: **≥ 50 green, 30–49 amber, < 30 red** (`main.js`).
- `docs/spider-man-portfolio/architecture-review.md` §7.3 gives **proposed, unvalidated** budgets, for a mid-range discrete GPU (GTX 1660 / RTX 3050 class) at 1080p: **frame time p95 ≤ 20 ms (≥ 50 fps), p50 ≤ 16.7 ms**; JS heap growth **0** over a 10-minute swing run; "draw calls added by portfolio billboards ≤ 12". They are marked as to-be-confirmed against a baseline that has **not** been recorded, so treat them as reference, not pass/fail.
- There is **no perf overlay or frame-time recorder** in the code (the `?perf=1` harness in the roadmap was never implemented), so the FPS number and your eyes are the only instruments. For percentiles use DevTools → Performance for a 10 s recording of one swing run.
- Fact worth knowing: there are 14 boards, each a group of 3 meshes (frame, panel, lamp), not merged, so the "≤ 12 draw calls" proposal is not met by construction; only boards in view are drawn. Judge by the FPS next to boards, not by the number.

**Observe and note (write down place + what you did):**

| Area | Look for | Report |
|---|---|---|
| FPS | steady number; drops when turning toward the skyline, near boards, after teleporting; amber/red | where, how low, how long |
| Frame-time spikes | a visible hitch (≥ ~100 ms) on switching modes, opening the map, opening a panel, first view of a board | trigger |
| Camera jitter | shake at speed, at the top of a swing, when passing close to a wall | place |
| Animation | pops, T-pose frames, foot sliding, arms detached from the web | clip/state |
| Web rope | flicker, stretching, snapping, anchoring in mid-air, attaching through a wall | anchor location |
| Collision | stuck on kerbs/walls/lamp posts, falling through roofs/street, clipping into facades | position |
| Boards / map | z-fighting, boards off the wall, pins or labels overlapping, a click hitting the wrong pin | zoom level |
| Console | any **red error** or `[portfolio]` / `[spider]` line. In the in-app browser used during development there was a lot of WebGPU console noise; in your browser, note the **first** error text and what you did just before it | text |
| Memory | open Task Manager/DevTools once at the start and after the swing run (X5) | growth |

## 7. Result sheet

| Section | Total | Pass | Fail | Notes |
|---|---|---|---|---|
| Must-pass M1–M16 | 16 | | | |
| Visual V1–V6 | 6 | | | |
| Regression R1–R5 | 5 | | | |
| Optional X1–X8 | 8 | | | |

For each failure: test ID, browser + GPU, what you pressed, what you expected, what happened, console text if any. Do not commit anything from QA sessions.
