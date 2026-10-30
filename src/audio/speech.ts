// Recorded speech: the MP3 clips of src/assets/speech (rendered by `npm run speech`, indexed in src/sim/speech.ts),
// fetched and decoded on first use and kept. The dialogue, dispatch and bark clips are small and fetched in the
// background once the context exists; the talk station's pieces when the programme comes to them.

import { phraseWords, SPEECH } from '../sim/speech';
import type { NodeTally } from './tally';

// import.meta.glob keys are relative to this file; values are the content-hashed URLs.
const URLS = import.meta.glob('../assets/speech/*.mp3', { query: '?url', import: 'default', eager: true }) as Record<string, string>;

export function clipUrl(id: string): string {
  return URLS[`../assets/speech/${id}.mp3`]!;
}

/** Fetches and decodes one clip. */
export type ClipLoader = (ctx: BaseAudioContext, id: string) => Promise<AudioBuffer>;

const fetchClip: ClipLoader = async (ctx, id) => ctx.decodeAudioData(await (await fetch(clipUrl(id))).arrayBuffer());

export class SpeechBank {
  private readonly buffers = new Map<string, AudioBuffer>();
  private readonly loading = new Map<string, Promise<AudioBuffer>>();

  constructor(
    private readonly ctx: BaseAudioContext,
    private readonly loader: ClipLoader = fetchClip,
  ) {}

  /** The decoded clip, or undefined while it is not loaded. */
  get(id: string): AudioBuffer | undefined {
    return this.buffers.get(id);
  }

  /** The clip, decoded. A clip that fails to load (the network) is forgotten, so the next request tries again. */
  load(id: string): Promise<AudioBuffer> {
    const ready = this.buffers.get(id);
    if (ready) return Promise.resolve(ready);
    let p = this.loading.get(id);
    if (!p) {
      p = this.loader(this.ctx, id).then(
        (b) => {
          this.buffers.set(id, b);
          this.loading.delete(id);
          return b;
        },
        (err: unknown) => {
          this.loading.delete(id);
          throw err;
        },
      );
      this.loading.set(id, p);
    }
    return p;
  }

  /** Starts loading `ids` without waiting; a clip that fails here loads again when it is played. */
  preload(ids: Iterable<string>): void {
    for (const id of ids) this.load(id).catch(() => undefined);
  }
}

export interface ClipPlay {
  ctx: BaseAudioContext;
  bank: SpeechBank;
  id: string;
  dest: AudioNode;
  /** Context time the clip starts: a start passed by the time it has loaded joins the clip where it would be. */
  at: number;
  level: number;
  /** Still wanted once loaded (default: always). */
  still?: () => boolean;
  tally?: NodeTally;
  /** The tally's kind (default 'voice'). */
  kind?: string;
}

/**
 * Plays a clip once it is loaded: into a gain of `level` into `dest`. Resolves to its source and gain, or null when it
 * was not played (no longer wanted, over by then, or it did not load). A music station plays a spoken ident with
 * `playClip({ ctx, bank, id: SPEECH.idents[name][i], dest: stationOut, at, level })`.
 */
export function playClip(p: ClipPlay): Promise<{ src: AudioBufferSourceNode; gain: GainNode } | null> {
  return p.bank.load(p.id).then(
    (buffer) => {
      const now = p.ctx.currentTime;
      const offset = Math.max(0, now - p.at);
      if ((p.still && !p.still()) || offset >= buffer.duration) return null;
      const src = p.ctx.createBufferSource();
      src.buffer = buffer;
      const gain = p.ctx.createGain();
      gain.gain.value = p.level;
      src.connect(gain);
      gain.connect(p.dest);
      p.tally?.track(p.kind ?? 'voice', src);
      src.start(Math.max(now, p.at), offset);
      return { src, gain };
    },
    () => null,
  );
}

/** Every clip short enough to be wanted at once: dialogue, dispatch phrases and barks. */
export function eagerClips(): string[] {
  return [...Object.values(SPEECH.dialogue), ...Object.values(SPEECH.dispatch), ...Object.values(SPEECH.barks).flat(2)];
}

/** The longest dispatch phrase, in words. */
const LONGEST = Math.max(1, ...Object.keys(SPEECH.dispatch).map((k) => k.split(' ').length));

/**
 * The dispatch clips that say `text`, longest phrase first at every word; a word no phrase starts with is skipped.
 * "All units, a carjacking reported in Midtown. Suspect on foot." is four clips.
 */
export function dispatchClips(text: string): string[] {
  const words = phraseWords(text);
  const out: string[] = [];
  for (let i = 0; i < words.length; ) {
    let n = Math.min(LONGEST, words.length - i);
    for (; n > 0; n--) {
      const id = SPEECH.dispatch[words.slice(i, i + n).join(' ')];
      if (id) {
        out.push(id);
        break;
      }
    }
    i += Math.max(1, n);
  }
  return out;
}
