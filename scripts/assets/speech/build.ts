// `npm run speech`: renders everything the game says with Kokoro-82M (render.py) and writes src/assets/speech/: one
// 32 kbps mono MP3 per clip and speech.json, the index the sim and the audio read (src/sim/speech.ts).
//
// Clips: the mission dialogue (dialogue.ts), the police dispatcher's phrases (phrases.ts), the talk station's pieces,
// the music stations' idents and the barks (script.ts). Rendered lines are cached by voice, speed and text in GTA7_SPEECH_CACHE
// (~/.cache/gta7-speech), so a rerun renders only new lines. Each clip is trimmed, band-limited where it is heard down
// a phone line, levelled to the same loudness and encoded with ffmpeg; files the index no longer lists are removed.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { BarkKind, SpeechIndex } from '../../../src/sim/speech';
import { dialogueKey, phraseWords } from '../../../src/sim/speech';
import { StaticWorld } from '../../../src/world/staticWorld';
import { dialogueLines } from './dialogue';
import { dispatchPhrases } from './phrases';
import { BARKS, CAST, PHONE_ROLES, SAY, SPEAKERS, STATION_IDENTS, TALK } from './script';
import { SHOW_PIECES } from './shows';

const RATE = 24000;
const HERE = new URL('.', import.meta.url).pathname;
const OUT = new URL('../../../src/assets/speech/', import.meta.url).pathname;
const PYTHON = process.env.GTA7_TTS_PYTHON ?? join(homedir(), 'Projects/VENVS/gta7-tts/bin/python');
const CACHE = process.env.GTA7_SPEECH_CACHE ?? join(homedir(), '.cache/gta7-speech');

/** One line as Kokoro reads it. */
interface Take {
  voice: string;
  text: string;
  speed: number;
  /** Heard down a phone line or a radio link. */
  phone?: boolean;
}

/** One clip: its takes in order, with a pause between them. */
interface Clip {
  id: string;
  takes: Take[];
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const hash = (s: string) => createHash('sha1').update(s).digest('hex');
/** The text as Kokoro reads it (SAY). */
const spoken = (text: string) => SAY.reduce((s, [re, say]) => s.replace(re, say), text);
const wavOf = (t: Take) => join(CACHE, `${hash(`kokoro-82m-v1.0|${t.voice}|${t.speed}|${spoken(t.text)}`)}.wav`);

const world = new StaticWorld();
const clips: Clip[] = [];
const index: SpeechIndex = {
  clips: {},
  dialogue: {},
  dispatch: {},
  talk: {
    azura: { host: [], call: [], news: [], ad: [], ident: [], serial: [] },
    bowl: { host: [], call: [], news: [], ad: [], ident: [], serial: [] },
    sapr: { host: [], call: [], news: [], ad: [], ident: [], serial: [] },
    static: { host: [], call: [], news: [], ad: [], ident: [], serial: [] },
  },
  adSeries: {},
  barks: {} as Record<BarkKind, string[][]>,
  idents: {},
};

for (const line of dialogueLines(world)) {
  const role = SPEAKERS[line.speaker];
  if (!role) throw new Error(`No voice for "${line.speaker}": add the speaker to SPEAKERS in script.ts`);
  const id = `dlg-${role}-${hash(line.text).slice(0, 10)}`;
  clips.push({ id, takes: [{ voice: CAST[role], text: line.text, speed: 1 }] });
  index.dialogue[dialogueKey(line.speaker, line.text)] = id;
}
for (const phrase of dispatchPhrases(world)) {
  const words = phraseWords(phrase).join(' ');
  const id = `dsp-${slug(words)}`;
  clips.push({ id, takes: [{ voice: CAST.dispatch, text: phrase, speed: 1 }] });
  index.dispatch[words] = id;
}
const series: Record<string, string[]> = {};
for (const piece of [...TALK, ...SHOW_PIECES]) {
  const id = `talk-${piece.id}`;
  const speed = piece.kind === 'ad' ? 1.05 : 1;
  clips.push({ id, takes: piece.lines.map(([role, text, opts]) => ({ voice: CAST[role], text, speed: opts?.speed ?? speed, phone: opts?.phone ?? PHONE_ROLES.has(role) })) });
  // A campaign is in the ad pools as its first part, and its parts under that part's id.
  if (piece.series) (series[piece.series] ??= [])[piece.part! - 1] = id;
  if ((piece.part ?? 1) > 1) continue;
  for (const show of piece.shows ?? [piece.show ?? 'azura']) index.talk[show][piece.kind].push(id);
}
for (const parts of Object.values(series)) index.adSeries[parts[0]!] = parts;
for (const [station, set] of Object.entries(STATION_IDENTS)) {
  index.idents[station] = set.lines.map((text, i) => {
    const id = `ident-${slug(station)}-${i}`;
    clips.push({ id, takes: [{ voice: set.voice, text, speed: 1 }] });
    return id;
  });
}
for (const [kind, set] of Object.entries(BARKS) as Array<[BarkKind, (typeof BARKS)[BarkKind]]>) {
  index.barks[kind] = set.voices.map((voice) =>
    set.lines.map((text, i) => {
      const id = `bark-${slug(kind)}-${voice.replace('_', '-')}-${i}`;
      clips.push({ id, takes: [{ voice, text, speed: 1 }] });
      return id;
    }),
  );
}

// Render the takes that are not cached yet.
mkdirSync(CACHE, { recursive: true });
const todo = new Map<string, Take>();
for (const c of clips) for (const t of c.takes) if (!existsSync(wavOf(t))) todo.set(wavOf(t), t);
if (todo.size > 0) {
  console.log(`rendering ${todo.size} lines`);
  const jobs = [...todo].map(([out, t]) => ({ out, voice: t.voice, text: spoken(t.text), speed: t.speed }));
  execFileSync(PYTHON, [join(HERE, 'render.py')], { input: JSON.stringify(jobs), stdio: ['pipe', 'inherit', 'inherit'], env: { ...process.env, HF_HUB_DISABLE_TELEMETRY: '1' } });
}

/** Samples of a 16-bit mono WAV, as floats. */
function readWav(file: string): Float32Array {
  const b = readFileSync(file);
  let p = 12;
  while (b.toString('ascii', p, p + 4) !== 'data') p += 8 + b.readUInt32LE(p + 4);
  const n = b.readUInt32LE(p + 4) / 2;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = b.readInt16LE(p + 8 + i * 2) / 32768;
  return out;
}

function writeWav(file: string, x: Float32Array): void {
  const b = Buffer.alloc(44 + x.length * 2);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(36 + x.length * 2, 4);
  b.write('WAVEfmt ', 8, 'ascii');
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(RATE, 24);
  b.writeUInt32LE(RATE * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36, 'ascii');
  b.writeUInt32LE(x.length * 2, 40);
  for (let i = 0; i < x.length; i++) b.writeInt16LE(Math.round(Math.max(-1, Math.min(1, x[i]!)) * 32767), 44 + i * 2);
  writeFileSync(file, b);
}

/** The take without its leading and trailing silence (40 ms kept on either side). */
function trim(x: Float32Array): Float32Array {
  let a = 0;
  let b = x.length - 1;
  while (a < b && Math.abs(x[a]!) < 0.01) a++;
  while (b > a && Math.abs(x[b]!) < 0.01) b--;
  const pad = Math.round(0.04 * RATE);
  return x.slice(Math.max(0, a - pad), Math.min(x.length, b + pad));
}

/** A second-order section (RBJ cookbook), run over `x` in place. */
function biquad(x: Float32Array, type: 'highpass' | 'lowpass', hz: number): void {
  const w = (2 * Math.PI * hz) / RATE;
  const alpha = Math.sin(w) / Math.SQRT2;
  const cos = Math.cos(w);
  const k = type === 'lowpass' ? (1 - cos) / 2 : (1 + cos) / 2;
  const b0 = k;
  const b1 = type === 'lowpass' ? 1 - cos : -(1 + cos);
  const a0 = 1 + alpha;
  const a1 = -2 * cos;
  const a2 = 1 - alpha;
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const x0 = x[i]!;
    const y0 = (b0 * x0 + b1 * x1 + k * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
    x[i] = y0;
  }
}

/** A phone line: 300 Hz to 3.4 kHz, 24 dB per octave on either side. */
function phoneLine(x: Float32Array): void {
  biquad(x, 'highpass', 300);
  biquad(x, 'highpass', 300);
  biquad(x, 'lowpass', 3400);
  biquad(x, 'lowpass', 3400);
}

/** Levels a clip to -20 dBFS RMS over its voiced samples, peaks held under -1 dBFS. */
function level(x: Float32Array): void {
  let ss = 0;
  let n = 0;
  let peak = 0;
  for (const v of x) {
    peak = Math.max(peak, Math.abs(v));
    if (Math.abs(v) > 0.02) {
      ss += v * v;
      n++;
    }
  }
  const g = Math.min(0.1 / Math.sqrt(ss / Math.max(1, n)), 0.89 / peak);
  for (let i = 0; i < x.length; i++) x[i]! *= g;
}

/** Seconds of quiet between two takes of a clip: shorter when the other speaker answers. */
const PAUSE_SAME = 0.35;
const PAUSE_TURN = 0.22;

mkdirSync(OUT, { recursive: true });
const tmp = join(CACHE, 'clip.wav');
const written = new Set<string>();
for (const c of clips) {
  const parts: Float32Array[] = [];
  c.takes.forEach((t, i) => {
    if (i > 0) parts.push(new Float32Array(Math.round((t.voice === c.takes[i - 1]!.voice ? PAUSE_SAME : PAUSE_TURN) * RATE)));
    const x = trim(readWav(wavOf(t)));
    if (t.phone) phoneLine(x);
    parts.push(x);
  });
  const x = new Float32Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) {
    x.set(p, o);
    o += p.length;
  }
  level(x);
  writeWav(tmp, x);
  const file = `${c.id}.mp3`;
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', tmp, '-ac', '1', '-ar', String(RATE), '-codec:a', 'libmp3lame', '-b:a', '32k', '-map_metadata', '-1', '-fflags', '+bitexact', '-flags:a', '+bitexact', join(OUT, file)]);
  index.clips[c.id] = Math.round((x.length / RATE) * 1000) / 1000;
  written.add(file);
}
rmSync(tmp);

for (const f of readdirSync(OUT)) {
  if (f.endsWith('.mp3') && !written.has(f)) {
    rmSync(join(OUT, f));
    console.log(`removed stale ${f}`);
  }
}
writeFileSync(join(OUT, 'speech.json'), `${JSON.stringify(index, null, 1)}\n`);
// What each clip says, for check.py (not shipped).
writeFileSync(join(CACHE, 'lines.json'), JSON.stringify(Object.fromEntries(clips.map((c) => [c.id, c.takes.map((t) => t.text).join(' ')]))));

const bytes = [...written].reduce((s, f) => s + readFileSync(join(OUT, f)).length, 0);
const seconds = Object.values(index.clips).reduce((a, b) => a + b, 0);
console.log(`${written.size} clips, ${(seconds / 60).toFixed(1)} min, ${(bytes / 1048576).toFixed(2)} MB`);
