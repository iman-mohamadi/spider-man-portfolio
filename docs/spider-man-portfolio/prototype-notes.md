# Spider-Man prototype — notes

First playable prototype, built on branch `m0-foundations` (uncommitted). Everything is isolated in new files and loaded lazily; `?spider=0` skips it completely and restores the original game.

## Run it
Serve the repository root over HTTP (the project has no build step). Use `python tools/serve.py 8080` (same as `python -m http.server`, but it sends `Cache-Control: no-store` so the browser never mixes old and new modules), then open `http://localhost:8080/`. Needs a WebGPU-capable browser, as before. Spider-Man is the active mode on load. Add `?spiderDebug` to expose `window.__spider` for inspection.

## Controls
| Input | Action |
|---|---|
| W A S D | Move, relative to the camera. On the rope: push / brake along the swing (W / S) and turn it (A / D) |
| Shift | Sprint (on the ground); also the parkour modifier: sprinting straight at a facade runs up it, and on a wall it crawls faster and, pressed while crawling, starts a wall run. It has nothing to do with the web |
| Space | Jump; **again in the air: double jump** (once per airborne cycle; landing, a web, a wall or a cling refills it). On the rope: let go with a small hop. On a wall (running or crawling): jump off it, away and up |
| Mouse | Look. The first click on the game captures the mouse (pointer lock); **Esc** frees it again |
| **Left mouse button** | **Web.** Aim with the camera until the ring is on the building you want, then press: shoots at the selected point. **Hold** to swing, **release** to let go (momentum is kept) |
| Wheel | Camera zoom |
| F | Interact (open or close the project panel); Esc also closes it |
| T, or the "Spidey" button | Switch to Spider-Man. 1-4 still select Walk / Drive / Cycle / Fly |

If the browser refuses pointer lock the game says so: clicks still shoot the web and you look by dragging with the **right** mouse button.

### Web targeting
- A small crosshair dot marks the centre of the screen. A **ring** (white, red and blue) sits on the anchor the web would hit. Anchors are on **several heights of every tall facade** (roof edge, then a row every 13 m down to 20 m) and on building **corners**, 8-72 m away, high enough for the swing to clear the street, with a clear line of sight from you and from the camera. Faint dots show up to three alternatives.
- The target is chosen by where you **look**: bearing counts fully, elevation 55%, and points on screen are preferred. Looking level at a building still gives a target; if the best one is above the top of the screen the ring is shown at the **screen edge with an arrow**, and a click still shoots it. Turning the camera to another building moves the ring there.
- It is stabilised: a new target must be clearly better than the current one (about 30%) to take over, the current one survives a quarter second without line of sight, and a target that stops qualifying (out of range, too low, behind you) is dropped immediately.
- No valid target at all (open sky, a park): the crosshair dims; a click flashes it red and shows "No web target: aim at a building". A click is remembered for about 0.2 s, so a target found a moment later still attaches.
- On the ground a click is a web launch (a hop, then the rope). Anchors that would need more than half the rope reeled in are not offered (a zip, not a swing). A swing that runs into a wall at speed lets go and the body slides down it instead of being pinned.

## Files
New: `js/spider-physics.js` (pure maths), `spider-gait.js` (pure gait + two-bone IK maths), `spider-world.js` (floor/roof, ray casts, anchors, corners), `spider-model.js` (loader and material fixes), `spider-anim.js` (procedural rig), `spider-controller.js` (ground/air/swing + web input state machine), `spider-input.js` (pointer lock, left button, look), `spider-camera.js`, `spider-targeting.js` (target selection + reticle), `spider-web.js`, `spider-install.js`, `portfolio-interaction.js`, `css/spider.css`, `content/portfolio.json`, `content/spider-man/scene.dat` (byte-identical copy of the model buffer, see below), `tools/serve.py`, and tests `tests/spider-*.test.cjs`.
Edited (small, additive): `js/main.js` (lazy install, loop calls, mode key and control hints), `js/controllers.js` (a `spider` entry in the teleport body table and an optional `onTeleport` hook), `js/traffic.js` (pedestrian-sized hitbox for Spider-Man).
Also changed because of download managers: the geodata files are now `js/building-geodata.dat` / `js/tree-geodata.dat` (were `.bin.gz`), and the model loader reads its geometry buffer from `content/spider-man/scene.dat` (a copy of `scene.bin`; the original model folder is untouched, and only the in-memory glTF is pointed at the copy). Internet Download Manager hijacked `.gz` and `.bin` requests and answered the game's `fetch()` with an empty 204.

## What changed in the polish pass
- **Animation architecture.** The model has no clips and its bone axes are irregular, so the rig is animated procedurally: every limb segment is *aimed* in model space (bind-pose direction onto a target direction), never rotated by Euler angles. `spider-anim.js` is a small state machine with continuous blending: ground (idle to walk to run to sprint, one gait driven by speed), air (TAKEOFF, RISE, APEX, FALL, PREP, LAUNCH) and swing, with per-state weights smoothed in time and directions blended on the sphere. A retargeted external humanoid clip set was judged not practical here: it would need a full skeleton retarget onto this rig's irregular axes, plus a licence and download decision, for a gain a gait solver already delivers. Same model, same skinning pipeline, same loader.
- **Running.** Feet follow a stance path (planted) and a lifted swing path; two-bone IK solves the legs, so knees, hips and ankles articulate at every speed. Cadence, stride, duty factor, foot lift, lean, pelvis/shoulder counter-rotation, arm swing and elbow flex all follow speed continuously (walk, jog, run, sprint). **Foot locking:** while a foot is in stance its ankle is pinned to a world position set at touch-down, and the model-space target is recomputed from the body's position and heading every frame, so turning, braking and accelerating cannot drag a planted foot; if the pinned foot would be out of the leg's reach it slides to the nearest reachable point.
- **Airborne.** Weights come from vertical speed, time since take-off or since a web release, and the predicted time to impact (from the height above the floor): a jump push-off, rise with counter-swinging arms, a tucked apex, a long fall with legs reaching down and arms thrown up, a landing preparation (legs reach forward and straighten, arms come down, head looks at the landing) and a stretched launch pose after a release. The whole body tilts along the velocity. Landing absorbs through the legs (crouch). The air pose's inputs are frozen at touch-down so it fades out instead of snapping.
- **Swinging.** The web arm points at the anchor (the hand side follows the side the anchor is on). The body leans forward and head-first on the way down and kicks the legs forward as it rises, banks into steering and turns, is stretched by rope tension, and coils (knees up, web arm pulled in, free arm swings forward) as the end of the arc approaches. Releasing blends into the launch pose.
- **Swing trajectory.** Targeting now simulates the first moments of each candidate swing with the same rope maths (`spider-swing-sim.js`) and ranks anchors by how far the body travels before the swing ends (45 m = full quality). An anchor on a facade straight ahead of the player ends in the wall and is ranked below anchors that carry the body past or around buildings; if nothing better exists it is still offered, so a click always works.
- **Camera** is a proper action camera: mouse look owns yaw and pitch, the crosshair ray is the camera's centre line, shoulder offset, speed-dependent distance and FOV (60 to 70, smoothed), look-ahead along the velocity, a pivot that rises slower than it falls, building pull-in that is immediate with slow release, ground/roof floor. **It never rotates by itself on the ground or in the air**, and while swinging only nudges towards the travel direction when that is already within about 30 degrees of where you look and the mouse has been still for 0.6 s; it never changes pitch by itself. While swinging the character sits lower in the frame. CameraSystem's own drag and gamepad offsets are discarded while it is active.
- **Swing control** keeps the rope solver (4 sub-steps, rope as an inequality constraint). The push is projected into the rope's tangent plane and split relative to the travel direction: along it pumps (or brakes), across it turns with an acceleration that grows with speed (a turn rate, not a fixed push) and does no work, so it cannot add energy. Pumping fades out towards the speed cap. Reeling is slower (16 m/s) and limited to 50% of the rope.

## What was tested, and how
- **Unit tests** (`node --test tests/*.test.cjs`, 313 tests, 312 pass; the failure is the missing `python3` alias): gait (foot sliding, duty factor, continuity, IK reach and degenerate inputs), physics (swing steering neutral/energy/NaN), world (corners, anchor enumeration, line of sight), targeting (scoring, on-screen only, hysteresis, line of sight, behind/low/zip rejection, projection), controller web state machine (press, hold, release, tap grace, buffer, no re-attach while held, Space release, paused, steering, rope constraint, no spikes), input (pointer lock, buttons, Esc, fallback, look signs), camera (look, no fighting, idle drift, walls, FOV, frame-rate independence, activation) and integration (modes, kill switch, controls text).
- **In the browser** (Intel GPU pane, which runs at 1-9 fps, so the real-time feel is not judged): the city loads with Spider-Man active; the ring sits on a roof corner when looking up; clicking launches a swing from the street; a stepped scripted sequence (run, sprint, jump, land, web, steer, release) ran without NaN, rope violations or bone pops; screenshots confirmed the run, sprint, leap and swing poses and the mid-swing camera.
- **Other modes:** taxi, helicopter, walk and cycle each still show their own label, hints and FOV; `?spider=0` loads no Spider-Man resources.

## Tuning the feel live (`?spiderTune`)
Open `http://localhost:8080/?spiderTune` for a panel of 47 sliders (Movement, Swing, Camera, Targeting, Animation) on the right. Every slider writes straight into the config the game reads each frame, so changes apply immediately; values persist in the browser, changed rows are highlighted, **Reset** restores the defaults and **Copy changes** puts a JSON of every value that differs from the defaults on the clipboard. Paste that back and the numbers become the new defaults. After a drag the slider releases focus, so W A S D keep working. Esc frees the mouse so you can reach the panel; click the game to capture it again. The panel is only loaded with the parameter (`js/spider-tuning.js`); the normal game never imports it.

Defaults changed in the tuning pass (no player feedback yet, so these are reasoned, not measured):
- **Camera:** the pivot follows tighter as speed grows (14 to 24) so the character stays nearer the frame centre at 40 m/s.
- **Swing:** the reel-in eases in over 0.3 s (`reelRamp`), so the web no longer yanks the instant it attaches.
- **Animation:** cadence, foot lift, forward lean and arm swing have multipliers (`Animation` group), default 1.


## Raimi character, clip animation and 3D web (latest pass)
- **Model.** The default character is now the Sam Raimi era Spider-Man (Mixamo skeleton, `content/spider-raimi/spider-raimi.glb`), converted from the supplied FBX with Three.js (`tools/model-lab.html`); `?spiderModel=ps4` or any load failure falls back to the original PS4 model. Inspection, conversion and verification details, and the licence caveat, are in `content/spider-raimi/README.md`. Compared with the PS4 model it has one clean skeleton with standard Mixamo bone names (76 skin joints, fingers, helper twist bones), normalised 4-influence skin weights, 10 draw calls, 1.82 m, and 2048 px suit maps with roughness.
- **Animation.** `js/spider-clips.js` plays 14 baked Mixamo clips (see the next section and `content/spider-raimi/ANIMATION_CATALOG.md`); the procedural rig stays as a layer. Without clips, or with `?spiderClips=off`, the procedural rig animates everything exactly as before; `?spiderClips=xbot` (development) plays the Three.js example Xbot's idle / walk / run.
- **Web.** `js/spider-web.js` is now real geometry: a braided cord of three twisted strands (615 vertices, one draw call, rebuilt in world space every frame) from the hand bone (after the matrices are refreshed, so it does not lag the pose) to the anchor. It sags with rope slackness (nearly straight when taut), shoots out in about 0.1 s, and on release whips back into the hand while thinning and going slack; slightly thicker with camera distance so it never vanishes; lit with a hint of emission; a small splat marks the anchor. The rope physics are unchanged.

## Mixamo animation library integration
37 FBX files were inspected (all compatible with the Raimi skeleton) and 11 became game clips (14 with the mirror images): idle, walk, run, sprint, jump, fall, hard landing, run-to-stop, start swinging, swinging, swing-to-land. The full per-file catalogue, the selection reasons, the Running-versus-Sprint comparison and the measurements are in `content/spider-raimi/ANIMATION_CATALOG.md`.
- **State machine** (`createClipRig`): every clip is an action whose time is set by the game each frame (nothing free-runs). Ground: idle / walk / run / sprint blended by speed on one phase advanced at ground speed / stride (stride from the clip's root speed; capped at 2.1x the clip's own cadence), cycles aligned at left-foot contact. Air: the jump clip is scrubbed through its measured flight window by the vertical speed, then the fall loop, then the clip's landing absorb (hard landing above 14 m/s impact). Stop: the run-to-stop settle, triggered by the recent peak speed (the game brakes from a sprint in 0.25 s). Swing: start clip, then the swinging clip scrubbed by the pendulum (it cannot loop), the left or right version by `webSide`; the swing-to-land flip when released with 0.8-2.4 s to impact, scrubbed so the feet land when the body does.
- **Arm retarget fix (ground locomotion).** The Raimi model rests in an A-pose (arms 42° down) and the Mixamo clips start from a T-pose, so the world-space retarget put every arm 42° too far in (crossed hands, forearms in the chest). `bakeRetarget(..., { armRest: 'align' })` first turns each arm segment onto the source's rest direction (`armSpread` adds a few degrees of clearance); on for idle, walk, run, sprint, hardLand, runStop, off for jump, fall and the swing clips (bit-identical to before). Arm segments now match the source to 0.0° (were 42-45°); left arm to right arm clearance 20-52 cm (was 0.1-0.7 cm). Details and the landing evaluation: `content/spider-raimi/ANIMATION_CATALOG.md`.
- **Procedural layer kept**, per bone: web arm 1.0 while swinging (its world aim at the anchor is restored after the torso is blended), hips and spine 0.35, head 0.5, legs 0.2, free arm 0.3, all faded with the release; launch pose after a release; accel / brake lean and turn bank on top of the clips; the full procedural pose for any state without clips.
- **Physics untouched**: the controller and swing simulation do not know the clip layer exists (a test checks it).
- **Measured** (probe through the real controller, ball-of-foot planted runs): foot slip 3.3 % at 8.5 m/s, 18.5 % at 15 m/s (a mocap clip made for 5.9 m/s cannot plant its feet at 15 m/s), 18.7 % on the first step from rest; peak leg bone speed 26-41 rad/s everywhere; web arm 0-3° off the anchor after the first 0.2 s. Automated tests 321 / 322 (the one failure is `python3` missing in the shell). **Not** visually checked in real time: the Browser pane renders at 1-9 fps, only stills of the swing, the sprint and a landing were looked at.

## Animation validation (what was measured, and how)
`tools/anim-probe.js` is a dev-only script (never loaded by the game): open the page with `?spiderDebug`, run `const probe = await import('/tools/anim-probe.js'); window.__probe = probe.install();`, then `__probe.report([2, 4, 8.5, 15])`, `__probe.groundBattery()`, `__probe.jumps()`, `__probe.rooftopFall()`, `__probe.swingRelease(lookYaw, holdFrames)`. All numbers below were measured in the browser through the real controller at 60 fps of simulated time (the test pane renders at only 1-9 fps, so wall-clock speed was not judged).

| Check | Result |
|---|---|
| Stance foot slip, isolated gait at 2 / 4 / 6 / 8.5 / 12 / 15 m/s | 0.00% at every speed (an earlier "15%" was a measurement error: it counted swing frames and was off by one frame; the corrected baseline before foot locking was 3-18% growing with speed) |
| Stance foot slip through the real controller, steady run and sprint | 0.00% |
| Turning (A/D weave) | 8.0% before foot locking, 0.03% after; hard sprint weave 0.00% |
| Braking (run, stop, run) | 6.8% before, 0.75% after (worst frame 27%: the pinned foot has to slide when the body stops faster than its reach allows) |
| Standing jump, running jump | takeoff, rise, apex, landing preparation, ground: weights progress in order, peak bone speed 13 and 29 rad/s |
| Walking off a 189 m roof (long fall, hard landing at 56 m/s) | peak bone speed 24 rad/s (was 76 before the air-pose timers were frozen at touch-down) |
| Swings looking left and right, released after 0.4 / 1.2 / 2.3 / 3.7 s | web hand follows the anchor side, peak bone speed 17-30 rad/s in every phase, no NaN |

**Visually inspected** (screenshots from the game camera, rear view): the run and sprint, the jump take-off (arms driving up), the apex and the landing preparation (arms out, legs apart). **Not** visually judged: motion quality in real time, the swing and release poses in motion (the test camera could not frame a swinging character), the side view of the stride. Numbers show the poses are continuous and the feet are planted; they do not show that it looks good.

## Known limitations
- **Not play-tested by hand at 60 fps.** Feel, camera comfort and animation timing at full speed are unjudged; tuning values are in `spider-physics.js` (`SPIDER`), `spider-camera.js` (`CFG`) and `spider-targeting.js` (`CFG`).
- **Pointer lock could not be exercised in the test pane** (the browser pane does not grant it). The input logic is unit-tested against a fake pointer-lock API, but a real mouse in a real browser is the thing to try first.
- Animation is Mixamo clips plus the procedural layer. Wall-running, climbing, zipping and landing rolls are not there (the roll clip was tested and dropped: the landing physics stops the body in 0.2 s); fingers are not individually posed; at sprint speed the feet slide about 18 % of the body's movement.
- Anchors are only on roof-edge facade points and corners of buildings 16 m or taller (and landmark boxes), at least ~18 m above the street. Parks, bridges and piers have none.
- Camera collision handles buildings, the ground and roofs, not trees or props.
- No touch or gamepad support for Spider-Man, and no Spider-Man sounds.
- The model is the unoptimised original (about 134K visible triangles, textures downscaled to 1024 at load).
- One placeholder portfolio point with placeholder text.

## How to test the new controls in the browser
1. `python tools/serve.py 8080`, open `http://localhost:8080/` (a hard reload after pulling these changes: `Ctrl+Shift+R`).
2. Click the game once (captures the mouse), move the mouse to look. Esc frees the mouse; click again to recapture.
3. Look up at a tall building: a ring appears on a roof edge or corner. Move the mouse to another building: the ring follows. Look at nothing: the crosshair dims.
4. Press and hold the left mouse button: Spider-Man shoots to the ring (from the street he hops first). Hold W to pump, A / D to steer, release the button to let go; Space lets go with a hop. Tap-and-release quickly: the web stays up for a moment (0.18 s) and then lets go.
5. Run (W), sprint (Shift), jump (Space) and land from height to see the run, airborne and landing poses.
6. `?spiderDebug` gives `window.__spider` (`controller`, `camera`, `targeting`, `input`, `rig`) for inspection; `?spider=0` disables the prototype.

### Wall traversal (no key): run, crawl, cling
There is no button for walls: the way he moves catches them. One system, two states that hand over to each other (`wall` = the run, `cling` = the crawl and the cling), all numbers in `SPIDER` (`wall*`, `cling*`, `mantle*`).
- **Catching a wall.** *Run*: in the air at 5.5 m/s or more with the stick toward or along a flat facade at least 5 m tall (a jump, a web release), or hitting a facade at 8 m/s or more at an angle (no stick needed: an impact keeps its momentum), or **sprinting (Shift) at 7.5 m/s or more straight at a facade from the ground**. *Crawl*: pushing the stick straight at a wall (within 45 degrees) at least 3.5 m tall for 0.3 s on the ground, 0.1 s in the air; or rising into the underside of a slab. Walking along or past a wall, a stick pointing away, a short, narrow or uneven wall never attach.
- **The run** keeps the speed (a head-on approach turns into climb speed), up to 2 s. When it is over (stick released, time or speed gone, a corner) it hands over to the crawl with the same velocity, which is let go gently; he never just drops. A run that only met a corner goes on running on the next face while Shift is held.
- **The crawl** moves along the surface with the stick as the camera sees it: with the camera at the wall W is up, S down, A / D left / right; looking along the wall W goes along it; the stick towards the wall climbs. 2.4 m/s, 4.8 with Shift, an analog stick scales it. Shift **pressed** while crawling along a wall starts a run. With no stick he stays where he is: **the cling** (no gravity, zero velocity, 0.5 m from the wall, hands and feet on it). A stick held round a corner keeps going round it.
- **Leaving.** Space = jump off (away and up, the double jump is back and the wall can be caught again after 0.45 s, another wall at once). Left click with a target = web swing. Crawl down to the floor to stand; crawl up over the top edge for a **mantle**: he rises along the wall until his chest is 0.5 m under the roof, then goes over the edge onto the roof (about 3.2 m/s along that path, at least 0.55 s).
- **Ceilings** only where the collision data has an underside: box colliders that start above the ground (bridge decks, landmark parts). Buildings are solid prisms with a roof but no underside, so an overhang of a building is never caught. Roofs, floors and slopes are never clung to.
- **Camera** on a wall: 1.2 m further back, lower in the frame, and, while the mouse is idle and the camera already looks roughly that way (within 70 degrees), a gentle turn (0.7 per second) towards the wall (crawl) or along the run. It eases in and out; the mouse always wins.

## Brand New Day suit (default character)

`?spiderModel=raimi` loads the Raimi model, `?spiderModel=ps4` the original; a model that fails to load falls back (bnd -> raimi -> ps4). The suit is `content/spider-bnd/spider-bnd.glb`, converted from the
user's download by `tools/bnd-lab.html` (see `content/spider-bnd/README.md`: decimated to ~167k triangles, UDIM textures packed into atlases, skinned to the Raimi Mixamo skeleton so every clip and the
procedural rig work unchanged). The eye frame has the suit's `Squint` / `Open` morph targets, driven by `js/spider-eyes.js` from the rig state. **Licence unconfirmed: do not publish.**
Verified: the file loads in the game (clips, rig and eye controller active), still renders of idle / swing / wall-cling poses, the two eye morphs rendered, unit tests. Not verified: real-time play.

## Portfolio boards in Times Square

All the portfolio boards (HQ, the projects, Skills, Contact) now hang on Times Square's own screens instead of being spread over the city, and the original generated posters there are removed.
`buildings.js` lists the 95 screen slots (`ManhattanCityBlocks.userData.timesSquareSlots`); `portfolio-billboards.js` `allocateSlots` gives each board the best slot (a wide shape, at most 42 m up,
in sight of a sidewalk, the identity board nearest the middle, F markers at least 16 m apart: they open within 6 m), draws it in the shape of the screen (a narrow screen gets the banner layout),
and shows it with `createLedScreenMaterial` (LED pitch, bezel, a slow sweep and a pulsing ticker, brighter than the old posters so it blooms). Every other slot shows a decor screen of the profile
(picture, kicker, title, text; a handful of textures reused). A board that finds no screen falls back to the old city-wide sites; `?portfolioTs=0` keeps the old city-wide boards and the posters.
Verified: the console reports 11 boards + 84 decor screens, no poster left, 9 F points and the pins in the square, stills of the screens in the game, the map; unit tests. Not verified: frame rate
in the square (the pane runs at 1-10 fps) and real-time play.

## Headfirst freefall dive (`js/spider-freefall.js`)

A long, fast fall (more than 9 m/s down for 0.08 s, at least 0.3 s in the air, 0.75 s or more to impact: a drop of ~14 m or more) turns into a headfirst dive. The module is pure: it reads the state the
controller already gives the rig (vertical and horizontal speed, time to impact, swing / wall / cling / double-jump state, heading) and returns a target pose and weights; it moves nothing.
`spider-anim.js` blends the pose into the air pose (`blendDive`: the head first, then chest and pelvis, then the arms, the legs last on the way in, the reverse on the way out; directions on the sphere,
the whole-body pitch through the body quaternion's slerp), `spider-clips.js` forces the procedural layer on while the dive has weight and blends the clip pose per bone group (so the entry starts
from the clip's actual pose), and `handPose` curls the fingers and straightens the wrists. The controller, physics, web and camera files are not touched.

Pose: the body pitched 90 degrees + the dive angle (26..45 degrees below the horizon, following the velocity) about the chest, chest to the ground; slight chest inclination, no arch; arms swept back along
the torso (upper arm ~19 degrees back, ~17 degrees out; forearm a little less back: slightly bent elbow); legs behind the pelvis, modest gap, knees slightly bent, toes pointed; fingers slightly curled.
Phases: entry 0.38..0.62 s (faster the faster the fall), sustain (deterministic drift: sums of sines of the accumulated clock, damped the faster the fall), exit 0.1..0.3 s (landing: done before the
touch-down, web 0.2 s, wall 0.18 s, double jump 0.2 s, slow-down 0.3 s). Faster falls tighten the pose (arms in and back, legs together and straighter) and steepen the body; turns twist the torso.
Rigs: Mixamo (Raimi and Brand New Day models) and the original PS4 skeleton both go through `findBones` (hips, head, spine[3 or 7], thigh, knee, ankle, upper arm, forearm, hand). Fingers are the chains under
the wrist; a model without finger bones (or with unskinned ones, as the Brand New Day model: its hands are rigid) just has no finger curl. Camera: unchanged; the chase camera sees the back, the trailing
legs and the arms along the sides.
Verified: unit tests (state machine, blending, pose, velocity response, determinism, ten-minute quaternion stability, rig mappings, wiring), scripted simulation in the real rig at 30 / 60 / 144 fps (poses agree within
0.04 rad), restoration of every bone after a dive, still renders of both rigs, a real-controller drop from 170 m in the game camera (dive started at 10 m/s, sustained at terminal speed, let go ~0.55 s before the
impact, upright landing). Not verified: real-time motion quality (the preview pane runs at ~1 fps) and a hand-played swing / wall transition.

### Times Square decor screens: a varied pool, not repeats

The 84 screens that are not key boards no longer repeat five boards. `decorDesigns` builds ~65 designs from the profile in seven styles (project hero picture, colour poster, giant keyword, scrolling ticker,
website banner, a count such as "8 PROJECTS", abstract web art) in seven Times Square colour themes; `decorPool` gives each screen shape (wide / square / tall) its own part of the pool (24 / 12 / 12 designs,
at 960x480 / 640x640 / 512x768); `planDecor` assigns them greedily so that the same subject stays ~180 m away from itself and from the key board about it, an identical design ~240 m, no style sits
next to itself on a wall and nothing is stacked twice. Measured on the real city: 39 designs on 84 screens, none more than 5 times, the closest identical pair 53 m apart, no subject stacked on a wall,
the closest copy of a key board's subject 51 m away. The owner's photo is only on the identity board.
