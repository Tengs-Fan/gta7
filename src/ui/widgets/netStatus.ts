// The multiplayer connection screens over the game: "connecting", "could not join" (the reason, TRY AGAIN, BACK TO
// TITLE), "connection lost" (RECONNECT, RETURN TO TITLE), and a banner while the player only watches.

import './netStatus.css';
import type { UiActions } from '../../input/input';

export interface NetStatusAction {
  id: string;
  label: string;
  run: () => void;
}

export class NetStatus {
  private el: HTMLElement | null = null;
  private banner: HTMLElement | null = null;
  private buttons: HTMLButtonElement[] = [];
  private sel = 0;

  constructor(private readonly ui: HTMLElement) {}

  /** A screen is up (it takes the menu keys). */
  get open(): boolean {
    return this.el !== null;
  }

  /** The screen's kind ('connecting', 'failed', 'lost'), or null. */
  get kind(): string | null {
    return this.el?.dataset.kind ?? null;
  }

  show(kind: 'connecting' | 'failed' | 'lost', title: string, text: string, detail: string, actions: NetStatusAction[]): void {
    this.hide();
    const el = document.createElement('div');
    el.className = `net-status ${kind}`;
    el.dataset.kind = kind;
    const box = document.createElement('div');
    box.className = 'net-box';
    const h = document.createElement('h2');
    h.textContent = title;
    const p = document.createElement('p');
    p.className = 'net-text';
    p.textContent = text;
    box.append(h, p);
    if (detail) {
      const d = document.createElement('p');
      d.className = 'net-detail';
      d.textContent = detail;
      box.append(d);
    }
    const row = document.createElement('div');
    row.className = 'net-buttons';
    this.buttons = actions.map((a, i) => {
      const b = document.createElement('button');
      b.className = i === 0 ? 'btn primary' : 'btn';
      b.dataset.id = a.id;
      b.textContent = a.label;
      b.addEventListener('click', () => a.run());
      row.append(b);
      return b;
    });
    if (this.buttons.length) box.append(row);
    el.append(box);
    this.ui.append(el);
    this.el = el;
    // No native focus: Enter reaches the screen through input() (as it reaches the menus), not as a second click.
    this.select(0);
  }

  hide(): void {
    this.el?.remove();
    this.el = null;
    this.buttons = [];
  }

  setBanner(text: string | null): void {
    if (!text) {
      this.banner?.remove();
      this.banner = null;
      return;
    }
    if (!this.banner) {
      this.banner = document.createElement('div');
      this.banner.className = 'net-banner';
      this.ui.append(this.banner);
    }
    if (this.banner.textContent !== text) this.banner.textContent = text;
  }

  /** Keyboard and pad on the screen: left/right/up/down pick a button, confirm presses it. */
  input(ui: UiActions): void {
    if (!this.buttons.length) return;
    const n = this.buttons.length;
    if (ui.left || ui.up) this.select((this.sel + n - 1) % n);
    if (ui.right || ui.down) this.select((this.sel + 1) % n);
    if (ui.confirm) this.buttons[this.sel]?.click();
  }

  private select(i: number): void {
    this.sel = i;
    this.buttons.forEach((b, k) => b.classList.toggle('sel', k === i));
  }
}
