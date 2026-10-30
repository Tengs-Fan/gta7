// Recorded speech (scripts/assets/speech, src/sim/speech.ts, src/audio/{speech,dialogue,barks}.ts): the index and the
// files agree, every line the game can say has a clip (mission dialogue, phone lines, every dispatch line the dispatcher
// can build), a line of dialogue stays up as long as it is spoken, and the players of dialogue and street voices follow
// their rules against a small fake context.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BARK_COOLDOWN, BARK_GAP, Barks } from '../../src/audio/barks';
import { Dialogue } from '../../src/audio/dialogue';
import { dispatchClips, SpeechBank } from '../../src/audio/speech';
import { COLOUR_NAMES, COMPASS, CRIME_PHRASES } from '../../src/sim/dispatch';
import { STORY } from '../../src/sim/missions';
import { dialogueKey, LINE_TAIL, lineSeconds, phraseWords, SPEECH } from '../../src/sim/speech';
import { VEHICLE_SPECS } from '../../src/sim/specs';
import { dialogueLines } from '../../scripts/assets/speech/dialogue';
import { zoneNames } from '../../scripts/assets/speech/phrases';
import { input, makeSim, step, teleport, world } from './helpers';

const DIR = new URL('../../src/assets/speech/', import.meta.url).pathname;

/** Every clip a talk station can play: each show's pieces of every kind and every part of every ad campaign. */
function talkClips(): string[] {
  return [...Object.values(SPEECH.talk).flatMap((show) => Object.values(show).flat()), ...Object.values(SPEECH.adSeries).flat()];
}

/** The words a line's dispatch clips say, joined. */
function spoken(text: string): string {
  const phraseOf = new Map(Object.entries(SPEECH.dispatch).map(([words, id]) => [id, words]));
  return dispatchClips(text)
    .map((id) => phraseOf.get(id))
    .join(' ');
}

describe('the speech index', () => {
  it('lists exactly the clips on disk, each a few kilobytes or more', () => {
    const files = readdirSync(DIR).filter((f) => f.endsWith('.mp3'));
    const ids = Object.keys(SPEECH.clips);
    expect(new Set(files)).toEqual(new Set(ids.map((id) => `${id}.mp3`)));
    for (const id of ids) expect(SPEECH.clips[id]).toBeGreaterThan(0.2);
    const used = [...Object.values(SPEECH.dialogue), ...Object.values(SPEECH.dispatch), ...talkClips(), ...Object.values(SPEECH.barks).flat(2)];
    for (const id of used) expect(existsSync(`${DIR}${id}.mp3`), id).toBe(true);
  });

  it('names the speech model and its license in LICENSES-ASSETS.md', () => {
    const md = readFileSync(new URL('../../LICENSES-ASSETS.md', import.meta.url), 'utf8');
    expect(md).toMatch(/^## Speech$/m);
    expect(md).toMatch(/\| Kokoro-82M v1\.0 and its voices \| hexgrad \| https:\/\/huggingface\.co\/hexgrad\/Kokoro-82M \| Apache-2\.0 \|/);
  });

  it('has a clip for every line of mission dialogue and every phone line, voiced by its speaker', () => {
    const lines = dialogueLines(world());
    expect(lines.length).toBeGreaterThan(50);
    for (const l of lines) {
      const id = SPEECH.dialogue[dialogueKey(l.speaker, l.text)];
      expect(id, `${l.speaker}: ${l.text}`).toBeDefined();
    }
    // Templated lines are rendered with the city's own values.
    expect(lines.some((l) => /^A collector wants a yellow Nightjar GT\. One is parked in [A-Z]/.test(l.text))).toBe(true);
    // Every mission's offer on the phone.
    for (const d of STORY) expect(lines.some((l) => l.text.includes(`"${d.title}"`))).toBe(true);
  });

  it('keeps a line of dialogue up for as long as it is spoken, a call as long as the contact speaks it in person', () => {
    const [key, id] = Object.entries(SPEECH.dialogue)[0]!;
    const [speaker, text] = key.split('|') as [string, string];
    expect(lineSeconds(speaker, text)).toBeCloseTo(SPEECH.clips[id]! + LINE_TAIL, 9);
    expect(lineSeconds(`${speaker} (phone)`, text)).toBe(lineSeconds(speaker, text));
    // A line nobody recorded (a mod's mission) stays up by its length.
    expect(lineSeconds('Nobody', 'Short.')).toBeCloseTo(1.6 + 6 * 0.055, 9);
  });

  it('a mission line comes with the duration of its clip', () => {
    const sim = makeSim({ ambient: false, police: false });
    const subs: Array<{ speaker: string; text: string; duration: number }> = [];
    sim.events.on('subtitle', (e) => subs.push(e));
    const lou = sim.world.layout.pois.find((p) => p.id === 'lou')!;
    teleport(sim, lou.x, lou.z);
    step(sim, 0.1);
    const marker = sim.interactions.markers.find((m) => m.kind === 'mission' && m.ref === STORY[0]!.id)!;
    teleport(sim, marker.x, marker.z);
    step(sim, 0.1);
    sim.update(1 / 60, input({ interact: true }));
    step(sim, 0.5);
    expect(subs.length).toBeGreaterThan(0);
    const s = subs[0]!;
    expect(SPEECH.dialogue[dialogueKey(s.speaker, s.text)]).toBeDefined();
    expect(s.duration).toBeCloseTo(lineSeconds(s.speaker, s.text), 9);
  });
});

describe('the police dispatcher', () => {
  it('can say every opening, sighting and search line the dispatcher builds, word for word', () => {
    const zones = zoneNames(world());
    const crimes = [...new Set([...Object.values(CRIME_PHRASES), 'a disturbance'])];
    const suspects = ['on foot', ...COLOUR_NAMES.flatMap(([c]) => Object.values(VEHICLE_SPECS).map((s) => `in ${/^[aeiou]/.test(c) ? 'an' : 'a'} ${c} ${s.name}`))];
    let n = 0;
    const check = (text: string) => {
      expect(spoken(text), text).toBe(phraseWords(text).join(' '));
      n++;
    };
    for (const zone of zones) {
      for (const what of crimes) for (const s of suspects) check(`All units, ${what} reported in ${zone}. Suspect ${s}.`);
      for (const d of COMPASS) check(`Suspect spotted heading ${d} through ${zone}.`);
      check(`We lost visual. Search around ${zone}.`);
    }
    for (const fixed of ['All units, return to patrol.', 'SWAT is rolling.', 'Air unit on scene.']) {
      check(fixed);
      expect(dispatchClips(fixed).length).toBe(1);
    }
    console.log(`[speech] ${n} dispatch lines covered by ${Object.keys(SPEECH.dispatch).length} phrases`);
  });

  it('can say the lines of a real chase', () => {
    const sim = makeSim({ police: true, ambient: false, seed: 11 });
    sim.cheats.godMode = true;
    const lines: string[] = [];
    sim.events.on('dispatch', (e) => lines.push(e.text));
    sim.wanted.setLevel(3);
    step(sim, 40);
    sim.wanted.setLevel(0);
    step(sim, 8);
    expect(lines.length).toBeGreaterThan(1);
    for (const l of lines) expect(spoken(l), l).toBe(phraseWords(l).join(' '));
  });
});

describe('the talk station and the street', () => {
  it('has idents, ads and a show of monologues, callers and news on every talk station, each a few seconds to half a minute, a serial chapter to a minute and a half', () => {
    const azura = SPEECH.talk.azura;
    expect(azura.ident.length).toBeGreaterThanOrEqual(4);
    expect(azura.ad.length).toBeGreaterThanOrEqual(10);
    expect(azura.host.length + azura.call.length + azura.news.length).toBeGreaterThanOrEqual(20);
    const bowl = SPEECH.talk.bowl;
    expect(bowl.ident.length).toBeGreaterThanOrEqual(4);
    expect(bowl.ad.length).toBeGreaterThanOrEqual(3);
    expect(bowl.host.length + bowl.call.length + bowl.news.length).toBeGreaterThanOrEqual(15);
    for (const show of ['sapr'] as const) {
      const p = SPEECH.talk[show];
      expect(p.ident.length, show).toBeGreaterThanOrEqual(4);
      expect(p.ad.length, show).toBeGreaterThanOrEqual(2);
      expect(p.host.length + p.call.length + p.news.length + p.serial.length, show).toBeGreaterThanOrEqual(15);
    }
    expect(SPEECH.talk.sapr.serial).toHaveLength(5);
    for (const pools of Object.values(SPEECH.talk)) {
      for (const [kind, ids] of Object.entries(pools)) for (const id of ids) expect(SPEECH.clips[id], id).toBeLessThan(kind === 'serial' ? 90 : 40);
    }
    for (const id of Object.values(SPEECH.adSeries).flat()) expect(SPEECH.clips[id], id).toBeLessThan(40);
  });

  it('has every kind of shout in several voices, each voice saying every line of its kind', () => {
    for (const [kind, voices] of Object.entries(SPEECH.barks)) {
      expect(voices.length, kind).toBeGreaterThanOrEqual(3);
      for (const lines of voices) expect(lines.length, kind).toBe(voices[0]!.length);
    }
  });
});

// ---------------------------------------------------------------------------
// The players, against a fake context.

class P {
  value: number;
  maxValue = 24000;
  constructor(v = 0) {
    this.value = v;
  }
  setValueAtTime(v: number): this {
    this.value = v;
    return this;
  }
  linearRampToValueAtTime(v: number): this {
    this.value = v;
    return this;
  }
  cancelScheduledValues(): this {
    return this;
  }
}

class N {
  readonly outputs: N[] = [];
  startedAt: number | null = null;
  offset = 0;
  stoppedAt = Infinity;
  onended: (() => void) | null = null;
  constructor(
    readonly kind: string,
    props: Record<string, unknown> = {},
  ) {
    Object.assign(this, props);
  }
  connect(d: N): N {
    this.outputs.push(d);
    return d;
  }
  disconnect(): void {}
  start(t: number, offset = 0): void {
    this.startedAt = t;
    this.offset = offset;
  }
  stop(t: number): void {
    this.stoppedAt = t;
  }
}

class Ctx {
  currentTime = 10;
  readonly made: N[] = [];
  private node(kind: string, props: Record<string, unknown> = {}): N {
    const n = new N(kind, props);
    this.made.push(n);
    return n;
  }
  createGain() {
    return this.node('gain', { gain: new P(1) });
  }
  createBiquadFilter() {
    return this.node('biquad', { type: 'lowpass', frequency: new P(350) });
  }
  createBufferSource() {
    return this.node('source', { buffer: null });
  }
  createWaveShaper() {
    return this.node('shaper', { curve: null });
  }
}

/** A bank whose clips all load at once, each `len` seconds long. */
function bank(ctx: Ctx, len = 2): SpeechBank {
  return new SpeechBank(ctx as unknown as BaseAudioContext, () => Promise.resolve({ duration: len } as AudioBuffer));
}

const filters = (ctx: Ctx) => ctx.made.filter((n) => n.kind === 'biquad').map((n) => `${(n as unknown as { type: string }).type} ${(n as unknown as { frequency: P }).frequency.value}`);
const sources = (ctx: Ctx) => ctx.made.filter((n) => n.kind === 'source');

afterEach(() => vi.restoreAllMocks());

describe('dialogue', () => {
  const [key] = Object.keys(SPEECH.dialogue);
  const [speaker, text] = key!.split('|') as [string, string];

  it('speaks a line in person dry, and a call down a 300 Hz to 3.4 kHz phone line', async () => {
    const ctx = new Ctx();
    const bus = new N('bus');
    const d = new Dialogue(ctx as unknown as BaseAudioContext, bus as unknown as AudioNode, bank(ctx));
    await d.say(speaker, text);
    expect(sources(ctx).length).toBe(1);
    expect(filters(ctx)).toEqual([]);
    await d.say(`${speaker} (phone)`, text);
    expect(sources(ctx).length).toBe(2);
    expect(filters(ctx).sort()).toEqual(['highpass 300', 'lowpass 3400']);
    // The new line cut the old one.
    expect(sources(ctx)[0]!.stoppedAt).toBeLessThan(ctx.currentTime + 0.1);
  });

  it('cuts the line on an empty subtitle (a skip) and says nothing for a line nobody recorded', async () => {
    const ctx = new Ctx();
    const d = new Dialogue(ctx as unknown as BaseAudioContext, new N('bus') as unknown as AudioNode, bank(ctx));
    await d.say(speaker, text);
    await d.say('', '');
    expect(sources(ctx)[0]!.stoppedAt).toBeLessThan(ctx.currentTime + 0.1);
    await d.say('Nobody', 'Unrecorded.');
    expect(sources(ctx).length).toBe(1);
  });

  it('holds a line under the pause menu and resumes it where it stopped', async () => {
    const ctx = new Ctx();
    const d = new Dialogue(ctx as unknown as BaseAudioContext, new N('bus') as unknown as AudioNode, bank(ctx, 3));
    await d.say(speaker, text);
    ctx.currentTime += 1.25;
    d.setPaused(true);
    expect(sources(ctx)[0]!.stoppedAt).toBeLessThan(ctx.currentTime + 0.1);
    ctx.currentTime += 20;
    d.setPaused(false);
    expect(sources(ctx).length).toBe(2);
    expect(sources(ctx)[1]!.offset).toBeCloseTo(1.25, 9);
    // A line that had ended by the pause does not come back.
    ctx.currentTime += 5;
    d.setPaused(true);
    d.setPaused(false);
    expect(sources(ctx).length).toBe(2);
  });
});

describe('voices in the street', () => {
  function rig() {
    const ctx = new Ctx();
    const out = new N('out');
    let heard: { gain: number; pan: number; cutoff: number } | null = { gain: 0.5, pan: 0, cutoff: 20000 };
    const b = new Barks(ctx as unknown as BaseAudioContext, bank(ctx), () => heard, () => out as unknown as AudioNode);
    return { ctx, b, out, mute: () => (heard = null) };
  }
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it('a person keeps one voice: the clip comes from the voice their id picks', async () => {
    for (const who of [0, 1, 2, 7, 12345]) {
      const { b, ctx } = rig();
      vi.spyOn(Math, 'random').mockReturnValue(0);
      const load = vi.spyOn(SpeechBank.prototype, 'load');
      expect(b.say('jacked', who, 0, 0, 0)).toBe(true);
      const voices = SPEECH.barks.jacked;
      expect(load).toHaveBeenCalledWith(voices[who % voices.length]![0]);
      await flush();
      expect(sources(ctx).length).toBe(1);
      vi.restoreAllMocks();
    }
  });

  it('keeps shouts a beat apart, each kind to its cooldown, and one person to one line at a time', () => {
    const { b, ctx } = rig();
    const beat = BARK_GAP + 0.01;
    expect(b.say('hurt', 1, 0, 0, 0)).toBe(true);
    expect(b.say('panic', 2, 0, 0, 0)).toBe(false);
    ctx.currentTime += beat;
    expect(b.say('panic', 2, 0, 0, 0)).toBe(true);
    ctx.currentTime += beat;
    expect(b.say('panic', 3, 0, 0, 0)).toBe(false);
    // Person 1 is still talking (the clip and a second after it); someone else may answer.
    expect(b.say('jacked', 1, 0, 0, 0)).toBe(false);
    expect(b.say('jacked', 4, 0, 0, 0)).toBe(true);
    ctx.currentTime += BARK_COOLDOWN.panic;
    expect(b.say('panic', 3, 0, 0, 0)).toBe(true);
  });

  it('is silent out of earshot, and a cruiser loudspeaker comes through a narrow band', async () => {
    const { b, ctx, mute } = rig();
    expect(b.say('pullOver', 5, 0, 0, 0)).toBe(true);
    await flush();
    expect(filters(ctx).sort()).toEqual(['highpass 500', 'lowpass 3000']);
    expect(ctx.made.some((n) => n.kind === 'shaper')).toBe(true);
    mute();
    ctx.currentTime += 60;
    expect(b.say('greet', 9, 500, 0, 500)).toBe(false);
  });
});
