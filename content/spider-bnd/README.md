# Spider-Man: Brand New Day suit (`spider-bnd.glb`)

The default character. `?spiderModel=raimi` loads the Raimi model instead, `?spiderModel=ps4` the original one; if this file cannot be loaded the game falls back to Raimi, then to the original.

## Provenance and licence

Converted from the user's own download in `spider-man_brand-new-day/` (`Spider-Man+Brand+New+Day.fbx`, `Textures.zip`; never modified). That download has **no licence file**, and the
production-style names (`spi_chr_spidermanhybrid_dev_model_v001`) suggest a studio asset. **The licence has not been confirmed: do not publish or redistribute this model (or commit it
to a public repository) until it is.** The Raimi model's licence is unconfirmed too, see `../spider-raimi/README.md`.

## What the file is

| | |
|---|---|
| Skeleton | the **same 76-joint Mixamo skeleton** (names, hierarchy, bind pose) as `../spider-raimi/spider-raimi.glb`, so every clip in `../spider-raimi/anims/` and the procedural rig drive it unchanged |
| Meshes | `BndSuit` (56k tris), `BndShoe`, `BndWebshooter`, `BndFrame` (eye frame, 12k), `BndLense` (eye lens, translucent): ~167k triangles, 5 draw calls. The FBX's `Web` mesh (151k triangles of raised web threads) is dropped: the lines are already in the suit texture |
| Textures | embedded: `tex/suit_*` and `tex/acc_*` atlases (3 x 2 tiles of 1024 px from the 4096 px UDIM tiles); base colour, normal, metallic-roughness |
| Eyes | `BndFrame` has the suit's two morph targets, `Squint` and `Open` (from the FBX). `js/spider-eyes.js` drives them: narrowed with speed, swinging and climbing, wide open in a fall and a double jump, and a blink every few seconds |
| Hands | one rigid piece per hand (no finger bones are weighted): the clips' finger motion has no visible effect on this model |

## How it was made (`tools/bnd-lab.html`, dev only)

1. The FBX triangle soup is welded and its UDIM UVs are remapped into the atlases (`tools/bnd-atlas.ps1` builds the atlases from the zip).
2. Quadric edge-collapse decimation that freezes UV seams and open boundaries (the morph targets are carried along per vertex).
3. Skinning to the Raimi skeleton: the arms are first turned about the shoulders to lie along the BND arms (the A-pose is steeper), then every vertex is weighted by its distance to the
   bone segments measured in limb radii, smoothed over the surface. The other meshes take the weights of the nearest suit vertex (the eye meshes: the head). The inverse bind matrices are
   those of the fitted pose, so at rest the mesh sits in the Raimi bind pose.
4. The suit's metallic map is ~0.9 everywhere (cloth as metal looks like a white sheen), so the exported metalness factor is 0.05.
5. Exported with `GLTFExporter` through a localhost receiver.

Rebuild: serve the repository, open `tools/bnd-lab.html`, then `await lab.load(); lab.build(); await lab.save()` with a receiver listening on `127.0.0.1:8150` that accepts `POST /save?name=spider-bnd.glb`.

## Known limits

- Skinning is linear blend with distance weights, no twist bones: very bent elbows or an arm raised past the head show some stretching at the shoulder.
- Motion quality is what the Mixamo clips and the procedural rig give; this model does not change the animation.
- Judged from still renders of poses only; real-time play was not observed.
