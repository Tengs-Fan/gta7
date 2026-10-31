// The index of the recorded speech (src/assets/speech/speech.json, written by `npm run speech`): how long each clip is
// and which clip says what. The sim reads it to keep a line of dialogue up for as long as it is spoken; audio/ plays the
// clips.

import index from '../assets/speech/speech.json';

/** A talk piece's kind: a serial's chapters air in order. */
export type TalkKind = 'host' | 'call' | 'news' | 'ad' | 'ident' | 'serial';
/** The talk shows: AZURA TALK's, THE BOWL's, SAPR's and STATIC's. */
export type ShowId = 'azura' | 'bowl' | 'sapr' | 'static';
export type BarkKind =
  | 'greet' | 'hurt' | 'jacked' | 'panic' | 'rammed' | 'witness' | 'freeze' | 'shots' | 'officerDown' | 'pullOver' | 'arrest' | 'turf'
  // People waving down a taxi the player drives, and a cabbie pulled out of his cab.
  | 'hail' | 'hailMissed' | 'cabbie'
  // Hollister Farm's owner, and the voice by the Bramble family crypt at three in the morning.
  | 'farmer' | 'farmerAngry' | 'whisper'
  // The Marina hand calling the Gull Regatta's boat up on its radio.
  | 'marina';
/**
 * What a music station's DJ says over a song's intro: an ident, a hit's announce ('front') or back-announce ('back'),
 * banter, or a line for the night, the rain, a chase or a chase got away from.
 */
export type LinkKind = 'ident' | 'front' | 'back' | 'banter' | 'night' | 'rain' | 'chase' | 'gotAway';

export interface SpeechIndex {
  /** Seconds of each clip, by id (the file is `<id>.mp3`). */
  clips: Record<string, number>;
  /** The clip of a line of dialogue, by dialogueKey. */
  dialogue: Record<string, string>;
  /** The clip of a police dispatch phrase, by its words (see phraseWords) joined with single spaces. */
  dispatch: Record<string, string>;
  /** Each talk show's pieces of each kind. A campaign is in the ad pools as its first part. */
  talk: Record<ShowId, Record<TalkKind, string[]>>;
  /** An ad campaign's parts in order, by its first part. */
  adSeries: Record<string, string[]>;
  /** Shouts of each kind: one list of clips per voice. */
  barks: Record<BarkKind, string[][]>;
  /** Spoken idents of the music stations, by station name. */
  idents: Record<string, string[]>;
  /** The music stations' DJ links of each kind (banter, night, rain, chase, gotAway), by station name. */
  dj: Record<string, Partial<Record<LinkKind, string[]>>>;
  /** The announce and back-announce of each of a music station's hits (stations/playlists.ts HITS, in order). */
  tracks: Record<string, Array<{ front: string; back: string }>>;
  /** The clip of each sentence the Azura Newsdesk can read (src/audio/newsText.ts), by its text. */
  news: Record<string, string>;
  /** The newsdesk's pieces about each mission, by mission id: when it is passed, and a day later. */
  missionNews: Record<string, { breaking: string; followUp?: string }>;
  /** AzuraLink's station announcements, by the departing train's destination. */
  pa: Record<string, string[]>;
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
