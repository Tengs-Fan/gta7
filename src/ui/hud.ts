// In-game heads-up display: status cluster, radar, messages and prompts.

import { formatMoney, formatTime, wrapAngle } from '../core/math';
import { KeyLabels } from '../input/input';
import type { BigStyle, SimEvents } from '../sim/events';
import type { Sim } from '../sim/sim';
import { WEAPONS, type WeaponId } from '../sim/specs';
import { collectBlips, drawBlip, gpsRoute, MAP_SCALE, type MapImage } from './mapRender';

const STAR = '<svg viewBox="0 0 24 24"><path d="M12 1.8l3.1 6.6 7.2.9-5.3 5 1.4 7.2L12 18l-6.4 3.5L7 14.3l-5.3-5 7.2-.9z"/></svg>';

export const WEAPON_ICONS: Record<WeaponId, string> = {
  fists: '<svg viewBox="0 0 64 40"><path d="M18 10c0-3 2-5 5-5h16c4 0 7 3 7 7v6l4 2v9c0 4-3 7-7 7H25c-4 0-7-3-7-7z M24 10v8 M30 9v9 M36 9v9 M42 10v8" stroke="#222" stroke-width="1.5"/></svg>',
  pistol: '<svg viewBox="0 0 64 40"><path d="M8 10h42l4 4v4H30l-3 3h-5l-4 13H9l5-15-6-2z"/></svg>',
  smg: '<svg viewBox="0 0 64 40"><path d="M4 13h46l6 3v4H38l-2 3h-6l-2 12h-7l2-12h-6l-3 8H8l3-10-7-2zM50 11h8v2h-8z"/></svg>',
  shotgun: '<svg viewBox="0 0 64 40"><path d="M2 15h48l10 1v3H40l-4 2H26l-8 9H8l7-10H2z"/></svg>',
  rifle: '<svg viewBox="0 0 64 40"><path d="M2 14h52l8 2v3H44l-3 3h-5l-2 10h-6l2-10h-5l-5 9h-8l5-10H2z M30 12h8v2h-8z"/></svg>',
  rocket: '<svg viewBox="0 0 64 40"><path d="M2 14h50l8 4-8 4H2z M18 22h6l2 10h-6z M34 22h5l1 6h-5z"/></svg>',
};

interface BigMsg {
  text: string;
  sub: string;
  style: BigStyle;
  duration: number;
}

// What the DOM shows initially; bind() returns to these for every new session.
const initialShown = () => ({ money: -1, health: -1, armor: -1, weapon: '', ammo: '', clock: '', stars: -1, flash: false, status: '', zone: '' });
const initialTimers = () => ({ help: 0, subtitle: 0, zone: 0, radio: 0, toast: 0, delta: 0, hurt: 0, objective: 0 });
/** Elements shown with the 'show' class for a while. */
const TIMED = ['help', 'subtitle', 'objective', 'zone', 'radio', 'toast', 'delta', 'big'];
/** Hitmarker display time (s) for a hit and for a kill. */
const HIT_TIME = 0.12;
const KILL_TIME = 0.25;
/** Damage-direction arcs: how many at once, how long one fades (s), and within what angle a new hit refreshes an arc already up. */
const ARCS = 4;
const ARC_TIME = 1;
const ARC_MERGE = 0.35;

export class Hud {
  readonly root: HTMLDivElement;
  private readonly el: Record<string, HTMLElement> = {};
  private readonly radar: HTMLCanvasElement;
  private readonly radarCtx: CanvasRenderingContext2D;
  private shown = initialShown();
  private timers = initialTimers();
  private bigQueue: BigMsg[] = [];
  private bigCur: BigMsg | null = null;
  private bigTimer = 0;
  private moneyDelta = 0;
  private unsub: Array<() => void> = [];
  private route: Array<{ x: number; z: number }> = [];
  private routeTimer = 0;
  private lastHealth = 100;
  private fadeTimeout = 0;
  private hitTimer = 0;
  /** Damage-direction arcs: seconds left and the world bearing (heading) of where the hit came from. */
  private readonly arcs: Array<{ el: HTMLElement; t: number; bearing: number }> = [];
  waypoint: { x: number; z: number } | null = null;
  visible = true;

  constructor(parent: HTMLElement, private readonly map: MapImage, private readonly keys = new KeyLabels()) {
    this.root = document.createElement('div');
    this.root.className = 'hud';
    this.root.innerHTML = `
      <div class="vignette" data-el="vignette"></div>
      <div class="hud-tr">
        <div class="hud-row"><div class="clock" data-el="clock">00:00</div><div class="weapon" data-el="weapon"><span data-el="wicon"></span><span class="ammo" data-el="ammo"></span></div></div>
        <div class="bars"><div class="bar health" data-el="hbar"><i data-el="health"></i></div><div class="bar armor" data-el="abar"><i data-el="armor"></i></div></div>
        <div class="money" data-el="money">$0</div>
        <div class="money-delta" data-el="delta"></div>
        <div class="stars" data-el="stars">${STAR.repeat(5)}</div>
        <div class="status hidden" data-el="status"></div>
      </div>
      <div class="radar"><canvas width="220" height="220" data-el="radar"></canvas></div>
      <div class="help" data-el="help"></div>
      <div class="radio" data-el="radio"></div>
      <div class="prompt hidden" data-el="prompt"></div>
      <div class="subtitle" data-el="subtitle"></div>
      <div class="objective" data-el="objective"></div>
      <div class="big" data-el="big"><div class="t" data-el="bigT"></div><div class="s" data-el="bigS"></div></div>
      <div class="zone" data-el="zone"></div>
      <div class="toast" data-el="toast"></div>
      <div class="crosshair" data-el="cross"><i></i></div>
      <div class="hitmarker" data-el="hitmarker"><b></b><b></b><b></b><b></b></div>
      <div class="dmg-dirs">${Array.from({ length: ARCS }, (_, i) => `<div class="dmg-dir" data-el="dmg${i}"></div>`).join('')}</div>
      <div class="fade" data-el="fade"></div>
    `;
    parent.appendChild(this.root);
    this.root.querySelectorAll<HTMLElement>('[data-el]').forEach((e) => {
      this.el[e.dataset.el!] = e;
    });
    for (let i = 0; i < ARCS; i++) this.arcs.push({ el: this.el[`dmg${i}`]!, t: 0, bearing: 0 });
    this.radar = this.el.radar as HTMLCanvasElement;
    this.radarCtx = this.radar.getContext('2d')!;
  }

  bind(sim: Sim): void {
    for (const u of this.unsub) u();
    this.unsub = [];
    this.reset(sim);
    const ev = sim.events;
    // A finished mission's or rampage's last objective must not linger next to its PASSED / FAILED.
    const clearObjective = () => {
      this.timers.objective = 0;
      this.el.objective!.classList.remove('show');
    };
    this.unsub.push(
      ev.on('message', (e) => this.help(this.keyCaps(e.text), e.duration)),
      ev.on('subtitle', (e) => {
        this.el.subtitle!.innerHTML = `<b>${escapeHtml(e.speaker)}:</b> ${escapeHtml(e.text)}`;
        this.el.subtitle!.classList.add('show');
        this.timers.subtitle = e.duration;
      }),
      ev.on('objective', (e) => {
        this.el.objective!.textContent = e.text;
        this.el.objective!.classList.add('show');
        this.timers.objective = 7;
      }),
      ev.on('big', (e) => {
        // Wasted / busted replace everything immediately.
        if (e.style === 'wasted' || e.style === 'busted') {
          this.bigQueue = [];
          this.showBig(e);
        } else this.bigQueue.push(e);
      }),
      ev.on('money', (e) => {
        this.moneyDelta += e.amount;
        this.timers.delta = 2.5;
      }),
      ev.on('vehicleEnter', (e) => {
        if (e.character.isPlayer) this.flashZone(e.vehicle.spec.name, '');
      }),
      ev.on('fade', (e) => {
        this.el.fade!.classList.add('on');
        window.clearTimeout(this.fadeTimeout);
        this.fadeTimeout = window.setTimeout(() => this.el.fade!.classList.remove('on'), Math.max(200, e.duration * 1000 - 500));
      }),
      ev.on('respawn', () => {
        this.lastHealth = sim.player.health;
      }),
      ev.on('missionEnded', clearObjective),
      ev.on('activityEnded', clearObjective),
      ev.on('damage', (e) => this.onDamage(e)),
    );
  }

  /** Hitmarkers for the player's hits; a damage-direction arc for hits on him that came from somewhere. */
  private onDamage(e: SimEvents['damage']): void {
    if (e.attacker?.isPlayer && !e.victim.isPlayer) {
      const el = this.el.hitmarker!;
      // A kill or a headshot keeps its colour until the marker goes out; a kill stays up longer.
      this.hitTimer = Math.max(this.hitTimer, e.killed ? KILL_TIME : HIT_TIME);
      el.classList.add('show');
      if (e.killed) el.classList.add('kill');
      if (e.zone === 'head') el.classList.add('head');
    } else if (e.victim.isPlayer && (e.dirX !== 0 || e.dirZ !== 0) && Number.isFinite(e.dirX + e.dirZ)) {
      // The hit travels along (dirX, dirZ): it came from the opposite way.
      const bearing = Math.atan2(-e.dirX, -e.dirZ);
      let arc = this.arcs.find((a) => a.t > 0 && Math.abs(wrapAngle(a.bearing - bearing)) < ARC_MERGE);
      if (!arc) arc = this.arcs.reduce((a, b) => (b.t < a.t ? b : a));
      arc.t = ARC_TIME;
      arc.bearing = bearing;
      arc.el.classList.add('show');
    }
  }

  /** Fades the hitmarker and the damage arcs; an arc points where its hit came from as the camera turns. */
  private updateHitFeedback(dt: number, camYaw: number): void {
    if (this.hitTimer > 0) {
      this.hitTimer -= dt;
      if (this.hitTimer <= 0) this.el.hitmarker!.classList.remove('show', 'kill', 'head');
    }
    for (const a of this.arcs) {
      if (a.t <= 0) continue;
      a.t -= dt;
      if (a.t <= 0) {
        a.el.classList.remove('show');
        a.el.style.opacity = '0';
        continue;
      }
      // The bearing relative to the view is positive to the left (headings turn anticlockwise), and
      // CSS rotates clockwise from the top of the screen.
      const deg = (((-wrapAngle(a.bearing - camYaw) * 180) / Math.PI) % 360 + 360) % 360;
      a.el.style.transform = `rotate(${deg.toFixed(1)}deg)`;
      a.el.style.opacity = (a.t / ARC_TIME).toFixed(3);
    }
  }

  /** Clears everything the previous session left on screen (the HUD is reused across games). */
  private reset(sim: Sim): void {
    this.shown = initialShown();
    this.timers = initialTimers();
    this.bigQueue = [];
    this.bigCur = null;
    this.bigTimer = 0;
    this.moneyDelta = 0;
    this.route = [];
    this.routeTimer = 0;
    this.lastHealth = sim.player.health;
    this.waypoint = null;
    window.clearTimeout(this.fadeTimeout);
    const el = this.el;
    for (const k of TIMED) el[k]!.classList.remove('show');
    el.fade!.classList.remove('on');
    el.money!.classList.remove('pop');
    // update() only writes these when they change, and '' is also a valid new-session value.
    el.ammo!.textContent = '';
    el.status!.textContent = '';
    el.status!.classList.add('hidden');
    this.hitTimer = 0;
    el.hitmarker!.classList.remove('show', 'kill', 'head');
    for (const a of this.arcs) {
      a.t = 0;
      a.el.classList.remove('show');
      a.el.style.opacity = '0';
    }
  }

  help(text: string, duration = 4): void {
    this.el.help!.innerHTML = text;
    this.el.help!.classList.add('show');
    this.timers.help = duration;
  }

  toast(text: string): void {
    this.el.toast!.textContent = text;
    this.el.toast!.classList.add('show');
    this.timers.toast = 2.5;
  }

  showRadio(name: string): void {
    this.el.radio!.textContent = name;
    this.el.radio!.classList.add('show');
    this.timers.radio = 2.5;
  }

  private flashZone(name: string, sub: string): void {
    this.el.zone!.innerHTML = `${escapeHtml(name)}${sub ? `<small>${escapeHtml(sub)}</small>` : ''}`;
    this.el.zone!.classList.add('show');
    this.timers.zone = 3;
  }

  private showBig(m: BigMsg): void {
    this.bigCur = m;
    this.bigTimer = m.duration;
    const big = this.el.big!;
    big.className = `big show ${m.style}`;
    this.el.bigT!.textContent = m.text;
    this.el.bigS!.textContent = m.sub;
  }

  setVisible(v: boolean): void {
    this.visible = v;
    this.root.classList.toggle('hidden', !v);
  }

  update(dt: number, sim: Sim, camYaw: number, aiming: boolean, prompt: string | null, time: number): void {
    if (!this.visible) return;
    const p = sim.player;
    const prog = sim.progress;
    const el = this.el;

    // Timed elements.
    for (const k of Object.keys(this.timers) as Array<keyof typeof this.timers>) if (this.timers[k] > 0) this.timers[k] -= dt;
    if (this.timers.help <= 0) el.help!.classList.remove('show');
    if (this.timers.subtitle <= 0) el.subtitle!.classList.remove('show');
    if (this.timers.zone <= 0) el.zone!.classList.remove('show');
    if (this.timers.radio <= 0) el.radio!.classList.remove('show');
    if (this.timers.toast <= 0) el.toast!.classList.remove('show');
    if (this.timers.delta <= 0) this.moneyDelta = 0;
    const objText = sim.missions.active?.objectiveText ?? '';
    if (objText && this.timers.objective <= 0 && this.timers.subtitle <= 0) {
      el.objective!.textContent = objText;
      el.objective!.classList.add('show');
    } else if (!objText && this.timers.objective <= 0) el.objective!.classList.remove('show');

    if (this.bigCur) {
      this.bigTimer -= dt;
      if (this.bigTimer <= 0) {
        this.bigCur = null;
        el.big!.classList.remove('show');
      }
    } else if (this.bigQueue.length > 0) {
      this.showBig(this.bigQueue.shift()!);
    }

    // Status cluster.
    const clock = sim.clock.label();
    if (clock !== this.shown.clock) {
      this.shown.clock = clock;
      el.clock!.textContent = clock;
    }
    if (prog.money !== this.shown.money) {
      if (this.shown.money >= 0) {
        el.money!.classList.remove('pop');
        void el.money!.offsetWidth;
        el.money!.classList.add('pop');
      }
      this.shown.money = prog.money;
      el.money!.textContent = formatMoney(prog.money);
    }
    // Hidden when the window expired and also when gains and losses inside it cancel out.
    if (this.moneyDelta !== 0) {
      el.delta!.textContent = `${this.moneyDelta > 0 ? '+' : '-'}${formatMoney(Math.abs(this.moneyDelta))}`;
      el.delta!.style.color = this.moneyDelta > 0 ? 'var(--money)' : '#ff6a5a';
      el.delta!.classList.add('show');
    } else el.delta!.classList.remove('show');
    const hp = Math.max(0, p.health) / p.maxHealth;
    if (Math.abs(hp - this.shown.health) > 0.001) {
      this.shown.health = hp;
      el.health!.style.transform = `scaleX(${hp})`;
      el.hbar!.classList.toggle('ok', hp > 0.5);
      el.hbar!.classList.toggle('low', hp < 0.25 && p.alive);
    }
    const ar = p.armor / 100;
    if (Math.abs(ar - this.shown.armor) > 0.001) {
      this.shown.armor = ar;
      el.armor!.style.transform = `scaleX(${ar})`;
      el.abar!.classList.toggle('hidden', ar <= 0);
    }
    if (p.health < this.lastHealth - 0.5) {
      this.timers.hurt = 0.35;
    }
    this.lastHealth = p.health;
    el.vignette!.style.opacity = String(Math.max(0, this.timers.hurt / 0.35) * 0.8 + (hp < 0.25 && p.alive ? 0.35 + Math.sin(time * 6) * 0.1 : 0));

    const w = p.inventory.current;
    if (w !== this.shown.weapon) {
      this.shown.weapon = w;
      el.wicon!.innerHTML = WEAPON_ICONS[w];
    }
    const slot = p.inventory.slot();
    const ammo = w === 'fists' ? '' : p.reloadTimer > 0 ? 'RELOAD' : `${slot.clip}/${slot.ammo}`;
    if (ammo !== this.shown.ammo) {
      this.shown.ammo = ammo;
      el.ammo!.textContent = ammo;
    }
    const stars = sim.wanted.level;
    const flash = sim.wanted.searching;
    if (stars !== this.shown.stars || flash !== this.shown.flash) {
      this.shown.stars = stars;
      this.shown.flash = flash;
      el.stars!.querySelectorAll('svg').forEach((s, i) => s.classList.toggle('on', i < stars));
      el.stars!.classList.toggle('flash', flash);
    }
    const status = this.statusText(sim);
    if (status !== this.shown.status) {
      this.shown.status = status;
      el.status!.textContent = status;
      el.status!.classList.toggle('hidden', !status);
    }

    // Zone changes.
    const pos = sim.playerPos();
    const zone = sim.world.zoneName(pos.x, pos.z);
    if (zone !== this.shown.zone) {
      if (this.shown.zone) this.flashZone(zone, '');
      this.shown.zone = zone;
    }

    // Prompt + crosshair.
    if (prompt) {
      el.prompt!.innerHTML = this.keyCaps(prompt);
      el.prompt!.classList.remove('hidden');
    } else el.prompt!.classList.add('hidden');
    // A reticle whenever a gun is out on foot: small and faint for hip fire, full while aiming (`aiming`
    // is the aim button), red while the muzzle is inside a wall (the shot would only hit that wall).
    const showCross = p.state === 'normal' && p.alive && !sim.playerDown && p.inventory.current !== 'fists';
    el.cross!.classList.toggle('show', showCross);
    el.cross!.classList.toggle('hip', showCross && !aiming);
    el.cross!.classList.toggle('blocked', showCross && sim.combat.muzzleBlocked(p));
    this.updateHitFeedback(dt, camYaw);

    this.drawRadar(sim, camYaw, time, dt);
  }

  /** Shows each 'Press E' in sim text (named after the QWERTY binding) as the key cap printed on the player's keyboard. */
  private keyCaps(text: string): string {
    return text.replace(/\b([Pp]ress) ([A-Z])\b/g, (_m, press: string, k: string) => `${press} <kbd>${escapeHtml(this.keys.label(`Key${k}`))}</kbd>`);
  }

  private statusText(sim: Sim): string {
    const m = sim.missions.active;
    if (m) {
      if (m.timer) return `${m.timer.label} ${formatTime(m.timer.endsAt - sim.time)}`;
      if (m.counter) return m.counter;
    }
    return sim.activities.status() ?? '';
  }

  private drawRadar(sim: Sim, camYaw: number, time: number, dt: number): void {
    const ctx = this.radarCtx;
    const W = this.radar.width;
    const H = this.radar.height;
    const cx = W / 2;
    const cy = H / 2;
    const p = sim.playerPos();
    const v = sim.player.vehicle;
    const speed = v ? v.speed : 0;
    const zoom = 0.75 - Math.min(0.3, speed / 120); // px per metre; zooms out at speed
    ctx.save();
    ctx.clearRect(0, 0, W, H);
    ctx.beginPath();
    ctx.arc(cx, cy, W / 2, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = '#16384f';
    ctx.fillRect(0, 0, W, H);
    // Rotate so that the camera's forward direction points up.
    ctx.translate(cx, cy);
    ctx.rotate(Math.PI + camYaw);
    ctx.scale(zoom / MAP_SCALE, zoom / MAP_SCALE);
    ctx.translate(-(p.x - this.map.minX) * MAP_SCALE, -(p.z - this.map.minZ) * MAP_SCALE);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.map.canvas, 0, 0);
    // GPS route to the waypoint or first objective.
    this.routeTimer -= dt;
    const target = this.waypoint ?? this.firstObjective(sim);
    if (target && this.routeTimer <= 0) {
      this.routeTimer = 1;
      this.route = gpsRoute(sim, target.x, target.z);
    }
    if (!target) this.route = [];
    if (this.route.length > 1) {
      ctx.strokeStyle = this.waypoint ? '#c04fff' : '#ffd23d';
      ctx.lineWidth = 6 / zoom;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      this.route.forEach((pt, i) => {
        const x = (pt.x - this.map.minX) * MAP_SCALE;
        const y = (pt.z - this.map.minZ) * MAP_SCALE;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
    }
    ctx.restore();

    // Blips in screen space.
    const range = W / 2 - 10;
    const toScreen = (x: number, z: number) => {
      const dx = (x - p.x) * zoom;
      const dz = (z - p.z) * zoom;
      const a = Math.PI + camYaw;
      const c = Math.cos(a);
      const s = Math.sin(a);
      return { x: cx + dx * c - dz * s, y: cy + dx * s + dz * c };
    };
    const blips = collectBlips(sim, time);
    if (this.waypoint) blips.push({ x: this.waypoint.x, z: this.waypoint.z, color: '#c04fff', label: '', sticky: true, shape: 'square' });
    for (const b of blips) {
      let s = toScreen(b.x, b.z);
      const dx = s.x - cx;
      const dy = s.y - cy;
      const d = Math.hypot(dx, dy);
      if (d > range) {
        if (!b.sticky) continue;
        s = { x: cx + (dx / d) * range, y: cy + (dy / d) * range };
      }
      drawBlip(ctx, b, s.x, s.y, b.shape === 'dot' ? 9 : 14);
    }
    // North marker.
    const n = toScreen(p.x, p.z - 10000);
    const nd = Math.hypot(n.x - cx, n.y - cy) || 1;
    const nx = cx + ((n.x - cx) / nd) * (W / 2 - 12);
    const ny = cy + ((n.y - cy) / nd) * (W / 2 - 12);
    ctx.fillStyle = '#ffffff';
    ctx.font = '700 16px Rajdhani, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 3;
    ctx.strokeText('N', nx, ny);
    ctx.fillText('N', nx, ny);
    // Player arrow (relative to the camera).
    const ph = sim.player.vehicle ? sim.player.vehicle.heading : sim.player.heading;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(-(ph - camYaw));
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, -10);
    ctx.lineTo(7, 8);
    ctx.lineTo(0, 4);
    ctx.lineTo(-7, 8);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
    // Health / armour ring.
    const hp = Math.max(0, sim.player.health) / sim.player.maxHealth;
    ctx.lineWidth = 5;
    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    ctx.beginPath();
    ctx.arc(cx, cy, W / 2 - 3, Math.PI * 0.6, Math.PI * 1.4);
    ctx.stroke();
    ctx.strokeStyle = hp > 0.5 ? '#6fd36f' : '#e2453c';
    ctx.beginPath();
    ctx.arc(cx, cy, W / 2 - 3, Math.PI * 1.4 - Math.PI * 0.8 * hp, Math.PI * 1.4);
    ctx.stroke();
  }

  private firstObjective(sim: Sim): { x: number; z: number } | null {
    const objs = [...(sim.missions.active?.markers ?? []), ...sim.activities.objectives()];
    const o = objs[0];
    if (!o) return null;
    const t = o.vehicle ?? o.character;
    return t ? { x: t.pos.x, z: t.pos.z } : { x: o.x, z: o.z };
  }
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export function weaponName(id: WeaponId): string {
  return WEAPONS[id].name;
}
