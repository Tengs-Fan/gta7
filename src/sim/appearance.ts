import type { Rng } from '../core/rng';
import type { Appearance, CharacterRole } from './entities';

const SKINS = [0xf1c27d, 0xe0ac69, 0xc68642, 0x8d5524, 0x5c3a1e, 0xffdbac, 0xd8a47f];
const SHIRTS = [0xc0392b, 0x2980b9, 0x27ae60, 0xf39c12, 0x8e44ad, 0xecf0f1, 0x2c3e50, 0xe84393, 0x16a085, 0xd35400, 0x7f8c8d, 0xf1c40f, 0x1abc9c];
const PANTS = [0x2c3e50, 0x34495e, 0x1a1a1a, 0x5d4037, 0x2e4053, 0x7b7d7d, 0x154360, 0xa0826d];
const HAIR = [0x1a1a1a, 0x3b2a1a, 0x6b4423, 0xb5651d, 0xd9c36a, 0x8a8a8a, 0x5a2d0c];

export function randomAppearance(rng: Rng, role: CharacterRole): Appearance {
  const skin = rng.pick(SKINS);
  switch (role) {
    case 'cop':
      return { skin, shirt: 0x1f3a93, pants: 0x101a3a, hair: rng.pick(HAIR), hat: 0x0d1b4c, height: rng.range(0.98, 1.06), build: rng.range(1.0, 1.12) };
    case 'swat':
      return { skin, shirt: 0x1c2833, pants: 0x17202a, hair: 0x111111, hat: 0x111111, height: rng.range(1.0, 1.06), build: 1.18 };
    case 'gang':
      return { skin, shirt: rng.pick([0x0e7c7b, 0x117864, 0x0b5345]), pants: 0x1b1b1b, hair: rng.pick(HAIR), hat: rng.chance(0.6) ? 0x0e7c7b : 0, height: rng.range(0.96, 1.05), build: rng.range(1.0, 1.15) };
    case 'player':
      return { skin: 0xc68642, shirt: 0x2a2c33, pants: 0x34557f, hair: 0x15110e, hat: 0, height: 1.02, build: 1.06 };
    case 'mission':
    case 'civilian':
    default:
      return {
        skin,
        shirt: rng.pick(SHIRTS),
        pants: rng.pick(PANTS),
        hair: rng.pick(HAIR),
        hat: rng.chance(0.15) ? rng.pick(SHIRTS) : 0,
        height: rng.range(0.9, 1.07),
        build: rng.range(0.88, 1.15),
      };
  }
}
