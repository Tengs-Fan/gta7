// What `npm run assets` builds. One entry per line so parallel tracks can add rows without merge conflicts.
// `src` paths are relative to the source cache; `license` is the id of a source in sources.json.
//
// Model families and their conventions (all outputs: metres, +Y up, +Z forward, meshopt, WebP textures):
//   character  origin between the feet, 1.8 m tall, shared 62-bone rig (bones renamed without dots)
//   vehicle    origin under the bounding-box centre on the ground, scaled so the length matches `length` (a
//              VEHICLE_SPECS length), wheels as separate nodes centred on their axles
//   boat       like vehicle, origin at the keel
//   prop       origin at the authored base, `scale` or `height`/`length` set the size

const KC = (name) => `kenney/car-kit/Models/GLB format/${name}.glb`;
const KW = (name) => `kenney/watercraft-kit/Models/GLB format/${name}.glb`;
const KR = (name) => `kenney/city-kit-roads/Models/GLB format/${name}.glb`;
const KN = (name) => `kenney/nature-kit/Models/GLTF format/${name}.glb`;
const KS = (name) => `kenney/city-kit-suburban/Models/GLB format/${name}.glb`;
const KB = (name) => `kenney/city-kit-commercial/Models/GLB format/${name}.glb`;
const PP = (id) => `polypizza/${id}.glb`;

/** Joint -> bone name in the Quaternius Ultimate Modular rig (names as three.js sees them, without dots). */
export const CHARACTER_BONES = {
  pelvis: 'Hips', spine: 'Abdomen', chest: 'Torso', upperChest: 'Chest', neck: 'Neck', head: 'Head',
  clavicleL: 'ShoulderL', shoulderL: 'UpperArmL', elbowL: 'LowerArmL', wristL: 'WristL',
  clavicleR: 'ShoulderR', shoulderR: 'UpperArmR', elbowR: 'LowerArmR', wristR: 'WristR',
  hipL: 'UpperLegL', kneeL: 'LowerLegL', ankleL: 'FootL', toeL: 'FootL_end',
  hipR: 'UpperLegR', kneeR: 'LowerLegR', ankleR: 'FootR', toeR: 'FootR_end',
};

// id, source file, license source id, output name, role
const CHARACTERS = [
  ['swat', PP('Btfn3G5Xv4'), 'pp-Btfn3G5Xv4', 'police', 'male'],
  ['punk', PP('BTALZymknF'), 'pp-BTALZymknF', 'gang', 'male'],
  ['businessman', PP('JFrLIKqvCH'), 'pp-JFrLIKqvCH', 'civilian', 'male'],
  ['hoodie', PP('gKLBoRsyKe'), 'pp-gKLBoRsyKe', 'civilian', 'male'],
  ['casual2', PP('kZ3DmIoGip'), 'pp-kZ3DmIoGip', 'civilian', 'male'],
  ['beach', PP('DojKLcO34E'), 'pp-DojKLcO34E', 'civilian', 'male'],
  ['worker', PP('Yg2bQZO6Hj'), 'pp-Yg2bQZO6Hj', 'civilian', 'male'],
  ['farmer', PP('7pn3R6hPvE'), 'pp-7pn3R6hPvE', 'civilian', 'male'],
  ['adventurer', PP('5EGWBMpuXq'), 'pp-5EGWBMpuXq', 'civilian', 'male'],
  ['woman_formal', PP('nIItLV9nxS'), 'pp-nIItLV9nxS', 'civilian', 'female'],
  ['woman_casual', PP('qJ2gsTUBHL'), 'pp-qJ2gsTUBHL', 'civilian', 'female'],
];

export const characters = CHARACTERS.map(([name, src, license, role, body]) => ({
  id: `char.${name}`, kind: 'character', src, license, out: `models/characters/${name}.glb`, role, body, height: 1.8,
}));

/** Shared animation clips of the rig, taken from the first character; no mesh. */
export const clips = { id: 'anim.umc', kind: 'animation', src: PP('Btfn3G5Xv4'), license: 'pp-Btfn3G5Xv4', out: 'models/characters/clips.glb' };

/** VEHICLE_SPECS footprints (width, height, length in metres) of the kinds a model can be fitted to; a unit test keeps them in step. */
export const SPEC_DIMS = {
  compact: [1.75, 1.45, 3.8], sedan: [1.9, 1.45, 4.7], taxi: [1.9, 1.45, 4.7], sports: [2.0, 1.18, 4.5], muscle: [2.0, 1.35, 4.9],
  pickup: [2.1, 1.85, 5.3], van: [2.1, 2.4, 5.1], police: [2.0, 1.5, 4.9], ambulance: [2.1, 2.5, 5.4], firetruck: [2.45, 2.9, 8.2],
  speedboat: [2.3, 1.5, 6.4], dinghy: [1.7, 0.9, 3.8],
};

// Vehicles. `spec` is the VEHICLE_SPECS kind the body is meant for (null: no matching kind yet), `length` its spec length.
// `wheels` maps the wheel roles to node names; a single `rear` node means both rear wheels are one mesh on a common axle.
const quat = (name, id, spec, length, nodes, extra = {}) => ({
  id: `veh.q.${name}`, kind: 'vehicle', src: PP(id), license: `pp-${id}`, out: `models/vehicles/q_${name}.glb`, spec, length, origin: 'bottom-center', wheels: nodes, ...extra,
});
const ken = (name, spec, length) => ({
  id: `veh.k.${name.replaceAll('-', '_')}`, kind: 'vehicle', src: KC(name), license: 'kenney-car-kit', out: `models/vehicles/k_${name.replaceAll('-', '_')}.glb`, spec, length, origin: 'bottom-center', lossless: true,
  wheels: { fl: 'wheel-front-left', fr: 'wheel-front-right', rl: 'wheel-back-left', rr: 'wheel-back-right' },
});
export const vehicles = [
  quat('police', 'BwwnUrWGmV', 'police', 4.9, { fl: 'Cop_FrontLeftWheel_Cylinder.011', fr: 'Cop_FrontRightWheel_Cylinder.012', rear: 'Cop_BackWheels_Cylinder.001' }),
  quat('taxi', 'x43lOScTpN', 'taxi', 4.7, { fl: 'Taxi_FrontLeftWheel_Cube.013', fr: 'Taxi_FrontRightWheel_Cube.014', rear: 'Taxi_BackWheels_Cube.010' }),
  quat('sports2', '1mkmFkAz5v', 'sports', 4.5, { fl: 'SportsCar2_FrontLeftWheel_Cylinder.017', fr: 'SportsCar2_FrontRightWheel_Cylinder.018', rear: 'SportsCar2_BackWheels_Cylinder.002' }),
  quat('suv', 'xsMtZhBkxL', null, 4.9, { fl: 'SUV_FrontLeftWheel_Cylinder.010', fr: 'SUV_FrontRightWheel_Cylinder.005', rear: 'SUV_BackWheels_Cylinder.009' }),
  quat('pickup', 'qn4grQgHm8', 'pickup', 5.3, { fl: 'FrontWheel_L', fr: 'FrontWheel_R', rear: 'BackWheels' }),
  quat('truck', 'cXw6oiFtZ8', null, 6.5, { fl: 'FrontWheel_L', fr: 'FrontWheel_R', rear: 'BackWheels' }),
  quat('sports', 'Gzj704DXdr', 'muscle', 4.9, { fl: 'FrontWheel_L', fr: 'FrontWheel_R', rear: 'BackWheels' }),
  ken('sedan', 'sedan', 4.7),
  ken('sedan-sports', 'muscle', 4.9),
  ken('hatchback-sports', 'compact', 3.8),
  ken('suv', null, 4.9),
  ken('suv-luxury', null, 4.9),
  ken('taxi', 'taxi', 4.7),
  ken('police', 'police', 4.9),
  ken('van', 'van', 5.1),
  ken('delivery', null, 5.8),
  ken('truck', null, 7),
  ken('ambulance', 'ambulance', 5.4),
  ken('firetruck', 'firetruck', 8.2),
  ken('garbage-truck', null, 7.5),
  ken('race', 'sports', 4.5),
];

const boat = (name, spec, length) => ({
  id: `boat.k.${name.replaceAll('-', '_')}`, kind: 'boat', src: KW(name), license: 'kenney-watercraft-kit', out: `models/boats/k_${name.replaceAll('-', '_')}.glb`, spec, length, origin: 'bottom-center', lossless: true,
});
export const boats = [
  boat('boat-speed-a', 'speedboat', 6.4), boat('boat-speed-b', 'speedboat', 6.4), boat('boat-speed-c', 'speedboat', 6.4), boat('boat-speed-d', 'speedboat', 6.4),
  boat('boat-row-small', 'dinghy', 3.8), boat('boat-fishing-small', null, 8), boat('boat-tug-a', null, 9), boat('boat-sail-a', null, 9),
  boat('buoy', null, 0.9),
];

const prop = (id, name, src, license, group, size, extra = {}) => ({ id: `prop.${id}`, kind: 'prop', src, license, out: `models/props/${group}/${name}.glb`, ...size, ...extra });
const kr = (name, scale = 10) => prop(`k.${name.replaceAll('-', '_')}`, name, KR(name), 'kenney-city-kit-roads', 'street', { scale }, { lossless: true });
const kn = (name, scale) => prop(`k.${name}`, name, KN(name), 'kenney-nature-kit', 'nature', { scale });
const ks = (name, scale = 10) => prop(`k.${name.replaceAll('-', '_')}`, name, KS(name), 'kenney-city-kit-suburban', 'suburban', { scale }, { lossless: true });
const kb = (name, scale = 10) => prop(`k.${name.replaceAll('-', '_')}`, name, KB(name), 'kenney-city-kit-commercial', 'commercial', { scale }, { lossless: true });
export const props = [
  prop('q.hydrant', 'q_hydrant', PP('DKkMQbEklp'), 'pp-DKkMQbEklp', 'street', { height: 0.8 }),
  prop('q.streetlight', 'q_streetlight', PP('nFwrlcLvM5'), 'pp-nFwrlcLvM5', 'street', { scale: 1 }),
  prop('q.palm', 'q_palm', PP('A6cKJYFsIb'), 'pp-A6cKJYFsIb', 'nature', { height: 7 }),
  prop('q.bench', 'q_bench', PP('jLxjFxFRpw'), 'pp-jLxjFxFRpw', 'street', { width: 1.8 }, { origin: 'bottom-center' }),
  prop('q.trashcan', 'q_trashcan', PP('i7HDuYDLkx'), 'pp-i7HDuYDLkx', 'street', { height: 0.9 }),
  prop('q.trafficlight', 'q_trafficlight', PP('lg9AKWejnF'), 'pp-lg9AKWejnF', 'street', { scale: 1 }),
  kr('light-square'), kr('light-curved'), kr('light-square-double'), kr('traffic-light'), kr('traffic-light-hanging'),
  kr('construction-cone'), kr('construction-barrier'), kr('construction-fence'), kr('dumpster'), kr('electricity-pole'),
  kr('road-sign-stop'), kr('road-sign-street'), kr('road-sign-warning'),
  kn('tree_palm', 5), kn('tree_palmBend', 5), kn('tree_palmTall', 5), kn('tree_palmShort', 5), kn('tree_palmDetailedTall', 5), kn('tree_palmDetailedShort', 5),
  kn('plant_bush', 2.5), kn('plant_bushLarge', 2.5), kn('plant_bushSmall', 2.5),
  kn('rock_smallA', 2.5), kn('rock_smallB', 2.5), kn('rock_largeA', 2.5),
  ks('tree-large'), ks('tree-small'), ks('fence'), ks('planter'),
  kb('detail-awning'), kb('detail-awning-wide'), kb('detail-parasol-a'), kb('detail-parasol-b'),
];

// PBR sets. `maps` are paths in the source cache.
const ph = (set, size = 512) => ({
  set, license: `ph-${set}`, size,
  maps: { albedo: `polyhaven/${set}/diff_1k.jpg`, normal: `polyhaven/${set}/nor_gl_1k.jpg`, orm: `polyhaven/${set}/arm_1k.jpg` },
});
const acg = (id, size = 512, emissive = false) => ({
  set: id.toLowerCase(), license: `acg-${id}`, size,
  maps: {
    albedo: `ambientcg/${id}/${id}_1K-JPG_Color.jpg`, normal: `ambientcg/${id}/${id}_1K-JPG_NormalGL.jpg`,
    rough: `ambientcg/${id}/${id}_1K-JPG_Roughness.jpg`, metal: `ambientcg/${id}/${id}_1K-JPG_Metalness.jpg`,
    ...(emissive ? { emissive: `ambientcg/${id}/${id}_1K-JPG_Emission.jpg` } : {}),
  },
});
export const textureSets = [
  ph('asphalt_02', 1024), ph('worn_asphalt'), ph('concrete_pavement'), ph('brick_wall_001'), ph('brick_pavement_02'),
  ph('coast_sand_01'), ph('white_plaster_02'), ph('leafy_grass'), ph('box_profile_metal_sheet'),
  acg('Facade001'), acg('Facade002', 512, true), acg('Facade005'), acg('Facade006'), acg('Facade009', 512, true),
];

export const envs = [
  { id: 'env.sky', kind: 'env', src: 'polyhaven/kloofendal_48d_partly_cloudy_puresky_1k.hdr', license: 'ph-kloofendal_48d_partly_cloudy_puresky', out: 'env/sky_1k.hdr' },
];
