// The talk shows beyond AZURA TALK (whose pieces are script.ts TALK), one file each: their pieces, their ads and their
// idents. build.ts renders them with TALK.

import type { TalkPiece } from '../script';
import { BOWL } from './bowl';

export const SHOW_PIECES: readonly TalkPiece[] = [...BOWL];
