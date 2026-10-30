// A small fake DOM, window and localStorage for driving the HUD, the menus and Game in Node (as in
// r2_fix3_menus.test.ts). Call installPage() in a beforeEach and vi.unstubAllGlobals() in an afterEach.

import { vi } from 'vitest';
import type { UiActions } from '../../src/input/input';

class FakeClassList {
  private readonly set = new Set<string>();
  add(...cs: string[]): void {
    for (const c of cs) this.set.add(c);
  }
  remove(...cs: string[]): void {
    for (const c of cs) this.set.delete(c);
  }
  toggle(c: string, force?: boolean): boolean {
    const on = force ?? !this.set.has(c);
    if (on) this.set.add(c);
    else this.set.delete(c);
    return on;
  }
  contains(c: string): boolean {
    return this.set.has(c);
  }
  get value(): string {
    return [...this.set].join(' ');
  }
  set value(v: string) {
    this.set.clear();
    for (const c of v.split(/\s+/)) if (c) this.set.add(c);
  }
}

/** A 2D context that accepts any drawing call. */
const ctx2d: unknown = new Proxy({} as Record<string | symbol, unknown>, {
  get: (t, k) => (k in t ? t[k] : () => ({ addColorStop: () => undefined, width: 0 })),
  set: (t, k, v) => {
    t[k] = v;
    return true;
  },
});

/** A WebGL 2 context for the GPU probe: every extension present, an unnamed GPU. */
const gl2: unknown = { RENDERER: 0x1f01, getExtension: () => ({ loseContext: () => undefined }), getParameter: () => '' };

const VOID_TAGS = new Set(['br', 'hr', 'img', 'input', 'meta']);

export class FakeElement extends EventTarget {
  readonly tagName: string;
  children: FakeElement[] = [];
  parent: FakeElement | null = null;
  readonly classList = new FakeClassList();
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, unknown> = { setProperty: () => undefined };
  readonly attrs: Record<string, string> = {};
  disabled = false;
  checked = false;
  value = '';
  width = 300;
  height = 150;
  clientWidth = 0;
  clientHeight = 0;
  scrollHeight = 0;
  scrollTop = 0;
  tabIndex = 0;
  /** How many times scrollIntoView() brought this element into view. */
  scrolledIntoView = 0;
  private text = '';
  private html = '';

  constructor(tag: string) {
    super();
    this.tagName = tag.toUpperCase();
  }
  get className(): string {
    return this.classList.value;
  }
  set className(v: string) {
    this.classList.value = v;
  }
  get textContent(): string {
    return this.text || this.children.map((c) => c.textContent).join('');
  }
  set textContent(v: string) {
    this.text = v;
    this.html = '';
    this.children = [];
  }
  get innerHTML(): string {
    return this.html;
  }
  set innerHTML(v: string) {
    this.html = v;
    this.text = v.replace(/<[^>]*>/g, '');
    this.children = [];
    parseInto(this, v);
  }
  appendChild<T extends FakeElement>(c: T): T {
    c.remove();
    c.parent = this;
    this.children.push(c);
    return c;
  }
  append(...cs: FakeElement[]): void {
    for (const c of cs) this.appendChild(c);
  }
  remove(): void {
    const p = this.parent;
    if (!p) return;
    const i = p.children.indexOf(this);
    if (i >= 0) p.children.splice(i, 1);
    this.parent = null;
  }
  /** All descendants, depth first. */
  all(): FakeElement[] {
    return this.children.flatMap((c) => [c, ...c.all()]);
  }
  querySelectorAll(sel: string): FakeElement[] {
    return this.all().filter((e) => (sel === '[data-el]' ? 'el' in e.dataset : e.tagName === sel.toUpperCase()));
  }
  getContext(kind?: string): unknown {
    return kind === 'webgl2' ? gl2 : ctx2d;
  }
  getBoundingClientRect(): { left: number; top: number; width: number; height: number } {
    return { left: 0, top: 0, width: this.width, height: this.height };
  }
  click(): void {
    if (!this.disabled) this.dispatchEvent(new Event('click'));
  }
  focus(): void {}
  scrollBy(opts: { top?: number }): void {
    this.scrollTop = Math.max(0, Math.min(this.scrollHeight - this.clientHeight, this.scrollTop + (opts.top ?? 0)));
  }
  scrollIntoView(): void {
    this.scrolledIntoView++;
  }
  setPointerCapture(): void {}
  requestPointerLock(): unknown {
    return undefined;
  }
}

/** Builds child elements (tags and attributes only) for the markup the UI writes via innerHTML. */
function parseInto(root: FakeElement, html: string): void {
  const stack = [root];
  for (const [, close, tag, attrs, selfClose] of html.matchAll(/<(\/?)([a-zA-Z][\w-]*)([^>]*?)(\/?)>/g)) {
    if (close) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const el = new FakeElement(tag!.toLowerCase());
    for (const [, k, v] of attrs!.matchAll(/([\w-]+)="([^"]*)"/g)) {
      if (k === 'class') el.className = v!;
      else if (k!.startsWith('data-')) el.dataset[k!.slice(5)] = v!;
      else if (k === 'width' || k === 'height') el[k] = Number(v);
      else el.attrs[k!] = v!;
    }
    stack[stack.length - 1]!.appendChild(el);
    if (!selfClose && !VOID_TAGS.has(tag!.toLowerCase())) stack.push(el);
  }
}

class FakeDocument extends EventTarget {
  pointerLockElement: FakeElement | null = null;
  hidden = false;
  createElement(tag: string): FakeElement {
    return new FakeElement(tag);
  }
  exitPointerLock(): void {
    this.pointerLockElement = null;
  }
}

/** localStorage with a quota on the characters of keys and values; `readOnly` makes every write fail as a full store. */
export class QuotaStorage {
  private readonly m = new Map<string, string>();
  readOnly = false;
  constructor(private readonly capacity = Infinity) {}
  get used(): number {
    let n = 0;
    for (const [k, v] of this.m) n += k.length + v.length;
    return n;
  }
  get keys(): string[] {
    return [...this.m.keys()].sort();
  }
  getItem(k: string): string | null {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    const value = String(v);
    const old = this.m.get(k);
    const next = this.used - (old === undefined ? 0 : k.length + old.length) + k.length + value.length;
    if (this.readOnly || next > this.capacity) throw new DOMException(`Setting the value of '${k}' exceeded the quota.`, 'QuotaExceededError');
    this.m.set(k, value);
  }
  removeItem(k: string): void {
    this.m.delete(k);
  }
  /** Fills the storage with other keys (another game on the same origin) until fewer than `left` characters are free. */
  fill(left: number): void {
    for (let i = 0; this.capacity - this.used >= left; i++) {
      const room = this.capacity - this.used - `other.${i}`.length;
      this.m.set(`other.${i}`, 'x'.repeat(Math.max(0, Math.min(5000, room - left + 1))));
    }
  }
  /** Removes what fill() added. */
  unfill(): void {
    for (const k of [...this.m.keys()]) if (k.startsWith('other.')) this.m.delete(k);
  }
}

/** Stubs document, window (with `storage` as its localStorage), navigator and requestAnimationFrame. */
export function installPage(storage: QuotaStorage = new QuotaStorage()): { storage: QuotaStorage } {
  const win = Object.assign(new EventTarget(), {
    innerWidth: 1280,
    innerHeight: 720,
    localStorage: storage,
    setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms),
    clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
  });
  vi.stubGlobal('document', new FakeDocument());
  vi.stubGlobal('window', win);
  vi.stubGlobal('navigator', { getGamepads: () => [] });
  vi.stubGlobal('requestAnimationFrame', () => 0);
  return { storage };
}

export const ui = (over: Partial<UiActions> = {}): UiActions => ({ pause: false, map: false, camera: false, radioNext: false, radioPrev: false, confirm: false, back: false, up: false, down: false, left: false, right: false, ...over });
