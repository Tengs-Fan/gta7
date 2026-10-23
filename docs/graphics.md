# Graphics and software rendering

## City and vehicle detail

The hardware presentation adds projecting cornices, sills, piers and mullions, with normal and roughness maps for facade materials, glazing, roads and paving. Ground details include concrete gutters, storm drains and manholes. Broadleaf trees use textured irregular crowns and branching trunks; palms have curved feathered fronds and ringed trunks. These remain spatially batched and instanced.

Vehicle bodies have tapered cabins, sculpted flanks, crowned hoods and clearcoat paint. Rounded tyres, open alloy wheels, brake rotors, mirrors, door seams, grilles, bumpers, plates and exhausts give each vehicle more detail. Exterior fittings add one batched mesh per detailed car and follow damage, burning and pool reset. Distant software traffic retains its simplified model.

### Vehicle draw structure

A detailed car draws its body, glass and fittings itself (three draws, four with the police stripe); its tyres, rims, lamps, light bar and taxi sign are drawn by `VehiclePartBatches` (`src/render/vehicleBatches.ts`): one instanced mesh per kind for tyres and for rims, and one for every plain box part of every car, which carries each lamp's colour, glow and finish per instance (smashed lamps are dark, charred ones black). The part meshes stay in each `VehicleView` with their transforms and materials (tests and lamp glows read them) but live on `PART_LAYER`, which no camera draws; `GameRenderer.drawVehicleParts()` copies the cars in view into the batches every frame. A car casts its shadow with one merged, shadow-only body per kind (body, fittings, glass and tyres at rest; a wreck has no glass or tyres) on `SHADOW_LAYER`, which the camera only sees during the shadow pass. On every hardware tier, cars other than the player's beyond 40 m (with 2 m of hysteresis) switch to the far version: an undented body joins its kind's instanced body batch (paint as the instance colour), which also casts the shadow, and its glass, fittings and livery join their kind batches, so a far car costs about nothing of its own; a dented one draws its own bent body. Far bodies, fittings and livery stay out of the contact-shadow pass. Software renderers keep the coarse merged far model at 32 m.

On High at 1920x1080 a sedan 5–20 m away costs about 6.6 calls with its shadow and contact-shadow draws (38 before), and ten far sedans cost at most 2 calls each including the shared batches.

High's drawing buffer is capped at 3.5 million pixels (`HIGH_PIXEL_BUDGET` in `quality.ts`): a 1920x1080 window on a dpr-2 screen draws 2494x1403 instead of 2880x1620; at dpr 1 nothing changes. Contact shadows work at half resolution, draw their depth and normals only out to 110 m (fading out over the last 35 m) and take those draws from the frame's own opaque render list instead of walking the scene again (`shadesContact` picks them), and they fade out over 0.25 s and are skipped while the camera moves faster than 8 m/s or turns faster than 1.6 rad/s, fading back in over 0.3 s once it slows. `StaticWorld.groundHeight` looks up decks and ramps in a 16 m grid (identical results to the old scan, about 5x faster). The player car's reflection cube leaves out street furniture with the moving things.

High adds local ambient occlusion before bloom and six nearby street lamps that light car bodies and facades at night. Lamp selection cross-fades, and broken lamps switch off immediately. Transparent effects and camera-dissolving foliage/characters are excluded from the contact-depth pass so invisible geometry cannot leave dark artifacts; sun and moon shadows still apply normally. Medium and Low keep the same resolution settings as before this visual pass.

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

## Weather

`src/sim/weather.ts` (no three.js or DOM) schedules the weather per world seed: eight three-hour slots a day, each kind picked by a stateless hash of (seed, day, slot) with weights clear 45, cloudy 25, overcast 12, rain 12, storm 6. A storm only comes out of rain or overcast, rain clears through cloud, and day 1 is always clear. Changes ramp over 45 game minutes from the slot's start; ground wetness looks back over the earlier rain and dries over about 1.5 game hours. The schedule never touches `sim.rng`, and a save restores it from the saved day and hour (no save change). `SimOptions.weather` defaults to `'clear'`, so headless sims stay clear; gameplay sims use the Weather setting. Overrides (RAINDANCE, debug hooks) ramp over 20 real seconds by default (6 for the cheat) and are not saved. In storms one strike may fall per quarter game minute (a `lightning` sim event `{ x, z, dist }`, 300–1500 m from the player), deterministic for the seed and time.

`Environment.update` takes the weather on every tier: cloud adds up to 0.6 cover and turns the cloud deck and sky grey (rain and storms darken them; at night the deck takes the city's glow from below), the sun and moon lose up to 80 % of their light, shadows soften to 0.4 intensity, the hemisphere fill rises slightly and greys, fog closes in to 45 % of its clear distance in a storm, and exposure rises up to 10 % under cloud. The env map re-bakes through the existing colour trigger. Lightning adds a two-stroke flash (gone within 0.5 s) to the sky's `uFlash` and the hemisphere light; with Lightning flashes off nothing drawn changes. Hooks: `setWeather(kind | fields, { instant })`, `weather()`, `clearWeather()`, `lightning(x?, z?)`, `forceWeather(mode | null)` (the e2e helpers force clear). On the M4 Pro at 1920x1080 High the perf playtest stayed at 60/60/58/60 fps, and storm at night, in a car, and rain at noon at 60 fps (frames 5.6–6.7 ms).

### Rain

`src/render/rain.ts` draws the rain as one instanced batch of thin streaks in a 48 x 30 x 48 m box around the camera: 6000 drops on High, 3500 on Medium, 1500 on Low and 500 on software renderers, with `uRain` following `weather.rain` (none in clear weather). Every drop's position is a hash wrapped in the box in the vertex shader, which adds the fall, the wind slant and a stretch along the camera's velocity, so the CPU only writes uniforms each frame and the rain keeps surrounding the camera at speed. Drops take `Environment.smokeLight`, so they dim at night. `src/render/rainCover.ts` builds a roof-height map on the CPU (2 m cells from the building colliders, garages and decks such as the pier) into a `DataTexture`; drops under a roof are discarded, so no rain falls indoors, in garages or under the pier.

`src/render/wetGround.ts` patches the shared road, sidewalk and plaza materials in `city.ts` once (`onBeforeCompile` with a fixed cache key, uniforms only), so weather changes compile no shaders. `uWet` follows `weather.wet`: albedo darkens up to 35 %, roughness drops, and on High and Medium a noise mask thresholded by the wetness forms puddles (fading in over the first eighth of wetness), with ripple rings while it rains. Covered cells stay dry: the puddle mask and its ripples are scaled by the cover-adjusted wetness, so garages, decks and the pier get neither. Low only darkens and lowers roughness; the software path's Lambert stand-ins take the darkening alone. The ground dries with `weather.wet` after the rain stops.

On a wet road, the light-streak batch in `lightSprites.ts` draws a reflection under the 64 lights nearest the camera (lamps, head and tail lights together), placed at the mirror point between the light and the camera and scaled by the wetness; dry roads get none. On High and Medium, cars within 60 m faster than 8 m/s on a road wetter than 0.3 throw spray off their rear wheels on the existing smoke layer. Rain is visual only: grip and handling are unchanged. `state().render` reports `rainDrops` and `wet`. `node scripts/playtest.mjs --scenario rainnight --size 1920x1080` runs rain at 23:00 on High through the perf scenario's places (see the measurements below). Wet-road streaks are scaled by how dark it is (`max(night, weather dim)`), so by day in the rain, when the weather's dimming turns car lights on, their reflections stay faint.

## Sea

`src/render/waves.ts` (no three.js) defines four Gerstner waves of 4.3 to 31 m, travelling roughly onshore, whose heights scale with `weather.seaState` (0.3 calm, 1 in a full storm): they add up to 0.10 m in calm and 0.35 m in a storm. Their time phases are wrapped in double precision on the CPU and sent as one `vec4` uniform, so they never stutter in float32. `src/render/sea.ts` patches the sea's standard material once (on top of the two-layer ripples, uniforms only, one cache key): every hardware tier adds the wave slopes (three times the geometric tilt, each wave fading out with distance before it aliases) to the ripple normal, and the ripple UVs are worked out from the world position because the sea mesh follows the camera. The software sea (`softwareSeaMaterial`) uses the two longest waves.

On High (`TierSpec.waterGrid`) the sea is a grid around the camera: 1 m cells to 80 m, 4 m cells to 400 m, then a flat skirt to 3 km. It moves in whole 4 m steps, so its vertices stay on a fixed world lattice and do not swim. The vertex shader displaces it with the same waves; each wave fades out before the cells get too coarse for it, and the fine ring's rim vertices between coarse ones are placed on the coarse ring's edges (`seaDisplaceEdge`), so the rings meet without cracks. Other tiers draw a flat plane; switching tier swaps the geometry and the `uDisplace` uniform only (the grid's buffers are freed when leaving High). The waves are visual only: the sim's sea stays flat at `WATER_Y`, so swimming, floating cars and buoyancy ignore them. `state().render.waterGrid` reports the grid; `setWeather({ seaState })` pins the sea state.

The shoreline is analytic, from the layout bounds and `BEACH_W`, `SAND_DROP`, `CURB_H`, `SEABED_Y`: the shader works out the water depth over the beach's sand slope and its drop-off (blending into deep water off the beach's ends), tints the shallows turquoise over the first 4 m of depth (and toward wet sand at the waterline), draws surf bands that move shoreward and grow with the sea state, and a noisy, gently pulsing foam strip 0.5 to 1.5 m wide along the west, north and south quay walls. Foam is part of the albedo, so it darkens at night. The software sea gets the shallows and the surf bands.

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

## Software fallback

Hardware rendering keeps the existing physical materials, procedural sky, reflections, shadows,
bloom, and High/Medium/Low resolution settings. Static city surfaces and street furniture are now
batched in 128 m cells so geometry outside the camera can be skipped.

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
