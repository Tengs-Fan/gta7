# Graphics and software rendering

## City and vehicle detail

The hardware presentation adds projecting cornices, sills, piers and mullions, with normal and roughness maps for facade materials, glazing, roads and paving. Ground details include concrete gutters, storm drains and manholes. Broadleaf trees use textured irregular crowns and branching trunks; palms have curved feathered fronds and ringed trunks. These remain spatially batched and instanced.

Vehicle bodies have tapered cabins, sculpted flanks, crowned hoods and clearcoat paint. Rounded tyres, open alloy wheels, brake rotors, mirrors, door seams, grilles, bumpers, plates and exhausts give each vehicle more detail. Exterior fittings add one batched mesh per detailed car and follow damage, burning and pool reset. Distant software traffic retains its simplified model.

Mission 3 cars (`vehicleView.ts`, `vehicleDetails.ts`): every car kind's glass is its own mesh in a dark tint, env-mapped (the sky, or the player car's reflection probe), drawn double-sided in one pass at 0.74 opacity with a Fresnel term that takes it to opaque at grazing angles (no transmission), so cabins read as closed glass with the riders dim behind it; cracked and shattered glass and the fade copies keep the patch. With the asset library loaded, seven kinds are drawn with Quaternius car models (`vehicleModels.ts`): compact `veh.q.suv`, sedan and taxi `veh.q.taxi` (the sedan without the roof sign), sports `veh.q.sports2`, muscle `veh.q.sports`, pickup `veh.q.pickup` and police `veh.q.police`. Each is scaled per axis to its spec box, its length warped so its axles land on the physics', split by material (or atlas cell) into paint, the cruiser's white panels, trim and glass, given a number plate on each end (laid on the model's plate panel where it has one, otherwise on the flattest stretch of the end clear of the lamps, found by casting rays), refined to 0.22 m edges so dents bend it, shaded smooth within a 38° crease and lined inside (dark, inward faces, with bulkheads closing the bonnet and boot) so no look through its glass passes out of the cabin; the view's own materials, interior, seat frame, tyres, lenses (on the model's lamps) and roof gear go on it, and without assets (Node tests, a failed load) every kind is procedural. The Kenney kit is not used: its toy proportions clash with the cast, and its ambulance's cab sits a metre ahead of the sim's front seats. The other kinds stay procedural: bodies fitted to `VEHICLE_SPECS` (within 3 % of length, width and height, wheels on the physics axles), the noses and tails are rounded in plan beyond the arches (`EndRounding`: one shape for the body, glass, fittings and lamps, so the shadow and far versions follow), the wheel arches carry moulded lips (painted on cars, dark trim on the working vehicles), the bus has a raked windscreen, window pillars and kerb-side doors, and the fire engine a raised nose with a chrome grille and aluminium roller-shutter lockers. Paint is a satin metallic base under a glossy clearcoat. Lamps are moulded lens shapes in one instanced batch: unlit by day when off, softly glowing after dark (no glow sprite or light), bright when driven; tyres show a tread, a lighter sidewall and a lettering band. A soft dark pad under every car (one instanced draw, `UNDER_SHADE`, drawn first among the transparent draws) shades the road beneath it, which neither the sun's shadow (none in shade, at night or on Low) nor the screen-space contact shadows draw; with the cast-iron-dark manhole covers (`cityArchitecture.manhole`) this removes the pale disc that showed under cars parked over a cover. The warm-up compiles a whole and a fading view of every kind, so a car's first spawn builds no shader program.

### Vehicle draw structure

A detailed car draws its body, glass and fittings itself (three draws, four with the police stripe); its tyres, rims, lamps, light bar and taxi sign are drawn by `VehiclePartBatches` (`src/render/vehicleBatches.ts`): one instanced mesh per kind for tyres and for rims, and one for every plain box part of every car, which carries each lamp's colour, glow and finish per instance (smashed lamps are dark, charred ones black). The part meshes stay in each `VehicleView` with their transforms and materials (tests and lamp glows read them) but live on `PART_LAYER`, which no camera draws; `GameRenderer.drawVehicleParts()` copies the cars in view into the batches every frame. A car casts its shadow with one merged, shadow-only body per kind (body, fittings, glass and tyres at rest; a wreck has no glass or tyres) on `SHADOW_LAYER`, which the camera only sees during the shadow pass. On every hardware tier, cars other than the player's beyond 40 m (with 2 m of hysteresis) switch to the far version: an undented body joins its kind's instanced body batch (paint as the instance colour), which also casts the shadow, and its glass, fittings and livery join their kind batches, so a far car costs about nothing of its own; a dented one draws its own bent body. Far bodies, fittings and livery stay out of the contact-shadow pass. Software renderers keep the coarse merged far model at 32 m.

On High at 1920x1080 a sedan 5–20 m away costs about 6.6 calls with its shadow and contact-shadow draws (38 before), and ten far sedans cost at most 2 calls each including the shared batches.

High's drawing buffer is capped at 3.5 million pixels (`HIGH_PIXEL_BUDGET` in `quality.ts`): a 1920x1080 window on a dpr-2 screen draws 2494x1403 instead of 2880x1620; at dpr 1 nothing changes. Contact shadows work at half resolution, draw their depth and normals only out to 110 m (fading out over the last 35 m) and take those draws from the frame's own opaque render list instead of walking the scene again (`shadesContact` picks them), and they fade out over 0.25 s and are skipped while the camera moves faster than 8 m/s or turns faster than 1.6 rad/s, fading back in over 0.3 s once it slows. `StaticWorld.groundHeight` looks up decks and ramps in a 16 m grid (identical results to the old scan, about 5x faster). The player car's reflection cube leaves out street furniture with the moving things.

High adds local ambient occlusion before bloom and six nearby street lamps that light car bodies and facades at night. Lamp selection cross-fades, and broken lamps switch off immediately. Transparent effects and camera-dissolving foliage/characters are excluded from the contact-depth pass so invisible geometry cannot leave dark artifacts; sun and moon shadows still apply normally. Medium and Low keep the same resolution settings as before this visual pass.

### Fades and helicopter crashes

Characters on foot fade in over `PED_FADE_IN` (0.5 s) the first time they are drawn within 200 m, so peds spawning nearby no longer pop in; the player and car occupants are always drawn whole. The fade is a per-instance `instanceFade` attribute on the crowd's instanced parts, applied as an ordered (Bayer) dither in the existing character shaders, and the characters' `customDepthMaterial` applies the same dither so the shadow fades with the body. A character removed while drawn on foot (a cleared body or a despawned ped) keeps its last pose and fades out over `PED_FADE_OUT` (0.6 s). `crowd.firstDrawn` in the browser logs the last 400 first-drawn characters with their position and fade. Vehicles removed within `VEHICLE_FADE_RANGE` (150 m) of the camera and in view (cleared wrecks, despawned traffic) fade out over `VEHICLE_FADE_OUT` (0.6 s): `VehicleView.beginFade()` swaps in `alphaHash` copies of the materials of the meshes the car draws itself and gives its shadow body (and a far car's own dented or coarse body) an `alphaHash` depth material, keeping the version it was drawn in (a far car stays far); `endFade()` restores everything before the view returns to the pool. Its tyres, rims, lamps, roof gear and far body, glass and fittings stay in the shared part batches: every bucket carries a per-instance `instanceFade` with the same Bayer dither as the characters (in its own material copy, and in the far bodies' `customDepthMaterial`), so a fading car adds no draw calls (measured 0 per fading car on Medium and Low, slightly fewer than live on High, where fading bodies leave the contact pass). Warmup compiles the fade copies and the bucket programs, so a fade does not compile new shader programs mid-play. Software renderers pass `alphaHash` and the instance fade through to their simplified materials.

The part batches draw each bucket through a geometry of their own that shares the part's vertex buffers and adds the per-instance attributes. A bucket whose part material or geometry is disposed (the player's local-reflection rim copies, replaced on every finish change) is retired at the next frame's `begin()`, after the frame it was drawn in: its instanced mesh, geometry and material copy are freed, so transient materials do not accumulate. `GameRenderer.hookShadowMap()` wraps three's `shadowMap.render` to show `SHADOW_LAYER` to the shadow pass; three builds a new shadow map when a lost WebGL context is restored, so the hook is installed again on restore (and checked every frame), once per shadow map.

A crashing police helicopter trails fire and smoke every frame while it falls (`effects.heliCrash`). Its descent is tested against the solid colliders and the Ferris wheel's disc (`src/sim/heliCrash.ts`): it comes to rest on top of the first roof it meets (the whole height swept in a step is tested, so the longest 0.1 s frame cannot carry it through a 0.4 m garage slab), including the garages and the police station, with a smaller blast on a garage roof (`HELI_ROOF_BLAST`) so a car parked inside is not destroyed, and it stops against the lighthouse, crane legs and the Ferris wheel instead of falling through them.

## Assets and the asset library

Models, PBR textures and the sky HDRI live under `src/assets/` and are built from CC0 sources by `npm run assets` (`scripts/assets/README.md` describes the pipeline and the output conventions; `LICENSES-ASSETS.md` lists every source). `src/assets/manifest.json` has one entry per file: id, file, kind, byte size, bounds, license id, and for characters a bone map and for vehicles wheel sockets.

`src/render/assets/` loads them:

- **Preload.** `main.ts` waits for the fonts, then calls `assets.preload(onProgress, { backend: browserBackend })` behind the "LOADING SAN AZURA" screen, and builds the game only when it settles. The bar follows the bytes received (each file is streamed; progress is the received bytes over the manifest's byte total, never backwards, at least one update per asset). Requests use the content-hashed URLs Vite emits for `import.meta.glob(..., { query: '?url' })`, which are relative, so the build also works from a sub-path such as GitHub Pages `/gta7/`; `assetsInlineLimit` is 0 so no model becomes a `data:` URI.
- **Timeout and fallback.** Preload resolves, it never rejects or hangs: after `PRELOAD_TIMEOUT_MS` (12 s) it aborts what is still pending and settles. A file that fails (HTTP error, abort, corrupt data) or times out is missing from the library, logs a single `console.warn` (`GTA7 assets: <id> failed (...)`; Chrome adds its own network line), and its view builds the procedural model it always had. A manifest that cannot be read leaves the library empty (one warning). Responses that arrive after the library has settled are dropped, so a model never changes in the middle of play and no shader compiles because of it. `?assets=0` skips the preload.
- **Lookup.** Views never wait: `assets.model(id)`, `assets.clone(id)` (a `SkeletonUtils.clone`, sharing geometry and materials), `assets.texture(id)`, `assets.bounds(id)` and `assets.socket(id, name)` answer synchronously and return `undefined` for anything not loaded. `assets.use(id)` also reports an id the manifest does not know, once. Node tests see an empty library unless they call `loadAssetsFromDisk()` (`src/render/assets/testing.ts`), which loads the committed GLBs through the same GLTFLoader and meshopt decoder with placeholder textures.
- **Warm-up and context loss.** `GameRenderer.warmup()` adds `assets.warmGroup()` (one clone of every loaded model, parked below the map) to the scene while it compiles, so every asset material has its program before first use, on every tier and for the software tier's vertex-lit replacements too; the group is removed again straight after. The warm-up runs again after a tier switch and after a restored WebGL context. Textures keep their `ImageBitmap` (it is never closed), so three uploads them again after a context loss.
- **Debugging.** `window.__gta7.ext.assets` has `report()` (manifest size, loaded, failed ids, timeout flag, bytes, preload and decode milliseconds), `ids(kind?)`, `entry(id)`, `list()` and `warmGroup()`.

The foundation only loads the assets; no view uses them yet.

## Time of day

The sky's image-based light (the baked environment map) is re-baked whenever the analytic sky colours change by about 2 % or the sun has fully set or risen, never less than half a real second after the previous bake, and at once after a jump in time (or every quarter game hour otherwise). Between bakes `scene.environmentIntensity` is scaled by the ratio of the sky's current to its baked irradiance (clamped to 0.5–2), so dawn and dusk brighten and darken every frame instead of in steps. This applies to every hardware tier with half-float targets; without them (and on software renderers) the sky light is an analytic hemisphere fill that was already continuous. The player car's local reflection probe recaptures after 0.05 game hours, still at most one capture start per half second. `__gta7.setClockRate(r)` and `__gta7.envStats()` help check this in the browser.

## Finish pass: colour grade and anti-aliasing

Every hardware tier ends its effects with `FinishPass` (`src/render/finishPass.ts`): High runs contact shadows, bloom, finish; Medium bloom, finish; Low finish alone. It works in linear HDR before three's own ACES and sRGB output, so tone mapping and colours stay the same pipeline on every tier. The grade (`gradeAt(hours, weather?)` in `src/render/grade.ts`) is keyframed over the day: noon is near neutral, golden hour (18:24) is warmer, and night is cooler, slightly desaturated, with a stronger vignette. It applies a luminance-normalised white balance, saturation, contrast in log space around mid grey, a small split tone and a vignette; no parameter moves more than 1e-3 per game minute, midnight included. Cloud lowers saturation and contrast and rain deepens the vignette, from the sim's weather.

High and Medium keep 4x MSAA from the WebGL context. Low uses FXAA inside the same pass: three's `FXAAShader`, patched to detect edges and blend in a reversible tone-mapped proxy (`c / (1 + max(c))`), so edges against bright lamps are not biased toward the light and HDR values are not clamped. The module throws on load if the patch no longer matches three's shader. Software renderers and GPUs without half-float targets have an LDR output where three allows no effects, so they get neither FXAA nor the grade. Tier switches only change the pass's uniforms (no shader rebuild). `__gta7.setPost({ aa, grade, vignette })` overrides it until the next quality change, and `state().render.post` reports `{ aa, grade, vignette }`.

On the M4 Pro at 1920x1080 High the perf playtest stayed at 60 fps in all four segments (final frames 5.3–6.8 ms).

## Night lights

`src/render/lightSprites.ts` draws three instanced batches, one draw call each, on every tier including software renderers. Lamp glows are camera-facing sprites at each working head, tail, brake, reverse and siren lamp (`VehicleView.lampWorldPositions()`), so smashed lamps and destroyed cars leave no glow. Each glow's colour times intensity stays below the bloom threshold (2.6), so bloom does not flicker on them; brake glows are about 2.2 times the running tail glow. Headlight pools are soft patches on the road ahead of cars with their lights on, nearest first, capped at 40 (High), 24 (Medium) and 12 (Low). On Low, which has no headlight spot light, the player's car gets a pool too. A third batch, light streaks, draws wet-road reflections (see Rain below). Lights turn on at night or in dark weather: `GameRenderer.weatherDim` follows `sim.weather.state.dim` every frame, and cars light up at `max(night, dim)` (rain and storm, and overcast; not clear or cloudy). `state().render` reports `glows`, `pools` and `streaks`.

Street lamps have a plinth, a lighter metal tapered pole, a curved arm and a luminaire head with a lit lens. The head position (`LAMP_HEAD` in `src/render/props.ts`) is shared by the lens, halo, ground pool and High's street lights, so they line up. A knocked-down lamp hides every part, including its halo and pool.

Street Run gates use open ground outlines and slim illuminated posts, with a separate readable turn instruction, road name, gate count and distance. This keeps traffic visible through a checkpoint.

## Lighting and sky

The baked environment map (the image-based light) blends a reduced, sun-clamped copy of the sky HDRI (`src/assets/env/sky_1k.hdr`, `prepareHdri` in `src/render/environment.ts`) with the analytic time-of-day sky. At every bake the HDRI is recoloured and scaled per channel, with separate gains towards the zenith and at the horizon, so that up-facing and sideways surfaces get the analytic sky's light: the HDRI adds clouds and a horizon to reflections, the clock keeps the colour and brightness, and by night it is as dark as the night sky. Its share is `HDRI_MAX` (0.92) in clear weather and less under cloud; around sunset and dawn its brightness follows the analytic sky smoothed over about an hour (`iblSmoothing`), so the dawn/dusk compensation above still changes the light every frame. Without the HDRI (Node tests, a failed load) the bake is the analytic one, unchanged; software renderers keep the analytic hemisphere fill. `envStats()` reports `source` (`'hdri'`, `'analytic'` or `'fill'`) and `hdriMix`.

At night the sky takes a warm city glow over the horizon (`cityGlow(hours)`, keyed on the clock, 0 by day, with no step larger than 0.5 % of its maximum per 0.01 h), and the cloud deck catches it from below. The finish pass lifts the night black level (`Grade.lift`, `NIGHT_LIFT`) with a cool grey floor that fades out above a few times its size, so dark asphalt reads as a surface while lit facades and the sky keep their brightness, and the hemisphere fill keeps a stronger night floor (`NIGHT_FILL` 0.45). The golden hour's key light leans golden and the grade towards yellow instead of magenta; noon stays neutral.

Street lamps get a wide haze around their heads at night (`LampHaze` in `src/render/lightSprites.ts`), 1.4 times larger and 1.6 times brighter in rain, sharing the lamp halos' positions and on/off attribute (a knocked-down lamp has neither); it is depth-tested, one draw call, and compiled by the warm-up. Wet-road streaks take the colour of their light: lamps stay warm white, tail lamps red, and the lit bulb of every standing traffic signal near the camera (`StreetLighting.offerSignalStreaks`) adds a red, amber or green streak.

Garage interiors and the foot of walls are patched once into three's lighting chunks (`src/render/interiorLight.ts`, before the first program is built, so no material needs a change of its own and no extra program is compiled). Under a garage's roof the sky's diffuse light is cut to `INTERIOR_SKY` (0.5), the sun's to `INTERIOR_SUN` (0.2) and the sky's reflections to `INTERIOR_REFLECT` (0.85), fading across the open door between 0.6 m outside and 0.8 m inside, so a car driving out returns to daylight within a metre with no step. Next to any building or garage wall the sky's diffuse light loses up to `WALL_AO` (0.42) in the corner, falling off with the distance from the footprint and the height above the kerb over `WALL_AO_REACH` (0.55 m), read from a field of signed distances to the footprints (0.5 m texels, one R8 texture); reflections lose half as much. People get a soft contact shadow under their feet on every tier (`FootShadows` in `src/render/contactShadows.ts`, one instanced draw multiplied into the frame).

| Feature | High | Medium | Low | Software renderers |
| --- | --- | --- | --- | --- |
| HDRI image-based light | sky HDRI blended into the baked environment map | sky HDRI blended into the baked environment map | sky HDRI blended into the baked environment map | none: analytic hemisphere fill (no environment map) |
| Lamp halos | lamp halo + haze, stronger in rain | lamp halo + haze, stronger in rain | lamp halo + haze, stronger in rain | lamp halo + haze, stronger in rain |
| Tinted wet reflections | wet-road streaks in each light's colour (lamps, signals, car lamps) | wet-road streaks in each light's colour (lamps, signals, car lamps) | wet-road streaks in each light's colour (lamps, signals, car lamps) | wet-road streaks in each light's colour (lamps, signals, car lamps) |
| City glow | warm glow on the night sky over the horizon | warm glow on the night sky over the horizon | warm glow on the night sky over the horizon | warm glow on the night sky over the horizon |
| Night black level | grade black-level lift + night city fill | grade black-level lift + night city fill | grade black-level lift + night city fill | night city fill only (no FinishPass) |
| Sunset grade | golden key light + yellow-leaning grade | golden key light + yellow-leaning grade | golden key light + yellow-leaning grade | golden key light only (no FinishPass) |
| Garage darkening | sky and sun light cut under garage roofs | sky and sun light cut under garage roofs | sky and sun light cut under garage roofs | none (vertex-lit stand-ins) |
| AO and contact shadows | GTAO + wall-foot occlusion + foot contact shadows | wall-foot occlusion + foot contact shadows | wall-foot occlusion + foot contact shadows | foot contact shadows |

`LIGHTING_TIERS` in `src/render/quality.ts` holds the same table; `tests/unit/lit_lighting.test.ts` checks it against what each tier's renderer builds and against this page. Tier switches change uniforms only. The lighting features compile no program during play (time of day, weather, garages) and come back after a WebGL context restore (`tests/e2e/lighting.spec.ts`).

## Props, foliage and dressing

Street furniture is modelled procedurally in `src/render/furniture.ts`: one vertex-coloured geometry per kind with its origin at its foot and its parts named in `userData.parts`, fitted within 15% per axis to the bounding box of the simpler d98da7b model and drawn instanced in the same 256 m prop cells. Lamps have a cast base, a tapered pole with collars, an arm with a brace and a cobra head with a clamp and photocell, with the lens at `LAMP_HEAD`. Benches have seven wooden slats on cast-iron side frames with armrests, bins a ribbed body with a rim and a domed lid, and hydrants a bonnet, an operating nut and three nozzles with caps. Traffic signals have three rimmed lenses under visors on a backplate, at the d98da7b bulb positions. Site signs (`siteView.ts`) have round posts, clamps and a rim round a plate with a printed face and a plain back. Deck rails and bollards are new. The drawn lamp pole and head cast no shadow: a 72-triangle stand-in per cell on `SHADOW_LAYER` does that (the drawn parts have 490 triangles), and `breakProp` and `restoreAll` move it with its lamp.

Broadleaf trees and bushes draw 140 and 72 leaf cards. The cards are alpha-tested (`alphaTest` 0.5, never blended) and textured from `src/assets/textures/leaf_atlas/albedo.webp`. `scripts/assets/leafAtlas.mjs` builds that atlas from ambientCG's LeafSet024 (CC0) as 2x2 tiles: three leaf sprays with alpha and one dense leaf mass. Each trunk splits into limbs below the canopy. Every card vertex stays inside the `foliageSpheres` envelopes even at full storm sway, so the camera and collision envelopes are unchanged. Palms lean 0.45 to 1.4 m at the top by a hash of their position, through a shear on the instance matrix over a built-in curve, and their trunks have ring geometry. The occluder dissolve follows the bent axis in three segments (`occluderOpacityPath` on the CPU, `uOccBend` in the shader).

Wind (`src/render/wind.ts`) sways the leaf cards and palm fronds in the vertex shader from render time and world position only, through the shared uniforms `uWindTime`, `uWindAmp` and `uWindDir`; `windOffset` is its CPU mirror for tests. The canopy edge of a tree moves about 5 cm in clear weather and 12 cm in a storm, and nothing below 1 m moves. High and Medium sway; Low and the software tier keep foliage still (`PropsView.setWindEnabled`). Shadows keep the unswayed shape, and the weather changes no program.

The dressing (`src/render/dressing.ts`) is render-only: it adds no colliders, uses hashes rather than the sim's random numbers, and is one instanced mesh per kind and cell. Ocean Beach has umbrellas, towels, loungers, lifeguard towers, volleyball nets and surfboards. Every house lot has yard items (picket fences, mailboxes, shrubs, planters and wheelie bins), Azura Pier has rails and the Marina has bollards. Lou's, the three spray shacks and the safehouse carport have workbenches, tool walls, shelving, tyre stacks or racks, tool chests, oil drums, jacks, posters and ceiling strip lights, at least 0.3 m clear of every car bay and clear of the entrance. `DressingRules` keeps items off roads, walking lines, crossings, parking slots, spawn points, POIs, markers and pickups.

Budget on hardware GPUs: 514 prop meshes (387 at d98da7b). At 1920x1080 High, in the same camera spots as d98da7b, draw calls are 1.03x in the downtown avenue view, 1.09x in Hillcrest (`13_residential_street`) and 1.14x on Ocean Beach (`14_beach_promenade`); triangles are 1.16x, 1.15x and 1.22x.

## Weather

`src/sim/weather.ts` (no three.js or DOM) schedules the weather per world seed: eight three-hour slots a day, each kind picked by a stateless hash of (seed, day, slot) with weights clear 45, cloudy 25, overcast 12, rain 12, storm 6. A storm only comes out of rain or overcast, rain clears through cloud, and day 1 is always clear. Changes ramp over 45 game minutes from the slot's start; ground wetness looks back over the earlier rain and dries over about 1.5 game hours. The schedule never touches `sim.rng`, and a save restores it from the saved day and hour (no save change). `SimOptions.weather` defaults to `'clear'`, so headless sims stay clear; gameplay sims use the Weather setting. Overrides (RAINDANCE, debug hooks) ramp over 20 real seconds by default (6 for the cheat) and are not saved. In storms one strike may fall per quarter game minute (a `lightning` sim event `{ x, z, dist }`, 300–1500 m from the player), deterministic for the seed and time.

`Environment.update` takes the weather on every tier: cloud adds up to 0.6 cover and turns the cloud deck and sky grey (rain and storms darken them; at night the deck takes the city's glow from below), the sun and moon lose up to 80 % of their light, shadows soften to 0.4 intensity, the hemisphere fill rises slightly and greys, fog closes in to 45 % of its clear distance in a storm, and exposure rises up to 10 % under cloud. The env map re-bakes through the existing colour trigger. Lightning adds a two-stroke flash (gone within 0.5 s) to the sky's `uFlash` and the hemisphere light; with Lightning flashes off nothing drawn changes. Hooks: `setWeather(kind | fields, { instant })`, `weather()`, `clearWeather()`, `lightning(x?, z?)`, `forceWeather(mode | null)` (the e2e helpers force clear). On the M4 Pro at 1920x1080 High the perf playtest stayed at 60/60/58/60 fps, and storm at night, in a car, and rain at noon at 60 fps (frames 5.6–6.7 ms).

### Rain

`src/render/rain.ts` draws the rain as one instanced batch of thin streaks in a 48 x 30 x 48 m box around the camera: 6000 drops on High, 3500 on Medium, 1500 on Low and 500 on software renderers, with `uRain` following `weather.rain` (none in clear weather). Every drop's position is a hash wrapped in the box in the vertex shader, which adds the fall, the wind slant and a stretch along the camera's velocity, so the CPU only writes uniforms each frame and the rain keeps surrounding the camera at speed. Drops take `Environment.smokeLight`, so they dim at night. `src/render/rainCover.ts` builds a roof-height map on the CPU (2 m cells from the building colliders, garages and decks such as the pier) into a `DataTexture`; drops under a roof are discarded, so no rain falls indoors, in garages or under the pier.

`src/render/wetGround.ts` patches the shared road, sidewalk and plaza materials in `city/` once (`onBeforeCompile` with a fixed cache key, uniforms only), so weather changes compile no shaders. `uWet` follows `weather.wet`: albedo darkens up to 35 %, roughness drops, and on High and Medium a noise mask thresholded by the wetness forms puddles (fading in over the first eighth of wetness), with ripple rings while it rains. Covered cells stay dry: the puddle mask and its ripples are scaled by the cover-adjusted wetness, so garages, decks and the pier get neither. Low only darkens and lowers roughness; the software path's Lambert stand-ins take the darkening alone. Wetness also flattens 80 % of a surface's normal-map relief (`WET_FLATTEN`: the water fills the pores), so the PBR asphalt turns glossy without glittering under the lamps. The ground dries with `weather.wet` after the rain stops.

On a wet road, the light-streak batch in `lightSprites.ts` draws a reflection under the 64 lights nearest the camera (lamps, head and tail lights together), placed at the mirror point between the light and the camera and scaled by the wetness; dry roads get none. On High and Medium, cars within 60 m faster than 8 m/s on a road wetter than 0.3 throw spray off their rear wheels on the existing smoke layer. Rain is visual only: grip and handling are unchanged. `state().render` reports `rainDrops` and `wet`. `node scripts/playtest.mjs --scenario rainnight --size 1920x1080` runs rain at 23:00 on High through the perf scenario's places (see the measurements below). Wet-road streaks are scaled by how dark it is (`max(night, weather dim)`), so by day in the rain, when the weather's dimming turns car lights on, their reflections stay faint.

## Ground

`src/render/city/surfaces.ts` builds the ground materials. On hardware tiers, roads and car parks use the Poly Haven `worn_asphalt` set, lawns use `leafy_grass` and the beach uses `coast_sand_01` (albedo, normal, and ORM as roughness and AO, from `src/assets/textures/`). Each set is tinted to the d98da7b surface colour. Sidewalks, plazas, kerbs and dirt keep their procedural tiles, so the paving joints are unchanged. If a set did not load (Node tests, a failed request) or the renderer is the software tier, the procedural tile is used instead.

A world-space detail patch is chained in front of the wet-ground patch (`onBeforeCompile` with fixed cache keys `…|gta7-ground-<surface>`, uniforms only). It adds:
- Asphalt: macro tone, darker repair rectangles with sealed seams on a 9 m lattice, and thin cracks along a noise iso-line in worn zones, which fade out once they are thinner than a pixel. Road segments also get lane wear from a per-vertex `aGround` attribute (across, from start, to end, half width): polished wheel paths, plus a dark oil strip mid-lane that is heaviest near the junctions.
- Sidewalks: grime along the kerb edges of each block's rectangle.
- Kerb faces and gutters: road dirt, heaviest at the foot of the kerb.
- Lawns: dry and lush patches and clover. Where a lawn meets a sidewalk, its quad reaches `LAWN_OVERHANG` (0.18 m) onto the paving and frays there, with a soil band inside the edge.
- Sand: colour variation and wind ripples (a normal tilt that fades where it would alias). A wet band runs from the sim's waterline to 8.8–11.4 m inland: darker (62 % less albedo), with roughness lowered to 0.65 (dry sand is about 0.96). The surf's lace, bubbles of 10 to 50 cm, runs up the sand and back with the sea's `surfPhases`, its reach scalloped along the shore. A second, turned albedo sample hides the set's repeat.

Manholes (about one per 41 m of road, in lane centres, clear of crosswalks and paint) are added to the ironwork mesh. Tyre marks (braking marks before the stop lines and turn arcs inside the junction boxes, at about 70 % of signalised junctions) are one transparent, wet-patched `road-decals` mesh for the whole map. Both are placed by hashes of road and node ids (`manholesOf`, `tyreMarksOf` in `city/roads.ts`), never by `sim.rng`. Every ground texture gets anisotropic filtering of min(cap, `getMaxAnisotropy()`), with a cap of 16 on High, 8 on Medium, 4 on Low and 1 on the software tier (`CityView.setAnisotropy`, called from `setQuality`). A change re-uploads the textures once and rebuilds no mesh or program. `__gta7.ext.ground` reports the textures and their anisotropy, a GPU memory estimate (about 18 MB), the manholes and tyre marks, the sim's and the drawn water depth at a point (`seaDepth(x, z)`), and the beach's waterline.
## Sea

`src/render/waves.ts` (no three.js) defines four Gerstner waves of 4.3 to 31 m, travelling roughly onshore, whose heights scale with `weather.seaState` (0.3 calm, 1 in a full storm): they add up to 0.10 m in calm and 0.35 m in a storm. Their time phases are wrapped in double precision on the CPU and sent as one `vec4` uniform, so they never stutter in float32. `src/render/sea.ts` patches the sea's standard material once (on top of the two-layer ripples, uniforms only, one cache key): every hardware tier adds the wave slopes (three times the geometric tilt, each wave fading out with distance before it aliases) to the ripple normal, and the ripple UVs are worked out from the world position because the sea mesh follows the camera. The software sea (`softwareSeaMaterial`) uses the two longest waves.

On High (`TierSpec.waterGrid`) the sea is a grid around the camera: 1 m cells to 80 m, 4 m cells to 400 m, then a flat skirt to 3 km. It moves in whole 4 m steps, so its vertices stay on a fixed world lattice and do not swim. The vertex shader displaces it with the same waves; each wave fades out before the cells get too coarse for it, and the fine ring's rim vertices between coarse ones are placed on the coarse ring's edges (`seaDisplaceEdge`), so the rings meet without cracks. Other tiers draw a flat plane; switching tier swaps the geometry and the `uDisplace` uniform only (the grid's buffers are freed when leaving High). The waves are visual only: the sim's sea stays flat at `WATER_Y`, so swimming, floating cars and buoyancy ignore them. `state().render.waterGrid` reports the grid; `setWeather({ seaState })` pins the sea state.

The shoreline is analytic, from the layout bounds and `BEACH_W`, `SAND_DROP`, `CURB_H`, `SEABED_Y`: the shader works out the water depth over the beach's sand slope and its drop-off (blending into deep water off the beach's ends), tints the shallows turquoise over the first 4 m of depth (and toward wet sand at the waterline), draws surf bands that move shoreward and grow with the sea state, and a noisy, gently pulsing foam strip 0.5 to 1.5 m wide along the west, north and south quay walls. Foam is part of the albedo, so it darkens at night. The software sea gets the shallows and the surf bands.
The sea's colour follows a drawn seabed that keeps falling offshore. Past 25 m outside the land rectangle it drops another 0.11 m per m (`seaShelfDepth`/`seaDrawnDepth`, render only; the sim's `waterDepth` stops at 7 m). Turquoise shallows (`#2fa89e`) give way to the material's teal by 4 m, then darken steadily through deep blue (`#0b4f78`, reached by 18 m) to a dark offshore blue (`#062c52`) by 45 m, the two ramps overlapping so the colour never pauses. The sand tint at the waterline is now a wet teal (`#86a89a`) and fades out within 0.15 m of depth. The ripple tile's UV is warped, and its strength scaled, by low-frequency samples of the tile itself (gently: warps about twice as strong fold the tile into streaks that fan out across the foreground). A third, finer layer (2.43 m tile, scale ratio 2.74, turned and drifting its own way) and a fourth (the first layer's tile shrunk 1.66 times and turned 53° the other way, `RIPPLE_D`) take over part of the ripple power from the first two (`RIPPLE_AB_GAIN` 0.8), so the repeats never line up and the first layer's longest trains no longer form a regular pattern: in 20 m top-down views at noon the autocorrelation's highest secondary peak, after a 33-pixel high-pass that removes the sky gradient and the sun's glint, fell from 0.25–0.35 (d98da7b) to 0.06–0.15. The surf bands dissolve 1.7 to 4 m out (`smoothstep(0.05, 0.12, depth)`), so the foam at the waterline is the swash and the sand's lace, centred within about a metre of the sim's waterline. Foam rings the pilings of every deck (`setPilings`, an analytic copy of the lattice in `city/coast.ts`, up to 0.7 m from each piling's side). Waves damp to 35 % of their height over the shallowest 2 m, so the drawn waterline stays within about a metre of the sim's.

The renderer ends a bullet's tracer where its path crosses the surface over water and draws a small splash there instead of the seabed impact (render only). A rocket that crosses the surface over water before it hits anything goes off at the surface (`combat.ts`) with a big `splash` event; a blast within 0.3 m of the surface over water is drawn as a water plume (a white column, a spray ring, mist and a wide foam ring, with no fire, smoke, sparks or flash light). Splashes throw a crown of droplets that streak along their flight, a mist puff and a foam ring (`src/render/foamRings.ts`, one instanced draw) that spreads on the sea and rides its waves through the shared uniforms; a bullet's ring spreads to 3 m across over 1.5 s. On the M4 Pro at 1920x1080 High the perf playtest measured 60/60/55/60 fps and `rainnight` 60/60.

## Per-tier summary

| | High | Medium | Low | Software renderers |
| --- | --- | --- | --- | --- |
| Effects chain | contact shadows, bloom, finish | bloom, finish | finish | none |
| Anti-aliasing | 4x MSAA | 4x MSAA | proxy FXAA | none |
| Colour grade and vignette | yes | yes | yes | no |
| Dawn/dusk env-map compensation | yes | yes | yes | n/a (analytic fill) |
| Lamp glows, wet-road streaks, lamp heads | yes | yes | yes | yes |
| Headlight pools | 40 | 24 | 12 (the player's car too) | 12 |
| Rain drops | 6000 | 3500 | 1500 | 500 |
| Wet ground | puddles, ripples, roof cover | same | darken and gloss | darken only |
| Tyre spray | yes | yes | no | no |
| Sea | displaced wave grid + wave normals | wave normals | wave normals | 2-wave `simpleWater` |

MSAA comes from the WebGL context, so it only changes after a reload; FXAA, the grade and everything else follow a tier switch at once. A page started on Low and switched to Medium or High therefore has no anti-aliasing until it is reloaded (the Settings screen says so). Tier switches and context restores rebuild the effects chain, rain count, wet-ground mode and sea geometry without leaking scene objects (`tests/unit/gfx_integration.test.ts`); `tests/e2e/gfx_tiers.spec.ts` boots each saved tier and checks these limits in clear weather and rain, by day and night.

## Measurements (Apple M4 Pro, Chrome with ANGLE Metal, 1920x1080, High)

After the whole graphics milestone (dawn/dusk smoothing, finish pass, night lights, weather, rain, sea), on 2026-10-22:

| Run | Segments (fps) | Final CPU frame |
| --- | --- | ---: |
| `--scenario perf` | start 60, downtown 60, pursuit-4-stars 58, beach-dusk 60 | — |
| `--scenario rainnight` (rain 1.0, 23:00, 6000 drops) | start 60, downtown 60, pursuit 60, beach 60 | 3.3–7.3 ms |
| Dusk sweep: `setTime(18.2)`, `setClockRate(10)`, a 20 s storm ramp, 30 s | 60 | env map re-baked 1.8 times a second |
| Software (SwiftShader, `--swiftshader`) | day, night and night rain render (35–47 colours); no post, no MSAA, 500 drops, `simpleWater` | — |

The two-minute chaos e2e stays above its 30 fps floor. The rainnight segments drew 31–49 glows, 4–11 headlight pools and 14–27 wet-road streaks.

After the second update (wave-1 content and multiplayer, release preparation on 2026-10-23, machine load average 8-13 from other work): `--scenario perf` start 60, downtown 60, pursuit-4-stars 58, beach-dusk 60 (CPU frame 4.3–5.4 ms, 648–1886 draw calls); `--scenario rainnight` (rain 1.0, 23:00) 60 in all four segments (CPU frame 3.1–5.9 ms); High tier and no console errors in both. The two-minute chaos e2e averaged 59.9 fps. The draw-structure work above (instanced vehicle parts, merged shadow bodies, far batches, the High pixel budget, cheaper contact shadows and the ground-height grid) cut the JavaScript frame time p95 by 26–55% against the previous release in the four perf scenes, measured back to back, and the plaza at 2880x1620 (dpr 2, uncapped) went from 42 to 137 fps. The static draw batching below later raised those cuts to ratios 0.46–0.61 (median 0.59 for the pursuit over five pairs, release re-measure on the final tree: a 0.54/0.61/0.55/0.48 first pair for downtown, pursuit, storm and plaza) and the dpr-2 plaza to 154 fps.

Static draw batching (release performance pass): in the 5-star pursuit the render list was dominated by the city (about 1100 chunk meshes) and props (about 980 small instanced meshes), not by vehicles. On hardware GPUs (`HARDWARE_CHUNK_SIZE`, 256 m) the shadow-casting city layers and the props are batched in 256 m cells, and the thin ground layers that cast no shadow (roads, gutters, kerbs, pavements, plazas, grass, markings, parking lines, ironwork, beach, quay, helipads: about 50 000 triangles in all) are one mesh each for the whole map, since culling a few triangles per cell saves nothing but draws. Every triangle, instance, material and shadow flag is unchanged; only the number of draws is. Fixed-view `GameRenderer.render` cost fell from 5.25 to 3.46 ms (1230 to 580 draw calls) and the pursuit scene's JavaScript frame time p95 went from 7.0–7.7 ms (72d0b98) to 4.4–4.7 ms, a ratio of 0.57–0.64 in six back-to-back pairs (it was 0.71–0.86 before). Downtown, storm and plaza ratios are 0.45–0.56; the plaza at dpr 2 (2494x1403 under the pixel budget) stays GPU-light at about 150 fps uncapped. Software GPUs keep their 128 m `CulledStaticMesh` cells. One visible trade-off: while a pole in a props cell is dissolving for the camera, that whole cell sits out of the contact-shadow pass (now 256 m rather than 128 m).

## Software fallback

Hardware rendering keeps the existing physical materials, procedural sky, reflections, shadows,
bloom, and High/Medium/Low resolution settings. Static city surfaces and street furniture are
batched in 256 m cells (thin ground layers in one mesh each) so geometry outside the camera can be
skipped; software renderers keep 128 m cells.

Software rasterisers (SwiftShader, llvmpipe, and similar renderers) select a separate path at boot:

- LDR output with the same ACES tone mapping and sRGB output conversion.
- Diffuse lighting evaluated at vertices, retaining textures, animated window occupancy,
  emissive lamps, character fading, and foliage fading.
- A simpler animated sky and ocean, with atmospheric visibility ending at 220 m.
- One draw per city material. Visible cell indices are compacted without moving vertex data.
- Nearby street furniture, spatial signal and roof-light batches, and a single-draw distant
  vehicle model beyond 32 m. The player's car retains its articulated, deformable model.
- No shadow maps, bloom, MSAA, or dynamic point/spot lighting on a software renderer.

Software Low renders at up to 0.45 of CSS resolution with a 130,000 pixel drawing-buffer budget;
Medium uses 0.5 / 200,000 pixels, and High uses 0.67 / 350,000 pixels. The budget prevents a larger
window or high-DPI screen from multiplying the software rasterisation cost. Menus, HUD text,
navigation, and the minimap retain their CSS resolution. Selecting High increases world resolution
on software GPUs; it does not enable the physical hardware rendering path.

Skid marks submit only written segments and stop drawing after fading. Broken prop bounds are
recomputed, and lamp clip attributes and traffic-light indexing survive spatial batching.

## Hardware validation

On 2026-10-21, the upgraded production build ran on an RX 6600 XT through Chromium/ANGLE OpenGL at native 1920 × 1080, High, with no browser errors. The existing `perf` playtest measured the following refresh-capped frame rates over its four-to-six-second segments. CPU times below are the final sampled frame, not averages or GPU timings.

| Scene | Actual FPS | Sampled CPU frame |
| --- | ---: | ---: |
| New-game street | 60 | 8.3 ms |
| Downtown | 60 | 7.4 ms |
| Four-star pursuit | 60 | 5.9 ms |
| Beach at dusk | 60 | 5.9 ms |

These are short representative scenes, not a guarantee for every crowded chase. The 31 selected production-browser checks cover walking, vehicle entry/driving/damage, the first mission, police, death/respawn, saves, UI, gamepad, audio, a two-minute chaos session, city lighting, quality switching, context recovery and Street Run journeys. All pass after updating the existing keyboard menu test for the Street Run entry. The unit suite then had 1,331 tests; the final affected reflection and vehicle suites were rerun successfully after removing ignored material-level reflection settings.

Keyboard-only route probes with ordinary traffic completed Dockside for gold (60.90 s) and Coastline for silver (99.91 s), awarding and saving their rewards. The simple driver reached Magnolia gate 10 before traffic collisions ended the attempt, so this pass does not claim a full keyboard-driven completion of that course. The driver changed no physics or traffic settings. These results used the medal times of the time (Dockside gold 1:18, Coastline silver 1:50); the courses have since been re-tuned to the times in the README, and `tests/e2e/street_runs_keyboard.spec.ts` now finishes Magnolia Rush through traffic with the keyboard.

## Earlier software measurements

Chrome with SwiftShader, a 960 × 540 viewport, Low settings, and a stationary new-game street view
on the development host measured these actual animation-frame rates (elapsed wall time, not the
simulation's clamped timestep):

| Rendering configuration | Actual FPS |
| --- | ---: |
| Original build, 0.67 scale | 2.08 |
| Optimised geometry/shaders, 0.67 scale | 7.5–8.6 |
| Optimised geometry/shaders, 0.50 scale | 11.65 |
| Optimised geometry/shaders, 0.45 scale | 14.65 |

The original scene submitted about 481,000 triangles and 418 draws. The optimised scene submits
roughly 56,000–70,000 triangles and 106–129 draws, depending on ambient traffic. The live world
continues to evolve during these samples, so these are representative measurements rather than
deterministic benchmark scores. Hardware GPU performance has not been measured on this host.

At 0.45 scale the sampled frame interval was 66.7 ms while JavaScript work was about 6.1 ms;
software rasterisation and presentation remain the limiting cost. Hardware acceleration is still
preferable for smooth driving and the full visual quality.

## Regression coverage

`tests/unit/spatial_render.test.ts` checks triangle/attribute preservation, negative cell coordinates,
visible-index compaction and restoration, real-bounds culling, live emissive material state,
software pixel budgets, and skid-buffer expiry. Vehicle-model tests check distant dimensions,
triangle reduction, and restoration of the detailed model. Renderer/environment/prop tests cover
quality switching, context loss, signal colours, clipping over the pier, and break/restore behaviour.
`tests/unit/w1_render_polish.test.ts` covers ped fade-in timing and shadow fade, body and wreck
fade-out, the fade state reset on a new game, and helicopter crashes against roofs, the lighthouse,
crane legs and the Ferris wheel.
`tests/unit/w1_fix_render.test.ts` covers the shadow hook surviving a replaced shadow map, retirement of disposed
transient part materials, the fade draw budget for near and far cars and wrecks, and helicopter roof landings at 0.1 s steps.
