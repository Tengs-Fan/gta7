// The mission dialogue, read from the mission scripts: every `m.say(SPEAKER, …)` and every `[SPEAKER, …]` line of an
// `m.intro([…])`, where SPEAKER is a string constant of the file. Both branches of a `cond ? 'a' : 'b'` count; a
// template literal is evaluated against the generated city (its ${…} may use `sim`, `spots` and the file's exported
// constants). The phone's offer lines come from offerLine and the mission table, and the taxi's fares' lines from their
// table (src/sim/activities/fares.ts).

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FARES } from '../../../src/sim/activities/fares';
import { STORY } from '../../../src/sim/missions';
import { BUSY_LINE, CONTACTS, contactById, offerLine } from '../../../src/sim/missions/contacts';
import { chapter2Spots, missionSpots } from '../../../src/sim/missions/spots';
import * as vera from '../../../src/sim/missions/vera';
import { StaticWorld } from '../../../src/world/staticWorld';
import { zoneNames } from './phrases';

export interface DialogueLine {
  speaker: string;
  text: string;
}

const MISSION_DIR = new URL('../../../src/sim/missions/', import.meta.url).pathname;

/** What a template literal of each file may refer to besides `sim`. */
const SCOPES: Readonly<Record<string, (world: StaticWorld) => Record<string, unknown>>> = {
  'vera.ts': (world) => ({ spots: chapter2Spots(world), ...vera }),
};

/** Index just past the expression starting at `i` that ends at depth 0 on `close`; string and template aware. */
function expressionEnd(src: string, i: number, close: string): number {
  let depth = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === "'" || c === '"' || c === '`') {
      i = stringEnd(src, i);
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) {
        if (c !== close) throw new Error(`Unbalanced ${c} at ${i}`);
        return i;
      }
      depth--;
    } else if (c === ',' && depth === 0) return i;
    i++;
  }
  throw new Error('Unterminated expression');
}

/** Index just past the string literal (quote or template) opening at `i`. */
function stringEnd(src: string, i: number): number {
  const q = src[i]!;
  i++;
  while (src[i] !== q) {
    if (src[i] === '\\') i++;
    else if (q === '`' && src[i] === '$' && src[i + 1] === '{') i = expressionEnd(src, i + 2, '}');
    i++;
  }
  return i + 1;
}

/** The string literals of an expression, templates evaluated in `scope`. */
function literals(expr: string, scope: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (let i = 0; i < expr.length; ) {
    const c = expr[i]!;
    if (c !== "'" && c !== '"' && c !== '`') {
      i++;
      continue;
    }
    const end = stringEnd(expr, i);
    const raw = expr.slice(i, end);
    const names = Object.keys(scope);
    out.push(new Function(...names, `return ${raw};`)(...names.map((n) => scope[n])) as string);
    i = end;
  }
  return out;
}

/** The lines one mission file can say. */
export function fileLines(file: string, source: string, world: StaticWorld): DialogueLine[] {
  const speakers = new Map<string, string>();
  for (const m of source.matchAll(/^const ([A-Z][A-Z0-9_]*) = '([^']+)';$/gm)) speakers.set(m[1]!, m[2]!);
  const scope = { Math, sim: { world }, spots: missionSpots(world), ...SCOPES[file]?.(world) };
  const lines: DialogueLine[] = [];
  for (const m of source.matchAll(/(\.say\(|\[)\s*([A-Z][A-Z0-9_]*),\s*/g)) {
    const speaker = speakers.get(m[2]!);
    if (!speaker) continue;
    const start = m.index + m[0].length;
    const expr = source.slice(start, expressionEnd(source, start, m[1] === '[' ? ']' : ')'));
    for (const text of literals(expr, scope)) lines.push({ speaker, text });
  }
  return lines;
}

/** Every line of mission dialogue, every phone line and every line of a taxi's fare, speakers without the " (phone)" of a call. */
export function dialogueLines(world = new StaticWorld()): DialogueLine[] {
  const lines: DialogueLine[] = [];
  for (const file of readdirSync(MISSION_DIR).sort()) {
    if (!file.endsWith('.ts')) continue;
    lines.push(...fileLines(file, readFileSync(join(MISSION_DIR, file), 'utf8'), world));
  }
  for (const c of CONTACTS) {
    lines.push({ speaker: c.name, text: BUSY_LINE }, { speaker: c.name, text: offerLine(c, undefined) });
  }
  for (const def of STORY) lines.push({ speaker: contactById(def.giver).name, text: offerLine(contactById(def.giver), def) });
  // What the taxi's fares say (activities/fares.ts): where to, for every place a trip can end in, and their goodbyes.
  for (const f of FARES) {
    for (const place of zoneNames(world)) lines.push({ speaker: f.speaker, text: f.ask(place) });
    lines.push({ speaker: f.speaker, text: f.paid }, { speaker: f.speaker, text: f.late });
  }
  const seen = new Set<string>();
  return lines
    .map((l) => ({ speaker: l.speaker.replace(/ \(phone\)$/, ''), text: l.text }))
    .filter((l) => {
      const key = `${l.speaker}|${l.text}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}
