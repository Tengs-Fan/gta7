# Asset pipeline

`npm run assets:fetch` downloads the sources, `npm run assets` builds `src/assets/**`, `src/assets/manifest.json` and `LICENSES-ASSETS.md` from them.

| File | Role |
| --- | --- |
| `sources.json` | Every download: URL, size, sha256, author, page and license (CC0 or credited CC-BY). One source per line; a source is also one row of `LICENSES-ASSETS.md`. |
| `fetch.mjs` | Downloads into `~/Projects/gta7-assets-src` (`GTA7_ASSETS_SRC` overrides), checks size and sha256, unzips archives. `--record` fills in size and hash for new sources, `--verify` never downloads. A second run downloads nothing. |
| `catalog.mjs` | What is built from the sources, one entry per line: characters, the shared clips, vehicles, boats, props, PBR texture sets, the sky. Add rows here for new assets. |
| `build.mjs` | Runs the catalog through `pipeline.mjs` (models) and `textures.mjs` (PBR sets), writes the manifest and the license table, and removes outputs the catalog no longer produces. |

## Conventions of the output

- Units are metres, +Y up, +Z forward, +X to the model's left (the sim's frame).
- Models are welded, deduplicated, pruned and meshopt-compressed (`EXT_meshopt_compression`); normals are quantised, positions stay float so geometry can be merged. Textures inside GLBs are WebP, at most 512 px unless a catalog entry asks for more, never above 1024.
- Characters (Quaternius Ultimate Modular, one shared 62-bone rig): 1.8 m tall, origin between the feet, bone names without dots (`UpperLeg.L` is `UpperLegL`, as three.js names them), animations stripped into the shared `models/characters/clips.glb`. The manifest's `bones` map links the skeleton's joints to bone names.
- Vehicles and boats: scaled uniformly so the length equals the `VEHICLE_SPECS` length of the kind they are meant for, origin under the bounding-box centre on the ground, the wheels as separate nodes (`wheel_fl`, `wheel_fr`, `wheel_rl`, `wheel_rr`, or `wheel_rear` for one mesh on a common rear axle) centred on their axles. The manifest holds the wheel centres as `sockets`, the wheel radius, and `fit`, the model's width, height and length divided by the spec's, so a view can see how much a body sticks out before fitting it.
- Props: origin at the authored base; `scale`, `height` or `width` in the catalog set the size.
- PBR sets: `textures/<set>/{albedo,normal,orm,emissive}.webp`; albedo is sRGB, normal is OpenGL (+Y up), ORM packs occlusion (R), roughness (G) and metalness (B). Sources without an occlusion map get white.
- The sky is the Poly Haven Radiance HDR, copied unchanged (`env/sky_1k.hdr`).
- Manifest `bounds` are `{min, max}` in metres for models and `{width, height}` in pixels for textures and the sky.

## Reproducibility

The build is deterministic: glTF-transform and sharp (WebP) produce identical bytes for identical input on the same machine and package versions (`package-lock.json` pins them), so two runs, or a fresh clone sharing the source folder, give the same sha256 for every file. No tolerance is needed on the machine that built the committed files. WebP output can differ in the last bits across CPU architectures or libwebp versions; files built elsewhere should compare by dimensions and a mean absolute difference of at most 1/255 per channel.

## Adding an asset

1. Add a source (one line) to `sources.json` and run `node scripts/assets/fetch.mjs --record`.
2. Add a row to `catalog.mjs` and run `npm run assets`.
3. Commit `sources.json`, `catalog.mjs`, `src/assets/**` (manifest included) and `LICENSES-ASSETS.md`. When merging branches that both added assets, keep the union of the lines and rerun `npm run assets`.

Raw zips and source images are never committed; no committed asset may exceed 5 MB.
