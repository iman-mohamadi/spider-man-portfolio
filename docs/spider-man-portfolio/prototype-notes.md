# Spider-Man prototype — notes

First playable prototype, built on branch `m0-foundations` (uncommitted). Everything is isolated in new files and loaded lazily; `?spider=0` skips it completely and restores the original game.

## Run it
Serve the repository root over HTTP (the project has no build step). Use `python tools/serve.py 8080` (same as `python -m http.server`, but it sends `Cache-Control: no-store` so the browser never mixes old and new modules), then open `http://localhost:8080/`. Needs a WebGPU-capable browser, as before. Spider-Man is the active mode on load. Add `?spiderDebug` to expose `window.__spider` for inspection.

## Controls
| Input | Action |
|---|---|
| W A S D | Move, relative to the camera. On the rope: push / brake along the swing (W / S) and turn it (A / D) |
| Shift | Sprint (on the ground). It has nothing to do with the web |
| Space | Jump. On the rope: let go with a small hop |
| Mouse | Look. The first click on the game captures the mouse (pointer lock); **Esc** frees it again |
| **Left mouse button** | **Web.** Aim with the camera until the ring is on the building you want, then press: shoots at the selected point. **Hold** to swing, **release** to let go (momentum is kept) |
| Wheel | Camera zoom |
| F | Interact (open or close the project panel); Esc also closes it |
| T, or the "Spidey" button | Switch to Spider-Man. 1-4 still select Walk / Drive / Cycle / Fly |

If the browser refuses pointer lock the game says so: clicks still shoot the web and you look by dragging with the **right** mouse button.

### Web targeting
- A small crosshair dot marks the centre of the screen. A **ring** (white, red and blue) sits on the anchor the web would hit: roof-edge facade points and building corners, 8-72 m away, high enough for the swing to clear the street, with a clear line of sight from you and from the camera. Faint dots show up to three alternatives.
- The target is chosen by where you **look** (bearing counts fully, elevation 60%), only from points that are actually on screen. Look up at the roof line to see targets on tall buildings. Turning the camera to another building moves the ring there.
- It is stabilised: a new target must be clearly better than the current one (about 30%) to take over, and the current one survives a quarter second without line of sight, so the ring does not jump between neighbouring buildings.
- No valid target: the crosshair dims; a click flashes it red and shows "No web target: aim at a building". A click is remembered for about 0.2 s, so a target found a moment later still attaches.
- On the ground a click is a web launch (a hop, then the rope). Anchors that would need more than half the rope reeled in are not offered (they would be a zip, not a swing).

## Files
New: `js/spider-physics.js` (pure maths), `spider-gait.js` (pure gait + two-bone IK maths), `spider-world.js` (floor/roof, ray casts, anchors, corners), `spider-model.js` (loader and material fixes), `spider-anim.js` (procedural rig), `spider-controller.js` (ground/air/swing + web input state machine), `spider-input.js` (pointer lock, left button, look), `spider-camera.js`, `spider-targeting.js` (target selection + reticle), `spider-web.js`, `spider-install.js`, `portfolio-interaction.js`, `css/spider.css`, `content/portfolio.json`, `content/spider-man/scene.dat` (byte-identical copy of the model buffer, see below), `tools/serve.py`, and tests `tests/spider-*.test.cjs`.
Edited (small, additive): `js/main.js` (lazy install, loop calls, mode key and control hints), `js/controllers.js` (a `spider` entry in the teleport body table and an optional `onTeleport` hook), `js/traffic.js` (pedestrian-sized hitbox for Spider-Man).
Also changed because of download managers: the geodata files are now `js/building-geodata.dat` / `js/tree-geodata.dat` (were `.bin.gz`), and the model loader reads its geometry buffer from `content/spider-man/scene.dat` (a copy of `scene.bin`; the original model folder is untouched, and only the in-memory glTF is pointed at the copy). Internet Download Manager hijacked `.gz` and `.bin` requests and answered the game's `fetch()` with an empty 204.

## What changed in the polish pass
- **Animation** is rebuilt around real gait mechanics instead of fixed sine swings. Feet follow a stance path (planted, moving backwards relative to the hips at exactly the ground speed, so no sliding) and a lifted swing path; two-bone IK solves the legs, so knees bend and the hips sink as needed at every speed. Cadence, stride, duty factor, foot lift, lean, torso twist, arm swing and elbow flex all follow speed continuously, so walking, running and sprinting differ (sprint: longer flight phase, deeper lean, higher knees, more arm drive). Pelvis and spine twist and roll with the stride, lean into acceleration and turns, the head stays level. Idle has weight shifting, breathing and head movement with incommensurate periods. Landing absorbs through the legs (IK) with arms thrown out. The airborne pose is chosen from vertical speed (rise: lead knee up, counter-swinging arms; float; fall: bracing legs, arms up and out) and the whole body tilts along the velocity. Swinging: the web arm points at the anchor, the other arm and the legs trail back with speed and rope tension, the body hangs from the rope and banks into steering. All blending is delta-time independent and spherical for directions; the air pose is frozen at touch-down so landing does not pop. Measured on a scripted run-jump-land-swing-release sequence, no bone exceeds 30 rad/s (before: 144).
- **Camera** is a proper action camera: mouse look owns yaw and pitch, the crosshair ray is the camera's centre line, shoulder offset, speed-dependent distance and FOV (60 to 70, smoothed), look-ahead along the velocity, a pivot that rises slower than it falls, building pull-in that is immediate with slow release, ground/roof floor. It only drifts towards the travel direction after the mouse has been idle for 0.9 s and never past about 100 degrees. CameraSystem's own drag and gamepad offsets are discarded while it is active.
- **Swing control** keeps the rope solver (4 sub-steps, rope as an inequality constraint). The push is projected into the rope's tangent plane and split relative to the travel direction: along it pumps (or brakes), across it turns with an acceleration that grows with speed (a turn rate, not a fixed push) and does no work, so it cannot add energy. Pumping fades out towards the speed cap. Reeling is slower (16 m/s) and limited to 50% of the rope.

## What was tested, and how
- **Unit tests** (`node --test tests/*.test.cjs`): gait (foot sliding, duty factor, continuity, IK reach and degenerate inputs), physics (swing steering neutral/energy/NaN), world (corners, anchor enumeration, line of sight), targeting (scoring, on-screen only, hysteresis, line of sight, behind/low/zip rejection, projection), controller web state machine (press, hold, release, tap grace, buffer, no re-attach while held, Space release, paused, steering, rope constraint, no spikes), input (pointer lock, buttons, Esc, fallback, look signs), camera (look, no fighting, idle drift, walls, FOV, frame-rate independence, activation) and integration (modes, kill switch, controls text).
- **In the browser** (Intel GPU pane, which runs at 1-9 fps, so the real-time feel is not judged): the city loads with Spider-Man active; the ring sits on a roof corner when looking up; clicking launches a swing from the street; a stepped scripted sequence (run, sprint, jump, land, web, steer, release) ran without NaN, rope violations or bone pops; screenshots confirmed the run, sprint, leap and swing poses and the mid-swing camera.
- **Other modes:** taxi, helicopter, walk and cycle each still show their own label, hints and FOV; `?spider=0` loads no Spider-Man resources.

## Known limitations
- **Not play-tested by hand at 60 fps.** Feel, camera comfort and animation timing at full speed are unjudged; tuning values are in `spider-physics.js` (`SPIDER`), `spider-camera.js` (`CFG`) and `spider-targeting.js` (`CFG`).
- **Pointer lock could not be exercised in the test pane** (the browser pane does not grant it). The input logic is unit-tested against a fake pointer-lock API, but a real mouse in a real browser is the thing to try first.
- Animation is procedural: there are no clips, so there is no motion-captured nuance. Wall-running, climbing, zipping and landing rolls are not there; feet can skate slightly in sharp turns; hands and feet are not individually posed.
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
