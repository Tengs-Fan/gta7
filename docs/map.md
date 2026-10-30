# The map of San Azura

San Azura used to be one perfect square: a 10 by 10 grid of blocks inside a ring road, a promenade round three sides and the beach on the fourth.
This page explains how the city is built, what depends on its shape, and how the shape was broken up without rewriting the road network.

![The map screen: Hillcrest Cove in the north-west, Cortez Canal from coast to coast, Port Basin in the south-west, Azura Point to the north, and the big blocks of Hillcrest Green, Civic Plaza and the Azura Bowl](screenshots/map.jpg)

## How the city is built

`src/world/layout.ts` generates the whole city from `CITY_SEED`, so every game (and the multiplayer server, which runs the sim from source) gets the same San Azura.

- Eleven vertical and eleven horizontal road lines (`vLines`, `hLines`) cut the land into 10 by 10 cells.
  Column widths and row depths vary a little (72-92 m), and lines 0, 2, 5, 8 and 10 are four-lane avenues.
- Each cell is a block: a sidewalk ring round a lot, cut into parcels that become buildings, yards, parking lots or container yards by district.
  Parks, the stadium and the special places (safehouse, hospital, police, spray shacks, gun shops, the bank, the contacts' places) are fixed cells.
- Outside the ring road lie the promenade (west, north and south), the boardwalk and the beach (east), the pier and the Marina.
- `src/world/roads.ts` turns the lines into a directed lane graph: a node at every line crossing, lanes between neighbouring nodes, turn curves, signals and A* routing.
- `src/world/sidewalks.ts` builds the pedestrians' graph: a loop round every block, crosswalks at every junction and the promenade loop.
- `src/world/staticWorld.ts` answers the sim's questions: colliders, ground height, water depth, zone and district names.

## What depends on the shape

Most gameplay places are found from the layout rather than written down as coordinates, so they move with it:

- Points of interest (`layout.pois`) carry their own positions; missions, activities, the multiplayer markers and respawns read them.
- Mission spots (`src/sim/missions/spots.ts`) pick block centres and road nodes by grid index (`blockCenter(bi, bj)`, `roads.node(i, j)`).
- Street-run courses (`src/sim/streetRuns.ts`) are lists of grid corners, routed along the road lines.
- Gang turfs (`GANG_TURFS`) are ranges of block indices.
- The courier place sits by the middle dock crane; Azura Customs and the pier arcade are offsets from the hospital and the pier.
- Zone and district lookups (`zoneName`, `districtAt`) and the map screen's zone labels index blocks by cell.
- Tests and playtests address junctions as `roads.node(i, j)`.

What assumes the square:

- Every road segment and node exists, and every node's degree follows from its grid position (signals, furniture, crosswalks).
- `isOnRoad` treats every line as road from one side of the city to the other.
- Land is one rectangle; the only water inside it is under the pier and the Marina.
  The ground renderer draws the promenade as three strips and the ring road's outer kerb as four long walls; the sea shader knows the land as one rectangle.

## The changes

The road network stays a grid of axis-aligned lines, because the lane graph, the sidewalk graph, the collider grid, the renderers and the AI all work on rectangles and four directions.
Inside that, the city loses its uniformity in four ways.

### Connectivity: segments and nodes can be missing

The layout records which road segments exist.
A segment exists when it borders at least one land block and does not run through the middle of a superblock or along the canal.
A node lives when one of its segments exists, and its degree, signal, crosswalks and furniture follow from its real neighbours.
The node grid keeps its 11 by 11 indexing, so `roads.node(i, j)` still names the same junction everywhere; dead nodes are skipped by routing, nearest-node searches and drawing.

### Superblocks

`layout.cells` maps each grid cell to its block, so one block can cover several cells:

- Hillcrest Green becomes a two-by-two park, the streets inside it turned into lawns and paths.
- The Azura Bowl takes two cells: the bowl in the middle, a car park at either end.
- Downtown gets Civic Plaza, two cells with towers at either end of an open square: paving, two lawns, a fountain and rows of trees.

The cells were picked where nothing else depends on the closed streets: no street-run course, mission spot or test junction runs through them.

### Water: a cove, a harbour basin, a canal and a headland

- **Hillcrest Cove** takes the north-west corner: two cells become sea, and the coast road turns round the water behind a sidewalk-wide quay.
  The Hillcrest Spray Shack moved one block east, out of the drowned cell.
- **Port Basin** cuts into the docks from the south: two cells become a harbour basin, with a 20 m wharf along the docks' last street where the three cranes now stand, and four boats moored in it.
- **Cortez Canal** replaces Cortez St, running from the north coast to the south coast between Westside and Downtown.
  Every street crosses it on a bridge: the junction's box is the carriageway (a deck at road height, no signal), with a footway deck either side and a parapet along each footway's outer edge; each promenade has a footbridge along its seaward edge.
  Columns 2 and 3 give 11 m each to it, so every other road line stays where it was.
  The Dockside Switchback street run moved its switchback one street east and crosses the canal twice.
- **Azura Point** is a headland of lawns, trees and benches reaching out into the bay from the north promenade beyond Hillcrest Green, with a path out to the lighthouse at its tip (the lighthouse used to stand at the promenade's north-east corner).

Water is a list of rectangles (`layout.water`) cut out of the land, and headlands (`layout.headlands`) add land outside it: `baseGround` is the seabed in the water and the curb height on a headland, zone names follow both, the quay walls are built wherever land meets water (`render/city/coast.ts`), the ground renderer leaves the water out of the promenade and draws the quays, and the sea shader keeps its quay foam off the old land edge where the sea now comes in.
Pedestrians keep to dry land: the promenade loop breaks where the sea comes in, and the bridges' footways join the sidewalks either side.

### Bays: the coast steps in and out

- **Gull Bay** (one cell) and **Northshore Bay** (two cells) drown the north shore either side of Hillcrest Green, so the shore runs bay, park and Azura Point, bay.
- **Pelican Harbor** (two cells) bites into Westside's shore between the cove and Port Basin.
- **Coral Bay** (one cell) cuts into the south shore west of the beach.

These bodies are drowned rather than left out: their blocks are generated as land, and once the street furniture stands, `drown()` removes the blocks and everything on them, closes the roads that bordered only them, keeps a signal only where three roads still meet on a live approach, and lets the water in.
The shared generator therefore makes exactly the draws it made while they were land, so every other lamp, tree, hydrant and bench, building and parked car stays where it was; only what stood in the bays moved.
Building ids keep their gaps, so facades and rooftops elsewhere keep their looks.
The ring road is not closed with them: it crosses each bay's mouth on a bridge (a carriageway deck at road height, a footway deck either side and a parapet along each, like the canal's), so the coast road runs on.
Closed, it turned the junctions either side into corners with a single way out, where a car fleeing the police was pinned against the quay (`r2_police_escape*`).
The bridges, the canal's and the bays', are drawn as one mesh: a few slabs across the city would only add draws if split into cells.
The two stunt ramps that stood in Pelican Harbor and Gull Bay moved along their promenades, and Hot Delivery's drop is now found from the block south of Northshore Bay.

Where water still cuts an avenue short, it leaves a stub whose far end leads only into side streets.
A city bus keeps to the avenues that go on (`throughAvenues` in `src/sim/driver.ts`): traffic spawns none on a stub, and a bus on the move never turns into one.

### Hills off the road grid

Hills were first set aside: vehicle physics, the collider grid's fixed height bands, the ground and facade renderers and the traffic and police AI all assume flat ground, with the ramps and decks the only slopes and steps.
They came back where none of those assumptions reach: off the road grid, on ground that no road, sidewalk, walk node or building footprint stands on.
`src/world/terrain.ts` holds the rises and everything they need.

- **Hillcrest Green** rises 7 m on its fountain at the top of Coral St: an elliptical cosine bell 136 by 156 m across, flat on its summit and 0 a good 7 m inside the park's lot, so the streets and sidewalks round it stay flat.
  Its steepest grade is 20%, gentler than the stunt ramps.
  The SAN AZURA letters stand on its south slope, facing down Coral St, the words either side of the old path up to the fountain and the last A slumped on its side.

Each flat-ground assumption is kept like this:

- **The layout.** `settleTerrain` runs last in `generateCity`: it records the rises and stands every prop on them, drawing no random number and moving nothing across the ground, so the pickups and the mission spots stay where they were.
  Only the trees and bushes on the lawn under the letters, and down the slope in front of them, go, so the sign is seen from the street.
- **The ground.** `baseGround` adds the rise on the lawns, and the roads, sidewalks and buildings all stand where it is 0, so every lookup there returns what it always did.
  The ground renderer draws a patch over a rise as a grid on a 2 m lattice, its triangles within a centimetre of the sim's slope.
- **Physics.** The slope is smooth and never steeper than 21%, so a car follows it (ground follow tracks a drop of up to 0.4 m per 1/120 s step), never hits a ledge, and crosses the summit at 30 m/s without leaving the ground; the body's roll across the slope is drawn only.
  People walk up it as they step up a curb.
- **The collider grid's height bands.** Sight-blocking boxes, nested every 2 m of rise, are buried in the hill: each stands half a metre under the turf over its footprint grown by 6.5 m, farther than any body, free-space check or camera that tests its own height band reaches from where it stands.
  So nothing on the ground ever meets one, while a police officer's or a witness's line of sight, a bullet or a blast across the hill stops in it: break line of sight over the crest.
- **The AI.** No lane and no walk node is on the hill: traffic and the police keep to the streets round it, and officers walk up it on foot.

## Rejected, and why

- **Diagonal or curved roads.** The lane graph knows four directions, and lanes, turns, signals, crosswalks, furniture and the renderers are built on that.
  A diagonal avenue would mean a new road model.
- **Very different block sizes.** Moving road lines shifts every block, which moves places that are offsets from others and the coordinates written into tests, for less variety than the superblocks and the water give.
  Only the canal's two neighbouring columns change width.

## Keeping the rest steady

- The coast (promenade furniture, beach palms, the pier and the Marina) draws from its own generator, seeded with the state the shared generator had when the coast began before, so the beach is exactly as it was.
- Tests that named lanes by their index in `roads.lanes` now name them by their place in the square city (`legacyLane` in `tests/unit/helpers.ts`), because closing segments renumbers lanes.
- New bays are drowned bodies (see Bays above), so adding one moves only what stood in it and the scenarios that used it.

## The shore

The open coast's sea walls and the headland's edges are fronted by a rocky foreshore drawn in `src/render/city/coast.ts`: boulders heaped at the walls' foot, in a band whose width wanders along the shore (2 to 11 m, 4 to 16 m round Azura Point), so the coast reads as a ragged line of rock and water from the street and from the air.
Port Basin and Cortez Canal keep their plain quays, as built water should.
The rocks are drawn only; the land and the water stay the rectangles above.
The cove, the basin and the canal count as shore for the surf in the ambience (`shoreInfo`), as the outer sea walls do.

More sea cells (a west inlet, a south bay, an extended cove) were tried and set aside for now: each one re-rolls every block generated after it, which moved 20 to 48 of the unit tests' scenarios and recorded hashes at once.

## Known limits

- Bridges are decks, like the pier: boats cannot pass under them, so the canal is for looking at from a boat rather than for sailing through, and a swimmer passing under a bridge climbs out onto it.
- The gang turf overlay on the map still covers Port Basin.
- The foreshore's boulders are decoration: a swimmer or a boat passes through them.
