// Key bindings: the keyboard actions the player can move to other keys. Bindings are physical keys
// (KeyboardEvent.code). The game reads every action by its default key (Input.poll, the sim's 'Press E' texts):
// Keymap turns a pressed key into the default key of the action bound to it, and a default key into the key that
// now does its action, for labels.

export interface ActionDef {
  id: string;
  label: string;
  /** Its key out of the box (US QWERTY position). */
  key: string;
}

/** The rebindable actions, in the order SETTINGS lists them. */
export const ACTIONS = [
  { id: 'forward', label: 'Move forward', key: 'KeyW' },
  { id: 'back', label: 'Move back', key: 'KeyS' },
  { id: 'left', label: 'Move left', key: 'KeyA' },
  { id: 'right', label: 'Move right', key: 'KeyD' },
  { id: 'sprint', label: 'Sprint', key: 'ShiftLeft' },
  { id: 'jump', label: 'Jump / handbrake', key: 'Space' },
  { id: 'enterExit', label: 'Enter / exit vehicle', key: 'KeyF' },
  { id: 'interact', label: 'Interact / skip line', key: 'KeyE' },
  { id: 'horn', label: 'Horn', key: 'KeyH' },
  { id: 'reload', label: 'Reload / next station', key: 'KeyR' },
  { id: 'prevWeapon', label: 'Previous weapon / station', key: 'KeyQ' },
  { id: 'job', label: 'Side job', key: 'KeyT' },
  { id: 'phone', label: 'Phone', key: 'Tab' },
  { id: 'map', label: 'Map', key: 'KeyM' },
  { id: 'camera', label: 'Camera distance', key: 'KeyV' },
  { id: 'pause', label: 'Pause', key: 'KeyP' },
] as const satisfies readonly ActionDef[];

export type ActionId = (typeof ACTIONS)[number]['id'];
export type KeyBindings = Record<ActionId, string>;

export const DEFAULT_BINDINGS: KeyBindings = Object.fromEntries(ACTIONS.map((a) => [a.id, a.key])) as KeyBindings;

/**
 * Keys that keep their own job and cannot take an action: the arrow keys (they move and steer like W A S D, and pick
 * menu rows), Escape, Enter, Backspace, right Shift (sprint, like left Shift), the number row (weapons) and the map's
 * zoom keys.
 */
export const RESERVED: Readonly<Record<string, string>> = {
  ArrowUp: 'moving and menus', ArrowDown: 'moving and menus', ArrowLeft: 'moving and menus', ArrowRight: 'moving and menus',
  Escape: 'pause and back', Enter: 'enter / exit and confirm', Backspace: 'back', ShiftRight: 'sprint',
  Equal: 'map zoom', Minus: 'map zoom', NumpadAdd: 'map zoom', NumpadSubtract: 'map zoom',
  ...Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`Digit${i}`, 'weapon slots'])),
};

/** Keys an action can be bound to. */
const BINDABLE = /^(Key[A-Z]|Space|Tab|ShiftLeft|ControlLeft|ControlRight|AltLeft|AltRight|CapsLock|Backquote|BracketLeft|BracketRight|Backslash|IntlBackslash|Semicolon|Quote|Comma|Period|Slash|Numpad[0-9]|NumpadDecimal|NumpadMultiply|NumpadDivide|NumpadEnter|Insert|Delete|Home|End|PageUp|PageDown)$/;

export function isBindable(code: unknown): code is string {
  return typeof code === 'string' && BINDABLE.test(code);
}

export function actionLabel(id: ActionId): string {
  return ACTIONS.find((a) => a.id === id)!.label;
}

/**
 * Stored bindings, checked: an unknown action is dropped, an action whose key is missing or not bindable (a typo, a
 * reserved key) keeps its default, and if that leaves two actions on one key (a hand-edited file) every binding goes
 * back to its default.
 */
export function parseBindings(raw: unknown): KeyBindings {
  const out: KeyBindings = { ...DEFAULT_BINDINGS };
  if (!raw || typeof raw !== 'object') return out;
  const r = raw as Record<string, unknown>;
  for (const a of ACTIONS) if (isBindable(r[a.id])) out[a.id] = r[a.id] as string;
  return new Set(Object.values(out)).size === ACTIONS.length ? out : { ...DEFAULT_BINDINGS };
}

export type RebindResult = { ok: true; bindings: KeyBindings } | { ok: false; reserved?: string; taken?: ActionId };

/**
 * Binds `code` to `action`. A key another action has is refused, naming that action (never swapped: the player
 * moves that one first), as is a reserved key.
 */
export function rebind(b: KeyBindings, action: ActionId, code: string): RebindResult {
  if (b[action] === code) return { ok: true, bindings: b };
  const reserved = RESERVED[code];
  if (reserved) return { ok: false, reserved };
  if (!isBindable(code)) return { ok: false, reserved: 'the browser' };
  const taken = ACTIONS.find((a) => a.id !== action && b[a.id] === code);
  if (taken) return { ok: false, taken: taken.id };
  return { ok: true, bindings: { ...b, [action]: code } };
}

/** The live bindings, with lookups both ways (see the file comment). */
export class Keymap {
  private b: KeyBindings = { ...DEFAULT_BINDINGS };
  private byCode = new Map<string, ActionId>();
  private byDefault = new Map<string, ActionId>(ACTIONS.map((a) => [a.key, a.id]));

  constructor() {
    this.set(DEFAULT_BINDINGS);
  }

  get bindings(): KeyBindings {
    return this.b;
  }

  /** Counts set() calls that changed something: text drawn with key names redraws when it moves on. */
  version = 0;

  set(b: KeyBindings): void {
    if (ACTIONS.every((a) => this.b[a.id] === b[a.id]) && this.byCode.size > 0) return;
    this.version++;
    this.b = { ...b };
    this.byCode = new Map(ACTIONS.map((a) => [this.b[a.id], a.id]));
  }

  /** Whether every action is on its default key. */
  get isDefault(): boolean {
    return ACTIONS.every((a) => this.b[a.id] === a.key);
  }

  /**
   * The code the game reads for a press of physical key `code`: the default key of the action bound to it, the key
   * itself where it is reserved or no action's default, else null (an action's default key that now does nothing).
   */
  virtual(code: string): string | null {
    const a = this.byCode.get(code);
    if (a) return ACTIONS.find((x) => x.id === a)!.key;
    return this.byDefault.has(code) ? null : code;
  }

  /** The key now doing the action whose default key is `code` (`code` itself when it is no action's default). */
  current(code: string): string {
    const a = this.byDefault.get(code);
    return a ? this.b[a] : code;
  }

  /** Whether an action is bound to physical key `code`. */
  hasAction(code: string): boolean {
    return this.byCode.has(code);
  }

  /** Whether physical key `code` does something: an action, or a reserved job. */
  isBound(code: string): boolean {
    return this.byCode.has(code) || code in RESERVED;
  }

  /** Whether the action whose default key is `code` is still on it. */
  atDefault(code: string): boolean {
    const a = this.byDefault.get(code);
    return !a || this.b[a] === code;
  }
}
