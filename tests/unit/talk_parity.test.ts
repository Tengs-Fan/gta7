// AZURA TALK's programme after the talk stations got their formats is the one it was before: recorded on main at
// 4323153 for seeds 1, 7 and 42, with the index of that day (its pools in order and the length of each clip), so new
// pieces and ads, which change what the shuffles draw, do not move it.

import { describe, expect, it, vi } from 'vitest';
import { talkProgramme } from '../../src/audio/talk';

vi.mock('../../src/sim/speech', async (actual) => {
  const real = await actual<typeof import('../../src/sim/speech')>();
  const none = { host: [], call: [], news: [], ad: [], ident: [] };
  const azura = {
    host: ['host-lights', 'host-wheel', 'host-steps', 'host-gulls', 'host-rent', 'host-potholes', 'host-chopper', 'host-cab', 'host-docks'].map((id) => `talk-${id}`),
    call: ['call-lighthouse', 'call-pickup', 'call-tacos', 'call-cat', 'call-velora', 'call-houseboat', 'call-kid'].map((id) => `talk-${id}`),
    news: ['news-ducks', 'news-thefts', 'news-weather', 'news-sports', 'traffic-pigeon', 'traffic-hill'].map((id) => `talk-${id}`),
    ad: ['ad-pipsqueak', 'ad-nightjar', 'ad-guns', 'ad-lawyer', 'ad-torque', 'ad-insurance', 'ad-hospital', 'ad-spray', 'ad-tacos', 'ad-pier', 'ad-hillcrest', 'ad-thunderhoof'].map((id) => `talk-${id}`),
    ident: ['ident-cheap', 'ident-voice', 'ident-facts', 'ident-road', 'ident-works'].map((id) => `talk-${id}`),
  };
  const clips: Record<string, number> = {
    'talk-host-lights': 28.356, 'talk-host-wheel': 25.874, 'talk-host-steps': 23.49, 'talk-host-gulls': 21.398,
    'talk-host-rent': 20.222, 'talk-host-potholes': 22.866, 'talk-host-chopper': 21.12, 'talk-host-cab': 20.12,
    'talk-host-docks': 19.348, 'talk-call-lighthouse': 19.607, 'talk-call-pickup': 17.873, 'talk-call-tacos': 23.334,
    'talk-call-cat': 19.742, 'talk-call-velora': 14.167, 'talk-call-houseboat': 10.509, 'talk-call-kid': 13.506,
    'talk-news-ducks': 28.39, 'talk-news-thefts': 22.217, 'talk-news-weather': 19.052, 'talk-news-sports': 19.178,
    'talk-traffic-pigeon': 22.285, 'talk-traffic-hill': 24.327, 'talk-ad-pipsqueak': 14.155,
    'talk-ad-nightjar': 16.925, 'talk-ad-guns': 15.294, 'talk-ad-lawyer': 13.117, 'talk-ad-torque': 10.449,
    'talk-ad-insurance': 9.289, 'talk-ad-hospital': 13.337, 'talk-ad-spray': 8.929, 'talk-ad-tacos': 10.498,
    'talk-ad-pier': 7.752, 'talk-ad-hillcrest': 12.745, 'talk-ad-thunderhoof': 8.235, 'talk-ident-cheap': 3.855,
    'talk-ident-voice': 4.708, 'talk-ident-facts': 2.936, 'talk-ident-road': 4.154, 'talk-ident-works': 4.464,
  };
  return { ...real, SPEECH: { ...real.SPEECH, clips, talk: { azura, bowl: none }, adSeries: {} } };
});

/** The first 20 segments of each seed: kind, clip, start and length (s, to the microsecond). */
const MAIN: Record<number, readonly string[]> = {
  1: [
    'jingle talk-ident-road 0.000000 6.144000',
    'gap - 6.144000 0.584331',
    'host talk-call-kid 6.728331 14.006000',
    'gap - 20.734331 0.663825',
    'ad talk-ad-tacos 21.398156 11.198000',
    'gap - 32.596156 0.672902',
    'ad talk-ad-torque 33.269058 11.149000',
    'gap - 44.418058 0.514617',
    'jingle talk-ident-cheap 44.932675 5.845000',
    'gap - 50.777675 0.571548',
    'host talk-host-docks 51.349223 19.848000',
    'gap - 71.197223 0.620689',
    'jingle talk-ident-voice 71.817913 6.698000',
    'gap - 78.515913 0.776999',
    'host talk-news-sports 79.292912 19.678000',
    'gap - 98.970912 0.750327',
    'ad talk-ad-spray 99.721239 9.629000',
    'gap - 109.350239 0.588343',
    'ad talk-ad-thunderhoof 109.938582 8.935000',
    'gap - 118.873582 0.780768',
  ],
  7: [
    'jingle talk-ident-cheap 0.000000 5.845000',
    'gap - 5.845000 0.621657',
    'host talk-host-potholes 6.466657 23.366000',
    'gap - 29.832657 0.773882',
    'ad talk-ad-tacos 30.606539 11.198000',
    'gap - 41.804539 0.610691',
    'jingle talk-ident-works 42.415230 6.454000',
    'gap - 48.869230 0.783866',
    'host talk-call-tacos 49.653096 23.834000',
    'gap - 73.487096 0.599194',
    'ad talk-ad-hillcrest 74.086290 13.445000',
    'gap - 87.531290 0.596728',
    'ad talk-ad-hospital 88.128018 14.037000',
    'gap - 102.165018 0.601031',
    'jingle talk-ident-facts 102.766050 4.926000',
    'gap - 107.692050 0.776412',
    'host talk-call-houseboat 108.468461 11.009000',
    'gap - 119.477461 0.696573',
    'ad talk-ad-thunderhoof 120.174034 8.935000',
    'gap - 129.109034 0.767319',
  ],
  42: [
    'jingle talk-ident-road 0.000000 6.144000',
    'gap - 6.144000 0.657978',
    'host talk-call-velora 6.801978 14.667000',
    'gap - 21.468978 0.508137',
    'ad talk-ad-insurance 21.977115 9.989000',
    'gap - 31.966115 0.721586',
    'jingle talk-ident-voice 32.687701 6.698000',
    'gap - 39.385701 0.561257',
    'host talk-news-weather 39.946958 19.552000',
    'gap - 59.498958 0.522408',
    'jingle talk-ident-facts 60.021367 4.926000',
    'gap - 64.947367 0.778352',
    'host talk-call-lighthouse 65.725719 20.107000',
    'gap - 85.832719 0.629341',
    'ad talk-ad-tacos 86.462060 11.198000',
    'gap - 97.660060 0.608134',
    'ad talk-ad-lawyer 98.268194 13.817000',
    'gap - 112.085194 0.769867',
    'jingle talk-ident-works 112.855061 6.454000',
    'gap - 119.309061 0.780460',
  ],
};

describe('AZURA TALK', () => {
  it('plays the programme it played before the talk formats, segment for segment', () => {
    for (const seed of [1, 7, 42]) {
      const segs = talkProgramme(seed, 600).slice(0, 20).map((s) => `${s.kind} ${s.clip || '-'} ${s.start.toFixed(6)} ${s.dur.toFixed(6)}`);
      expect(segs, `seed ${seed}`).toEqual(MAIN[seed]);
    }
  });
});
