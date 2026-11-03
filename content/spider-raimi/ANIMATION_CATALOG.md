# Spider-Man animation library: audit and integration

Source: 37 Mixamo FBX files (15 in `content/spider-raimi/anims-src/`, 22 in `content/spider-raimi/anims-src/Action Adventure Pack/`), downloaded "Without Skin" for the Raimi Spider-Man character. The files are never modified; the game plays clips baked from them by `tools/model-lab.html` (`lab.convertAnims()`, selection in `tools/clip-selection.json`) into `content/spider-raimi/anims/`.

Everything below was measured by loading each FBX with three.js FBXLoader in the browser (`lab.inspectAnims`) and retargeting it onto the Raimi skeleton; numbers marked "m/s" for source files are in the Mixamo character's size (multiply by 0.956, the leg-length ratio, for the Raimi model).

## What every file has in common

| | |
|---|---|
| Files found / inspected | **37 / 37** (all parse; 7 pack files carry a footer 1 byte longer than FBXLoader allows and are parsed from an in-memory copy, see `loadFbxTolerant`) |
| Skeleton | 65 bones named `mixamorigHips`, `mixamorigSpine`..., no colon, identical hierarchy to the Raimi model (Hips > Spine > Spine1 > Spine2 > Neck > Head / shoulders > arms > fingers; Hips > UpLeg > Leg > Foot > ToeBase). **No bone of any clip is missing from the Raimi skeleton.** |
| Content | no meshes or skins (Without Skin); 53 tracks per clip: hips position + 52 bone rotations; no scale tracks; no other bone has a moving position track (so nothing stretches a different skeleton) |
| Units | centimetres, hips at about 97 cm in the rest pose (the Raimi hips are at 93.4 cm: legs 0.956 of the source) |
| Rate | 30 fps keys, except Walking Turn 180 (about 60 fps) and Turn To Running (72 fps) |
| Compatibility with the Raimi model | **All 37 are compatible.** Bone axes and roll differ from the model, so rotations are not copied: the clips are retargeted in world space (each bone moves away from its rest pose by the same world rotation), baked at 30 fps with the hips scaled by the leg ratio. Mirror images (left/right) were verified numerically to 1.64 cm. |

## The 37 files

Loop gap = the largest rotation difference of any bone between the last and the first pose (0° = the clip loops by itself). "Root motion" is the travel of the hips over the clip; clips that travel are baked with the travel removed (the controller moves the body) so that foot speed can be matched to the real ground speed.

| File | Action | Duration | Keys @ fps | Translation | Unwanted rotation | Loop gap | Type | Verdict |
|---|---|---|---|---|---|---|---|---|
| `Idle.fbx` | Standing idle, breathing and small weight shifts (10 s, no repeat to notice). | 10.00 s | 301 @ 30 | in place | yaw 0°, tilt 4° | 0° | gameplay loop | **USED idle** |
| `Walking.fbx` | Forward walk cycle. | 1.03 s | 32 @ 30 | root motion 1.85 m (1.79 m/s) | yaw 0°, tilt 4° | 0° | gameplay loop | **USED walk** |
| `Walking Backwards.fbx` | Backwards walk cycle. | 1.20 s | 37 @ 30 | root motion 1.36 m (1.13 m/s) | yaw 0°, tilt 10° | 0° | gameplay loop | **rejected** |
| `Walking Turn 180.fbx` | Walk, turn round 180 degrees, walk on. | 1.00 s | 60 @ 59 | in place | yaw -180°, tilt 6° | 180° | one-shot | **rejected** |
| `Running.fbx` | Forward run cycle (jog-run). | 0.63 s | 20 @ 30 | root motion 3.75 m (5.92 m/s) | yaw 0°, tilt 14° | 0° | gameplay loop | **USED run** |
| `Running Slide.fbx` | Run into a baseball slide on the ground. | 1.53 s | 47 @ 30 | root motion 6.70 m (4.37 m/s) | yaw 0°, tilt 61° | 0° | special move | **rejected** |
| `Running Forward Flip.fbx` | Run, leap and front-flip. | 1.10 s | 34 @ 30 | root motion 4.41 m (4.01 m/s) | yaw 0°, tilt 175° | 0° | special move | **rejected** |
| `Turn To Running.fbx` | Stand, turn on the spot, break into a run. | 1.70 s | 124 @ 72 | root motion 3.20 m (1.88 m/s) | yaw -113°, tilt 23° | 114.5° | one-shot | **rejected** |
| `Sprint.fbx` | Fast forward sprint cycle. | 0.53 s | 17 @ 30 | root motion 3.29 m (6.17 m/s) | yaw 0°, tilt 21° | 0° | gameplay loop | **USED sprint** |
| `Jumping.fbx` | Standing jump: crouch, push-off, arms-up flight, landing absorb. | 1.90 s | 58 @ 30 | in place | yaw 0°, tilt 22° | 1.5° | gameplay one-shot | **USED jump** |
| `Falling Idle.fbx` | Free-fall hold: arms out, legs bent, slight flutter. | 0.70 s | 22 @ 30 | in place | yaw 0°, tilt 4° | 0° | gameplay loop | **USED fall** |
| `Hard Landing.fbx` | The whole drop: starts 2.6 m up, falls, lands in a deep crouch and stands. | 2.50 s | 76 @ 30 | root motion 1.03 m (0.41 m/s) | yaw -9°, tilt 64° | 97.9° | one-shot | **rejected (the pack version is used)** |
| `Start Swinging.fbx` | Jump and reach with one hand, the pull that starts a web swing. | 2.03 s | 62 @ 30 | root motion 3.66 m (1.80 m/s) | yaw -58°, tilt 64° | 155° | gameplay one-shot | **USED swingStart** |
| `Swinging.fbx` | The swing itself: web hand up, body hanging, legs kicking forward then trailing. | 1.97 s | 60 @ 30 | root motion 5.17 m (2.63 m/s) | yaw 86°, tilt 46° | 120.1° | gameplay (scrubbed) | **USED swingLoop** |
| `Swing To Land.fbx` | Let go of the web at the end of the arc, flip, land in a crouch. | 1.87 s | 57 @ 30 | root motion 4.95 m (2.65 m/s) | yaw 367°, tilt 172° | 151° | gameplay one-shot | **USED swingLand** |
| `pack/cover to stand (2).fbx` | Leave a crouched wall cover and stand (variant). | 1.40 s | 43 @ 30 | root motion 1.00 m (0.71 m/s) | yaw 111°, tilt 23° | 111.8° | cover system | **rejected** (padded parse) |
| `pack/cover to stand.fbx` | Leave a crouched wall cover and stand. | 1.50 s | 46 @ 30 | root motion 0.98 m (0.65 m/s) | yaw 133°, tilt 25° | 133.6° | cover system | **rejected** |
| `pack/crouched sneaking left.fbx` | Crouched side-step to the left. | 1.27 s | 39 @ 30 | root motion 1.34 m (1.06 m/s) | yaw 0°, tilt 9° | 0° | stealth | **rejected** (padded parse) |
| `pack/crouched sneaking right.fbx` | Crouched side-step to the right. | 1.10 s | 34 @ 30 | root motion 1.24 m (1.13 m/s) | yaw 0°, tilt 24° | 0° | stealth | **rejected** |
| `pack/falling idle.fbx` | Free-fall hold. | 0.70 s | 22 @ 30 | in place | yaw 0°, tilt 4° | 0° | duplicate | **rejected (duplicate)** |
| `pack/falling to roll.fbx` | Fall, land into a forward roll, stand. | 1.80 s | 55 @ 30 | root motion 3.05 m (1.69 m/s) | yaw -9°, tilt 132° | 93.9° | gameplay one-shot | **converted, tested, then REJECTED** (padded parse) |
| `pack/hard landing.fbx` | Heavy two-foot landing from a fall: deep crouch, hand to the ground, stand. | 2.00 s | 61 @ 30 | in place | yaw -9°, tilt 64° | 97.9° | gameplay one-shot | **USED hardLand** |
| `pack/idle (2).fbx` | Standing idle. | 10.00 s | 301 @ 30 | in place | yaw 0°, tilt 4° | 0° | duplicate | **rejected (duplicate)** |
| `pack/idle (3).fbx` | Standing idle variant (small head/torso movement). | 3.27 s | 99 @ 30 | in place | yaw 0°, tilt 14° | 0.1° | idle variant | **not used** |
| `pack/idle (4).fbx` | Crouched idle (hips at 0.59 m). | 2.57 s | 78 @ 30 | in place | yaw 0°, tilt 11° | 0° | stealth | **not used** |
| `pack/idle (5).fbx` | Standing idle variant (ready stance). | 2.27 s | 69 @ 30 | in place | yaw 0°, tilt 15° | 0° | idle variant | **not used** |
| `pack/idle.fbx` | Standing idle (breathing). | 4.00 s | 121 @ 30 | in place | yaw 0°, tilt 6° | 0° | idle variant | **not used** |
| `pack/jumping up.fbx` | A very short hop upwards (0.23 s, 8 keys). | 0.23 s | 8 @ 30 | in place | yaw 1°, tilt 22° | 98.4° | one-shot | **rejected** |
| `pack/left cover sneak.fbx` | Sidestep along a wall in cover (left). | 1.13 s | 35 @ 30 | root motion 1.34 m (1.18 m/s) | yaw 0°, tilt 12° | 0° | cover system | **rejected** (padded parse) |
| `pack/left turn.fbx` | Turn on the spot to the left. | 1.03 s | 32 @ 30 | in place | yaw 0°, tilt 4° | 1.5° | one-shot | **rejected** |
| `pack/right cover sneak.fbx` | Sidestep along a wall in cover (right). | 1.13 s | 35 @ 30 | root motion 1.34 m (1.18 m/s) | yaw 0°, tilt 12° | 0° | cover system | **rejected** (padded parse) |
| `pack/right turn.fbx` | Turn on the spot to the right. | 1.03 s | 32 @ 30 | in place | yaw 0°, tilt 7° | 0° | one-shot | **rejected** |
| `pack/run to stop.fbx` | Run, brake and settle into a standing pose. | 0.90 s | 28 @ 30 | root motion 0.81 m (0.90 m/s) | yaw -46°, tilt 25° | 75.4° | gameplay one-shot | **USED runStop** |
| `pack/running.fbx` | Forward run cycle (slower jog, 0.7 s). | 0.70 s | 22 @ 30 | root motion 3.32 m (4.74 m/s) | yaw 0°, tilt 10° | 0° | gameplay loop | **not used** |
| `pack/stand to cover (2).fbx` | Crouch into wall cover (variant). | 1.27 s | 39 @ 30 | root motion 1.21 m (0.96 m/s) | yaw -133°, tilt 20° | 133.6° | cover system | **rejected** (padded parse) |
| `pack/stand to cover.fbx` | Crouch into wall cover. | 1.13 s | 35 @ 30 | root motion 1.18 m (1.04 m/s) | yaw -111°, tilt 17° | 112° | cover system | **rejected** (padded parse) |
| `pack/walking.fbx` | Forward walk cycle. | 1.03 s | 32 @ 30 | root motion 1.85 m (1.79 m/s) | yaw 0°, tilt 4° | 0° | duplicate | **rejected (duplicate)** |

Reasons for the verdicts, one line per file:

- `Idle.fbx`: Longest loop, truly in place, loop gap 0 deg. The idle (2) file in the pack is the same animation.
- `Walking.fbx`: Clean loop (gap 0 deg), root motion 1.79 m/s gives the stride. Same animation as the pack walking (identical keys and measurements, different bytes).
- `Walking Backwards.fbx`: The character always faces where it goes (the controller turns the body to the velocity); there is no backwards gait to drive.
- `Walking Turn 180.fbx`: Rotates the hips by 180 deg itself and cannot loop (180 deg gap): it would fight the controller, which owns the heading and turns it at its own rate.
- `Running.fbx`: Clean loop, root motion 5.92 m/s (5.66 m/s on the Raimi legs), 0.63 s cycle.
- `Running Slide.fbx`: Hips drop to 0.25 m and the body tilts 61 deg: a slide mechanic the game does not have.
- `Running Forward Flip.fbx`: Full 175 deg somersault in the air (needs a trick button and its own physics). Possible later as a trick; not part of this pass.
- `Turn To Running.fbx`: Turns the body 113 deg itself, 72 fps keys, 114 deg loop gap: the heading belongs to the controller.
- `Sprint.fbx`: Clean loop, root motion 6.17 m/s (5.90 on the Raimi legs), 0.53 s cycle, lower head and more forward lean than Running.
- `Jumping.fbx`: In place. Feet leave at 0.55 s and touch down at 1.10 s (measured), so the flight is scrubbed by the vertical speed.
- `Falling Idle.fbx`: In place, 0.7 s, loop gap 0 deg. Same animation as the pack falling idle.
- `Hard Landing.fbx`: Contains the fall as well (hips 0.47..2.6 m) and 1 m of travel; the pack hard landing has only the landing.
- `Start Swinging.fbx`: The reach/pull is the point; hips 2.4-3.4 m (it hangs high), so the hips are baked crouch-only and the physics owns the height. Right hand in the original.
- `Swinging.fbx`: Not loopable (120 deg gap between first and last pose), so it is not played: it is a pose bank scrubbed by the pendulum phase. Left hand in the original.
- `Swing To Land.fbx`: Full flip (172 deg tilt), feet touch down at 1.32 s (measured): scrubbed so that touch-down coincides with the real landing. Left hand in the original.
- `pack/cover to stand (2).fbx`: No cover system in the game.
- `pack/cover to stand.fbx`: No cover system in the game.
- `pack/crouched sneaking left.fbx`: No crouch-walk, no strafing: the body faces its direction of travel.
- `pack/crouched sneaking right.fbx`: No crouch-walk, no strafing.
- `pack/falling idle.fbx`: Same measurements as Falling Idle.fbx in the root folder (0.7 s, 22 keys, identical heights).
- `pack/falling to roll.fbx`: Tested in the game: the landing physics stops the body in about 0.2 s, so the roll plays in place; mixed with the standing pose the somersault (hips tilt 132 deg) also bent the interpolation (87 rad/s spike). The hard landing fits the physics.
- `pack/hard landing.fbx`: In place (0.17 m), first contact at 0.07 s, then the absorb and the recovery.
- `pack/idle (2).fbx`: Same measurements as Idle.fbx (10 s, 301 keys).
- `pack/idle (3).fbx`: Loops (0.1 deg gap). Only one idle is needed; a second one could be picked at random for variety later.
- `pack/idle (4).fbx`: No crouch state in the game.
- `pack/idle (5).fbx`: Loops. There is no combat system, so a combat idle has nothing to be selected by.
- `pack/idle.fbx`: Loops. 4 s; the 10 s Idle.fbx hides the repetition better.
- `pack/jumping up.fbx`: Too short to carry a jump (no flight, no landing); 98 deg loop gap. Jumping.fbx covers the full arc.
- `pack/left cover sneak.fbx`: No cover system.
- `pack/left turn.fbx`: The controller already turns the body; an authored turn would fight its heading.
- `pack/right cover sneak.fbx`: No cover system.
- `pack/right turn.fbx`: Same as left turn.
- `pack/run to stop.fbx`: Plays in place from 0.12 s (feet already planted), 0.9 s long; the settle after the game has braked to a standstill.
- `pack/running.fbx`: Loops, but root speed 4.74 m/s (4.5 on the Raimi legs) is further from the game speeds than Running (5.66); the game runs at 8.5 and 15 m/s.
- `pack/stand to cover (2).fbx`: No cover system.
- `pack/stand to cover.fbx`: No cover system.
- `pack/walking.fbx`: Same measurements as Walking.fbx (1.033 s, 32 keys, 1.85 m).

## Selected clips and how they are baked

| Slot | Source | Hips | Root | Duration | Root speed | Foot speed | Notes |
|---|---|---|---|---|---|---|---|
| `idle` | `Idle.fbx` | full | strip | 10 s | 0 m/s | 0 m/s |  |
| `walk` | `Walking.fbx` | full | detrend | 1.0333 s | 1.708 m/s | 1.642 m/s |  |
| `run` | `Running.fbx` | full | detrend | 0.6333 s | 5.661 m/s | 4.526 m/s |  |
| `sprint` | `Sprint.fbx` | full | detrend | 0.5333 s | 5.9 m/s | 4.576 m/s |  |
| `jump` | `Jumping.fbx` | crouchOnly | strip | 1.9 s | 0 m/s | 0.339 m/s | flight 0.55..1.1 s |
| `fall` | `Falling Idle.fbx` | crouchOnly | strip | 0.7 s | 0 m/s | 0 m/s |  |
| `hardLand` | `Action Adventure Pack/hard landing.fbx` | full | strip | 2 s | 0.081 m/s | 0.582 m/s | first contact 0.0667 s |
| `runStop` | `Action Adventure Pack/run to stop.fbx` | full | strip | 0.9 s | 0.864 m/s | 0.571 m/s | first contact 0 s |
| `swingStart` | `Start Swinging.fbx` | crouchOnly | strip | 2.0333 s | 1.719 m/s | 0.519 m/s | original hand R, mirror `swingStartM` |
| `swingLoop` | `Swinging.fbx` | crouchOnly | strip | 1.9667 s | 2.512 m/s | 1.169 m/s | original hand L, mirror `swingLoopM` |
| `swingLand` | `Swing To Land.fbx` | full | strip | 1.8667 s | 2.535 m/s | 0.806 m/s | original hand L, mirror `swingLandM`; flight 0..1.3167 s |

Root speed is the speed the clip really covers (its root motion on the Raimi legs); foot speed is what the planted foot implies, which is less reliable (heel-toe roll). The stride used by the game is `rootSpeed x duration`.

`crouchOnly` hips keep only the dips below standing height: the physics owns the height of the body in the air and on the web, but a crouch for a landing still counts.

## Sprint.fbx against Running.fbx at the game's real speeds

The game moves at **8.5 m/s** (run) and **15 m/s** (shift). Both clips were made for about 5.7-5.9 m/s on these legs, so neither plays "at its own speed": the cycle has to turn 1.5x faster at 8.5 and 2.6x faster at 15. The animator advances ONE shared phase at `ground speed / stride` (stride = the clip's root speed x its duration: 3.58 m for Running, 3.15 m for Sprint), capped at 2.1x the clip's own rate so the legs never become a blur.

| | Running | Sprint |
|---|---|---|
| Cycle | 0.63 s | 0.53 s |
| Root speed (Raimi legs) | 5.66 m/s | 5.90 m/s |
| Stride | 3.58 m | 3.15 m |
| Posture | head 1.46-1.55 m, hips tilt 14° | head 1.33-1.45 m, hips tilt 21° (lower, forward) |
| Foot slip at 8.5 m/s (planted toe, 3+ frames) | 3.3 % | 3.7 % |
| Foot slip at 15 m/s | 20.2 % | 18.8 % |

(each clip forced alone through the same probe; the shipped blend measured 3.4 % and 18.3-18.8 %.)

Both slide the same at every speed, so the choice is posture: Running below 9 m/s, Sprint above 13 m/s, a smoothstep blend between (`sprintFrom`/`sprintTo`). At 15 m/s no mocap clip made for ~6 m/s can keep the feet planted: the cap limits the legs to 12.4 m/s of foot travel, the remaining 2.6 m/s (about 18 %) is slide. That is an honest limit of this library, not a tuned-away number.

## Swing state machine: Start Swinging, Swinging, Swing To Land

The swing physics (`spider-swing-sim.js`, the controller) is untouched; the clip layer only receives its state (`swinging`, `webSide`, `vy`, `landIn`, anchor) and never writes position or velocity.

| State | Clip | How it is played |
|---|---|---|
| Attach | `swingStart` (hand chosen by `webSide`) | from 0.15 s, plays forward for about 0.9 s (the reach and pull), then hands over to the loop |
| Hanging | `swingLoop` | **not played, scrubbed**: the clip cannot loop (120° gap), so its time follows the pendulum, `t = lerp(0.02, 0.47, smoothstep(-0.6, 0.8, vy/16)) x duration` (legs forward on the way up, trailing on the way down) |
| Web arm | procedural | weight 1.0 on the web arm bones, and the arm's WORLD aim at the anchor is restored after the torso is blended, so the hand cannot drift off the target; hips 0.35, spine 0.35, head 0.5, legs 0.2, free arm 0.3 |
| Release | fall / jump clip, plus the procedural launch pose (0.8 fading over 0.5 s) | the procedural swing weight fades with the release instead of switching |
| Landing from the swing | `swingLand` flip when the time to impact is 0.8-2.4 s and the speed above 5 m/s | scrubbed to `airEnd(1.317 s) - landIn`, never faster than 3.2x real time, so the feet touch exactly when the body does; the crouch plays on from 1.317 s at 1.25x |

The left-hand and right-hand versions: `Start Swinging` is a right-hand reach, `Swinging` and `Swing To Land` are left-hand in the originals; the converter measures which hand is higher (`meta.hand`) and writes the mirror image as `<name>M`; the runtime takes the one whose hand matches `webSide`.

## Transitions implemented

| Transition | How |
|---|---|
| Idle → Walk → Run → Sprint | speed-weighted blend of four clips on one phase, aligned at left-foot contact so the legs never cross when blending |
| Sprint → Stop | the game brakes from 15 m/s to 0 in about 0.25 s; the `runStop` settle (0.12 s in, 1.5x) is triggered by the recent peak speed, cancelled when the player accelerates again |
| Run → 180° turn | the controller brakes, turns and accelerates (8.5 → 0.9 → 8.5 m/s in half a second): walk/run blend plus the stop settle fading out as speed returns; bank and lean from the yaw rate |
| Jump → Fall → Landing | `jump` scrubbed by the vertical speed through its measured flight window, `fall` loop after the apex, then the clip's own landing absorb (1.10 s on) on touch-down |
| Sprint → Jump → Landing → Run | the same, with the landing weight fading as speed returns |
| Hard fall → Landing | `hardLand` (first contact at 0.07 s) above 14 m/s impact speed |
| Start Swinging → Swing Loop | start clip hands over to the pendulum-scrubbed loop |
| Swing Loop → Release → Falling | per-bone procedural share fades smoothly (a hard switch gave a 103 rad/s pop at the release frame; fixed) |
| Swing Release → Rooftop Landing | `swingLand` flip when the geometry allows it, else fall and hard landing |
| Swing To Land → Running | the crouch fades into the locomotion blend as speed returns |

## Validation

Three levels, kept apart on purpose.

### 1. Automated tests (node, no browser)

`node --test tests/*.test.cjs`: **322 tests, 321 pass.** The 1 failure is `tree generator ...` and is the environment (the test calls `python3`, a Microsoft Store alias on this PC), not this work. New in `tests/spider-clips.test.cjs`: the selection file, the manifest (all slots present, mirror images, measurement fields, locomotion speeds ordered, jump flight inside the clip, opposite hands), the baked data of all 14 clips (finite, unit quaternions, increasing times, identical bone set), and the state-machine contract (scrubbed not free-running, web arm procedural, no writes to the body, the physics files do not import the clip layer).

### 2. Motion measured in the browser (probe driving the real controller at 60 fps)

`tools/anim-probe.js` (dev-only, never loaded by the game) steps the real controller and reads the bones, so these are numbers from the game's own code, not renders. The page itself ran at 1-9 fps in the Browser pane, so the loop was stepped by hand.

Foot slip: ball of the foot (ToeBase), planted = within 4 cm of its lowest height for 3+ frames; slip = the foot's net movement over the body's net movement in that stretch.

| Case | Clips (shipped) | Procedural rig (`?spiderClips=off`) |
|---|---|---|
| Run steady 8.5 m/s | **3.3 %** (worst run 7 %) | 9.6 % (worst 14 %) |
| Sprint steady 15 m/s | **18.5 %** (worst 21 %) | 13.7 % (worst 21 %) |
| Start from rest, first second | 18.7 % (worst run 193 %: the very first foot while the body has barely moved) | 7.2 % (worst 50 %) |
| Run, weaving A/D | 10.5 % | 15.7 % |
| Sprint, hard weaving | 9.1 % | 11.1 % |

Leg bone angular speed (pops): steady run 28 rad/s, steady sprint 39, start from rest 27, weaving 26-39; the procedural rig showed 76 rad/s at the start from rest. No spike above 41 rad/s anywhere in the ground, jump, landing and swing sequences after the fixes below (a running leg is 15-40 rad/s).

Web arm against the anchor (angle between shoulder→hand and shoulder→anchor, whole swing): mean 4.2-7.0°, 0-3° from 0.2 s after the attach on, against 4.3-4.9° mean for the procedural rig. The arm needs about 0.1-0.2 s to reach after the attach (first frames 94-134° away while it rises from the idle pose; the procedural rig started at 70-82°).

Defects found by this measurement and fixed: (1) the stop settle never fired because the game brakes from a sprint in 0.25 s (now uses the recent peak speed); (2) 103 rad/s pop at the release frame (per-bone swing weights switched off with the state instead of fading); (3) the web arm drifted 6-17° off the anchor once the torso was blended with the clip (the arm's world aim is now restored); (4) 87 rad/s spike in the roll (shortest-path interpolation across a 180° pose, which is why the roll was dropped); (5) the dev fallback (no air clips) snapped at touch-down (70 → 12 rad/s).

### 3. Visually verified in real-time gameplay

**Not done.** The Browser pane renders this scene at 1-9 fps, so no real-time playback could be judged. What was looked at, as still screenshots of the real game with the state machine driving the model: mid-swing (web arm up toward the anchor, legs hanging), mid-sprint seen from behind, the crouch after a swing-to-land flip. The mid-air flip, the hard landing, the left-hand versus right-hand mirror, the jump arc and the walk/run blend were checked only numerically.

## Remaining issues

- **Sprint at 15 m/s: the planted feet slide about 18 % of the body's movement** (see above); only a faster clip or a foot IK on the clips would remove it. The start from rest also slides on its first step (18.7 %).
- No real-time visual check (pane too slow); a person should play it for a minute: jump arcs, the flip landing timing and the left/right swing hands first.
- `Swinging.fbx` is a pose bank, not a loop; the pendulum mapping (`0.02..0.47` of its length) was chosen from the clip's pose content and is not tuned by eye.
- The roll (`falling to roll`) was converted, tested and dropped: the game's landing physics takes the body's momentum away within about 0.2 s, so a travelling roll plays in place. If landings should carry momentum, the roll is the clip to bring back.
- `idle.json` is 1.8 MB (10 s at 30 fps); it could be thinned. Total baked clips: about 5.4 MB across 14 files + manifest.
- The Raimi model licence is still unconfirmed (see `README.md`).

## Ground locomotion fix: why the arms crossed (and what changed)

**Root cause: a rest-pose mismatch in the retarget, not the Mixamo clips, not the procedural layer.** Every Mixamo clip is authored from a **T-pose** (upper arms horizontal). The Raimi model was modelled in an **A-pose**: its upper arms rest 42° below horizontal (forearms 41°, hands 44°) and its clavicles 19° down (Mixamo 3°). The world-space retarget moves each bone "by the same world rotation away from its rest pose", which is only right when both rest poses agree. With the arms already 42° down, every arm in every clip ended up 42° too far down and in: hanging arms swung across the front of the pelvis and, in a run, the pumping forearms folded into the chest and into each other.

Evidence, measured on the real model (`lab.convertAnims` / probe, not by eye):

| | Before | After |
|---|---|---|
| Direction of upper arm, forearm and hand against the Mixamo source, any frame of any clip | 42-45° off, constant (it is the rest-pose difference) | 0.0° |
| Left arm against right arm (closest vertices) in idle / walk / run / sprint | 0.7 / 0.2 / 0.1 / 0.1 cm (touching) | 52 / 39 / 38 / 20 cm |
| Share of arm vertices within 1.5 cm of torso or pelvis, worst pose (idle / walk / run / sprint) | 3.9 / 13 / 16 / 19 % | 0 / 0 / 0 / 0 % (sprint 0 in isolation; 1.7 % worst pose, closest 0.4 cm, once the lean is added in game) |
| Run to stop and hard landing: left arm against right arm | 0.1 cm and 0.1 cm | 21 and 17 cm |

The procedural layer was ruled out: ground locomotion gives it weight 0 (only a spine lean, applied after the clips, so arms move with the torso). The clips were ruled out: the source arms in the FBX are correct and symmetric (checked against the source skeleton). Blending was ruled out: the error was already there in each clip alone.

What changed:
- `bakeRetarget` (`js/spider-clips.js`) has a new option `armRest: 'align'`: each arm segment (upper arm, forearm, hand + fingers, per side) is first turned by the world rotation that takes the model's rest direction onto the source's rest direction, then the clip's motion is applied. The forearm gets its own correction (the model's forearm also points about 15° forward of the straight Mixamo arm). Legs, spine and clavicles already agree with the source and are untouched. `armSpread` (degrees) additionally turns the arm chain outwards about the shoulder, for the broad chest.
- `tools/clip-selection.json`: `armRest: "align"` on idle, walk (spread 5°), run (4°), sprint (12°), hardLand and runStop (the two landing clips had the same fault). **jump, fall and the three swing clips are not changed**: their baked tracks are bit-identical to the version tested before (compared value by value).
- Sprint: extra forward lean in the clip layer raised from 0.06 to 0.2 rad at full sprint speed (about 11° more on top of the clip's own 21°).
- Landings: the swing-to-land crouch now plays all the way through (it ends in the crouch) and holds its last pose briefly, instead of being cut after 0.14 s; a landing shot is played through faster while the body is already running again.
- Clips were not replaced: Idle, Walking, Running and Sprint were kept. Only their arm retargeting was wrong. No other clip in the 37 was needed.

## Landing evaluation (Hard Landing, Run To Stop, Swing To Land)

| Clip | Contact timing | Compression | Posture and hands | In the game |
|---|---|---|---|---|
| `hardLand` (pack) | clip contact at 0.067 s, the shot starts at the game's touch-down | hips 0.93 m → 0.51 m (standing), 0.74-0.80 m while the player keeps running | deep crouch, torso low, a fist to the ground; arms now clear of the legs | heavy and believable when the body stops; the physics brakes a fall from 11.6 m/s to 0 in 0.25 s, the clip takes 0.9 s |
| `runStop` (pack) | plays from 0.12 s, feet already planted | hips 0.98 → 0.74 m | braking lunge, torso back up by 0.55 s | fires once per stop, cancelled when the player accelerates again |
| `swingLand` | contact at 1.317 s, scrubbed to the real touch-down | deepest of the three, hips 0.41 m | full superhero crouch, the clip ends in the crouch | now plays 0.55 s + hold, then fades into idle or the run |

Return to running: with forward held the crouch is blended with the run at most 35 % and gone in about 0.7 s (hips back at 0.9 m, peak leg bone speed 24-28 rad/s, no pop). Duration against physics: standing hard landing 0.9 s, jump landing 0.35 s, swing landing about 0.75 s.

**Additional landing animations: not required.** The one real limitation is a true running landing (touch down at 8-25 m/s and carry on without a crouch); it is currently a 35 % crouch blended into the run, which reads as a small dip. If that ever needs to look better, the specific clip to look for on Mixamo is a landing that ends in a run, e.g. search "Falling To Landing" and "Running Jump" (use the landing part), downloaded FBX Binary, Without Skin, 30 fps, In Place. Not needed for this pass.

## Second locomotion pass: the new Male Locomotion Pack and five single files

Inventory (15 files, all parse, all 65 `mixamorig` bones, no bone missing from the Raimi skeleton; measurements in the model's source size, multiply speeds by 0.956):

| File | What it is | Measured | Verdict |
|---|---|---|---|
| `Running.fbx` (new) | a 0.70 s jog | 4.74 m/s, 22 keys: **the same animation as `Action Adventure Pack/running.fbx`**, it replaced the faster 0.63 s Running (5.92 m/s) on disk | rejected: slower and more upright than the run it replaced (cadence 1.88x at 8.5 m/s, tilt 10°) |
| `Male Locomotion Pack/standard run.fbx` | athletic run, leaned, low hips | 0.73 s, 4.42 m/s, tilt 26°, hips 0.84-0.93 | **USED run** (leaned silhouette; slip at 8.5 m/s 3.4 %, cadence 2.0x, below the 2.1x cap) |
| `Male Locomotion Pack/idle.fbx` | neutral stand, 8.3 s | whole body drifts 2°, rigid, arms stiff | rejected |
| `Male Locomotion Pack/walking.fbx` | walk | 1.66 m/s, same family as Walking.fbx | not needed (the game has no walk key; walking only exists for a tenth of a second while accelerating) |
| `Male Locomotion Pack/jump.fbx` | standing jump, 2.2 s | | not used (jumping is kept as it is) |
| `left/right strafe (walking).fbx` (4) | side steps, 1.7 and 4.5 m/s | | rejected: the body faces its direction of travel, there is no strafe |
| `left/right turn 90.fbx` | turn on the spot | 90° of hips yaw, 0.93 s | rejected: the controller owns the heading |
| `Running Jump.fbx` | running leap | 0.9 s, feet off 0.07-0.60 s, 4.7 m/s, lands in a stride and carries on | **USED runJump** for jumps at 5 m/s or faster (starts in a stride, lands into the run); `?spiderRunJump=0` restores the standing jump |
| `Running To Turn.fbx` | run, brake, turn round 188°, stand | 2.27 s, ends standing | rejected: the controller reverses in about 0.5 s and the player is already running again |
| `Running Right Turn.fbx` | veering turn, 36° | 0.77 s, hips yaw -36° | rejected as a clip (it rotates the body itself); its idea is done procedurally: bank and chest/head lead into the turn |
| `Turn To Running.fbx` | turn 113° then run | unchanged from the earlier file | rejected, as before |
| `Action Adventure Pack/idle (3).fbx`, `idle.fbx` | look-around idles, 3.3 and 4.0 s | head turns 51° and 71°, relaxed stance | **USED idleLookA/B**, played once now and then (every 6-11 s of standing) with 0.7 s fades |

Findings of this pass:
- **Lean bug (worked on every run).** The spine lean and bank were applied about the world X and Z axes, which is only right when the character faces +Z. Running any other way leaned the body sideways. They now use the character's own axes (forward lean at sprint 48-50° at four different headings, sideways lean 0-5°).
- **The idle was a statue.** `Idle.fbx` moves under 1° at the spine and 5° anywhere (peak bone speed 0 rad/s over six seconds). A procedural breath and weight shift (about 1° of chest, 1° of hips and shoulders) is now added to the idle, and the look-around idles play now and then (peak 7 rad/s while standing, no pop at the start of a run).
- Speed-based lean: grows from 6 m/s (0.025 rad per m/s, at most 0.22 rad), accelerating leans forward, braking back, the chest leads into turns.
- Foot slip with the new run: 3.4 % at 8.5 m/s, 19 % at 15 m/s (sprint, unchanged); weaving 7.5-12 %.
- **Comparison workflow:** `tools/anim-probe.js` `grid(rows)` (candidates as rows, moments of the cycle as columns, same model, scale, light and camera, baked from the FBX exactly as the converter would), `turnaround(items)` (front, side and rear of the same moment, floating above the street) and `stage(speed)` for the real state machine.

Not done: a real-time play-through (the pane is too slow), the start-of-run and start-of-walk clips (none in the collections; if needed, Mixamo search "Start Running" / "Walking Start"), and a better running landing (the Running Jump landing covers jumps; falls still use the hard landing).

## Final polish pass: sprint, starts and stops, landings out of a run

**Sprint foot slip.** No clip in the 37 + 15 files is faster than `Sprint.fbx` (5.9 m/s on the Raimi legs; the rest are 4.2-5.7). Compared candidates: Sprint, the old Running (5.66), pack running (4.5), standard run (4.2): all would need 2.5-3.5x cadence at 15 m/s. Cadence stays capped at 2.1x; what the cap cannot cover is now made up by **stride correction** (`strideIK` in `js/spider-clips.js`): a two-bone leg solve on the clip's own pose that scales each foot's fore-aft reach by up to 1.2x (knee keeps its side, foot keeps the clip's orientation, legs stop short of straight). It acts only above about 12.4 m/s, never below, and not during landings.

| Planted-toe slip | Before | After |
|---|---|---|
| Run 8.5 m/s | 3.4 % | 3.4 % (unchanged) |
| Sprint 15 m/s | 18.5 % | **4.0 %** |
| Sprint, hard weave | 9.1 % | 5.0 % |
| Run weave | 7.5-12 % | 9.1 % |
| Leg bone peak, sprint | 39 rad/s | 55 rad/s (the knees extend faster through the longer stride) |

The knee peak is the price; the stride was looked at in a side still (wide stride, no hyperextension or twist). `strideMax` (in `cfg`) 1.0 turns it off.

**Start-walk, start-run, walk-to-run, run-to-sprint clips: none exist** in either collection (checked all 52 files by name and by measurement: every locomotion clip is a steady cycle or a stop/turn). The existing speed blends (idle, walk, run, sprint on one phase) and the acceleration lean stand in for them; nothing was faked from an unsuitable clip. Run-to-stop exists (`run to stop`, in use) and no second one is needed.

**Landing out of a run (fall, roof edge, building).** A fall with impact above 14 m/s while moving above 5 m/s now lands with the running jump's stride landing with the hard landing's crouch mixed in (30-65 % depending on impact); a still body keeps the plain hard landing, a swing release keeps the swing-to-land flip, jump landings are unchanged. Tested off a 189 m roof: weights run through runJump + hardLand into idle, peak bone speed 15 rad/s.

**Not verified:** real-time motion. Stills and measurements only.
