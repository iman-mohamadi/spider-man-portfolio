# Project structure

The city (upstream "Slop New York") is a flat set of ES modules in `js/` loaded by `index.html` -> `js/main.js` through an import map. Moving them into folders would change every import, the dynamic imports, the tests that read source files by path and the asset URLs, for no change in behaviour, so the layout was kept and is described here instead.

| Area | Files |
|---|---|
| Bootstrap | `index.html`, `js/main.js`, `css/style.css` |
| World and city | `city-config.js`, `city-grid.js`, `boroughs.js`, `buildings.js`, `building-*.js`, `landmarks.js`, `street-*.js`, `trees*.js`, `road-*.js`, `lighting.js`, `post-processing.js`, `tsl-materials.js`, `*-geodata.js/.dat` |
| Vehicles, pedestrians, audio | `cars.js`, `vehicles.js`, `vehicle-*.js`, `traffic.js`, `bus.js`, `helicopter.js`, `pedestrian*.js`, `audio-*.js` |
| Characters and cameras | `controllers.js` (person, car, cyclist, helicopter), `cameras.js` (the shared camera system), `gamepad-controls.js`, `touch-controls.js` |
| Spider-Man (optional, `?spider=0` skips it) | `spider-install.js` (entry), `spider-controller.js`, `spider-physics.js`, `spider-swing-sim.js`, `spider-camera.js`, `spider-input.js`, `spider-targeting.js`, `spider-web.js`, `spider-world.js`, `spider-anim.js`, `spider-gait.js`, `spider-clips.js`, `spider-model*.js`, `spider-tuning.js`, `css/spider.css` |
| Map and navigation | `nyc-map.js` (full map, minimap, search, click to teleport, portfolio pins), `nyc-geodata.js`, `subway-*.js` |
| Portfolio | `content/profile.json` is the ONE source of truth (schema in `js/portfolio-content.js`: validation, legacy compatibility); `portfolio-sites.js` (candidate billboard sites, the only place they are listed); `portfolio-billboards.js` (wall allocation, board drawing, map pins); `portfolio-interaction.js` (the F-key project panel and its markers); photo and project images in `content/profile/` and `content/projects/`; `content/portfolio.json` is DEPRECATED (ignored, kept for the compatibility layer) |
| Models and animation data | `content/spider-man/` (PS4 model), `content/spider-raimi/` (Raimi model, `anims/` baked clips, `ANIMATION_CATALOG.md`); sources in `content/spider-raimi/anims-src/`, `spider-man-2004-2007-sam-raimi-trilogy/`, `marvel_spider_man_ps4_for_blender/` (never modified) |
| Development tools | `tools/serve.py` (dev server), `tools/model-lab.html` + `tools/clip-selection.json` (model and clip conversion), `tools/anim-probe.js` (animation measurements), `tools/build-*.py/.mjs`, `tools/geo-*.mjs`, `tools/overpass.sh` (geodata), `tools/benchmark-pedestrians.mjs` |
| Tests | `tests/*.test.cjs` (`node --test tests/*.test.cjs`) |

Cleanup review: every file in `js/`, `css/`, `tools/` and `tests/helpers/` is referenced by an import, a dynamic import, `index.html`, a test or another tool, except `tools/benchmark-pedestrians.mjs` (a stand-alone upstream benchmark, kept). Nothing was deleted, moved or renamed: the remaining candidates (planning notes in `docs/spider-man-portfolio/`, the source model folders, the CV and photo in the repository root) are the owner's originals or of uncertain use.
