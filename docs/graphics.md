# Graphics and software rendering

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

## Measured behaviour

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
