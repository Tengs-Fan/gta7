// Las Lomas County's roadside oddities (world/country/oddities.ts) that stand on their own, drawn: the giant fibreglass cow
// on her flatbed and the farm stand beside her, the Little Green Diner's sign with the saucer crashed by it (its beacon
// blinks after dark), Bigfoot at his pull-off with his plaque, the abandoned pickup, the school bus henhouse and the
// bees' hives, and the payphone, with the gravel of the pull-off. All of it is two meshes (the cow wears her own hide's
// texture; the rest is vertex-coloured), its painted boards one piece of the places' atlas (kit.ts), and the beacon and its
// halo two small ones, hidden with the rest of the county past the fog. The telephone poles are poles.ts's.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { countryGround } from '../../world/country';
import { inFrame, type Placed, type StaticKind } from '../../world/country/oddities';
import type { ViewState } from '../../sim/viewState';
import { face } from '../city/attractions';
import { canvas, toTexture } from '../textures/misc';
import { cowTexture } from './farmModels';
import type { CountryView } from './index';
import { DIRT_Y, type PlacesKit } from './kit';
import {
  busGeometry, bigfootGeometry, cowTrimGeometry, DECK_Y, DINER_BOARD, DINER_SAUCER, dinerSignGeometry, flatbedGeometry, giantCowGeometry, hivesGeometry, payphoneGeometry, pickupGeometry, PLAQUE, plaqueGeometry, saucerGeometry,
  standGeometry,
} from './oddityModels';
import { sign } from './town';

/** The beacon's colours: lit red and green by turns after dark, and a dull glass by day. */
const BEACON = [new THREE.Color(0xff3030), new THREE.Color(0x36ff6a)] as const;
const BEACON_DULL = new THREE.Color(0x40100f);
/** How often it blinks (a colour lasts this long, s). */
const BLINK = 0.7;

/** What each oddity is made of but for the cow's hide and the saucer (its beacon is drawn apart). */
const PLAIN: Readonly<Record<StaticKind, () => THREE.BufferGeometry[]>> = {
  cow: () => [flatbedGeometry(), cowTrimGeometry()],
  stand: () => [standGeometry()],
  diner: () => [dinerSignGeometry()],
  bigfoot: () => [bigfootGeometry()],
  plaque: () => [plaqueGeometry()],
  pickup: () => [pickupGeometry()],
  bus: () => [busGeometry()],
  hives: () => [hivesGeometry()],
  payphone: () => [payphoneGeometry()],
};

/** A geometry in an oddity's own frame, stood where it stands. */
function placed(geo: THREE.BufferGeometry, p: Placed, y: number): THREE.BufferGeometry {
  return geo.applyMatrix4(new THREE.Matrix4().makeRotationY(p.rot).setPosition(p.x, y, p.z));
}

/** A soft round glow, white in the middle to nothing at the rim. */
function haloTexture(): THREE.Texture {
  const [c, ctx] = canvas(64, 64);
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.25, 'rgba(255,255,255,0.45)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  return toTexture(c, true, false);
}

/**
 * Stands the static oddities in the county and paints their boards. Returns what moves each frame: the saucer's beacon,
 * which blinks red and green after dark.
 */
export function buildOddities(view: CountryView, kit: PlacesKit): (night: number, time: number, sim: ViewState | null) => void {
  const L = view.world.layout;
  const o = L.country.oddities;
  const ground = (x: number, z: number) => countryGround(L.country, x, z);
  const place = kit.place('oddities');
  const parts: THREE.BufferGeometry[] = [];
  const saucer = saucerGeometry();
  for (const p of o.statics) {
    const y = ground(p.x, p.z);
    for (const g of PLAIN[p.kind]()) parts.push(placed(g, p, y));
    if (p.kind === 'diner') parts.push(placed(saucer.clone().translate(DINER_SAUCER.u, 0, DINER_SAUCER.d), p, y));
  }
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, metalness: 0.05 });
  mat.name = 'oddity-models';
  const merged = mergeGeometries(parts, false)!;
  for (const g of parts) g.dispose();
  view.add(merged, mat, { shadow: true, split: false, name: 'oddity-models' });

  // The cow: her own hide's texture, glossy as fibreglass is, the farms' cow's spots on her.
  const cow = o.statics.find((p) => p.kind === 'cow')!;
  const hide = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, map: cowTexture(), roughness: 0.28 });
  hide.name = 'giant-cow';
  view.add(placed(giantCowGeometry(), cow, ground(cow.x, cow.z)), hide, { shadow: true, split: false, name: 'giant-cow' });

  // Gravel under the pull-off.
  const dirtUv = { kind: 'world', scale: view.city.ground.tile('plain') } as const;
  for (const r of o.pads) kit.dirt.flat(r.minX, r.minZ, r.maxX, r.maxZ, DIRT_Y, dirtUv);

  boards(kit, place, o.statics, ground);
  return beacon(view, o.statics.find((p) => p.kind === 'diner')!, saucer.userData.beacon as [number, number, number], ground);
}

/** The boards of the places' atlas (kit.ts) on the oddities: each one at u across, y up and d along its oddity's frame, facing as it does or turned by `turn`. */
function boards(kit: PlacesKit, place: ReturnType<PlacesKit['place']>, statics: readonly Placed[], ground: (x: number, z: number) => number): void {
  const at = (kind: StaticKind) => statics.find((p) => p.kind === kind)!;
  const put = (p: Placed, band: [number, number], w: number, h: number, u: number, y: number, d: number, turn = 0, [u0, u1] = [0, 1]) => {
    const c = inFrame(p, u, d);
    kit.board(place, band, w, h, c.x, ground(p.x, p.z) + y, c.z, p.rot + turn, u0, u1);
  };

  // The diner's board: lit after dark, its name over its pie.
  const { w, h, y } = DINER_BOARD;
  put(at('diner'), sign(kit, [['LITTLE GREEN DINER', 104], ['OUT OF THIS WORLD PIE', 58]], '#f8e45c', '#14432c', 320), w, h, 0, y + h / 2, 0.14);

  // The cow's name along her trailer's sides, and the stand's board over its roof.
  const cow = at('cow');
  const name = kit.atlas.board([['BERTHA', 70, '#f6f1e4'], ['THE UDDERLY LARGE COW · NOT FOR SALE', 34, '#f6f1e4']], '#2c5f8c', 132);
  for (const s of [-1, 1]) put(cow, name, 6.2, 0.8, s * 1.36, DECK_Y - 0.25, 0, (s * Math.PI) / 2);
  put(at('stand'), kit.atlas.board([['FARM STAND', 96, '#f6f1e4'], ['EGGS · PIE · (THE COW IS NOT FOR SALE)', 40, '#f6f1e4']], '#7a2e1c', 184), 3.9, 0.7, 0, 3.0, 0.27);

  // The bus: the district's name, painted out and over, along its yellow band on the road side.
  put(at('bus'), kit.atlas.board([['LAS LOMAS ELEMENTARY', 38, '#1d1d1d']], '#d7a21f', 56), 7.2, 0.4, -1.215, 1.38, -0.9, -Math.PI / 2);

  // The payphone: PHONE over the roof's front, lit.
  put(at('payphone'), sign(kit, [['PHONE', 100]], '#ffffff', '#1f5fa0', 128), 0.9, 0.3, 0, 2.78, 0.56, 0, [0.3, 0.7]);

  // The plaque on Bigfoot's stone, tipped back: the slope's face, in five short lines.
  const stone = at('plaque');
  const text = kit.atlas.board(
    [
      ['BIGFOOT', 110, '#f1e4b8'],
      ['(SCULPTED FROM MEMORY)', 50, '#f1e4b8'],
      ['ERECTED 1987 BY THE LAS LOMAS CHAMBER OF COMMERCE.', 44, '#d8c88c'],
      ["SIGHTINGS: 0. FOOTPRINTS: 14, ALL THE CHAMBER'S.", 44, '#d8c88c'],
      ['PLEASE DO NOT FEED, PHOTOGRAPH OR BELIEVE HIM.', 44, '#d8c88c'],
    ],
    '#3c3a35',
    486,
    '#c8b87a',
  );
  const { w: pw, len, tilt, y: py } = PLAQUE;
  const sin = Math.sin(tilt);
  const cos = Math.cos(tilt);
  // A point of the slab's top face (a hair over it): u across, v up the slope.
  const corner = (u: number, v: number) => {
    const c = inFrame(stone, u, 0.04 * sin - v * cos);
    return [c.x, ground(stone.x, stone.z) + py + 0.04 * cos + v * sin, c.z] as const;
  };
  const [a, b, c, d] = [corner(-pw / 2 + 0.05, -len / 2 + 0.03), corner(pw / 2 - 0.05, -len / 2 + 0.03), corner(pw / 2 - 0.05, len / 2 - 0.03), corner(-pw / 2 + 0.05, len / 2 - 0.03)];
  face(place.painted, a, b, c, d, [Math.sin(stone.rot) * sin, cos, Math.cos(stone.rot) * sin], [1, 1, 1], [0, text[0], 1, text[0], 1, text[1], 0, text[1]]);
}

/** The saucer's beacon on its dome: a small lamp that blinks red and green after dark, and a halo round it. */
function beacon(view: CountryView, diner: Placed, [bu, by, bd]: [number, number, number], ground: (x: number, z: number) => number): (night: number, time: number) => void {
  const c = inFrame(diner, DINER_SAUCER.u + bu, DINER_SAUCER.d + bd);
  const y = ground(diner.x, diner.z) + by;
  const lamp = new THREE.MeshBasicMaterial({ color: BEACON_DULL });
  const bulb = new THREE.SphereGeometry(0.14, 8, 6).translate(c.x, y, c.z);
  view.add(bulb, lamp, { split: false, receive: false, name: 'saucer-beacon' });
  // The halo faces the highway the sign is read from, and is seen from no other side.
  const glow = new THREE.MeshBasicMaterial({ map: haloTexture(), color: BEACON[0], transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false, opacity: 0 });
  const halo = new THREE.PlaneGeometry(2.4, 2.4).rotateY(diner.rot).translate(c.x + Math.sin(diner.rot) * 0.2, y, c.z + Math.cos(diner.rot) * 0.2);
  view.add(halo, glow, { split: false, receive: false, name: 'saucer-halo' });
  return (night, time) => {
    const k = Math.floor(time / BLINK) % 2;
    const lit = night > 0.25;
    lamp.color.copy(lit ? BEACON[k]! : BEACON_DULL).multiplyScalar(lit ? 0.4 + night : 1);
    glow.color.copy(BEACON[k]!);
    glow.opacity = lit ? Math.min(1, night * 1.4) : 0;
  };
}
