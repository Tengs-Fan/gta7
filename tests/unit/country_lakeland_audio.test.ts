// Lake Lomas's voices (audio/ambience.ts): loons and ducks calling at dawn and dusk within a few hundred metres of the water,
// and the campfire's crackle from dusk to the first light within seventy metres of it.

import { describe, expect, it } from 'vitest';
import { Ambience, ambienceTargets, crackleNoise, type AmbienceFrame, type AmbienceInput } from '../../src/audio/ambience';
import { Rng } from '../../src/core/rng';
import { campfireLit } from '../../src/world/country/lakeland';

const at = (over: Partial<AmbienceInput>) => ambienceTargets({ district: 'country', hours: 12, shoreDist: 1000, height: 0, traffic: 0, inVehicle: false, ...over });

describe('the lake\'s loons and ducks', () => {
  it('call at dawn and at dusk from the water and a few hundred metres off, and not at noon, at night or far away', () => {
    for (const hours of [5.8, 6.5, 7.2, 18.4, 19, 20]) expect(at({ hours, lakeDist: 0 }).loons, `${hours} h`).toBeGreaterThan(0.5);
    for (const hours of [0, 3, 12, 14, 23]) expect(at({ hours, lakeDist: 0 }).loons, `${hours} h`).toBe(0);
    expect(at({ hours: 6.5, lakeDist: 150 }).loons).toBeGreaterThan(0.3);
    expect(at({ hours: 6.5, lakeDist: 150 }).loons).toBeLessThan(at({ hours: 6.5, lakeDist: 0 }).loons);
    expect(at({ hours: 6.5, lakeDist: 400 }).loons).toBe(0);
    expect(at({ hours: 6.5 }).loons).toBe(0);
    // The ducks are the same at the twilights, with a thin line of them by day.
    expect(at({ hours: 19, lakeDist: 10 }).ducks).toBeGreaterThan(0.8);
    expect(at({ hours: 13, lakeDist: 10 }).ducks).toBeGreaterThan(0);
    expect(at({ hours: 13, lakeDist: 10 }).ducks).toBeLessThan(0.2);
    expect(at({ hours: 19, lakeDist: 600 }).ducks).toBe(0);
  });

  it('are muffled in a car like every layer', () => {
    expect(at({ hours: 6.5, lakeDist: 0, inVehicle: true }).loons).toBeLessThan(0.5 * at({ hours: 6.5, lakeDist: 0 }).loons);
  });
});

describe('the campfire\'s crackle', () => {
  it('is heard within seventy metres of the fire from dusk until it burns down at first light, loudest beside it', () => {
    expect(at({ hours: 23, fireDist: 4 }).fire).toBe(1);
    expect(at({ hours: 23, fireDist: 40 }).fire).toBeGreaterThan(0.2);
    expect(at({ hours: 23, fireDist: 40 }).fire).toBeLessThan(0.8);
    expect(at({ hours: 23, fireDist: 71 }).fire).toBe(0);
    for (const hours of [8, 12, 16]) expect(at({ hours, fireDist: 4 }).fire, `${hours} h`).toBe(0);
    for (const hours of [20, 0, 4]) expect(at({ hours, fireDist: 4 }).fire, `${hours} h`).toBe(1);
    expect(at({ hours: 6, fireDist: 4 }).fire).toBe(campfireLit(6));
    expect(at({ hours: 23 }).fire).toBe(0);
  });

  it('is a rumble with some fourteen pops a second, most of them small, none clipping, and starts and ends on a quiet bed', () => {
    const rate = 8000;
    const d = new Float32Array(rate * 7);
    const rng = new Rng(3);
    crackleNoise(d, rate, () => rng.next());
    let peak = 0;
    let loud = 0;
    for (const v of d) {
      expect(Number.isFinite(v)).toBe(true);
      peak = Math.max(peak, Math.abs(v));
      if (Math.abs(v) > 0.6) loud++;
    }
    expect(peak).toBeGreaterThan(0.5);
    expect(peak).toBeLessThan(2.5);
    // Pops are sparse in time: the loud samples are a sliver of the loop.
    expect(loud / d.length).toBeLessThan(0.01);
  });
});

describe('the ambience engine', () => {
  /** A context that accepts every call and answers with itself: enough to run the voices without a sound card. */
  const any: unknown = new Proxy(() => any, { get: (_t, k) => (k === Symbol.toPrimitive ? () => 0 : any), set: () => true, apply: () => any });
  const ctx = { currentTime: 0, sampleRate: 48000, createBuffer: () => any, createBufferSource: () => any, createGain: () => any, createBiquadFilter: () => any, createOscillator: () => any, createStereoPanner: () => any, createDelay: () => any } as unknown as BaseAudioContext;

  it('plays a loon as three oscillators (a vibrato and two partials) and a duck as one, each started and stopped once, and brings the campfire layer up at night', () => {
    const oscs: Array<{ started: number; stopped: number }> = [];
    const counting = {
      ...ctx,
      createOscillator: () => {
        const rec = { started: 0, stopped: 0 };
        oscs.push(rec);
        return new Proxy(() => any, { get: (_t, k) => (k === 'start' ? () => rec.started++ : k === 'stop' ? () => rec.stopped++ : k === Symbol.toPrimitive ? () => 0 : any), set: () => true, apply: () => any });
      },
    } as unknown as BaseAudioContext;
    const amb = new Ambience(counting, any as AudioNode);
    for (let k = 0; k < 8; k++) amb.update(1 / 60, k / 60, { district: 'country', hours: 6.5, shoreDist: 900, height: 0, traffic: 0, inVehicle: false, seaPan: 0, trafficPan: 0, lakeDist: 30, fireDist: 20, lakePan: 0.4, firePan: -0.5 } satisfies AmbienceFrame);
    expect(amb.ready).toBe(true);
    const frame = { district: 'country', hours: 23, shoreDist: 900, height: 0, traffic: 0, inVehicle: false, seaPan: 0, trafficPan: 0, lakeDist: 30, fireDist: 12, lakePan: 0.4, firePan: -0.5 } as AmbienceFrame;
    const play = (amb as unknown as { play: (kind: string, t: number, f: AmbienceFrame) => void }).play.bind(amb);
    const voice = (kind: string) => {
      const before = oscs.length;
      play(kind, 1, frame);
      return oscs.slice(before);
    };
    const loon = voice('loons');
    expect(loon.length).toBe(3);
    const duck = voice('ducks');
    expect(duck.length).toBe(1);
    for (const o of [...loon, ...duck]) expect([o.started, o.stopped]).toEqual([1, 1]);
    amb.update(1 / 60, 2, frame);
    expect(amb.levels.fire).toBeGreaterThan(0.5);
  });
});
