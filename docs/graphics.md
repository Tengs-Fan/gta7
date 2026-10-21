# Graphics and software rendering

## City and vehicle detail

The hardware presentation adds projecting cornices, sills, piers and mullions, with normal and roughness maps for facade materials, glazing, roads and paving. Ground details include concrete gutters, storm drains and manholes. Broadleaf trees use textured irregular crowns and branching trunks; palms have curved feathered fronds and ringed trunks. These remain spatially batched and instanced.

Vehicle bodies have tapered cabins, sculpted flanks, crowned hoods and clearcoat paint. Rounded tyres, open alloy wheels, brake rotors, mirrors, door seams, grilles, bumpers, plates and exhausts give each vehicle more detail. Exterior fittings add one batched mesh per detailed car and follow damage, burning and pool reset. Distant software traffic retains its simplified model.

High adds local ambient occlusion before bloom and six nearby street lamps that light car bodies and facades at night. Lamp selection cross-fades, and broken lamps switch off immediately. Transparent effects and camera-dissolving foliage/characters are excluded from the contact-depth pass so invisible geometry cannot leave dark artifacts; sun and moon shadows still apply normally. Medium and Low keep the same resolution settings as before this visual pass.

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
