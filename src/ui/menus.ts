// Menu screens (title, pause, map, stats, controls, settings, shop, credits)
// managed as a stack. Keyboard, gamepad and mouse can all drive them.

import { formatMoney } from '../core/math';
import type { UiActions } from '../input/input';
import type { Sim } from '../sim/sim';
import { shopItems } from '../sim/interactions';
import { PACKAGE_COUNT } from '../sim/pickups';
import type { Settings } from '../settings';
import { escapeHtml } from './hud';
import { collectBlips, drawBlip, MAP_SCALE, type MapImage } from './mapRender';

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

  constructor(parent: HTMLElement, private readonly host: MenuHost, private readonly map: MapImage) {
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

  showTitle(): void {
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
    wrap.appendChild(list.el);
    wrap.appendChild(h('div', 'title-foot', 'A fan-made parody sandbox. Not affiliated with or endorsed by Rockstar Games or Take-Two Interactive. All city, character, vehicle and brand names are fictional. Best with keyboard + mouse or a gamepad.'));
    el.appendChild(wrap);
    this.push({ el, input: (ui) => list.input(ui) });
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
    const kb: Array<[string, string]> = [
      ['Move / Drive', 'W A S D'],
      ['Look / Aim', 'Mouse'],
      ['Sprint', 'Shift'],
      ['Jump / Handbrake', 'Space'],
      ['Shoot / Punch', 'Left click'],
      ['Aim', 'Right click'],
      ['Enter / Exit vehicle', 'F'],
      ['Interact / Horn', 'E'],
      ['Reload / Next radio', 'R'],
      ['Weapons', '1-6, Q, wheel'],
      ['Taxi / Vigilante job', 'T'],
      ['Camera distance', 'V'],
      ['Map', 'M'],
      ['Pause', 'Esc / P'],
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
    const grid = (rows: Array<[string, string]>) => `<div class="keys">${rows.map(([a, b]) => `<div><span>${a}</span><span>${b}</span></div>`).join('')}</div>`;
    panel.innerHTML = `<h2>CONTROLS</h2><h3>Keyboard &amp; mouse</h3>${grid(kb)}<h3>Gamepad</h3>${grid(pad)}
      <h3>Tips</h3><p>Steal any car with <kbd>F</kbd>, even with someone inside. Lose the cops by breaking line of sight or by driving into a Spray Shack. Hidden packages, stunt ramps and rampages are scattered across San Azura. Drive a taxi or police car and press <kbd>T</kbd> for side jobs.</p>`;
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
    const slider = (label: string, key: 'master' | 'music' | 'sfx' | 'sensitivity' | 'fov', min: number, max: number, stepv: number, fmt: (v: number) => string) => {
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
      input.addEventListener('input', () => {
        s[key] = Number(input.value);
        val.textContent = fmt(s[key]);
        this.host.applySettings({ ...s });
      });
      row.append(lab, input, val);
      panel.appendChild(row);
    };
    const qrow = h('div', 'setting');
    const qsel = h('select');
    for (const q of ['low', 'medium', 'high'] as const) {
      const o = h('option');
      o.value = q;
      o.textContent = q.toUpperCase();
      if (s.quality === q) o.selected = true;
      qsel.appendChild(o);
    }
    qsel.addEventListener('change', () => {
      s.quality = qsel.value as Settings['quality'];
      this.host.applySettings({ ...s });
    });
    qrow.append(h('span', '', 'Graphics quality'), qsel, h('span', '', ''));
    panel.appendChild(qrow);
    const pct = (v: number) => `${Math.round(v * 100)}%`;
    slider('Master volume', 'master', 0, 1, 0.05, pct);
    slider('Music (radio)', 'music', 0, 1, 0.05, pct);
    slider('Sound effects', 'sfx', 0, 1, 0.05, pct);
    slider('Mouse sensitivity', 'sensitivity', 0.2, 3, 0.05, (v) => v.toFixed(2));
    slider('Field of view', 'fov', 55, 90, 1, (v) => `${v}°`);
    const irow = h('div', 'setting');
    const inv = h('input');
    inv.type = 'checkbox';
    inv.checked = s.invertY;
    inv.style.pointerEvents = 'auto';
    inv.addEventListener('change', () => {
      s.invertY = inv.checked;
      this.host.applySettings({ ...s });
    });
    irow.append(h('span', '', 'Invert look Y'), inv, h('span', '', ''));
    panel.appendChild(irow);
    const row = h('div', 'row-end');
    const del = h('button', 'btn', 'DELETE SAVE');
    del.disabled = !this.host.hasSave();
    del.addEventListener('click', () =>
      this.confirm('Delete your saved game? This cannot be undone.', () => {
        this.host.deleteSave();
        del.disabled = true;
      }),
    );
    const back = h('button', 'btn primary', 'BACK');
    back.addEventListener('click', () => this.pop());
    row.append(del, back);
    panel.appendChild(row);
    el.appendChild(panel);
    this.push({ el, input: (ui) => (ui.back ? this.pop() : undefined) });
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

  showMap(): void {
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
    el.appendChild(h('div', 'map-hint', 'Click to set a waypoint (click it again to clear) · Drag to pan · Wheel to zoom · <kbd>M</kbd>/<kbd>Esc</kbd> to close'));
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
      const blips = collectBlips(sim, time);
      const wp = this.host.waypoint();
      if (wp) blips.push({ x: wp.x, z: wp.z, color: '#c04fff', label: 'W', sticky: true, shape: 'circle' });
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
    canvas.addEventListener('mousedown', (e) => {
      dragging = true;
      moved = 0;
      lx = e.clientX;
      ly = e.clientY;
    });
    canvas.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const k = scale();
      cx -= (e.clientX - lx) / k;
      cz -= (e.clientY - ly) / k;
      moved += Math.abs(e.clientX - lx) + Math.abs(e.clientY - ly);
      lx = e.clientX;
      ly = e.clientY;
    });
    canvas.addEventListener('mouseup', (e) => {
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
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      zoom = Math.max(0, Math.min(4, zoom + (e.deltaY < 0 ? 0.5 : -0.5)));
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
    });
  }
}
