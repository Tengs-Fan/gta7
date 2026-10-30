# GTA 7: Grand Turbo Anarchy

An original, GTA-style open-world crime sandbox that runs entirely in the browser.
Steal cars, cause chaos, outrun the cops, and work your way up from a broke ex-con to the top of **San Azura**, a sun-bleached fictional coastal city.

The city, the buildings, every sound effect and the music of nine radio stations are generated at runtime.
The models and textures are free CC0 assets, and every voice (the contacts, the police, people in the street and whole talk stations) is recorded English speech rendered offline with an open text-to-speech model (see [Assets](#assets)).

> Fan-made parody.
> Not affiliated with or endorsed by Rockstar Games or Take-Two Interactive.
> All characters, places, vehicles and brands are fictional.

![A red Nightjar GT rolls through a Midtown junction at golden hour, past shopfronts, traffic and pedestrians](docs/screenshots/street.jpg)

## Quick start

**Play it now in your browser: https://tengs-fan.github.io/gta7/** (Chrome or Edge, with a keyboard and mouse or a gamepad).
To run it yourself:

Requirements: Node.js 22.12 or newer within 22.x, 24.x or 26+ (the range Vitest 5 supports; 23 and 25 are not), a browser with WebGL 2 and hardware acceleration, and a keyboard and mouse or a gamepad: there are no touch controls.
The game is tested in Chromium, so Chrome and Edge are the safe choice; Firefox and Safari should work but are not tested automatically.

```sh
npm install
npm run dev        # http://localhost:5173
```

Production build:

```sh
npm run build      # type-checks, then bundles to dist/
npm run preview    # serves dist/ at http://localhost:4173
```

`dist/` is a static site with relative paths, so it can be hosted anywhere, under a sub-path too.

Choose NEW GAME on the title screen, and a few seconds later Mama Lou calls with your first job: steal a car (walk up to one and press F) and drive it into her garage in the Docks, following the route on the radar.
Choose STREET RUN for an immediate drive in a Nightjar GT and a choice of three timed courses.
Progress stays in this browser: the game autosaves after every mission passed and street run finished, E at the safehouse saves, and CONTINUE on the title screen picks up from there.
To play with friends on your network, run the optional multiplayer server (see [Multiplayer](#multiplayer-optional)).

## Controls

| Action | Keyboard and mouse | Gamepad |
| --- | --- | --- |
| Move / steer | W A S D or the arrow keys | Left stick |
| Look (in a vehicle it orbits the camera) | Mouse | Right stick |
| Sprint (on foot) | Shift | A |
| Jump (on foot) | Space | X |
| Shoot / punch / throw (on foot) | Left click | RT |
| Aim, or the throwing arc for grenades and molotovs, or the sniper scope (on foot) | Right click | LT |
| Scope zoom (sniper rifle, while aiming) | Mouse wheel (Q zooms back out) | LB / RB |
| Reload (on foot) | R | B |
| Choose a weapon | 1–9, mouse wheel, Q (previous) | LB / RB on foot, LB in a vehicle |
| Accelerate / brake and reverse (vehicle) | W or Up / S or Down | RT / LT |
| Handbrake (vehicle) | Space | RB or A |
| Shoot from a vehicle (pistol or SMG), or spray the water cannon in the fire truck | Left click | X |
| Horn, or siren in a police vehicle | E or H | L3 |
| Radio next / previous (vehicle) | R / Q | D-pad right / left |
| Enter / exit vehicle (also carjacks) | F or Enter | Y |
| Interact: missions, shop, save, retry, skip dialogue | E | D-pad up |
| Start / cancel a street run (road car), taxi job (taxi), or vigilante job (police vehicle) | T | D-pad down |
| Phone (on foot), answer a call | Tab | D-pad right |
| Camera distance | V | R3 |
| Map | M | Back |
| Pause | Esc or P | Start |
| Menus | W S or Up Down choose, A D or Left Right adjust, Enter or Space confirm, Esc or Backspace back | D-pad or left stick choose and adjust, A confirm, B back |

- Keys are matched by position and named here as on a US QWERTY keyboard, as bound by default; SETTINGS > Key bindings rebinds any keyboard action.
  In the game, prompts and the CONTROLS screen show the names printed on your own layout, so on AZERTY you move with Z Q S D; Firefox and Safari learn the layout as you press keys.
- The game captures the mouse when you start or resume play, or when you click the game view.
  Mouse look works only while it is captured, and losing it (Esc) pauses the game, as does switching to another tab or window, also on the WASTED or BUSTED screen; RESUME continues.
- Weapon slots: 1 Fists, 2 Pistol, 3 SMG, 4 Shotgun, 5 Assault Rifle, 6 Rocket Launcher, 7 Baseball Bat / Combat Knife, 8 Grenade / Molotov Cocktail, 9 Sniper Rifle; pressing 7 or 8 again switches between the two weapons on that key.
  The wheel, Q and LB / RB step through the weapons you own that still have ammo; in a vehicle only the pistol and SMG fire, Q changes the station, and on a gamepad LB steps the weapons (RB is the handbrake).
- Getting out of a moving car: below 3.5 m/s you step out, up to 11 m/s the car brakes first, and faster than that you bail out, tumble and lose 6 health.
- Motorbikes and boats use the vehicle controls: W / S (RT / LT) for throttle and brake or reverse, A / D (left stick) to lean or steer, F (Y) to get on or off.
  The Viper 600 pulls a wheelie at full throttle below about 12 m/s; a boat steers only with way on, has no handbrake and no street runs, and you board it from the pier or climb in from the water with F.
- In multiplayer the same keys apply (see [Multiplayer](#multiplayer-optional)).
  There the phone key, Tab (D-pad right), lists the room's players instead, and T at a course start, or pause > STREET RUNS, opens a head-to-head Street Run for the room.
- Map: click, or press Enter, Space or A at the center cross, to set a waypoint, and do it again on the waypoint to clear it.
  Drag, the arrow keys, W A S D, the D-pad or the left stick pan; the wheel, + and -, or LB and RB zoom; the number keys 1–7 (or a pad's Y to pick a row and X to switch it) turn legend categories on and off; M, Esc or Back close it.
  The game is paused while the map is open.
- Gamepads: the first pad the browser reports with the standard mapping is used.
  Buttons are named Xbox-style, and prompts switch to pad buttons as soon as you use the pad, and back to keys when you press a key.

## What's in the game

- **A whole city.** San Azura is a street grid across seven districts (Downtown towers, Midtown, the Hillcrest suburbs, Westside, Port Azura Docks, Southgate and the Ocean Beach strip), broken up by the sea and by big blocks (see [docs/map.md](docs/map.md)).
  Hillcrest Cove bites into the north-west corner, Cortez Canal runs from coast to coast between Westside and Downtown under a bridge at every street, Port Basin cuts into the docks with cranes on its wharf and boats moored in it, and Azura Point reaches out into the bay with the lighthouse at its tip.
  The rest of the coast steps in and out too: Gull Bay and Northshore Bay flank Hillcrest Green on the north shore, Pelican Harbor bites into Westside and Coral Bay cuts in west of the beach, with the ring road crossing each bay's mouth on a bridge, so the city no longer reads as a square.
  Hillcrest Green is a park four blocks big, Civic Plaza an open square between downtown towers, and the Azura Bowl stadium stands between its car parks; Azura Park and Southgate Square, Azura Pier and its Ferris wheel and the Marina complete it.
  Parody shopfronts (DONUTS, PAWN, TACOS, BAIL BONDS and more), tower lobbies and house porches line the streets, and lamp posts, traffic signals, fire hydrants, bins and benches break.
- **The look.** Stylised low-poly models with PBR materials, all CC0 (see [Assets](#assets) and [Credits](#credits)).
  People are chunky toy figures built in code from rounded segments on the game's own jointed skeleton: a face, hair, caps and sunglasses, shirts with collars and jackets, police badges, and their own height, build and colours; feet are planted by the gait, and every body part is one instanced draw for the whole crowd.
  Cars: seven kinds (compact, sedan, taxi, sports, muscle, pickup and police) are low-poly Quaternius models fitted to the cars' real sizes and axles, with number plates, lined cabins and riders seated inside; the van, bus, SWAT van, ambulance and fire engine are rebuilt procedural bodies. Every car has tinted glass that mirrors the sky and street, clearcoat paint, moulded lamp lenses that glow softly after dark, tyres with sidewalls, and a soft shade under it; dents, broken lamps and wrecks show on the new bodies.
  Buildings have PBR stone, brick, plaster and metal facades with recessed windows, sills, cornices and parapets. Roofs carry HVAC units, water tanks, stair housings, antennas, vents and roof gardens. Four landmark towers (a stepped crown with a spire, a pyramid, an open crown and a wedge) mark the skyline, and the skyline keeps its outline in the afternoon haze. Shops have 178 storefront designs with rooms behind the glass, signs and awnings, lit at night.
  Ground and water: PBR asphalt with repairs, cracks, lane wear, cast-iron manholes and junction tyre marks; kerb grime; lawns with colour variation and a frayed edge; beach sand with wind ripples, a wet band and the swash's foam. The sea darkens from turquoise shallows to deep blue offshore, its ripples no longer tile, and foam rings the pier and Marina pilings. A rocky foreshore of boulders, wandering out into rocky fingers here and there, runs along the foot of the open coast's sea walls and heaps up round Azura Point; the harbour basin and the canal keep their plain quays.
  Modelled street furniture (lamps, benches, bins, hydrants, traffic signals, site signs, deck rails and bollards), leaf-card trees with branching trunks, curved ringed palms, foliage that sways in the wind on High and Medium, beach and yard dressing (umbrellas, towels, loungers, lifeguard towers, volleyball nets, surfboards; picket fences, mailboxes, shrubs, planters, wheelie bins), and furnished garages at Lou's, the spray shacks and the safehouse.
  Motorbikes and boats are sculpted procedural models: sport bike and scooter with lugged tyres, spoked or alloy rims, forks, tanks or body panels, seats and mirrors; speedboat, dinghy and the Marina's moored cruisers with vee hulls, rails, seats, a glass windscreen and modelled outboards; a foam ring marks each boat's waterline. Bikes and boats (and their riders) fade in where they appear.
  Modelled guns (slide or receiver, grip, trigger guard, sights, hollow muzzle; magazine, pump, handguard, stock or scope per gun) on the sim's weapon points; the muzzle flash rides the gun's recoil.
  Explosions: a volumetric fireball (noise-shaded puffs, HDR core) scaled to the blast, spark streaks, modelled debris that settles on the ground, a dense dark smoke plume from burning wrecks, scorch marks draped on the ground (not on the sea), and a burnt (soot, char, bare metal) wreck material for cars, bikes and boats.
  Lighting: the city is lit by a sky HDRI blended with the time-of-day sky (smooth dawn and dusk kept); at night a warm city glow on the sky, a lifted black level so streets read, lamp haze that grows in rain and wet-road reflections in each light's colour, traffic signals included; a golden sunset; darker garage interiors; ambient occlusion at the foot of walls and contact shadows under people.
- **Day and night.** A day lasts 24 minutes.
  Clouds catch the sunset, a moon and stars come out, windows light up building by building through the evening and thin out after midnight, and at night the Ferris wheel lights up and the lighthouse beam sweeps round.
  Shops stay open late: about two thirds are lit at 22:30, then they close one by one until shortly after 02:00.
- **Weather.** Clear, cloudy, overcast, rain and storm skies change every three game hours (the first day is always clear), with greyer skies, softer shadows, closer fog, lightning in storms, and cars turning their lights on when it gets dark. Rain falls around the camera (but not under roofs, in garages or under the pier), wets and darkens the streets with puddles that dry out after the shower, reflects lamps and car lights in streaks on the road, and fast cars throw up spray. Boats under way leave a foam wake and throw spray off the bow (High and Medium). Weather is visual only: it does not change grip or traffic. The sea rolls with waves that grow in a storm (on High the surface itself rises and falls), with turquoise shallows, surf on the beach and foam along the quay walls; bullets and rockets fired into it splash or throw up a column of water at the surface. Swimming and floating stay level whatever the waves.
- **Living streets.** Traffic follows its lanes, stops at red lights, yields on left turns (judging a fast player car by when it gets there, not only how near it is), honks, overtakes, steers round cars left empty in the road and backs out of blockages, from about 14 cars around you late at night to 30 at rush hour.
  Pedestrians cross on the walk signal, flee from gunfire and explosions, put their hands up, cower or run at gunpoint, and some fight back, above all the street gangs: Los Tiburones (teal; Docks and Westside) and Los Halcones (red and gold; Southgate), each with its own cars and turf, shown on the map.
  Walk into their turf with a gun out, or attack one of them, and the whole crew comes for you; now and then the two gangs fight it out where their turfs meet.
  Hit someone or open fire with no police around and a bystander may pull out his phone, and a few seconds later you are wanted unless you stop him first; ram another car hard and its driver may jump out to fight you or run for it.
- **Driving.** Sixteen vehicles: the Pipsqueak compact, Velora sedan, Azura Cab, Nightjar GT sports car, Thunderhoof muscle car, Dustrunner pickup, Breadbox van, Citybus, Patrol Cruiser, Riot Van, an ambulance and a fire truck, the Viper 600 sport bike and the Zippa 50 scooter, and the Marlin speedboat and Puffin dinghy, and you can steal any road vehicle, even with someone inside.
  Arcade handling with handbrake drifts, skid marks and tire smoke, and the body rocks on its springs over curbs and bumps; cars dent, lose their lamps and glass, spark along walls, catch fire when they land on their roof and blow up, and you can see who is inside through the glass.
  Cars wade through the surf off the beach but sink in deep water, where the people in them swim out or drown, and Azura Pier and the Marina deck can be driven onto, and off.
  Five stunt ramps pay stunt bonuses, doubled for the first jump off each one.
  The bikes lean into turns, the sport bike pulls wheelies, a hard crash throws the rider off, and bikes ride in traffic, park in the bays and can be stolen like cars.
  Boats wait at the Marina: step aboard from the pier (or climb in from the water) with F, run them on the open sea where they ride the waves; they run aground on the beach, stop at quays and piers, and leaving one puts you on the pier or in the water.
- **On foot and in the water.** Walk, sprint and jump (long falls hurt); with your back to a wall the camera rises over your shoulder and looks down at you, aiming or not (the crosshair stays where the drawn view points; the sniper scope is still your eye). Swim in deep water: there is no drowning, but no shooting, weapon switching or getting into cars either.
- **Street runs.** Three repeatable timed courses with a launch countdown, ordered checkpoints, turn directions, bronze/silver/gold medals, cash payouts and saved personal bests. Take the fast avenues of Magnolia Rush, the long coastal sweep of Coastline Circuit, or the tight corners of Dockside Switchback, twice over the canal.
- **Combat.** Fists, Pistol, SMG, Shotgun, Assault Rifle and Rocket Launcher, and a Baseball Bat and Combat Knife (combos: the bat floors people, the knife makes them bleed), Grenades and Molotov cocktails (hold right mouse for the throwing arc; grenades bounce and blow 3 s later, molotovs start a spreading fire that sets people and cars alight) and a Sniper Rifle (right mouse for the scope, the wheel zooms), sold at Bang Bang Guns and found around the city.
  Hip fire is quick and loose, while aiming zooms over the shoulder and tightens the spread; hit markers show hits, headshots and kills, and red arcs show where fire is coming from.
  Body armor, jab-jab-hook punch combos, drive-bys with the pistol or SMG, and explosions that throw people and cars and set off damaged or light cars nearby.
  The dead drop their cash, and the police helicopter can be shot down.
- **Wanted level.** Five stars.
  Crimes like carjacking, assault and gunfire count only when the police see them, and so does killing a gang member or an armed mission guard, while murdering anyone else, attacks on the police and explosions are always reported.
  Patrol cars, pursuit units that from two stars cut you off from ahead and shoot from their windows, SWAT Riot Vans from four stars, and a helicopter from three that loses you behind buildings and at night sees little beyond its spotlight.
  Officers arrest you when they reach you on foot while you are not running, or beside your car once it has stopped, and from two stars they shoot on sight (at any level once you attack one of them); a DISPATCH line on the HUD narrates the chase.
  From three stars the police also set up roadblocks ahead of you with spike strips; burst tyres slow you down and make the car slide.
  To lose them, break line of sight and get out of the red search area on the radar (or hide inside it for longer) until the evade bar fills, or pay a Spray Shack $100 a star for a respray, if the police don't see you drive in.
  BUSTED costs bail ($100 plus $150 a star) and, from two stars, your guns; WASTED costs a hospital bill ($100 plus $100 a star) and your armor.
- **Story.** You are Kai Navarro, just out after six years inside, and a new game opens with a call from Mama Lou.
  Twelve missions in two chapters. Chapter 1: Wheels, Hot Delivery and Repo Man for Lou, then Loose Lips, Heatwave and The Big Score for Dex Moreau, the last a raid on the First Azura Bank with a getaway to the Marina; Hot Delivery, Repo Man and Heatwave pit you against the Tiburones.
  The Big Score ends with CHAPTER 1 COMPLETE and a pointer to Vera Salgado, who has work at Hotel Salgado in Southgate (the lime V on the map).
  Chapter 2 for Vera: Shadow Play (tail a courier without being seen), Room Service (hold the hotel against three waves), Showroom Condition (steal a yellow Nightjar GT; under 70% condition pays half), Off the Road (ram two cars off the road), Rush Hour (a timed four-stop pickup) and Last Call (a 3-star finale: lose the cops), paying $7,000 to $15,000.
  The contacts are the pink L, the teal D and, once The Big Score is done, the lime V on the radar, shown while they have a job for you; a failed mission can be retried with E within 20 seconds, or later from the pause menu, on foot or in a vehicle, as long as you are not wanted or on a rampage; Heatwave and The Big Score have checkpoints.
- **Phone.** Tab (D-pad right) opens the phone: contacts call when they have work and route your GPS to them (a call never starts a mission by itself; walk into the marker and press E), Texts keep mission rewards and payouts, and Azura Cab picks you up and drives you to your map waypoint for a small fare (refused while wanted, in a vehicle or during a mission; press F to get out early at no charge).
- **Properties.** Buy the garage across the street from the safehouse ($15,000; stores 4 cars with their paint and upgrades) and the Pier Arcade ($25,000; $500 a game day, up to 7 days, collected at the safehouse). Azura Customs (east Midtown, purple C) sells engine, brakes and tyre upgrades and paint; upgrades stay with the car, and through saves only for cars stored in the garage.
- **Side content.** Taxi fares in an Azura Cab and vigilante jobs in a police vehicle (press T), paramedic jobs in an ambulance (San Azura General) and firefighter jobs in the fire truck (SAFD Station 1 by SAPD Central; hold fire to use the water cannon), both with levels, Azura Express courier runs from First Azura Bank in any car or on a bike (press T there), Lou's export list at her garage (ship 8 listed cars at the docks crane), three gang rampages, twenty hidden packages ($25,000 for finding them all), unique stunt jumps, health, armor and weapon pickups, and two Bang Bang Guns stores (from the Pistol at $250 to the Rocket Launcher at $8,000, Body Armor $300, First Aid $80).
- **Radio and sound.** In a vehicle, nine stations play endless music generated live, up the dial: NEON DRIVE 88.7 (synthwave), VELVET 89.9 (lounge and bossa nova), DOCKSIDE DUB 92.3 (dub), PULSE 96.1 (house), COYOTE 97.7 (outlaw country), WIPEOUT 99.5 (surf rock), BOOM BAP 101.3 (hip-hop), BREAKNECK 102.7 (drum and bass) and PIXEL 103.9 (chiptune), each with spoken station idents.
  Up the dial from there, the talk stations: AZURA TALK 104.5 runs Chet Bramble's talk show (his rants, callers, Dolores Vance's newsdesk and Skip's traffic from the Skycopter), and THE BOWL 1090 AM, narrow and hissy on the AM band, has Big Ron Tackett on the hopeless San Azura Gulls, Sal from Southgate on the phone every night and Nate Pruitt's injury report; RADIO OFF is the last stop, and tuning in shows the station's name and a one-line tag.
  Every talk station is live whether or not you listen, with spoken idents over its own jingle and parody ad breaks that suit it: Morty Fenwick's campaign goes on from one break to the next, the fine print races by, and Azura Cab, San Azura General and Azura Express are hiring.
  AZURA TALK's newsdesk reports on you: after one of Chet's pieces, Dolores Vance breaks in with your chases of two stars or more (where they started and ended, a police helicopter that did not make it home, whether you got away), a car you drove into the water, a pile of burnt cars, and each mission you pass, with a follow-up a game day later; a story airs at most twice.
  Her forecast reads the weather's own schedule, so it comes true: the sky now, the next change today and tomorrow's, then "as promised" when the change arrives while you listen (under Always clear, City Hall has banned weather).
  Songs have an intro, verses, a bridge and an outro with fills, and each station drives harder in its own way while you are wanted, then calms down after: WIPEOUT's tom groove takes over, DOCKSIDE DUB turns to steppers, VELVET's band panics into double-time swing, COYOTE breaks into banjo rolls and PIXEL plays the boss battle.
  The police dispatcher reads each dispatch line over the scanner; sirens drop in pitch as they pass (Doppler); gunfire echoes by district, ringing on between downtown towers and hardly at all on the open beach.
  Mama Lou, Dex and Vera speak every line of their missions, and their calls come down a phone line; officers shout at you to freeze, a cruiser's loudspeaker orders you to pull over, and people in the street say hello, yell after their stolen car, curse a driver who rams them and call for help.
  An ambience of city hum, traffic, surf, gulls, birds by day and crickets at night, an engine voice for every kind of vehicle, music that ducks under dialogue and nearby explosions, and the world muffled inside a car.
  Tyres squeal in wandering bands of noise when they slide (lower and choppier braking straight, a chirp off the line in a strong car, only a scrub on sand and grass); crashes thud, crunch and ring, breaking glass on hard hits; scrapes grind; explosions crack, roar and rumble on with debris pattering down; sirens sound through a horn speaker.
- **HUD, map and saves.** A radar that turns with the camera, with a road-following GPS route to your waypoint, the objective or the contact who has work, and the police, the helicopter and the search area on the radar and the map while you are wanted.
  Prompts and first-time hints drawn for your keyboard layout or gamepad, a full-screen map with district names, a waypoint you can set, a legend with seven categories you can switch off (missions, shops including Azura Customs, places, properties grey for sale and green owned, gang turf, collectibles, and the cyan A, F, C and E marks of the paramedic, firefighter, courier and car export jobs), a completion checklist (story per contact, collectibles, activities, properties), and a STATS screen with a game completion percentage (story 50%, packages 20%, stunts 15%, rampages 15%; jobs and properties are checklist-only).
  Three save slots in the browser: save at the safehouse with E, which asks for a slot (not while wanted, on a mission or on a rampage), plus an autosave after every mission passed. A slot with a save asks before it is replaced; CONTINUE asks which slot to load; autosaves go to the slot the game was loaded from or last saved to, a new game autosaves into the first empty slot, and with all three full it does not autosave until you save at the safehouse. A save from an earlier version moves into slot 1 on first start.
- **Multiplayer (optional).** Free roam for up to 8 players per room on your own machine or LAN, with a small Node server you run yourself: each player with his own wanted level, police and side jobs in a shared city. Single player stays the default and needs no server; see [Multiplayer](#multiplayer-optional).

<table>
  <tr>
    <td width="50%" valign="top"><img src="docs/screenshots/night-chase.jpg" alt="At night in Hillcrest, a police cruiser with its light bar flashing rides alongside a yellow Nightjar GT while the police helicopter arrives with its searchlight"><br>Three stars after dark in Hillcrest, with the helicopter's searchlight closing in.</td>
    <td width="50%" valign="top"><img src="docs/screenshots/combat.jpg" alt="Over the player's shoulder, assault rifle fire goes into a smoking police cruiser in Downtown while two officers shoot back"><br>An assault rifle against a burning Patrol Cruiser in Downtown.</td>
  </tr>
  <tr>
    <td width="50%" valign="top"><img src="docs/screenshots/mission.jpg" alt="The player's dark blue car with a Tiburones car under a red marker behind it, the DELIVERY timer at 0:38 and the objective Lose the tail"><br>Hot Delivery: shaking off a Tiburones car with the DELIVERY clock running.</td>
    <td width="50%" valign="top"><img src="docs/screenshots/beach.jpg" alt="The player walks along Azura Pier under the Ferris wheel, with the palm-lined beach and the skyline across the water"><br>Azura Pier and its Ferris wheel, with Ocean Beach and the skyline behind.</td>
  </tr>
  <tr>
    <td colspan="2" align="center"><img src="docs/screenshots/map.jpg" width="50%" alt="The full-screen map of San Azura: Hillcrest Cove in the north-west, Cortez Canal from coast to coast, Port Basin in the docks, Azura Point and its lighthouse to the north, Hillcrest Green, Civic Plaza and the Azura Bowl, with district names, markers and a legend"><br>The full-screen map: the cove, the canal, the basin and Azura Point.</td>
  </tr>
</table>

## Street runs

Choose **STREET RUN** on the title screen, select a course (each one lists its gold, silver and bronze times and your best), and launch in a Nightjar GT. Existing saved money, story progress and personal bests carry over.
During free roam, press **T** (D-pad down) in an ordinary road car to enter the nearest course. Finish any mission and lose the cops first; taxis and police vehicles keep their own jobs.

Follow the GPS route and stop inside the start gate. The car lines up for a three-second countdown; hold W or RT to launch at GO.
Pass every glowing checkpoint in order, using the turn direction above the radar and the route to prepare for corners. The clock shows your next medal target, and the last gate is the finish line.
During a run the next two junctions with traffic lights on the course hold green for you: cross traffic waits at red and pedestrians stay off your road. Each gate covers the whole junction, so a tight line through a corner still counts.

| Course | Start area | Gold | Silver | Bronze | Gold payout |
| --- | --- | --- | --- | --- | --- |
| Magnolia Rush | Azura Ave / Magnolia Ave | 0:55 | 1:10 | 1:35 | $1,000 |
| Coastline Circuit | Sunset Ave / Magnolia Ave | 1:05 | 1:25 | 1:55 | $1,400 |
| Dockside Switchback | Vista Ave / Southgate Ave | 0:52 | 1:06 | 1:30 | $1,250 |

Silver pays 70% of the gold prize and bronze pays 45%. Every successful finish saves your reward and personal best; slower replays retain your faster record.
The courses loop back to their starts, so press T after a finish to line up again. Drive to another start area to enter its nearest course, or choose it from the title screen.
Press T during a run to cancel. Running out of time, leaving the car, or losing it to a wreck ends the attempt without a payout.

## Cheats

Type a code during play: no Enter, any mix of upper and lower case, each letter within 1.5 seconds of the one before.
A message confirms it ("Cheat activated", "Cheat: god mode on" and "Cheat: god mode off" for IMMORTAL, or the new weather for RAINDANCE).
The first letters of a code may briefly do their usual job (M opens the map, F gets you out of your car), and the game undoes that once the code is complete.

| Code | Effect |
| --- | --- |
| `CHILLOUT` | Clears the wanted level, but not below the stars a mission fixes (the bank alarm in The Big Score) |
| `GUNSGALORE` | Gives you the Pistol, SMG, Shotgun, Assault Rifle and Rocket Launcher if you lack them and adds 300 rounds to each, every time you type it |
| `FIXMYRIDE` | Repairs the vehicle you are in or, on foot, the nearest one within 30 m that you were the last to drive: full health, fire out, back on its wheels |
| `IMMORTAL` | God mode on or off: no damage to you, or to your vehicle while you drive it; you can still be BUSTED |
| `MONEYTREE` | Adds $50,000 |
| `SUNSET` | Sets the clock to 18:18 |
| `NIGHTOWL` | Sets the clock to 23:00 |
| `SPAWNSPORTS` | An empty Nightjar GT about 6 m ahead of you, if there is room for one within 20 m |
| `COPMAGNET` | Two more wanted stars, up to five |
| `RAINDANCE` | Steps the weather: rain, storm, overcast, clear, then back to the forecast (not saved) |

## Settings and graphics quality

SETTINGS is on the title screen and in the pause menu.
Changes apply at once and are stored in the browser (`localStorage` key `gta7.settings.v1`); the three save slots are stored in the browser too (`gta7.save.slot1` to `gta7.save.slot3`, with the last slot used in `gta7.saves.v1`). A single save from an earlier version (`gta7.save.v1`) is moved into the first empty slot the first time the slots are read, byte for byte, and still loads with all its progress.
The map's legend toggles are remembered with the settings.

| Setting | Range | Default |
| --- | --- | --- |
| Graphics quality | Auto, Low, Medium, High | Auto |
| Master volume, Music (radio), Sound effects | 0–100% each | 80%, 60%, 85% |
| Mouse sensitivity (the right stick too) | 0.20–3.00 | 1.00 |
| Field of view (wider at speed in a vehicle, narrower when aiming) | 55–90° | 68° |
| Invert look Y (mouse and right stick) | On / Off | Off |
| Tutorial hints (first-time hints and the "Press F to steal" prompt) | On / Off | On |
| Weather (Always clear ramps the sky to clear and keeps it so) | Dynamic, Always clear | Dynamic |
| Lightning flashes (off: storms keep their rain and lightning events, without the sky and light flash) | On / Off | On |
| Resolution scale | 50–100% | 100% |
| FPS cap | 30, 60, Unlimited | Unlimited |
| Subtitle size | Small, Normal, Large | Normal |
| Camera shake | On / Off | On |
| Key bindings | rebind any keyboard action (a key another action uses is refused, naming it; arrows, Esc, Enter, Backspace, right Shift, number keys and +/- keep their jobs); RESET TO DEFAULTS | |
| DELETE SAVE | deletes one slot, asks first | |

**Auto** picks a tier once per page load from the GPU, and the row shows its choice, such as AUTO (HIGH).
It picks High on discrete GPUs (laptop ones included) and on Apple M-series Pro, Max and Ultra chips, Medium on other integrated GPUs (GeForce MX laptop chips count as integrated), on phone and tablet GPUs and on any GPU it does not recognize, and Low on software renderers and on integrated GPUs driving very large screens (where Medium would draw more than 3.5 million pixels, such as 3440x1440, or 3840x2160 at 100% scaling).

| | High | Medium | Low |
| --- | --- | --- | --- |
| Resolution | full, pixel ratio up to 1.5, at most 3.5 million pixels | 85%, high-DPI ignored | 67%, high-DPI ignored |
| Anti-aliasing | 4x MSAA | 4x MSAA | FXAA |
| Time-of-day colour grade and vignette | on | on | on |
| Sun shadows | 2048 map | 1024 map | off |
| Bloom | on | on | off |
| Contact shadows on streets and vehicles | on | off | off |
| Building facades (recessed windows, sills, shop interiors) | full depth | full depth | flat |
| Texture filtering on the ground / on facades | 16x / 8x anisotropic | 8x / 4x | 4x / 2x |
| Foliage sways in the wind | yes | yes | still |
| Nearby street lamps illuminate cars and facades | six pooled lights | off | off |
| Dynamic lights (sirens, muzzle flashes, explosions) | all | two, shared | none |
| Your headlight beam at night | on | on | off |
| Headlight patches on the road at night (nearest cars, yours included on Low) | 40 | 24 | 12 |
| Rain streaks around the camera | 6,000 | 3,500 | 1,500 |
| Wet streets | puddles and ripples | puddles and ripples | darker and glossier |
| Tyre spray on wet roads | on | on | off |
| Boat wake and bow spray | on | on | off |
| Sea waves | the surface rises and falls | in the lighting | in the lighting |
| Traffic and pedestrians | 100% | 90% | 75% |
| Ambient cars drawn | all | all | within 150 m |

Cars beyond about 40 m use a lighter far version on every tier, and contact shadows are worked out at half resolution, reach about 110 m and fade out while the camera moves fast.
Cars are the new models on every tier.
Software renderers draw flat facades, the procedural ground maps without anisotropic filtering and still foliage, and keep the analytic hemisphere fill with no grade lift and no garage or wall darkening; [graphics notes](docs/graphics.md) has the per-tier lighting table ("Lighting and sky") and the full per-tier summary.
Colors are the same on every tier; Low loses the bloom, the shadows and some of the sky's detail. Head, tail, brake and reverse lamps glow at night (and in dark weather) on every tier, wet roads reflect them in streaks, and the shallows, surf and quay foam are drawn on every tier.
Everything applies at once except MSAA, which changes after a reload (the Settings screen says so); Low's FXAA follows the tier at once. So a page started on Low and switched to Medium or High has no anti-aliasing until you reload. Software renderers get neither anti-aliasing nor the colour grade.
A lower tier's traffic and pedestrian numbers take effect as cars and people come and go: nobody is removed on the spot.

If the graphics driver resets, the game pauses behind "Graphics reset - restoring..." and returns to the pause menu once WebGL is back; choose RESUME to carry on.
If it has not come back after 10 seconds, the notice offers RELOAD.

## Known issues

All of these are minor; the most noticeable come first.

**Camera**

- Swimming a couple of meters off a quay or a Marina pier, swinging the camera over the edge makes it hop up in one frame; right against a pier a fast swing with the far camera (V) can make it jump for a frame, and near the edge a wall, a crane leg or a change of camera distance can make it dive in toward you and back out.

**Traffic and driving**

- Traffic cannot squeeze between two cars left less than about a car and a half apart on opposite sides of a narrow street, and queues there honking while you stay nearby; move one of the cars or drive off.
- When a car overtaking one left in the road meets oncoming traffic, the drivers can spend half a minute or more backing up and taking turns.
- City buses turning at the four outer corners of the ring road crawl round the bend and swing into the oncoming lanes for a couple of seconds.
- A car or wreck that spins into the tall back corner of a stunt ramp can come to rest with the corner sticking into its side.
- A car or bus sliding slowly off the side of the pier shows part of its body poking up through the deck for a second or two as it falls in, and a car resting half inside the edge of the pier or the Marina deck can be shoved or steered about twice as deep into it, though it still drives away.
- Near the land end of Azura Pier or the Marina deck, getting out of a car on the side that faces the edge can drop you about a meter onto the sand, where you cannot climb back up (walk round to the land end), and a wreck sunk under the deck can block getting out of a car parked above it ("No room to get out here") until you drive off.
- Now and then a new city bus appears slightly overlapping the bus ahead of it in the same lane, usually out of sight, and both end up dented.
- Boats cannot pass under the canal's bridges (they are decks, like the pier), so the canal is for looking at from a boat, not for sailing through.

**Multiplayer (limits of this version)**

- Nothing is saved in multiplayer: money, weapons and records last only as long as you stay in the room, and RECONNECT after a lost connection joins you as a new player.
- Story missions, cheats, saving and shops are single player only; properties, Lou's export board and the phone's cab are single-player features too.
- Your own movement and driving are predicted on your machine. On a slow or lossy link (a few hundred milliseconds of lag, or lost packets) the server's answer can differ from the prediction, and your character or car is eased back, or jumps when it is more than 3 m off; other players and the traffic are drawn about 0.1 s behind the server and can stutter when snapshots are lost. Play on a LAN or a nearby server.
- A page that the game server did not serve (`npm run dev`, `npm run preview`, the GitHub Pages build) looks for the server on its own host at port 4210 with `?mp=1`, and the MULTIPLAYER screen suggests `ws://localhost:4210`; for any other server, type its address or add `&server=<host>:<port>`.
- An `https://` page (such as the GitHub Pages build) can only reach a `wss://` server or `ws://localhost`; playing over the internet needs your own hosting behind a TLS proxy (see [docs/multiplayer.md](docs/multiplayer.md)).
- The Docker image has not been built or run (Docker was not available where it was written).
- Shooting another player gives you wanted stars like any gunfire the police see, and with stars you cannot open or join a head-to-head Street Run until you lose them.
- A racer who quits a head-to-head Street Run but stays in his race car keeps it: only the empty cars of racers who did not finish are removed, so one left on the grid (which is also the finish line) stays in the way.

<details><summary>More, by area</summary>

**Police, combat and people**

- After a police stop that ends calmly, the officer who got out on the passenger side can grind against his cruiser's side for about half a minute, unable to get back in, and is then left behind when it drives off.
- At two stars or more, standing still on top of a stunt ramp to be arrested does not work: no officer climbs up, and about 45 seconds after they arrive they shoot you dead; come down off the ramp first.
- If a car you left behind kills a pedestrian, either because another vehicle smashed it into them or because it was still rolling after you bailed out and died, the death can be pinned on you, with a wanted star, even when you are far away.
- People who flee onto the narrow Marina piers walk off the side into the sea, and some stay paddling against a pier or a moored boat; on the beach beside a pier or the Marina deck a fleeing person can get boxed in and stand frozen for up to about ten seconds.
- Stunt ramps look solid, but bullets, officers' line of sight and explosions pass straight through them.
- At one star, an officer who ends up in the sea while you are swimming treads water until you leave it; swimming away still loses the star.
- Officers on a pier cannot get back to a cruiser standing in the surf beside it: while you are wanted they pace back and forth at the pier's land end, and once you are not they give up and leave the car sitting dark in the water.
- A shot aimed at you that misses can still fly on and hit an officer standing behind you.
- A gunman firing from a tight gap beside a vehicle now and then puts a stray round into it.
- A police car shoved into shallow water stays put there while you are close by.
- At one star far out on Azura Pier, officers on foot can take so long to walk out that the star clears before they reach you.
- Fleeing along the north and west coast, the bays leave fewer ways out than the old straight shore did, and losing two or three stars takes longer there than inland.

**Missions and jobs**

- A Spray Shack respray shows the car's new paint a moment before the screen is fully dark.

**Graphics**

- On older or low-end GPUs that cannot render to high-precision buffers, paint, glass and chrome don't reflect the sky and bright lights don't glow, at any setting.
- The small porches in front of houses (deck, posts and roof) and the bank's front steps are decoration only: cars, people and bullets pass through them.
- The boulders along the sea walls and round Azura Point are decoration only: a swimmer or a boat passes through them.
- Motorbikes and boats have no lighter far version (a near one costs about 6-8 draw calls on High, about the same as a nearby car).
- At around 10 fps, water from a knocked-over fire hydrant comes out in separate puffs instead of a steady jet.

**Menus, input and small windows**

- In small windows (about 500 px tall or 800 px wide, or less), on-screen text can overlap: MISSION PASSED over a help message or an offer card, or the objective over the district name or the radar.
- Typing a cheat with a menu open can make its first letter do its menu job (MONEYTREE typed on the map closes the map until the code is finished); type cheats during play.
- On Firefox and Safari with a layout that moves letters (AZERTY, Dvorak, Colemak), the CONTROLS screen and key prompts show US letters until you have pressed those keys once; prompts then correct themselves, and the CONTROLS screen does when you reopen it.
- If you open the map while holding a movement key, then press and release the opposite key, the map keeps scrolling until you let go of the first key.
- On a touchpad, a sideways two-finger swipe over the game now and then switches your weapon by one.
- On a gamepad in a vehicle, LB steps through all your weapons, including ones that cannot be fired from a car, on its way to the Pistol or SMG.
- If the browser will not capture the mouse (in an embedded page, say), the camera on foot cannot be turned at all and nothing says why; open the game in its own tab.
- On the title screen, the ambient hum and wind keep playing while the tab is in the background; mute the tab.

</details>

## Architecture

It is strict TypeScript on three.js 0.186, built with Vite 8 and tested with Vitest 5 and Playwright 1.64; three.js and two Fontsource fonts are the only runtime dependencies of the game in the browser, and `ws` (with `tsx` and `@types/ws` for development) is used by the optional multiplayer server only.
The game is split into a **headless simulation** and a **presentation layer**:

```
src/
  core/        math and conventions, seeded RNG, typed event emitter, 2D SAT collision and ray tests
  world/       deterministic city generator, lane graph with signals and A*, sidewalk graph,
               static collider grid with DDA raycasts, ground height, water and zones
  sim/         the game itself: entities, player, vehicle and character physics, driver AI, traffic,
               pedestrians, wanted level, police and dispatch, gangs, roadblocks, witnesses, combat,
               pickups, markers and shops, properties, side activities, story missions, money, stats
               and the save format (three slots, with per-system data in the save's ext section)
  render/      three.js views that mirror the sim each frame: city, props, sky and ocean, vehicles,
               instanced crowd with a planted-foot gait, particles, markers, cameras, quality tiers;
               city/ and textures/ hold the city builders and the procedural canvas textures per family
  render/assets/  the asset library: preload with progress, synchronous lookup, clones, procedural fallback
  assets/      committed models (GLB, meshopt), PBR textures (WebP), the sky HDRI and manifest.json,
               built by `npm run assets` (see Assets)
  ui/          HUD and radar, the phone, menus and the full-screen map, first-time hints, key and button glyphs
  input/       keyboard with layout-aware key names, mouse with pointer lock, gamepad, cheat codes
  audio/       synthesized effects, mixer and ducking, ambience, engine voices, procedural radio (stations/: the
               instrument kit and one style per station), talk stations, recorded speech (dialogue, police scanner,
               voices in the street, station idents), gun echo, Doppler
  net/         multiplayer: the wire protocol (protocol.ts, wire.ts, shared with server/), the room and race types
               (lobby.ts), and the browser client, loaded only for a multiplayer game: session, socket transport,
               snapshot mirror, interpolation, local prediction, the single-player-only places (mpPlaces.ts) and the
               address/URL parsing (client.ts, session.ts, transport.ts, mirror.ts, interp.ts, predictor.ts, url.ts)
  game.ts      frame loop, title and play modes, menus, cheats, crash screen, context-loss notice
  main.ts      boot (WebGL 2 check, fonts, asset preload behind the loading screen, then the game), error hooks
  settings.ts  settings and the three save slots in localStorage
  debug.ts     window.__gta7, the console and test API (in every build)
scripts/assets/ downloads the asset sources (fetch.mjs, sources.json) and builds src/assets (build.mjs, catalog.mjs)
server/        optional Node multiplayer server (rooms, room rules and head-to-head races in lobby.ts, protocol I/O, static file serving); see docs/multiplayer.md
Dockerfile     builds the client and runs the multiplayer server in a container (untested)
```

`src/core`, `src/world`, `src/sim` and `src/net/protocol.ts` never touch the DOM, WebGL, audio, storage or three.js, so the whole simulation runs in Node (the multiplayer server runs it from source); `server/` uses Node but never three.js or the DOM. `tests/unit/cross_determinism.test.ts` and `tests/unit/net_layering.test.ts` check this.
The layers only import downwards: `core` ← `world` ← `sim` ← `render`, `audio`, `input` ← `ui` ← `game.ts`.
`Sim.update(dt, input)` clamps a frame to 0.1 s and runs every system in a fixed order, with physics in substeps of at most 1/120 s.
The sim keeps one `PlayerSlot` per human player in `sim.players` (character, controller, wanted record, progress, camera pose, death state), and `sim.player`, `sim.wanted`, `sim.progress` and the like are aliases for slot 0, the single-player seat; `update` also takes a `Map` of one input per slot id, and player-scoped events carry an optional `playerId` (absent means slot 0 in a one-seat single-player sim; a sim with several slots or a server room tags every slot, 0 included).
With several slots (multiplayer), each player has his own police pursuit, respawn, side job and pickups, traffic and pedestrians stream round every group of players, and players can hurt each other; with one slot everything runs exactly as single player always has.
Missions are generator scripts resumed synchronously inside `Sim.update`, and all randomness in the sim comes from a seeded RNG, so a run from the same seed and inputs repeats exactly; the game itself passes no seed, so San Azura is the same city in every game.
The renderer, HUD and audio subscribe to the typed events in `src/sim/events.ts` (shots, explosions, impacts, messages) and read entity state each frame, through the read-only `ViewState` interface of `src/sim/viewState.ts` and the id of the local player slot rather than the `Sim` class.
Conventions: +X is east, +Z south and +Y up, and heading h faces (sin h, cos h).

### Adding content

New content goes through registries, so a feature adds its own files and a line or two in a table instead of editing the core loops:

| To add | Where |
| --- | --- |
| A story contact and his missions | a row in `CONTACTS` (`src/sim/missions/contacts.ts`, or `registerContact`), a file of `MissionDef` generator scripts like `missions/vera.ts`, and one line in `missions/index.ts` (or `registerContactMissions`); the map, phone, HUD colours and checklist follow the table |
| A side activity (job key T, or a marker) | a file in `src/sim/activities/` implementing `ActivityDef` (`canStart`, `prompt`, `start`, `update`, `end`, `objectives`, `status`, optional completion rows) and `registerActivity` in `activities/index.ts`; the `Activities` facade and the HUD call it by kind |
| A vehicle or weapon | an entry in `VEHICLE_SPECS` or `WEAPONS` in `src/sim/specs.ts` (a vehicle's `class: 'car' \| 'bike' \| 'boat'` and engine voice, a weapon's damage, ammo, shop price and icon are fields there; systems branch on the class, not the kind); number keys follow `WEAPON_ORDER`, and weapons with the same spec `slot` share a key, as on 7 and 8 |
| Saved state | a `SaveCodec` (`key`, `serialize`, `parse`, `apply`) passed to `registerSaveCodec` (`src/sim/saveExt.ts`): it is stored in the save's `ext` section, `SAVE_VERSION` stays 1, a rejected or corrupt entry is dropped without touching the rest of the save, and unknown keys are kept |
| A per-frame system | a `SimSystem` in one of the ordered `SYSTEM_SLOTS` (`src/sim/systems.ts`: `preInput`, `afterPlayers`, `afterTraffic`, `afterPhysics`, `afterCombat`, `afterInteractions`, `afterMissions`, `late`) with `registerSystem` or `sim.addSystem`; within a slot, registration order |
| Checklist, completion and STATS rows | `registerCompletion` (`src/sim/completion.ts`) and `registerStatRow` (`src/sim/statRows.ts`) |
| Map blips and legend rows | `registerMapPoi` and `registerMapCategory` (`src/ui/mapRender.ts`); the legend keys 1-7 follow the category order |
| A screen or HUD widget | a file in `src/ui/screens/` (opened by name from a marker with `registerScreen`) or `src/ui/widgets/` with its own CSS file imported by the module |
| A console or test hook | `registerDebug(name, api)` (`src/debug.ts`) puts it at `window.__gta7.ext[name]`; the existing hooks and `state()` fields stay as they are |

Render features declare what they do on each quality tier and free their GPU resources on a tier switch or a lost context; new randomness in the sim must not draw from `sim.rng` unless the feature means to change the seeded run (presentation uses `Math.random`).

## Assets

The look of the game comes from free models and textures that are committed in optimised form under `src/assets/`: `models/` (GLB, meshopt-compressed, welded and deduplicated, textures as WebP of at most 1024 px, 512 by default), `textures/<set>/` (PBR sets as albedo, normal and ORM WebP), `env/sky_1k.hdr` and `manifest.json` (per asset: file, kind, bounds, license id, and for characters a bone map, for vehicles wheel sockets).
All of it is CC0 (or credited CC-BY); `LICENSES-ASSETS.md` lists every source with author, URL and license and is generated with the manifest.

```sh
npm run assets:fetch   # downloads the sources listed in scripts/assets/sources.json into ~/Projects/gta7-assets-src (GTA7_ASSETS_SRC overrides) and checks size and sha256; a second run downloads nothing
npm run assets         # rebuilds src/assets/**, manifest.json and LICENSES-ASSETS.md from those sources (scripts/assets/catalog.mjs says what is built); two runs give identical bytes
```

The raw downloads (zips, FBX, JPG sets) are never committed. To add an asset, add its source to `sources.json`, run `assets:fetch -- --record` once to fill in size and hash, add a line to `catalog.mjs` and run `npm run assets`.
Speech is built apart: `src/assets/speech/` holds one 32 kbps mono MP3 per clip and `speech.json`, its index (which clip says each line of dialogue and each dispatch phrase, each talk show's pieces and ad campaigns and the shouts, and every clip's length, which the sim uses to keep a line up for as long as it is spoken).
`npm run speech` renders them with [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) (Apache-2.0): the mission dialogue is read from the mission scripts, the dispatcher's phrases from its tables and the city's zone names, and the rest from `scripts/assets/speech/script.ts` and `shows/`; see [scripts/assets/speech/README.md](scripts/assets/speech/README.md).
Rerun it after changing a line of dialogue, a vehicle, a zone name or a dispatch line: `tests/unit/speech.test.ts` fails until every line the game can say has its clip.
The dialogue, dispatch and shout clips are fetched in the background when sound starts; a talk station piece when the programme comes to it, and it is let go once it is off the air.
At boot `main.ts` waits for the fonts, then calls `assets.preload(onProgress)` (`src/render/assets/`), which fetches the manifest and every file by its content-hashed relative URL (so the game also runs from a sub-path such as GitHub Pages `/gta7/`), decodes them, and moves the bar of the loading screen with the bytes received. Preload waits at most 12 s (`PRELOAD_TIMEOUT_MS`) and never rejects: an asset that fails or stalls simply stays out of the library, logs one `console.warn`, and its view builds today's procedural model. Views ask the library synchronously (`assets.model(id)`, `assets.clone(id)`, `assets.texture(id)`), so Node tests and `?assets=0` run entirely on the procedural models, and a test can load the real files with `loadAssetsFromDisk()` from `src/render/assets/testing.ts`. After preload the renderer's warm-up compiles the asset materials once, and again after a lost WebGL context is restored. `window.__gta7.ext.assets` lists what loaded.

## Testing

```sh
npm run typecheck                  # tsc --noEmit, strict
npm test                           # unit tests in Node (Vitest); npm run test:watch to watch
npx playwright install chromium    # once, before the first end-to-end run (optional on macOS, see below)
npm run test:e2e                   # end-to-end tests in Chromium (Playwright)
npm run check                      # typecheck + unit + build + e2e
```

### Unit tests

167 files with 2562 tests (one TCP test is skipped unless `GTA7_MP_TEST_PORT` is set to a free port) run in Node, with no browser.
They cover collision math, world invariants, physics, driver AI, pedestrians, combat, the camera with your back to a wall, the wanted level and the police, every story mission of both chapters completed by a scripted bot with its failure paths and retries, side jobs, properties, gangs, roadblocks and witnesses, saves in three slots (with an old single save, extension data per slot and corrupt entries), the content registries, the multiplayer wire protocol, server rooms, room rules and head-to-head races, interest management, the multi-player sim (per-player wanted, pursuits, respawns and streaming), the client's mirror and prediction, a 10-minute chaotic soak test (36,000 frames with a seeded random player), same-seed determinism runs of the wave-1 behaviour (bikes, boats, grenades and molotovs, witnesses, angry drivers, every new job, a business over a game day, gangs and roadblocks), the layering rules (no three.js or browser code in the sim, the protocol or the server), this README's Controls table against the real key bindings, and the mission 3 asset pipeline and families (the manifest and licenses, the asset library and its warm-up, characters, cars, bikes and boats, buildings, ground and water, props, lighting, guns and effects, and the car reflection cube), with the real models loaded from disk.
The renderer, crowd, HUD, menus, input, audio and `Game` flows run against small in-file fakes (canvas, WebGL renderer, Web Audio, `localStorage`), and one file even runs the particle and skid-mark shaders through a small GLSL interpreter on the CPU.
The police tests are statistics over many deterministic seeds, and they set the suite's run time.
`DUMP_MAP=city.svg npx vitest run tests/unit/world.test.ts` also writes a top-down SVG of the city.

### End-to-end tests

166 tests in 52 files boot the production build in Chromium (1280x720, one worker) and play it with real keyboard and mouse events and a stubbed standard gamepad.
They cover stealing and driving a car, the first mission, Hot Delivery and The Big Score, chapter 2, a murder that brings the police, WASTED, mission retries from the pause menu, the menus, the HUD layout in small windows, the gun shop, saving and continuing after a reload, the side jobs and the wave-1 jobs, the phone, properties and the mod shop, save slots, key bindings and the map legend, bikes, boats and drifting, the new weapons, gangs, roadblocks, witnesses and angry drivers, the talk radio and a five-star hot mix with the talk station on air throughout, street runs, night rendering and the quality tiers, WebGL context loss, crash screens, nine of the ten cheats (RAINDANCE has unit tests), the multiplayer client against a real server (joining by URL, a lost server, an address with nothing behind it, and single player opening no socket), two and three clients in one room (seeing each other, a chase of one player, the Marina boats, leaving and joining), a head-to-head Street Run between two clients, a two-minute chaos session that must average over 30 fps, and the mission 3 models and materials: the asset library (every asset loaded, and a failed model or texture falling back to its family's procedural form), remote players' characters, car glass and models, the sculpted bikes and boats with their fades, building facades, props and foliage, guns, explosions and burnt wrecks, and the lighting tiers.
Most tests also fail on any console error, console warning or page error.

`npm run test:e2e` builds the game and serves it on port 4173, but if a server already answers there (a leftover `npm run preview`), Playwright tests that one without building; set `CI=1` to always build (it then fails if the port is busy).
`npm run check` therefore builds twice, once itself and once in the end-to-end step.

The browser uses the hardware GPU through ANGLE and Vulkan by default on Linux. Set `GTA7_ANGLE=gl` to use desktop OpenGL instead; this path was verified on an RX 6600 XT under Linux. `GTA7_BROWSER=/absolute/path/to/chrome` optionally selects an existing Chromium executable. Both variables also work with `scripts/playtest.mjs`.

On macOS the default is ANGLE Metal (`--use-angle=metal`), because Chrome there has no Vulkan backend and would quietly fall back to software rendering and the Low tier.
If the Playwright browser a run would launch is not installed, the tests and playtests use the installed Google Chrome at `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` (only if that file exists), so `npx playwright install chromium` is optional on a Mac.
Headless runs launch Playwright's `chromium-headless-shell` and headed runs (`--headed`) its full Chromium, so a `--only-shell` install falls back to Chrome only when headed and a `--no-shell` install only when headless.
`GTA7_ANGLE` and `GTA7_BROWSER` still override both defaults, and `GTA7_SWIFTSHADER=1` still forces software rendering.
`GTA7_SWIFTSHADER` unset, empty or `0` means hardware rendering; the end-to-end tests also treat any other value as on, while `scripts/playtest.mjs` only accepts `1` (or `--swiftshader`). This setup was verified on an Apple M4 Pro, where the game picks the High tier.
The first test in `tests/e2e/r2_quality.spec.ts` logs the WebGL renderer string and the Auto tier, which shows quickly whether a run got the hardware GPU.
On a machine without a GPU, use software rendering, which is many times slower and may miss the chaos test's 30 fps:

```sh
GTA7_SWIFTSHADER=1 npm run test:e2e
```

Automated browsers run without pointer lock, because headless Chromium that grants it can stop delivering frames.
Under automation the game refuses the lock unless the URL has `?lock=1`, and the test helpers also stub it out; `node scripts/playtest.mjs --pointer-lock` adds `lock=1` and leaves the stub out, for a real lock.

### Playtests

`scripts/playtest.mjs` drives a running build (`npm run build && npm run preview`) in the Chromium that `npx playwright install chromium` fetches (or, on macOS without it, the installed Google Chrome), through `window.__gta7` and real keyboard and mouse input.
It saves numbered screenshots and a `report.json` (console errors, state snapshots, and fps, draw calls and heap per segment), and exits with 1 if the scenario threw.

```sh
node scripts/playtest.mjs --scenario tour --out /tmp/shots
node scripts/playtest.mjs --script my-steps.mjs --url http://localhost:4173/
```

| Flag | Meaning | Default |
| --- | --- | --- |
| `--scenario <name>` | `tour`, `drive`, `chase`, `night`, `rainnight` (rain at 23:00 on High in the `perf` places: the start, downtown, a four-star pursuit and the beach) or `perf` | `tour` |
| `--script <file.mjs>` | your own steps: a module exporting `default async function (t)`, where `t` is the helper object documented at the top of `scripts/playtest.mjs` (`boot`, `newGame`, `game`, `state`, `shot`, `press`, `hold`, `measure` and more) | |
| `--url <url>`, `--port <n>` | the page to open | `http://localhost:4173/` |
| `--out <dir>` | screenshots and `report.json` | `/tmp/gta7-playtest` |
| `--size WxH` | viewport | `1600x900` |
| `--swiftshader` | software rendering (or `GTA7_SWIFTSHADER=1`) | off |
| `--headed` | show the browser window | headless |
| `--pointer-lock` | allow pointer lock (adds `lock=1`) | off |
| `--intro` | keep Mama Lou's opening call | off (adds `intro=0`) |

### Several checkouts at once

- `GTA7_PORT=<port> npm run test:e2e` builds and serves this checkout on its own port, so several worktrees can run the suite side by side.
  Add `GTA7_REUSE=1` to test a server already running on that port instead; it must serve this checkout and be up to date.
  `tests/e2e/mp_client.spec.ts`, `mp_cross.spec.ts`, `mp_lobby.spec.ts` and `mp_bystander.spec.ts` start their own multiplayer server on `GTA7_MP_PORT` (default 4210): give each checkout its own.
- `scripts/with-slot.sh browser|cpu <command...>` runs a command while holding one of a few machine-wide slots, so several test runs on one machine don't start more browsers or test suites than it can hold.
  `GTA7_BROWSER_SLOTS` (default 4) and `GTA7_CPU_SLOTS` (default 3) set the number of slots, and the script needs Linux `flock` and bash 4.1 or newer.
  Where `flock` is missing (macOS), it simply runs the command without a slot; it is not required for testing there.

```sh
GTA7_PORT=4181 scripts/with-slot.sh browser npx playwright test
scripts/with-slot.sh cpu npx vitest run
```

### Test hooks

- `?intro=0` turns off Mama Lou's opening call, which otherwise starts the first mission 2.5 s into a new game; the end-to-end tests and playtests add it.
- `?lock=1` allows pointer lock under automation (see above).
- `window.__gta7` (`src/debug.ts`) is the console and test API, present in every build, production included.
  `state()` reports the mode, the player, money, the clock, the wanted level, the mission, entity counts, render stats and frame timings; `game` and `sim` are the live objects; `newGame`, `teleport`, `place`, `spawnVehicle`, `give`, `setWanted`, `setTime`, `setClockRate`, `setWeather`, `clearWeather`, `lightning`, `forceWeather`, `setPost`, `godMode`, `startMission`, `markDone`, `setCamera` and `spawnPedAhead` set up a scene; and `poi`, `weather`, `envStats`, `samplePixels` and `characterAlive` look things up.
  Modules add their own hooks under `window.__gta7.ext` with `registerDebug` (`ext.phone` for the phone log, calls and cab, `ext.combat` for fire, throws and the scope, `ext.assets` for what the asset library loaded, `ext.ground` for the ground textures, manholes, tyre marks and sea depth, `ext.fx` with `stats()`, `lobes()`, `debris()`, `scorches()` and `scorchAt(x, z, r)`; `state().render.effects` gives the live, peak and cap count per effect type), and a multiplayer session adds `window.__gta7.net` (see [Multiplayer](#multiplayer-optional)).

## Multiplayer (optional)

The game is single player by default and needs no server: the GitHub Pages build has none, and a single-player game never opens a network connection.
Multiplayer is free roam for 2 to 8 players per room, on a small Node server that runs the game for every room: each player has his own character, weapons, money, wanted level and police, side jobs and respawns, players can shoot and run each other over, and the city (traffic, people, gangs, police, weather and the clock) is shared.

**Local or LAN game** (on the machine that hosts it, from a checkout of this repository):

```sh
npm ci
npm run build      # the server serves the built game from dist/
npm run server     # the game and its WebSocket on port 4210, on all interfaces
```

The server prints the addresses to open. On the host open `http://127.0.0.1:4210/?mp=1&room=<id>&name=<name>`; other people on the same network open `http://<your-ip>:4210/?mp=1&room=<id>&name=<name>`, with one of the LAN addresses it printed (on macOS, allow incoming connections for `node` if the firewall asks).
Everyone with the same room id plays together (rooms are separate worlds; without `room` it is `lobby`; a 9th player is told the room is full). `GET /status` reports the rooms, players and tick times.

**Joining:** a page served by the game server joins that server, whatever port it was started on (`npm run server -- --port <n>`); from any other page (`npm run dev`, `npm run preview`, the GitHub Pages build) `?mp=1` looks on the page's own host at port 4210, so add `&server=<host>:<port>` (or a full `ws://` / `wss://` address) for any other server.
The URL form is `?mp=1&server=<host:port>&room=<id>&name=<name>`, where everything but `mp=1` is optional.

**In the game:** your own movement, driving and trigger pulls are predicted locally (the muzzle flash and the shot sound come at once, the tracer and the hit follow the server's events); other players and the traffic are drawn about 0.1 s behind the newest snapshot.
If the server goes away the screen says so within 3 s and offers RECONNECT (you rejoin as a new player) or RETURN TO TITLE; a server address that does not answer gives COULD NOT JOIN with TRY AGAIN or BACK TO TITLE.
From the title, MULTIPLAYER asks for a name (required, up to 24 characters), a server (the page's own host and port when the game server served it, else `ws://localhost:4210`) and a room (default `lobby`), remembers them in the browser and joins with JOIN or Enter; a failed join offers TRY AGAIN or BACK.

**In the room:** players join side by side on the sidewalk by the safehouse, and players who die together respawn side by side.
Tab (D-pad right), the phone key, or pause > PLAYERS lists the room with each player's stars, kills and deaths.
Other players have name tags (up to 150 m, faint behind buildings, none behind the camera) and diamond blips on the radar and map; each player has their own colour (shirt, name tag, blip and race car) and a look drawn from their name.
PvP damage is on. Kills appear in a kill feed ("Ann killed Bea"), and kills and damage to another player's car are credited to the attacker; each player respawns on their own at the hospital or, when busted, the police station, and the shared clock does not jump.
Head-to-head Street Runs: pause > STREET RUNS opens a course for the room (or press T at a course start); others join within 20 s and the opener can START NOW. Everyone lines up on one grid in a fresh car, one countdown holds all until GO, each racer sees their own gates and place, and the results (finish order, times, medals; DNF for quitters, leavers and busted or wrecked racers; OUT OF TIME past bronze) are the same on every screen. No money is paid and nothing is saved. Drivers a racer bumps do not get out to fight, and a player with stars has to lose the cops before opening or joining a race.
Story contacts, the safehouse, properties, Lou's export board, gun shops and the phone are marked as single player only and say so when used (the safehouse "Saving is off in multiplayer.", the phone key "The phone (calls, texts and cabs) is single-player only." above the player list), and a typed cheat answers "Cheats are off in multiplayer." See [Known issues](#known-issues) for the other limits.

**Docker** (untested: Docker was not available where this was written):

```sh
docker build -t gta7-server .
docker run --rm -p 4210:4210 gta7-server
# then open http://127.0.0.1:4210/?mp=1 (or http://<host>:4210/?mp=1&room=<id>)
```

**Over the internet:** an `https://` page, such as the GitHub Pages build, may only open `wss://` connections (or `ws://localhost`), so it cannot join a plain `ws://` server on another machine.
Internet play needs your own hosting with the server behind a TLS reverse proxy that forwards the page and the `/ws` WebSocket path; open the game through the proxy's `https://` address, or join it with `&server=wss://<your-host>`.
No cloud hosting is set up and nothing in this repository deploys a server; [docs/multiplayer.md](docs/multiplayer.md) has the server options, the protocol, proxy examples for Caddy and nginx, and the measurements.

For testing, `&lag=<ms>&jitter=<ms>&loss=<fraction>` simulates a slow link and `&predict=0` turns off prediction; `window.__gta7.net` (`state()`, `local()`, `entity()`, `players()`, `police()`, `roster()`, `events()`, `room()`, `race()`, `command()`, `join()`, `reconnect()`, `leave()`, `overlay()`) exists once a session starts.
`GET /status` also lists, per room, the clock, weather, broken props and wrecked vehicles, and for each member his position, state, health, vehicle, wanted level and the police chasing him, how many police rounds passed him and how much health police fire took from him, and `policeUnits`, every police unit with the player it works for and the one it targets; a server started with `--dev` takes `debug` commands (`teleport`, `drive`, `wanted`, `give`, `godMode`, `neverWanted`, `civilians`, `wreck`) for setting up scenes.
A player left standing at 2-3 stars is busted in 15-20 s, as in single player, and a late joiner is sent only the police within 250 m of him.
`tests/e2e/mp_client.spec.ts`, `mp_cross.spec.ts`, `mp_lobby.spec.ts` and `mp_bystander.spec.ts` start their own server on `GTA7_MP_PORT` (default 4210), all with `--dev` (`mp_client` also with `--puppets`): `mp_client` plays one browser against server-side players, `mp_cross` plays two to three clients through the cross-area flows (seeing each other walk and drive, a chase of one player only, the Marina boats for the second player, and leaving and joining), `mp_lobby` races two clients head to head, and `mp_bystander` has one player shoot civilians to 2 stars and run a sidewalk route on foot (god mode for him alone, so the chase lasts) for a measured 60 s of police pursuit while the other stands at 0 stars 14 m off the route, and checks from `/status` that no unit targets him, no round passes him and his health never drops.
`npm run typecheck` also checks `server/` (`tsc -p server/tsconfig.json`).

## Performance

The game targets 60 fps on desktop hardware.
The upgraded build measured 60 fps at native 1920x1080 High on an RX 6600 XT in the perf playtest's starting street, Downtown, four-star pursuit and beach-at-dusk scenes. These short samples were refresh-capped; their last CPU frames took 5.9–8.3 ms.
With the dawn/dusk smoothing, colour grade, night lights, weather, rain and waves, an Apple M4 Pro at 1920x1080 High measured 60/60/58/60 fps in the same four scenes, and 60 fps in all four segments of `--scenario rainnight` (rain at 23:00). See [graphics notes](docs/graphics.md) for the measurement scope, detailed changes and earlier software-rendering results.
The second update made the busy scenes cheaper before adding to them: a car's tyres, rims, lamps, light bar and taxi sign are drawn in a few shared instanced batches and its shadow by one merged body, so a nearby sedan costs about 7 draw calls on High instead of 38 and a car beyond 40 m about 2; High caps its drawing buffer at 3.5 million pixels (a 1920x1080 window on a Retina screen draws 2494x1403); contact shadows are cheaper; and ground-height lookups use a grid.
The release pass then drew the static city (ground layers as one mesh each, shadow casters and props in 256 m cells on hardware GPUs) with about half the draw calls. Measured back to back against the previous release on the M4 Pro, the JavaScript frame time (95th percentile) is 39-52% lower in the four perf scenes (ratios 0.46-0.61 against the earlier release; the four-star pursuit is 0.59 at the median of five pairs), and the plaza at dpr 2 (a 2494x1403 buffer under the High pixel budget) runs uncapped at about 150 fps (55 before).
With every feature of the update in place (bikes and boats, the new weapons and fire, gangs and roadblocks; the multiplayer client is loaded only for a multiplayer game), the perf playtest measured 60/60/58/60 fps and `rainnight` 60/60/60/60 fps at 1920x1080 High on the M4 Pro, and the two-minute chaos test averaged 59.9 fps.
Motorbikes and boats now cost about as much as a car (6-8 draw calls on High, 14-30 before), but have no lighter far version yet (see Known issues).
Nothing adjusts itself at runtime: there is no dynamic resolution, and the tier only changes when you pick another one (see [Settings and graphics quality](#settings-and-graphics-quality) for what each tier trades away).
`node scripts/playtest.mjs --scenario perf` prints fps, draw calls, triangles and heap at the start, in Downtown, in a four-star pursuit and on the beach at dusk.
`window.__gta7.game.renderer.vehicleParts.counts` reports the vehicle part batches and `contactShadows.drawn` the contact-shadow depth draws; `window.__gta7.game.renderer.crowd.firstDrawn` lists the last 400 characters drawn for the first time.
`window.__gta7.state()` reports actual wall-clock `fps`, plus `render.calls` and the latest CPU timings in `perf.frameMs`, `simMs` and `renderMs`. `perf.frameIntervalMs` measures the time between animation frames, including GPU or browser delays that CPU timings miss. Physics still clamps long frames for stability; the FPS counter does not. Sample many frames when comparing performance.

## Credits

Models, textures and the sky come from CC0 sources, listed one by one in [LICENSES-ASSETS.md](LICENSES-ASSETS.md):

- [Quaternius](https://quaternius.com) (via [Poly Pizza](https://poly.pizza)): cars, trucks, street props and the palm tree.
- [Kenney](https://kenney.nl): Car Kit, Watercraft Kit, City Kit (Commercial, Suburban, Roads) and Nature Kit.
- [Poly Haven](https://polyhaven.com): PBR ground and wall textures (worn asphalt, leafy grass, coast sand and more) and the Kloofendal sky HDRI (Greg Zaal, Jarod Guest).
- [ambientCG](https://ambientcg.com): facade materials, and the leaf atlas built from [LeafSet024](https://ambientcg.com/a/LeafSet024).

No asset needs attribution; CC-BY assets, if one is ever added, are credited here by the text in their `LICENSES-ASSETS.md` row.

Every voice is rendered with [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) by hexgrad (model and voices Apache-2.0); the lines are original.

## License

Code: MIT, see [LICENSE](LICENSE).
Fonts: Anton and Rajdhani, SIL Open Font License (bundled via Fontsource).
