// What the multiplayer rules send besides snapshots: the room's state (players with their kills and deaths, the
// head-to-head race and its results) and the kill feed, as events in the protocol's generic form, plus the 'race'
// command clients send. Shared by server and client; pure TypeScript.

import type { RaceStage, RacerStatus } from '../sim/headToHead';
import type { StreetRunMedal } from '../sim/streetRuns';

/** Event types (generic events: no schema in the protocol, so no version bump). */
export const ROOM_EVENT = 'mpRoom';
export const FEED_EVENT = 'mpFeed';
/** Client command for the head-to-head Street Run; its argument is a RaceCommand as JSON. */
export const RACE_COMMAND = 'race';

/** Seconds a race stays open for others to join once a player opens it. */
export const RACE_JOIN_WINDOW = 20;
/** Metres from a course's start gate within which the job key (T) opens or joins its race. */
export const RACE_START_REACH = 14;

export interface RaceCommand {
  action: 'open' | 'join' | 'leave' | 'start';
  course?: string;
}

export interface RoomPlayer {
  playerId: number;
  name: string;
  slot: number;
  kills: number;
  deaths: number;
  /** Damage this player did to other players' cars. */
  carDamage: number;
}

export interface RaceEntrant {
  playerId: number;
  name: string;
  status: RacerStatus;
  gate: number;
  /** Finishing position (1-based), 0 for anyone who did not finish. */
  position: number;
  time: number | null;
  finishTick: number | null;
  medal: StreetRunMedal | null;
  reason: string;
}

export interface RaceView {
  courseId: string;
  courseName: string;
  hostId: number;
  hostName: string;
  stage: RaceStage;
  /** Server tick the entries close (lobby), GO, and the end of the race (-1 until known). */
  closeTick: number;
  goTick: number;
  endTick: number;
  gates: number;
  medals: { gold: number; silver: number; bronze: number };
  entrants: RaceEntrant[];
}

export interface RoomState {
  /** Bumped on every change. */
  version: number;
  tick: number;
  tickRate: number;
  players: RoomPlayer[];
  race: RaceView | null;
}

export interface FeedEntry {
  kind: 'kill' | 'death' | 'busted' | 'wreck' | 'join' | 'leave' | 'race';
  text: string;
  killerId?: number;
  victimId?: number;
  killer?: string;
  victim?: string;
  weapon?: string;
}

/** A css colour from a packed 0xRRGGBB. */
export function cssColor(c: number): string {
  return '#' + (c >>> 0).toString(16).padStart(6, '0').slice(-6);
}
