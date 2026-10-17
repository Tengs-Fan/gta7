// World-wide dimensions shared by generation, simulation and rendering.

export const CITY_SEED = 7;
export const GRID_N = 10;

export const LANE_W = 4;
export const AVENUE_W = 16; // 2 lanes per direction
export const STREET_W = 10; // 1 lane per direction + 1 m shoulders
export const SIDEWALK_W = 4;
export const CROSSWALK_W = 4;
export const CURB_H = 0.15;

/** Distance from the block edge at which pedestrians walk. */
export const PED_INSET = 2.2;
/** Distance from the curb at which lamps, trees and signals stand. */
export const PROP_INSET = 0.9;

export const PROMENADE_W = 34; // land strip beyond the outer ring road on the W, N and S coasts
export const BOARDWALK_W = 14; // east coast strip before the sand starts
export const BEACH_W = 110;
/** The beach sand drops this much from the boardwalk (CURB_H) over BEACH_W. */
export const SAND_DROP = 3.2;
export const WATER_Y = -1.0;
export const SEABED_Y = -8;
/** Swimming starts when the water is deeper than this. */
export const SWIM_DEPTH = 1.05;
/** Thickness of the pier and marina deck slabs, which hang from the deck height down. */
export const DECK_SLAB = 0.35;

export const GRAVITY = 22;
