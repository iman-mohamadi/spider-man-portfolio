# Spider-Man (Raimi era) model: provenance and pipeline

`spider-raimi.glb` is the game's default character. It is generated, not authored: do not edit it by hand.

## Source
- File used: `raimisuit - mixamorig.fbx` from `spider-man-2004-2007-sam-raimi-trilogy/source/Spider-Man 3 Model - Sketchfab.zip` (a Sketchfab download supplied by the
  project owner: "Spider-Man (2004-2007) Sam Raimi Trilogy", by Mr. P, Mixamo-compatible rig). The FBX, the zip and the texture folder are never modified.
- **Licence: not confirmed.** The download carries no licence file. Before publishing the game, check the licence on the model's Sketchfab page and add the required
  attribution here and in the credits. Spider-Man is also a Marvel / Sony character: this is a personal portfolio prototype.

## What the FBX contained (inspected with Three.js FBXLoader)
- One SkinnedMesh, 143,702 triangles (431,106 unwelded vertices), 10 materials, one skeleton of 76 skinning joints (101 nodes with helper twist and end bones).
- Standard Mixamo bone names (`mixamorigHips` ... `mixamorigLeftToe_End`, fingers included; only `HeadTop_End` is missing, there is `mixamorigHead_end`), plus 24 twist helper bones.
- Skin weights: at most 4 influences per vertex, all weights sum to 1, no unweighted vertices, no out-of-range joint indices.
- Units: centimetres, T-pose, Y up, faces +Z, left = +X (the same convention as the previous model). 2.07 m tall (scaled to 1.82 m).
- No animation clips in the FBX. Phong materials with 4096 px colour and normal maps, no roughness (the zip has roughness maps for four materials).

## Conversion (`tools/model-lab.html`, Three.js FBXLoader + GLTFExporter, run in the browser)
- Skeleton and weights unchanged; verified numerically: after bending an arm, a leg and the spine, 10,515 sampled vertices of the original FBX, of the welded mesh and of the GLB
  loaded back through GLTFLoader agree to 8e-8 m.
- Triangles reordered so each material is one contiguous range (10 draw calls instead of 374) and identical vertices welded (431k to 142k).
- UV V flipped (FBX origin bottom-left, glTF top-left); materials rebuilt as MeshStandardMaterial with the 4K maps downsized (suit 2048, the rest 512-1024, JPEG); suit
  and logo roughness maps added; the FBX's red/blue material tint removed (colour is white, the textures carry the colours); the lens glass kept transparent.
- Root scaled to 1.82 m; the skeleton keeps its own units. Result: 14.8 MB.

## Animation clips (`anims/`)
The game plays real Mixamo animations (`js/spider-clips.js`), baked for this skeleton. Which of the 37 downloaded files are used, and why, is in `ANIMATION_CATALOG.md`.
- `anims-src/` holds the downloaded FBX files (never modified, not served to players: the game never loads an FBX). `anims/` holds the baked result: 14 JSON clips
  (`idle walk run sprint jump fall hardLand runStop swingStart swingLoop swingLand` and the mirror images `swingStartM swingLoopM swingLandM`) and `manifest.json` (version 2: file + measurements per clip).
- **Rebuilding.** `tools/clip-selection.json` says which FBX becomes which clip and how (hips and root handling, mirror image, hand). Then `python tools/serve.py 8080 --save-clips`,
  open `http://localhost:8080/tools/model-lab.html`, run `await lab.convertAnims()`. Each clip is retargeted in world space onto this skeleton (bone axes differ from stock Mixamo),
  measured (duration, root speed, foot speed, contact and flight events, swing hand), validated (finite, unit quaternions, same duration) and written; the game picks it up on the next load.
  `lab.inspectAnims([...files])` produces the per-file audit used for the catalogue.
- **Mixamo terms.** The animations are free to use in a project but not to redistribute as a library. The baked clips are derived from them: before publishing this repository, decide whether the
  `anims/` folder and `anims-src/` belong in it (the other option is to leave them out and let each builder download and convert their own, as above).
- Without clips (or `?spiderClips=off`) the game animates with the procedural rig. `?spiderClips=xbot` (development) plays the idle / walk / run of the Three.js example Xbot, fetched at run time (nothing is saved).
