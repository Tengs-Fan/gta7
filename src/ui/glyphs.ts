// Key glyphs for HUD text. The sim names keys after their QWERTY bindings, in three literal
// forms only: 'Press E', '<kbd>E</kbd>' and '(E)'. formatKeys() turns those into keycaps named
// as printed on the player's keyboard, or into gamepad buttons once the last input came from a
// pad. Nothing else is touched: '(S on the radar)' or 'Expressway' stay as they are.

import type { KeyLabels } from '../input/input';

export type InputDevice = 'kb' | 'pad';

export interface GlyphContext {
  /** On-screen key names for the player's layout; QWERTY names without it. */
  labels?: KeyLabels;
  /** A few keys do something else in a vehicle (R: reload on foot, next station in a car). */
  inVehicle?: boolean;
}

export type PadButton = 'a' | 'b' | 'x' | 'y' | 'lb' | 'rb' | 'lt' | 'rt' | 'back' | 'start' | 'l3' | 'r3' | 'up' | 'down' | 'left' | 'right';

/** Each key's gamepad button on foot and in a vehicle, as Input.poll() binds them (standard mapping). */
const PAD: Record<string, [onFoot: PadButton, inVehicle: PadButton]> = {
  E: ['up', 'up'], // interact
  F: ['y', 'y'], // enter / exit
  T: ['down', 'down'], // taxi / vigilante job
  R: ['b', 'right'], // reload / next radio station
  Q: ['lb', 'left'], // previous weapon / previous station
  H: ['l3', 'l3'], // horn
  M: ['back', 'back'], // map
  V: ['r3', 'r3'], // camera distance
  P: ['start', 'start'], // pause
  Esc: ['start', 'start'],
  Tab: ['right', 'right'], // phone (on foot)
  Space: ['x', 'rb'], // jump / handbrake
  Shift: ['a', 'a'], // sprint
  LMB: ['rt', 'x'], // shoot (drive-by in a vehicle, where RT is the throttle)
  RMB: ['lt', 'lt'], // aim
};

const PAD_TEXT: Partial<Record<PadButton, string>> = { a: 'A', b: 'B', x: 'X', y: 'Y', lb: 'LB', rb: 'RB', lt: 'LT', rt: 'RT', back: 'Back', start: 'Start', l3: 'L3', r3: 'R3' };

/** The four arms of a D-pad cross (24 x 24 view box). */
const DPAD_ARM: Partial<Record<PadButton, string>> = { up: 'M9 2h6v7H9z', down: 'M9 15h6v7H9z', left: 'M2 9h7v6H2z', right: 'M15 9h7v6h-7z' };
const DPAD_CROSS = 'M9 2h6v7h7v6h-7v7H9v-7H2V9h7z';

/** Keys named in full rather than by a letter. */
const NAMED = ['Esc', 'Space', 'Shift', 'Enter', 'Tab'];
/** The keys a named mention stands for that can be rebound (Esc and Enter cannot). */
const NAMED_CODES: Record<string, string> = { Space: 'Space', Shift: 'ShiftLeft', Tab: 'Tab' };
/** Keys that '(X)' may name: the bound shortcuts only, so '(A)' in prose stays prose. */
const PAREN = ['E', 'F', 'T', 'R', 'Q', 'H', 'M', 'V', 'P', 'Esc', 'Space', 'Shift', 'Tab'];

const KEY = `([A-Z]|${NAMED.join('|')})`;
// One pass over all four forms, so a keycap written for one key is never read again as another
// (on Colemak the F binding is printed T, and the T binding G).
const PATTERN = new RegExp(`<kbd>${KEY}</kbd>|\\b([Pp]ress) ${KEY}\\b|\\((${PAREN.join('|')})\\)|\\b([Ll]eft|[Rr]ight)[- ]click\\b`, 'g');

function escapeText(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** A gamepad button glyph: the face buttons in their usual colours, a drawn cross for the D-pad. */
export function padGlyph(b: PadButton): string {
  const arm = DPAD_ARM[b];
  if (arm) return `<kbd class="pad dpad" aria-label="D-pad ${b}"><svg viewBox="0 0 24 24" aria-hidden="true"><path class="dpad-base" d="${DPAD_CROSS}"/><path class="dpad-on" d="${arm}"/></svg></kbd>`;
  return `<kbd class="pad pad-${b}">${PAD_TEXT[b]}</kbd>`;
}

function keyGlyph(key: string, device: InputDevice, ctx: GlyphContext): string {
  const pad = device === 'pad' ? PAD[key] : undefined;
  if (pad) return padGlyph(pad[ctx.inVehicle ? 1 : 0]);
  // Keys without a pad button (W A S D, digits...) keep their keycap on a pad too.
  const code = key.length === 1 ? `Key${key}` : NAMED_CODES[key];
  const label = code ? (ctx.labels?.label(code) ?? key) : key;
  return `<kbd>${escapeText(label)}</kbd>`;
}

/**
 * Converts the key mentions in HUD text (already HTML) into glyphs for the active device. Call it
 * once, on text that still names the QWERTY bindings: its output must not be converted again.
 */
export function formatKeys(html: string, device: InputDevice, ctx: GlyphContext = {}): string {
  return html.replace(PATTERN, (m, kbd?: string, press?: string, pressed?: string, paren?: string, side?: string) => {
    if (kbd) return keyGlyph(kbd, device, ctx);
    if (press && pressed) return `${press} ${keyGlyph(pressed, device, ctx)}`;
    if (paren) return keyGlyph(paren, device, ctx);
    // Mouse buttons read fine as words on a keyboard; a pad player needs the trigger instead.
    if (side && device === 'pad') return keyGlyph(/^l/i.test(side) ? 'LMB' : 'RMB', device, ctx);
    return m;
  });
}
