// The index of the recorded speech (src/assets/speech/speech.json, written by `npm run speech`): how long each clip is
// and which clip says what. The sim reads it to keep a line of dialogue up for as long as it is spoken; audio/ plays the
// clips.

import index from '../assets/speech/speech.json';

export type TalkKind = 'host' | 'call' | 'news' | 'ad' | 'ident';
export type BarkKind = 'greet' | 'hurt' | 'jacked' | 'panic' | 'rammed' | 'witness' | 'freeze' | 'shots' | 'officerDown' | 'pullOver' | 'arrest' | 'turf' | 'hail' | 'hailMissed' | 'cabbie';

export interface SpeechIndex {
  /** Seconds of each clip, by id (the file is `<id>.mp3`). */
  clips: Record<string, number>;
  /** The clip of a line of dialogue, by dialogueKey. */
  dialogue: Record<string, string>;
  /** The clip of a police dispatch phrase, by its words (see phraseWords) joined with single spaces. */
  dispatch: Record<string, string>;
  /** The talk station's pieces of each kind. */
  talk: Record<TalkKind, string[]>;
  /** Shouts of each kind: one list of clips per voice. */
  barks: Record<BarkKind, string[][]>;
  /** Spoken idents of the music stations, by station name. */
  idents: Record<string, string[]>;
}

export const SPEECH = index as SpeechIndex;

/** A spoken line stays up this long after its clip ends. */
export const LINE_TAIL = 0.4;

/** The dialogue index's key of a line: a call's speaker is the contact ("Mama Lou (phone)" speaks as "Mama Lou"). */
export function dialogueKey(speaker: string, text: string): string {
  return `${speaker.replace(/ \(phone\)$/, '')}|${text}`;
}

/**
 * Seconds a line of dialogue stays up: as long as its clip plus LINE_TAIL, or, for a line nobody recorded (a mission
 * registered by a mod), by its length.
 */
export function lineSeconds(speaker: string, text: string): number {
  const id = SPEECH.dialogue[dialogueKey(speaker, text)];
  return id ? SPEECH.clips[id]! + LINE_TAIL : Math.min(6, 1.6 + text.length * 0.055);
}

/** The words of a phrase as the dispatch index keys them: lower case, punctuation dropped. */
export function phraseWords(text: string): string[] {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
}
