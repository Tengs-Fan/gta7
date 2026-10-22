# Graphics and software rendering

## City and vehicle detail

The hardware presentation adds projecting cornices, sills, piers and mullions, with normal and roughness maps for facade materials, glazing, roads and paving. Ground details include concrete gutters, storm drains and manholes. Broadleaf trees use textured irregular crowns and branching trunks; palms have curved feathered fronds and ringed trunks. These remain spatially batched and instanced.

Vehicle bodies have tapered cabins, sculpted flanks, crowned hoods and clearcoat paint. Rounded tyres, open alloy wheels, brake rotors, mirrors, door seams, grilles, bumpers, plates and exhausts give each vehicle more detail. Exterior fittings add one batched mesh per detailed car and follow damage, burning and pool reset. Distant software traffic retains its simplified model.

High adds local ambient occlusion before bloom and six nearby street lamps that light car bodies and facades at night. Lamp selection cross-fades, and broken lamps switch off immediately. Transparent effects and camera-dissolving foliage/characters are excluded from the contact-depth pass so invisible geometry cannot leave dark artifacts; sun and moon shadows still apply normally. Medium and Low keep the same resolution settings as before this visual pass.

## Time of day

The sky's image-based light (the baked environment map) is re-baked whenever the analytic sky colours change by about 2 %, at most about twice a real second, and at once after a jump in time (or every quarter game hour otherwise). Between bakes `scene.environmentIntensity` is scaled by the ratio of the sky's current to its baked irradiance (clamped to 0.5–2), so dawn and dusk brighten and darken every frame instead of in steps. This applies to every hardware tier with half-float targets; without them (and on software renderers) the sky light is an analytic hemisphere fill that was already continuous. The player car's local reflection probe recaptures after 0.05 game hours, still at most one capture start per half second. `__gta7.setClockRate(r)` and `__gta7.envStats()` help check this in the browser.

## Finish pass: colour grade and anti-aliasing

Every hardware tier ends its effects with `FinishPass` (`src/render/finishPass.ts`): High runs contact shadows, bloom, finish; Medium bloom, finish; Low finish alone. It works in linear HDR before three's own ACES and sRGB output, so tone mapping and colours stay the same pipeline on every tier. The grade (`gradeAt(hours, weather?)` in `src/render/grade.ts`) is keyframed over the day: noon is near neutral, golden hour (18:24) is warmer, and night is cooler, slightly desaturated, with a stronger vignette. It applies a luminance-normalised white balance, saturation, contrast in log space around mid grey, a small split tone and a vignette; no parameter moves more than 1e-3 per game minute, midnight included. Cloud lowers saturation and contrast and rain deepens the vignette once weather supplies those inputs (clear by default).

High and Medium keep 4x MSAA from the WebGL context. Low uses FXAA inside the same pass: three's `FXAAShader`, patched to detect edges and blend in a reversible tone-mapped proxy (`c / (1 + max(c))`), so edges against bright lamps are not biased toward the light and HDR values are not clamped. The module throws on load if the patch no longer matches three's shader. Software renderers and GPUs without half-float targets have an LDR output where three allows no effects, so they get neither FXAA nor the grade. Tier switches only change the pass's uniforms (no shader rebuild). `__gta7.setPost({ aa, grade, vignette })` overrides it until the next quality change, and `state().render.post` reports `{ aa, grade, vignette }`.

On the M4 Pro at 1920x1080 High the perf playtest stayed at 60 fps in all four segments (final frames 5.3–6.8 ms).

## Night lights

`src/render/lightSprites.ts` draws three instanced batches, one draw call each, on every tier including software renderers. Lamp glows are camera-facing sprites at each working head, tail, brake, reverse and siren lamp (`VehicleView.lampWorldPositions()`), so smashed lamps and destroyed cars leave no glow. Each glow's colour times intensity stays below the bloom threshold (2.6), so bloom does not flicker on them; brake glows are about 2.2 times the running tail glow. Headlight pools are soft patches on the road ahead of cars with their lights on, nearest first, capped at 40 (High), 24 (Medium) and 12 (Low). On Low, which has no headlight spot light, the player's car gets a pool too. A third batch, light streaks, is ready for wet roads and stays empty until rain enables it. Lights turn on at night or when `GameRenderer.weatherDim` is high (the input for dark weather). `state().render` reports `glows`, `pools` and `streaks`.

Street lamps have a plinth, a lighter metal tapered pole, a curved arm and a luminaire head with a lit lens. The head position (`LAMP_HEAD` in `src/render/props.ts`) is shared by the lens, halo, ground pool and High's street lights, so they line up. A knocked-down lamp hides every part, including its halo and pool.

Street Run gates use open ground outlines and slim illuminated posts, with a separate readable turn instruction, road name, gate count and distance. This keeps traffic visible through a checkpoint.

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

These are short representative scenes, not a guarantee for every crowded chase. The 31 selected production-browser checks cover walking, vehicle entry/driving/damage, the first mission, police, death/respawn, saves, UI, gamepad, audio, a two-minute chaos session, city lighting, quality switching, context recovery and Street Run journeys. All pass after updating the existing keyboard menu test for the Street Run entry. The unit suite has 1,331 tests; the final affected reflection and vehicle suites were rerun successfully after removing ignored material-level reflection settings.

Keyboard-only route probes with ordinary traffic completed Dockside for gold (60.90 s) and Coastline for silver (99.91 s), awarding and saving their rewards. The simple driver reached Magnolia gate 10 before traffic collisions ended the attempt, so this pass does not claim a full keyboard-driven completion of that course. The driver changed no physics or traffic settings.

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
