# GTA 7: Grand Turbo Anarchy

An original, GTA-style open-world crime sandbox that runs entirely in the browser.
Steal cars, cause chaos, outrun the cops, and work your way up from a broke ex-con to the top of **San Azura**, a sun-bleached fictional coastal city.

Everything is generated at runtime: the city, the buildings, the cars, the people, every texture, every sound effect and three radio stations of procedural music.
There are no downloaded assets.

> Fan-made parody. Not affiliated with or endorsed by Rockstar Games or Take-Two Interactive.
> All characters, places, vehicles and brands are fictional.

## Quick start

Requirements: Node 22+, a browser with WebGL 2 (recent Chrome, Edge or Firefox with hardware acceleration).

```sh
npm install
npm run dev        # http://localhost:5173
```

Production build:

```sh
npm run build      # type-checks, then bundles to dist/
npm run preview    # serves dist/ at http://localhost:4173
```

`dist/` is a static site with relative paths, so it can be hosted anywhere.

## Controls

| Action | Keyboard & mouse | Gamepad |
| --- | --- | --- |
| Move / drive | W A S D | Left stick |
| Look / aim | Mouse | Right stick |
| Accelerate / brake (car) | W / S | RT / LT |
| Sprint | Shift | A |
| Jump / handbrake | Space | X / RB |
| Shoot / punch | Left click | RT |
| Aim | Right click | LT |
| Enter / exit vehicle (also carjacks) | F | Y |
| Interact (missions, shops, save) / horn in car | E | D-pad up / L3 |
| Reload / next radio station in car | R | B / D-pad right |
| Weapons | 1–6, Q, mouse wheel | LB / RB (LB in a vehicle) |
| Taxi / vigilante job | T | D-pad down |
| Camera distance | V | R3 |
| Map | M | Back |
| Pause | Esc / P | Start |

Keys are bound by position, and the table names them as on a US QWERTY keyboard.
In the game, prompts and the CONTROLS screen use the names printed on your own layout, so on AZERTY you move with Z Q S D.
Browsers without the Keyboard API (Firefox, Safari) learn the layout as you press keys.

Click the game view to capture the mouse. Pressing Esc releases it and pauses.

## What's in the game

- **A whole city.** Ten by ten blocks across seven districts (Downtown towers, Midtown, Hillcrest suburbs, Westside, the Port Azura docks, Southgate and the Ocean Beach strip), parks, a stadium, a pier with a Ferris wheel, a marina, a lighthouse, a working day/night cycle with lit windows, street lamps and reflections.
- **Living streets.** Lane-following traffic that obeys traffic lights, yields on left turns, honks and drives around blockages; pedestrians who walk the sidewalks, use crosswalks on the right signal, idle, flee from violence, cower at gunpoint, and sometimes fight back.
- **Driving.** Ten vehicles from the Pipsqueak compact to the Nightjar GT sports car, a city bus and a SWAT van, with arcade handling, handbrake drifts, skid marks, damage, smoke, fire and explosions. Five stunt ramps pay out stunt bonuses.
- **Combat.** Fists, pistol, SMG, shotgun, assault rifle and a rocket launcher, with headshots, armor, drive-bys and chain-reaction explosions.
- **Wanted level.** Five stars. Crimes generate heat with witness rules. Police patrols, pursuit units that overtake traffic, officers who arrest at one star and shoot from two, SWAT vans and a helicopter with a spotlight. To lose the cops, break line of sight and leave the search area, or drive into a **Spray Shack**. Getting caught means BUSTED; dying means WASTED.
- **Story.** Six missions for two contacts, Mama Lou and Dex Moreau, ending with a bank heist.
- **Side content.** Taxi fares, vigilante jobs in a police car, three gang rampages, twenty hidden packages, health/armor/weapon pickups, and the Bang Bang Guns weapon shop.
- **Radio.** NEON DRIVE 88.7 (synthwave), BOOM BAP 101.3 (hip-hop) and PULSE 96.1 (house). All three are generated live and never repeat exactly.
- **HUD.** Radar with GPS routing to waypoints and objectives, full-screen map with waypoints, stats, settings (quality, volumes, sensitivity, invert Y, field of view), and saving at the safehouse plus autosave after missions.

Cheats are typed during play: `CHILLOUT`, `GUNSGALORE`, `FIXMYRIDE`, `IMMORTAL`, `MONEYTREE`, `SUNSET`, `NIGHTOWL`, `SPAWNSPORTS`, `COPMAGNET`.

## Architecture

The game is split into a **headless simulation** and a **presentation layer**:

```
src/
  core/     math, seeded RNG, typed event emitter, 2D SAT collision and ray tests
  world/    deterministic city generator, lane graph with signals and A*, sidewalk graph,
            static collider grid with DDA raycasts, ground height / water / zones
  sim/      the game itself: entities, vehicle & character physics, driver AI, pedestrians,
            police & wanted level, combat, pickups, shops, side activities, missions, saves
  render/   three.js views that mirror the sim each frame (city, props, sky, water,
            vehicles, instanced crowd, particles, markers, camera)
  ui/       HUD, radar and map, menus
  input/    keyboard, mouse (pointer lock) and gamepad mapping
  audio/    synthesized effects, engine and siren, procedural radio
  game.ts   frame loop and game states;  main.ts  boot;  debug.ts  window.__gta7 test API
```

`src/sim` never touches the DOM, WebGL or audio, so the whole game runs in Node.
That is what makes it testable: missions are generator scripts resumed synchronously inside `Sim.update`, physics runs at 120 Hz substeps, and every system can be stepped deterministically from a test.
The renderer, HUD and audio subscribe to sim events (shots, explosions, impacts, messages) and read entity state each frame.

## Testing

```sh
npm test              # unit tests: collision math, world invariants, physics, AI,
                      # combat, police, every story mission completed by a bot,
                      # failure paths, saves, and a 10-minute chaotic soak test
npm run test:e2e      # Playwright: builds, serves and plays the real game in Chromium
npm run check         # typecheck + unit + build + e2e
```

The end-to-end suite boots the production build. It plays through real keyboard, mouse and gamepad input, including the first mission, carjacking, shooting, wanted levels, menus, the gun shop, save and continue after a reload, night rendering and quality switches, and a two-minute chaos session. It asserts there are zero console errors.
Automated browsers (Playwright and `scripts/playtest.mjs`) run without pointer lock, because headless Chromium stops delivering frames once it grants the lock; pass `--pointer-lock` to the playtest script or add `?lock=1` to the URL to re-enable it.

It uses the hardware GPU through ANGLE/Vulkan by default. On machines without a GPU, run it with software rendering:

```sh
GTA7_SWIFTSHADER=1 npm run test:e2e
```

## Performance

The game targets 60 fps on desktop hardware. On an RTX 3070 laptop it renders about 200–550 draw calls at roughly 3 ms of CPU per frame.
**Graphics quality** in Settings defaults to *Auto*, which picks a tier once at startup from the GPU: *High* on discrete graphics cards, *Medium* on integrated and mobile GPUs, and *Low* on software renderers (and on integrated GPUs driving very large screens).
*Medium* renders at 85% resolution (ignoring high-DPI scaling) with smaller shadow maps, at most two dynamic lights and a little less traffic.
*Low* renders at 67% resolution without anti-aliasing, shadows, bloom or dynamic lights, with fewer cars and pedestrians, and does not draw ambient cars farther than 150 m.
Colours are the same on every tier.
Anti-aliasing changes take effect after a reload; everything else applies at once.
If the graphics driver resets, the game pauses behind a notice and carries on once WebGL is restored.

## License

Code: MIT. Fonts: Anton and Rajdhani, SIL Open Font License (bundled via Fontsource).
