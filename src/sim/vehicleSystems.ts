// The vehicle classes' systems (bikes, boats), registered for every Sim (see systems.ts). sim.ts imports this module.

import { BIKE_SYSTEM } from './bikes';
import { registerSystem } from './systems';

registerSystem(BIKE_SYSTEM);
