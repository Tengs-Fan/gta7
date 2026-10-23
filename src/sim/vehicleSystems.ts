// The vehicle classes' systems (bikes, boats), registered for every Sim (see systems.ts). sim.ts imports this module.

import { BIKE_SYSTEM } from './bikes';
import { MARINA_SYSTEM } from './boats';
import { SINKING_SYSTEM } from './sinking';
import { registerSystem } from './systems';

registerSystem(BIKE_SYSTEM);
registerSystem(MARINA_SYSTEM);
registerSystem(SINKING_SYSTEM);
