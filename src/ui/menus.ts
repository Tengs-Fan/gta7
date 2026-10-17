// Menu screens (title, pause, map, stats, controls, settings, shop, credits)
// managed as a stack. Keyboard, gamepad and mouse can all drive them.

import { clamp, formatMoney } from '../core/math';
import { KeyLabels, WHEEL_GESTURE_GAP, WHEEL_STEP, type UiActions } from '../input/input';
import type { Sim } from '../sim/sim';
import { shopItems } from '../sim/interactions';
import { PACKAGE_COUNT } from '../sim/pickups';
import type { Settings } from '../settings';
import { escapeHtml } from './hud';
import { collectBlips, drawBlip, MAP_SCALE, type Blip, type MapImage } from './mapRender';

export interface MenuHost {
  hasSave(): boolean;
  newGame(): void;
  continueGame(): void;
  resume(): void;
  quitToTitle(): void;
  abandonMission(): void;
  settings(): Settings;
  applySettings(s: Settings): void;
  deleteSave(): void;
  sim(): Sim | null;
  setWaypoint(p: { x: number; z: number } | null): void;
  waypoint(): { x: number; z: number } | null;
  click(): void;
}

interface Screen {
  el: HTMLElement;
  input(ui: UiActions): void;
  /** Called every frame while on top (for animated screens like the map). */
  tick?(dt: number): void;
  /** Called when the screen is on top again after the one above it closed. */
  refresh?(): void;
  close?(): void;
}

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', html = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html) e.innerHTML = html;
  return e;
}

/** A vertical list of buttons with keyboard / gamepad selection. */
class ButtonList {
  readonly el = h('div', 'menu');
  private buttons: HTMLButtonElement[] = [];
  private sel = 0;

  constructor(items: Array<{ label: string; action: () => void; disabled?: boolean; id?: string }>, private readonly click: () => void) {
    for (const it of items) {
      const b = h('button');
      b.textContent = it.label;
      b.disabled = !!it.disabled;
      if (it.id) b.dataset.id = it.id;
      b.addEventListener('click', () => {
        if (b.disabled) return;
        this.click();
        it.action();
      });
      b.addEventListener('mouseenter', () => this.select(this.buttons.indexOf(b)));
      this.el.appendChild(b);
      this.buttons.push(b);
    }
    this.sel = this.buttons.findIndex((b) => !b.disabled);
    this.select(this.sel);
  }

  private select(i: number): void {
    if (i < 0) return;
    this.sel = i;
    this.buttons.forEach((b, k) => b.classList.toggle('sel', k === i));
  }

  move(d: number): void {
    const n = this.buttons.length;
    for (let k = 1; k <= n; k++) {
      const i = (this.sel + d * k + n * 10) % n;
      if (!this.buttons[i]!.disabled) {
        this.select(i);
        return;
      }
    }
  }

  /** Enables or disables the button with this id, moving the selection off it if needed. */
  setDisabled(id: string, disabled: boolean): void {
    const b = this.buttons.find((x) => x.dataset.id === id);
    if (!b) return;
    b.disabled = disabled;
    if (this.buttons[this.sel]?.disabled) this.move(1);
  }

  input(ui: UiActions): void {
    if (ui.up) this.move(-1);
    if (ui.down) this.move(1);
    if (ui.confirm) this.buttons[this.sel]?.click();
  }
}

export class Menus {
  readonly root: HTMLDivElement;
  private stack: Screen[] = [];
  /** Seconds since the top screen appeared; input is ignored briefly so the
   *  key that opened a screen (or exited pointer lock) cannot also close it. */
  private age = 0;

  constructor(parent: HTMLElement, private readonly host: MenuHost, private readonly map: MapImage, private readonly keys = new KeyLabels()) {
    this.root = h('div');
    parent.appendChild(this.root);
  }

  get open(): boolean {
    return this.stack.length > 0;
  }

  get top(): Screen | null {
    return this.stack[this.stack.length - 1] ?? null;
  }

  private push(s: Screen): void {
    const prev = this.top;
    if (prev) prev.el.classList.add('hidden');
    this.stack.push(s);
    this.root.appendChild(s.el);
    this.age = 0;
  }

  pop(): void {
    const s = this.stack.pop();
    if (!s) return;
    s.close?.();
    s.el.remove();
    this.top?.el.classList.remove('hidden');
    this.top?.refresh?.();
    this.age = 0;
  }

  closeAll(): void {
    while (this.stack.length) this.pop();
  }

  input(ui: UiActions, dt: number): void {
    const s = this.top;
    if (!s) return;
    this.age += dt;
    s.tick?.(dt);
    if (this.age < 0.25) return;
    s.input(ui);
  }

  // ---------------------------------------------------------------------------

  /** Title menu; `notice` is an optional one-line message under the buttons. */
  showTitle(notice?: string): void {
    this.closeAll();
    const el = h('div', 'screen');
    el.appendChild(h('div', 'title-shade'));
    const wrap = h('div', 'title-wrap');
    wrap.appendChild(h('div', 'logo', '<span class="gta">GTA</span><span class="seven">7</span><span class="sub">GRAND TURBO ANARCHY</span><span class="tag">WELCOME TO SAN AZURA</span>'));
    const list = new ButtonList(
      [
        { label: 'CONTINUE', action: () => this.host.continueGame(), disabled: !this.host.hasSave(), id: 'continue' },
        { label: 'NEW GAME', action: () => this.host.newGame(), id: 'new' },
        { label: 'CONTROLS', action: () => this.showControls() },
        { label: 'SETTINGS', action: () => this.showSettings() },
        { label: 'CREDITS', action: () => this.showCredits() },
      ],
      () => this.host.click(),
    );
    if (notice) list.el.appendChild(h('div', 'title-note', escapeHtml(notice)));
    wrap.appendChild(list.el);
    wrap.appendChild(h('div', 'title-foot', 'A fan-made parody sandbox. Not affiliated with or endorsed by Rockstar Games or Take-Two Interactive. All city, character, vehicle and brand names are fictional. Best with keyboard + mouse or a gamepad.'));
    el.appendChild(wrap);
    this.push({
      el,
      input: (ui) => list.input(ui),
      // The save may have been deleted from SETTINGS meanwhile.
      refresh: () => list.setDisabled('continue', !this.host.hasSave()),
    });
  }

  showPause(): void {
    const sim = this.host.sim();
    const el = h('div', 'screen dim');
    const panel = h('div', 'panel');
    panel.style.width = 'min(520px, 92vw)';
    panel.appendChild(h('h2', '', 'PAUSED'));
    const items: Array<{ label: string; action: () => void }> = [
      { label: 'RESUME', action: () => this.host.resume() },
      { label: 'MAP', action: () => this.showMap() },
      { label: 'STATS', action: () => this.showStats() },
      { label: 'CONTROLS', action: () => this.showControls() },
      { label: 'SETTINGS', action: () => this.showSettings() },
    ];
    if (sim?.missions.active) items.push({ label: 'ABANDON MISSION', action: () => this.host.abandonMission() });
    items.push({ label: 'QUIT TO TITLE', action: () => this.confirm('Quit to the title screen? Unsaved progress will be lost.', () => this.host.quitToTitle()) });
    const list = new ButtonList(items, () => this.host.click());
    panel.appendChild(list.el);
    if (sim) {
      const m = sim.missions.active;
      panel.appendChild(h('p', '', m ? `Mission: <b>${escapeHtml(m.def.title)}</b> — ${escapeHtml(m.objectiveText || m.def.blurb)}` : `Zone: <b>${escapeHtml(sim.world.zoneName(sim.playerPos().x, sim.playerPos().z))}</b> · ${sim.clock.label()} · Day ${sim.clock.day}`));
    }
    el.appendChild(panel);
    this.push({ el, input: (ui) => (ui.back || ui.pause ? this.host.resume() : list.input(ui)) });
  }

  confirm(text: string, yes: () => void): void {
    const el = h('div', 'screen dim');
    const panel = h('div', 'panel');
    panel.style.width = 'min(520px, 92vw)';
    panel.appendChild(h('p', '', escapeHtml(text)));
    const list = new ButtonList(
      [
        { label: 'YES', action: () => { this.pop(); yes(); } },
        { label: 'NO', action: () => this.pop() },
      ],
      () => this.host.click(),
    );
    panel.appendChild(list.el);
    el.appendChild(panel);
    this.push({ el, input: (ui) => (ui.back ? this.pop() : list.input(ui)) });
  }

  showControls(): void {
    const el = h('div', 'screen dim');
    const panel = h('div', 'panel');
    // Named as printed on the player's keyboard: the bindings are positions, so AZERTY moves with Z Q S D.
    const k = (code: string) => this.keys.label(code);
    const kb: Array<[string, string]> = [
      ['Move / Drive', ['KeyW', 'KeyA', 'KeyS', 'KeyD'].map(k).join(' ')],
      ['Look / Aim', 'Mouse'],
      ['Sprint', 'Shift'],
      ['Jump / Handbrake', 'Space'],
      ['Shoot / Punch', 'Left click'],
      ['Aim', 'Right click'],
      ['Enter / Exit vehicle', k('KeyF')],
      ['Interact / Horn', k('KeyE')],
      ['Reload / Next radio', k('KeyR')],
      ['Weapons', `1-6, ${k('KeyQ')}, wheel`],
      ['Taxi / Vigilante job', k('KeyT')],
      ['Camera distance', k('KeyV')],
      ['Map', k('KeyM')],
      ['Pause', `Esc / ${k('KeyP')}`],
    ];
    const pad: Array<[string, string]> = [
      ['Move / Steer', 'Left stick'],
      ['Look', 'Right stick'],
      ['Accelerate / Shoot', 'RT'],
      ['Brake / Aim', 'LT'],
      ['Handbrake', 'RB / A'],
      ['Jump', 'X'],
      ['Sprint', 'A'],
      ['Enter / Exit', 'Y'],
      ['Reload', 'B'],
      ['Weapons', 'LB / RB'],
      ['Interact', 'D-pad up'],
      ['Radio', 'D-pad left/right'],
      ['Job', 'D-pad down'],
      ['Map / Pause', 'Back / Start'],
    ];
    const grid = (rows: Array<[string, string]>) => `<div class="keys">${rows.map(([a, b]) => `<div><span>${a}</span><span>${escapeHtml(b)}</span></div>`).join('')}</div>`;
    panel.innerHTML = `<h2>CONTROLS</h2><h3>Keyboard &amp; mouse</h3>${grid(kb)}<h3>Gamepad</h3>${grid(pad)}
      <h3>Tips</h3><p>Steal any car with <kbd>${escapeHtml(k('KeyF'))}</kbd>, even with someone inside. Lose the cops by breaking line of sight or by driving into a Spray Shack. Hidden packages, stunt ramps and rampages are scattered across San Azura. Drive a taxi or police car and press <kbd>${escapeHtml(k('KeyT'))}</kbd> for side jobs.</p>`;
    const row = h('div', 'row-end');
    const back = h('button', 'btn primary', 'BACK');
    back.style.pointerEvents = 'auto';
    back.addEventListener('click', () => this.pop());
    row.appendChild(back);
    panel.appendChild(row);
    el.appendChild(panel);
    this.push({ el, input: (ui) => (ui.back || ui.confirm ? this.pop() : undefined) });
  }

  showCredits(): void {
    const el = h('div', 'screen dim');
    const panel = h('div', 'panel credits-roll');
    panel.innerHTML = `<h2>CREDITS</h2>
      <p><b>GTA 7: Grand Turbo Anarchy</b><br>An original open-world sandbox built for the browser.</p>
      <p>Everything you see and hear is generated at runtime: the city, the cars, the people, the textures, the sound effects and the three radio stations.</p>
      <p>Built with three.js, TypeScript and Vite. Fonts: Anton &amp; Rajdhani (SIL Open Font License).</p>
      <p>All characters, places, vehicles and brands are fictional. Any resemblance to real persons or businesses is coincidental. This is a fan-made parody and is not affiliated with Rockstar Games or Take-Two Interactive.</p>`;
    const row = h('div', 'row-end');
    const back = h('button', 'btn primary', 'BACK');
    back.addEventListener('click', () => this.pop());
    row.appendChild(back);
    panel.appendChild(row);
    el.appendChild(panel);
    this.push({ el, input: (ui) => (ui.back || ui.confirm ? this.pop() : undefined) });
  }

  showStats(): void {
    const sim = this.host.sim();
    if (!sim) return;
    const s = sim.progress.stats;
    const p = sim.progress;
    const story = sim.missions.defs.length;
    const done = sim.missions.defs.filter((d) => p.hasDone(d.id)).length;
    const completion = Math.round(((done / story) * 0.5 + (p.packages.length / PACKAGE_COUNT) * 0.2 + (p.stunts.length / sim.world.layout.ramps.length) * 0.15 + (p.rampages.length / 3) * 0.15) * 100);
    const km = (m: number) => `${(m / 1000).toFixed(1)} km`;
    const time = `${Math.floor(s.playTime / 3600)}h ${Math.floor((s.playTime % 3600) / 60)}m`;
    const rows: Array<[string, string]> = [
      ['Game completion', `${completion}%`],
      ['Story missions', `${done} / ${story}`],
      ['Hidden packages', `${p.packages.length} / ${PACKAGE_COUNT}`],
      ['Unique stunt jumps', `${p.stunts.length} / ${sim.world.layout.ramps.length}`],
      ['Rampages', `${p.rampages.length} / 3`],
      ['Money earned', formatMoney(s.moneyEarned)],
      ['Money spent', formatMoney(s.moneySpent)],
      ['Time played', time],
      ['People killed', String(s.kills)],
      ['Cops killed', String(s.copsKilled)],
      ['Cars stolen', String(s.carsStolen)],
      ['Vehicles destroyed', String(s.vehiclesDestroyed)],
      ['Shots fired', String(s.shotsFired)],
      ['Headshots', String(s.headshots)],
      ['Distance driven', km(s.distanceDriven)],
      ['Distance on foot', km(s.distanceOnFoot)],
      ['Highest wanted level', '★'.repeat(s.maxWanted) || '—'],
      ['Times wasted', String(s.timesWasted)],
      ['Times busted', String(s.timesBusted)],
      ['Taxi fares', String(s.taxiFares)],
      ['Vigilante level', String(s.vigilanteLevel)],
      ['Stunt bonuses', String(s.stuntBonuses)],
      ['Best stunt airtime', `${s.bestStuntAir.toFixed(1)} s`],
    ];
    const el = h('div', 'screen dim');
    const panel = h('div', 'panel');
    panel.innerHTML = `<h2>STATS</h2><div class="stat-grid">${rows.map(([a, b]) => `<span>${a}</span><span>${b}</span>`).join('')}</div>`;
    const row = h('div', 'row-end');
    const back = h('button', 'btn primary', 'BACK');
    back.addEventListener('click', () => this.pop());
    row.appendChild(back);
    panel.appendChild(row);
    el.appendChild(panel);
    this.push({ el, input: (ui) => (ui.back || ui.confirm ? this.pop() : undefined) });
  }

  showSettings(): void {
    const s = { ...this.host.settings() };
    const el = h('div', 'screen dim');
    const panel = h('div', 'panel');
    panel.appendChild(h('h2', '', 'SETTINGS'));
    const apply = () => this.host.applySettings({ ...s });
    // Keyboard / gamepad: up / down pick a row, left / right adjust it, confirm activates it.
    const rows: Array<{ el: HTMLElement; adjust?(d: number): void; activate?(): void; skip?(): boolean }> = [];
    let sel = 0;
    const select = (i: number) => {
      sel = i;
      rows.forEach((r, k) => r.el.classList.toggle('sel', k === i));
    };
    const move = (d: number) => {
      const n = rows.length;
      for (let k = 1; k <= n; k++) {
        const i = (sel + d * k + n * 10) % n;
        if (!rows[i]!.skip?.()) {
          select(i);
          return;
        }
      }
    };
    const addRow = (r: (typeof rows)[number]) => {
      const i = rows.length;
      rows.push(r);
      r.el.addEventListener('mouseenter', () => select(i));
    };
    const slider = (label: string, key: 'master' | 'music' | 'sfx' | 'sensitivity' | 'fov', min: number, max: number, stepv: number, keyStep: number, fmt: (v: number) => string) => {
      const row = h('div', 'setting');
      const lab = h('span', '', label);
      const input = h('input');
      input.type = 'range';
      input.min = String(min);
      input.max = String(max);
      input.step = String(stepv);
      input.value = String(s[key]);
      input.style.pointerEvents = 'auto';
      const val = h('span', '', fmt(s[key]));
      const set = (v: number) => {
        s[key] = v;
        input.value = String(v);
        val.textContent = fmt(v);
        apply();
      };
      input.addEventListener('input', () => set(Number(input.value)));
      row.append(lab, input, val);
      panel.appendChild(row);
      // Snapped to the slider's step so repeated presses don't drift (0.7999999...).
      const snap = (v: number) => Number((Math.round(v / stepv) * stepv).toFixed(6));
      addRow({ el: row, adjust: (d) => set(clamp(snap(s[key] + d * keyStep), min, max)) });
    };
    const qualities = ['low', 'medium', 'high'] as const;
    const qrow = h('div', 'setting');
    const qsel = h('select');
    for (const q of qualities) {
      const o = h('option');
      o.value = q;
      o.textContent = q.toUpperCase();
      if (s.quality === q) o.selected = true;
      qsel.appendChild(o);
    }
    const setQuality = (q: Settings['quality']) => {
      s.quality = q;
      qsel.value = q;
      apply();
    };
    qsel.addEventListener('change', () => setQuality(qsel.value as Settings['quality']));
    qrow.append(h('span', '', 'Graphics quality'), qsel, h('span', '', ''));
    panel.appendChild(qrow);
    addRow({
      el: qrow,
      adjust: (d) => {
        const q = qualities[clamp(qualities.indexOf(s.quality) + d, 0, qualities.length - 1)]!;
        if (q !== s.quality) setQuality(q);
      },
    });
    const pct = (v: number) => `${Math.round(v * 100)}%`;
    slider('Master volume', 'master', 0, 1, 0.05, 0.05, pct);
    slider('Music (radio)', 'music', 0, 1, 0.05, 0.05, pct);
    slider('Sound effects', 'sfx', 0, 1, 0.05, 0.05, pct);
    slider('Mouse sensitivity', 'sensitivity', 0.2, 3, 0.05, 0.1, (v) => v.toFixed(2));
    slider('Field of view', 'fov', 55, 90, 1, 5, (v) => `${v}°`);
    const irow = h('div', 'setting');
    const inv = h('input');
    inv.type = 'checkbox';
    inv.checked = s.invertY;
    inv.style.pointerEvents = 'auto';
    const setInvert = (v: boolean) => {
      s.invertY = v;
      inv.checked = v;
      apply();
    };
    inv.addEventListener('change', () => setInvert(inv.checked));
    irow.append(h('span', '', 'Invert look Y'), inv, h('span', '', ''));
    panel.appendChild(irow);
    addRow({ el: irow, adjust: () => setInvert(!s.invertY), activate: () => setInvert(!s.invertY) });
    const hrow = h('div', 'setting');
    const hints = h('input');
    hints.type = 'checkbox';
    hints.checked = s.hints;
    hints.style.pointerEvents = 'auto';
    const hval = h('span', '', s.hints ? 'On' : 'Off');
    const setHints = (v: boolean) => {
      s.hints = v;
      hints.checked = v;
      hval.textContent = v ? 'On' : 'Off';
      apply();
    };
    hints.addEventListener('change', () => setHints(hints.checked));
    hrow.append(h('span', '', 'Tutorial hints'), hints, hval);
    panel.appendChild(hrow);
    addRow({ el: hrow, adjust: () => setHints(!s.hints), activate: () => setHints(!s.hints) });
    const row = h('div', 'row-end');
    const del = h('button', 'btn', 'DELETE SAVE');
    del.disabled = !this.host.hasSave();
    del.addEventListener('click', () =>
      this.confirm('Delete your saved game? This cannot be undone.', () => {
        this.host.deleteSave();
        del.disabled = true;
        if (rows[sel]?.el === del) move(1);
      }),
    );
    const back = h('button', 'btn primary', 'BACK');
    back.addEventListener('click', () => this.pop());
    row.append(del, back);
    panel.appendChild(row);
    addRow({ el: del, activate: () => del.click(), skip: () => del.disabled });
    addRow({ el: back, activate: () => back.click() });
    select(0);
    el.appendChild(panel);
    this.push({
      el,
      input: (ui) => {
        if (ui.back) {
          this.pop();
          return;
        }
        if (ui.up) move(-1);
        if (ui.down) move(1);
        const r = rows[sel]!;
        if (ui.left) r.adjust?.(-1);
        if (ui.right) r.adjust?.(1);
        if (ui.confirm) r.activate?.();
      },
    });
  }

  showShop(onClose: () => void): void {
    const sim = this.host.sim();
    if (!sim) return;
    const el = h('div', 'screen dim');
    const panel = h('div', 'panel');
    panel.style.width = 'min(620px, 92vw)';
    const head = h('h2', '', 'BANG BANG GUNS');
    const money = h('div', 'money');
    const list = h('div', 'shop-list');
    const msg = h('div', 'shop-msg');
    const items = shopItems();
    let sel = 0;
    const rows: HTMLDivElement[] = [];
    const render = () => {
      money.textContent = formatMoney(sim.progress.money);
      items.forEach((it, i) => {
        const r = rows[i]!;
        const owned = it.weapon ? sim.player.inventory.has(it.weapon) : false;
        const price = sim.interactions.priceOf(it);
        r.innerHTML = `<span>${escapeHtml(it.label)}${owned ? ' <span class="own">(ammo +' + it.ammo + ')</span>' : it.weapon ? ` <span class="own">+${it.ammo} rounds</span>` : ''}</span><span class="own">${it.weapon ? sim.player.inventory.total(it.weapon) + ' owned' : ''}</span><span class="price">${formatMoney(price)}</span>`;
        r.classList.toggle('sel', i === sel);
      });
    };
    const buy = (i: number) => {
      const err = sim.interactions.buy(items[i]!.id);
      msg.textContent = err ?? `Bought: ${items[i]!.label}`;
      this.host.click();
      render();
    };
    items.forEach((_it, i) => {
      const r = h('div', 'shop-item');
      r.addEventListener('click', () => {
        sel = i;
        buy(i);
      });
      r.addEventListener('mouseenter', () => {
        sel = i;
        render();
      });
      rows.push(r);
      list.appendChild(r);
    });
    render();
    panel.append(head, money, list, msg);
    const row = h('div', 'row-end');
    const back = h('button', 'btn primary', 'LEAVE');
    back.addEventListener('click', () => {
      this.pop();
    });
    row.appendChild(back);
    panel.appendChild(row);
    panel.appendChild(h('p', '', 'Click or press <kbd>Enter</kbd> to buy, <kbd>Esc</kbd> to leave.'));
    el.appendChild(panel);
    this.push({
      el,
      input: (ui) => {
        if (ui.back) this.pop();
        else if (ui.up) {
          sel = (sel + items.length - 1) % items.length;
          render();
        } else if (ui.down) {
          sel = (sel + 1) % items.length;
          render();
        } else if (ui.confirm) buy(sel);
      },
      close: onClose,
    });
  }

  /** Full-screen map; `onClose` runs when it closes (opened from gameplay: resume the game). */
  showMap(onClose?: () => void): void {
    const sim = this.host.sim();
    if (!sim) return;
    const el = h('div', 'map-screen');
    const canvas = h('canvas');
    el.appendChild(canvas);
    el.appendChild(h('div', 'map-title', 'SAN AZURA'));
    el.appendChild(
      h(
        'div',
        'map-legend',
        [
          ['#ffffff', 'You'],
          ['#ff4fa3', 'Mama Lou (missions)'],
          ['#38e1d2', 'Dex Moreau (missions)'],
          ['#ffd23d', 'Objective'],
          ['#4aa8ff', 'Safehouse (save)'],
          ['#ff8a1f', 'Gun shop'],
          ['#3fd96b', 'Spray Shack'],
          ['#ff4a4a', 'Hospital'],
          ['#3a6bff', 'Police'],
          ['#c04fff', 'Waypoint'],
        ]
          .map(([c, t]) => `<div><i style="background:${c}"></i>${t}</div>`)
          .join(''),
      ),
    );
    el.appendChild(h('div', 'map-hint', `Click to set a waypoint (click it again to clear) · Drag to pan · Wheel to zoom · <kbd>${escapeHtml(this.keys.label('KeyM'))}</kbd>/<kbd>Esc</kbd> to close`));
    const ctx = canvas.getContext('2d')!;
    // Start centred on the island showing the whole city.
    const b = sim.world.layout.bounds;
    let zoom = 0;
    let cx = (b.landMinX + b.beachEndX) / 2;
    let cz = (b.landMinZ + b.landMaxZ) / 2;
    let dragging = false;
    let moved = 0;
    let lx = 0;
    let ly = 0;
    const scale = () => {
      const base = Math.min(canvas.width / (this.map.canvas.width / MAP_SCALE), canvas.height / (this.map.canvas.height / MAP_SCALE));
      return base * Math.pow(1.5, zoom);
    };
    const toWorld = (sx: number, sy: number) => {
      const k = scale();
      return { x: cx + (sx - canvas.width / 2) / k, z: cz + (sy - canvas.height / 2) / k };
    };
    const draw = (time: number) => {
      const w = el.clientWidth || window.innerWidth;
      const hh = el.clientHeight || window.innerHeight;
      if (canvas.width !== w || canvas.height !== hh) {
        canvas.width = w;
        canvas.height = hh;
      }
      const k = scale();
      ctx.fillStyle = '#08111a';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.save();
      ctx.translate(canvas.width / 2, canvas.height / 2);
      ctx.scale(k / MAP_SCALE, k / MAP_SCALE);
      ctx.translate(-(cx - this.map.minX) * MAP_SCALE, -(cz - this.map.minZ) * MAP_SCALE);
      ctx.drawImage(this.map.canvas, 0, 0);
      ctx.restore();
      // District labels.
      ctx.font = '700 15px Rajdhani, sans-serif';
      ctx.textAlign = 'center';
      const seen = new Set<string>();
      for (const blk of sim.world.layout.blocks) {
        if (seen.has(blk.zone)) continue;
        if (blk.district === 'park' && zoom < 1) continue;
        seen.add(blk.zone);
        const group = sim.world.layout.blocks.filter((b) => b.zone === blk.zone);
        const mx = group.reduce((a, b) => a + (b.rect.minX + b.rect.maxX) / 2, 0) / group.length;
        const mz = group.reduce((a, b) => a + (b.rect.minZ + b.rect.maxZ) / 2, 0) / group.length;
        const sx = canvas.width / 2 + (mx - cx) * k;
        const sy = canvas.height / 2 + (mz - cz) * k;
        ctx.lineWidth = 4;
        ctx.strokeStyle = 'rgba(0,0,0,0.85)';
        ctx.fillStyle = '#e8ecf2';
        ctx.strokeText(blk.zone.toUpperCase(), sx, sy);
        ctx.fillText(blk.zone.toUpperCase(), sx, sy);
      }
      // The waypoint goes first, under the rest: a contact's L / D on the same spot stays on top.
      const wp = this.host.waypoint();
      const blips: Blip[] = wp ? [{ x: wp.x, z: wp.z, color: '#c04fff', label: 'W', sticky: true, shape: 'circle' }] : [];
      blips.push(...collectBlips(sim, time));
      for (const b of blips) drawBlip(ctx, b, canvas.width / 2 + (b.x - cx) * k, canvas.height / 2 + (b.z - cz) * k, 18);
      const p = sim.playerPos();
      const ph = sim.player.vehicle ? sim.player.vehicle.heading : sim.player.heading;
      ctx.save();
      ctx.translate(canvas.width / 2 + (p.x - cx) * k, canvas.height / 2 + (p.z - cz) * k);
      ctx.rotate(Math.PI - ph);
      ctx.fillStyle = '#fff';
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(0, -12);
      ctx.lineTo(8, 9);
      ctx.lineTo(0, 4);
      ctx.lineTo(-8, 9);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    };
    let t = 0;
    canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      // Capture, so the move and the release reach the canvas even over the legend / hint or
      // outside the window and the drag always ends with the button.
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {
        // Pointer already gone: the buttons check below still ends the drag.
      }
      dragging = true;
      moved = 0;
      lx = e.clientX;
      ly = e.clientY;
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      if ((e.buttons & 1) === 0) {
        dragging = false; // the release happened where we couldn't see it
        return;
      }
      const k = scale();
      cx -= (e.clientX - lx) / k;
      cz -= (e.clientY - ly) / k;
      moved += Math.abs(e.clientX - lx) + Math.abs(e.clientY - ly);
      lx = e.clientX;
      ly = e.clientY;
    });
    const endDrag = () => {
      dragging = false;
    };
    canvas.addEventListener('pointercancel', endDrag);
    canvas.addEventListener('lostpointercapture', endDrag);
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('pointerup', (e) => {
      if (!dragging || e.button !== 0) return;
      dragging = false;
      if (moved > 6) return;
      const r = canvas.getBoundingClientRect();
      const w = toWorld(e.clientX - r.left, e.clientY - r.top);
      const cur = this.host.waypoint();
      const k = scale();
      if (cur && Math.hypot(cur.x - w.x, cur.z - w.z) * k < 16) this.host.setWaypoint(null);
      else this.host.setWaypoint(w);
      this.host.click();
    });
    // Steps like the weapon wheel: the first event of a gesture (see WHEEL_GESTURE_GAP) is one
    // 0.5 step whatever its size, so a notch is a step on every platform (4 px on macOS, 53 on
    // Linux, 100 on Windows, a page). The rest of a gesture, such as a touchpad's dozens of tiny
    // events per swipe, zooms by distance: a step per WHEEL_STEP px, at most one per event.
    let wheelT = -Infinity;
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 800 : 1;
      const dy = e.deltaY * unit;
      // Ignored events still continue the gesture: a stray vertical event in a sideways touchpad
      // swipe is not a whole step. Unlike for weapons, ctrl+wheel (a touchpad pinch) zooms too.
      const newGesture = e.timeStamp - wheelT > WHEEL_GESTURE_GAP;
      wheelT = e.timeStamp;
      if (!Number.isFinite(dy) || dy === 0 || Math.abs(e.deltaX * unit) > Math.abs(dy)) return;
      const steps = newGesture ? 1 : Math.min(Math.abs(dy) / WHEEL_STEP, 1);
      zoom = clamp(zoom - Math.sign(dy) * 0.5 * steps, 0, 4);
    }, { passive: false });
    this.push({
      el,
      input: (ui) => {
        if (ui.back || ui.map || ui.pause) this.pop();
        const k = scale();
        if (ui.left) cx -= 60 / k;
        if (ui.right) cx += 60 / k;
        if (ui.up) cz -= 60 / k;
        if (ui.down) cz += 60 / k;
      },
      tick: (dt) => {
        t += dt;
        draw(t);
      },
      close: onClose,
    });
  }
}
