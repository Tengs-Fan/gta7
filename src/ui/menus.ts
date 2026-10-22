// Menu screens (title, pause, map, stats, controls, settings, shop, credits)
// managed as a stack. Keyboard, gamepad and mouse can all drive them.

import { clamp, formatMoney } from '../core/math';
import { KeyLabels, WHEEL_GESTURE_GAP, WHEEL_STEP, type UiActions } from '../input/input';
import { QUALITY, type QualityTier } from '../render/quality';
import type { Sim } from '../sim/sim';
import { shopItems } from '../sim/interactions';
import { PACKAGE_COUNT } from '../sim/pickups';
import { formatRunTime } from '../sim/streetRuns';
import type { Settings } from '../settings';
import { padGlyph, type InputDevice } from './glyphs';
import { escapeHtml } from './hud';
import { collectBlips, drawBlip, drawPoliceOverlay, MAP_SCALE, type Blip, type MapImage } from './mapRender';

export interface MenuHost {
  hasSave(): boolean;
  newGame(): void;
  /** Start the standalone driving challenge from the title screen. */
  startStreetRun?(id?: string): void;
  streetRunCourses?(): Array<{ id: string; title: string; description: string; best?: number; target?: number; distance?: number; reward?: number }>;
  continueGame(): void;
  resume(): void;
  quitToTitle(): void;
  abandonMission(): void;
  /** Retry the retained failed attempt, including after the quick retry prompt expires. */
  retryMission?(): void;
  settings(): Settings;
  applySettings(s: Settings): void;
  deleteSave(): void;
  sim(): Sim | null;
  setWaypoint(p: { x: number; z: number } | null): void;
  waypoint(): { x: number; z: number } | null;
  click(): void;
  /** The tier 'auto' picked at boot, and whether the renderer was created with MSAA (only a reload changes that). */
  quality?(): { auto: QualityTier; msaa: boolean; software?: boolean };
}

interface Screen {
  el: HTMLElement;
  /** Called every frame while on top, once the screen's input guard is over (dt: the frame time). */
  input(ui: UiActions, dt: number): void;
  /**
   * Called every frame while on top, also during the input guard (for animated screens like the map). `ui` is that
   * frame's input, to watch what is held, never to act on: during the guard it may be the key that opened the screen.
   */
  tick?(dt: number, ui: UiActions): void;
  /** Called when the screen is on top again after the one above it closed. */
  refresh?(): void;
  close?(): void;
  /** The screen pans with the left stick itself (the map): the stick makes it no up / down / left / right steps. */
  pans?: boolean;
}

type StickDir = 'up' | 'down' | 'left' | 'right';
/** The left stick steps a menu once pushed past STICK_PRESS along its main axis, and is let go below STICK_RELEASE... */
const STICK_PRESS = 0.5;
const STICK_RELEASE = 0.3;
/** ...and held, it steps again after STICK_REPEAT_DELAY seconds, then every STICK_REPEAT seconds. */
const STICK_REPEAT_DELAY = 0.4;
const STICK_REPEAT = 0.13;

/** How far the stick (x, y) leans the way of `dir`. */
function stickAlong(dir: StickDir, x: number, y: number): number {
  return dir === 'right' ? x : dir === 'left' ? -x : dir === 'down' ? y : -y;
}

/** NEW GAME's question when there is a save: the new game's first save replaces it. */
export const NEW_GAME_WARNING = 'Start a new game? Your saved game will be replaced the next time the game saves (after a mission or at the safehouse).';

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

  /** `initial`: the item selected at first, or the first enabled one after it (else the first enabled one). */
  constructor(items: Array<{ label: string; action: () => void; disabled?: boolean; id?: string; description?: string }>, private readonly click: () => void, initial = 0) {
    for (const it of items) {
      const b = h('button');
      b.textContent = it.label;
      b.ariaLabel = it.label;
      b.disabled = !!it.disabled;
      if (it.id) b.dataset.id = it.id;
      if (it.description) {
        b.dataset.description = it.description;
        b.ariaDescription = it.description;
      }
      b.addEventListener('click', () => {
        if (b.disabled) return;
        this.click();
        it.action();
      });
      // The mouse picks what it really moves over: never a greyed-out item (which would swallow Enter),
      // and not one that a new screen puts under a resting cursor.
      b.addEventListener('mousemove', () => {
        const i = this.buttons.indexOf(b);
        if (!b.disabled && i !== this.sel) this.select(i);
      });
      // Tab focus and the game's arrow / stick selection should always name the same action.
      b.addEventListener('focus', () => this.select(this.buttons.indexOf(b)));
      this.el.appendChild(b);
      this.buttons.push(b);
    }
    const from = this.buttons.findIndex((b, i) => i >= initial && !b.disabled);
    this.sel = from >= 0 ? from : this.buttons.findIndex((b) => !b.disabled);
    this.select(this.sel);
  }

  private select(i: number): void {
    if (i < 0) return;
    this.sel = i;
    this.buttons.forEach((b, k) => b.classList.toggle('sel', k === i));
    this.buttons[i]?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
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
  /** The device of the last input (see input()): the map and shop name its buttons. */
  private device: InputDevice = 'kb';
  /**
   * The left stick's steps (see stickStep): the direction it holds, the time to its next step, and whether it has been
   * seen at rest since the top screen appeared (held from play or through the press that opened it, it does nothing).
   */
  private stick: { dir: StickDir | null; wait: number; armed: boolean } = { dir: null, wait: 0, armed: false };

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
    this.stick = { dir: null, wait: 0, armed: false };
  }

  pop(): void {
    const s = this.stack.pop();
    if (!s) return;
    s.close?.();
    s.el.remove();
    this.top?.el.classList.remove('hidden');
    this.top?.refresh?.();
    this.age = 0;
    this.stick = { dir: null, wait: 0, armed: false };
  }

  closeAll(): void {
    while (this.stack.length) this.pop();
  }

  /** One frame of input for the top screen; `device` is the one that produced the last input (keyboard and mouse, or a pad). */
  input(ui: UiActions, dt: number, device?: InputDevice): void {
    if (device) this.device = device;
    const s = this.top;
    if (!s) return;
    this.age += dt;
    s.tick?.(dt, ui);
    const step = this.stickStep(ui, dt, s);
    if (this.age < 0.25) return;
    s.input(step ? { ...ui, [step]: true } : ui, dt);
  }

  /**
   * This frame's step of the left stick through screen `s`, as a D-pad press: once it is pushed past STICK_PRESS along
   * its main axis (one axis only: a slant does not both pick a settings row and change it), then again while it is held
   * (STICK_REPEAT_*), until it is let go below STICK_RELEASE. None until it has been seen at rest since the screen
   * appeared (see stick), during the screen's input guard, or on the map, which it pans.
   */
  private stickStep(ui: UiActions, dt: number, s: Screen): StickDir | null {
    const st = this.stick;
    // A broken pad axis (NaN) reads as at rest: it must neither step nor hold a step.
    const x = Number.isFinite(ui.stickX) ? ui.stickX! : 0;
    const y = Number.isFinite(ui.stickY) ? ui.stickY! : 0;
    if (st.dir !== null && stickAlong(st.dir, x, y) < STICK_RELEASE) st.dir = null;
    if (Math.max(Math.abs(x), Math.abs(y)) < STICK_RELEASE) st.armed = true;
    if (!st.armed || s.pans || this.age < 0.25) return null;
    if (st.dir === null) {
      const dir: StickDir = Math.abs(x) > Math.abs(y) ? (x > 0 ? 'right' : 'left') : y > 0 ? 'down' : 'up';
      if (stickAlong(dir, x, y) <= STICK_PRESS) return null;
      st.dir = dir;
      st.wait = STICK_REPEAT_DELAY;
      return dir;
    }
    st.wait -= dt;
    if (st.wait > 0) return null;
    st.wait = Math.max(st.wait + STICK_REPEAT, 0);
    return st.dir;
  }

  // ---------------------------------------------------------------------------

  /** Title menu; `notice` is an optional one-line message under the buttons. */
  showTitle(notice?: string): void {
    this.closeAll();
    const el = h('div', 'screen title-screen');
    el.appendChild(h('div', 'title-shade'));
    const wrap = h('div', 'title-wrap');
    wrap.appendChild(h('div', 'title-eyebrow', '<span class="title-mark"></span> SAN AZURA / AN OPEN WORLD CRIME SANDBOX'));
    const intro = h('div', 'title-intro');
    intro.appendChild(h('div', 'logo', '<span class="gta">GTA</span><span class="seven">7</span><span class="sub">GRAND TURBO ANARCHY</span>'));
    intro.appendChild(h('p', 'title-copy', 'A city of opportunity.<br>A spectacular way to get in trouble.'));
    wrap.appendChild(intro);
    const list = new ButtonList(
      [
        { label: 'CONTINUE', action: () => this.host.continueGame(), disabled: !this.host.hasSave(), id: 'continue', description: 'Pick up where you left off' },
        // There is one save slot, and the new game's first save (a passed mission, the safehouse) overwrites it.
        {
          label: 'NEW GAME',
          action: () => (this.host.hasSave() ? this.confirm(NEW_GAME_WARNING, () => this.host.newGame()) : this.host.newGame()),
          id: 'new',
          description: 'Meet the city. Make a name for yourself.',
        },
        ...(this.host.startStreetRun ? [{
          label: 'STREET RUN', id: 'street-run', description: 'Get behind the wheel. Beat the clock.',
          action: () => this.showStreetRuns(),
        }] : []),
        { label: 'CONTROLS', action: () => this.showControls() },
        { label: 'SETTINGS', action: () => this.showSettings() },
        { label: 'CREDITS', action: () => this.showCredits() },
      ],
      () => this.host.click(),
    );
    list.el.classList.add('title-menu');
    if (notice) list.el.appendChild(h('div', 'title-note', escapeHtml(notice)));
    wrap.appendChild(list.el);
    wrap.appendChild(h('div', 'title-input-note', 'KEYBOARD + MOUSE / GAMEPAD'));
    wrap.appendChild(h('div', 'title-foot', 'An original parody sandbox. All names are fictional. Not affiliated with Rockstar Games or Take-Two Interactive.'));
    el.appendChild(wrap);
    el.appendChild(h('div', 'title-world-caption', '<span>WELCOME TO</span><strong>SAN<br>AZURA.</strong><small>GOOD WEATHER. BAD DECISIONS.</small>'));
    this.push({
      el,
      input: (ui) => list.input(ui),
      // The save may have been deleted from SETTINGS meanwhile.
      refresh: () => list.setDisabled('continue', !this.host.hasSave()),
    });
  }

  /** A real course selection, including the player's saved bests, before entering a car. */
  showStreetRuns(): void {
    const courses = this.host.streetRunCourses?.() ?? [];
    if (!courses.length) {
      this.host.startStreetRun?.();
      return;
    }
    const el = h('div', 'screen dim');
    const panel = h('div', 'panel runs-panel');
    panel.appendChild(h('div', 'panel-eyebrow', 'SAN AZURA / STREET SERIES'));
    panel.appendChild(h('h2', '', 'PICK YOUR RUN.'));
    panel.appendChild(h('p', 'runs-intro', 'A fast car. A clear route. Your time to beat.<br>Cross every gate in order and bring it home for gold.'));
    const list = new ButtonList([
      ...courses.map((c) => {
        const meta = [
          c.distance !== undefined ? `${(c.distance / 1000).toFixed(1)} KM` : '',
          c.target !== undefined ? `GOLD ${formatRunTime(c.target)}` : '',
          c.best !== undefined ? `BEST ${formatRunTime(c.best)}` : 'NO TIME SET',
          c.reward !== undefined ? `UP TO ${formatMoney(c.reward)}` : '',
        ].filter(Boolean).join('  /  ');
        return {
          label: c.title.toUpperCase(), description: `${c.description}\n${meta}`,
          action: () => this.host.startStreetRun?.(c.id), id: `course-${c.id}`,
        };
      }),
      { label: 'BACK', action: () => this.pop(), id: 'courses-back' },
    ], () => this.host.click());
    list.el.classList.add('course-menu');
    panel.appendChild(list.el);
    el.appendChild(panel);
    this.push({ el, input: (ui) => ui.back ? this.pop() : list.input(ui) });
  }

  showPause(): void {
    const sim = this.host.sim();
    const m = sim?.missions.active ?? null;
    const retry = this.host.retryMission ? sim?.missions.retryMenuOffer() : null;
    const el = h('div', 'screen dim');
    const panel = h('div', 'panel pause-panel');
    panel.style.width = 'min(520px, 92vw)';
    panel.appendChild(h('div', 'panel-eyebrow', 'SAN AZURA / TAKE A BREATHER'));
    panel.appendChild(h('h2', '', 'PAUSED'));
    const items: Array<{ label: string; action: () => void; id?: string; description?: string; disabled?: boolean }> = [
      { label: 'RESUME', action: () => this.host.resume() },
      { label: 'MAP', action: () => this.showMap() },
      { label: 'STATS', action: () => this.showStats() },
      { label: 'CONTROLS', action: () => this.showControls() },
      { label: 'SETTINGS', action: () => this.showSettings() },
    ];
    // An abandoned mission offers no retry: it starts over from its contact. Once its goal is met (MissionCtx.won) it
    // is passed whatever happens during the closing lines, an abandon included, so there is nothing to abandon. The
    // sim stands still while this menu is open, so that cannot change under it.
    if (m && !m.won) items.push({ label: 'ABANDON MISSION', action: () => this.confirm('Abandon the mission? You will have to start it again from the beginning.', () => this.host.abandonMission()) });
    if (retry) items.push({
      label: retry.checkpoint > 0 ? 'RETRY FROM CHECKPOINT' : 'RETRY MISSION',
      id: 'retry-mission',
      description: `${retry.title} · ${retry.blocked ?? (retry.checkpoint > 0 ? 'Resume from your last checkpoint.' : 'Start this attempt again.')}`,
      disabled: !!retry.blocked,
      action: () => this.host.retryMission?.(),
    });
    const quitWarning = retry ? 'Quit to the title screen? This mission retry and its checkpoint will be lost. Completed missions remain saved.' : 'Quit to the title screen? Unsaved progress will be lost.';
    items.push({ label: 'QUIT TO TITLE', action: () => this.confirm(quitWarning, () => this.host.quitToTitle()) });
    const list = new ButtonList(items, () => this.host.click());
    panel.appendChild(list.el);
    if (sim) {
      // Past the goal the objective line is stale (or empty, then the blurb would read as still to do).
      const doing = m ? (m.won ? 'complete' : escapeHtml(m.objectiveText || m.def.blurb)) : '';
      const job = sim.activities.job;
      const activity = job?.kind === 'streetRun' ? `<b>${escapeHtml(job.course.name)}</b><br>${escapeHtml(sim.activities.status() ?? '')}` : escapeHtml(sim.activities.status() ?? '');
      panel.appendChild(h('p', 'pause-context', m ? `Mission: <b>${escapeHtml(m.def.title)}</b> — ${doing}` : activity || `Zone: <b>${escapeHtml(sim.world.zoneName(sim.playerPos().x, sim.playerPos().z))}</b> · ${sim.clock.label()} · Day ${sim.clock.day}`));
    }
    el.appendChild(panel);
    this.push({ el, input: (ui) => (ui.back || ui.pause ? this.host.resume() : list.input(ui)) });
  }

  /**
   * A yes / no question over the current screen. Every one guards something that cannot be undone, so it
   * opens on NO: a second press of the key that asked it (or menu mashing) never accepts it.
   */
  confirm(text: string, yes: () => void): void {
    const el = h('div', 'screen dim');
    const panel = h('div', 'panel');
    panel.style.width = 'min(520px, 92vw)';
    panel.appendChild(h('p', '', escapeHtml(text)));
    const list = new ButtonList(
      [
        { label: 'YES', action: () => { this.pop(); yes(); }, id: 'yes' },
        { label: 'NO', action: () => this.pop(), id: 'no' },
      ],
      () => this.host.click(),
      1,
    );
    panel.appendChild(list.el);
    el.appendChild(panel);
    this.push({ el, input: (ui) => (ui.back ? this.pop() : list.input(ui)) });
  }

  /**
   * Keyboard and gamepad scrolling for a panel that can be taller than the window (CONTROLS, STATS, CREDITS):
   * up / down move it by half its height, and focus() lets Page Up / Down, Home and End scroll it natively.
   * A cue at its bottom edge shows while there is more below, which overlay scrollbars do not.
   */
  private scroller(panel: HTMLElement): { input(ui: UiActions): void; tick(): void; focus(): void } {
    panel.tabIndex = -1;
    const cue = h('div', 'scroll-cue hidden');
    panel.appendChild(cue);
    return {
      input: (ui) => {
        const d = (ui.down ? 1 : 0) - (ui.up ? 1 : 0);
        if (d !== 0) panel.scrollBy?.({ top: d * Math.max(80, panel.clientHeight * 0.5), behavior: 'smooth' });
      },
      tick: () => cue.classList.toggle('hidden', !(panel.scrollHeight - panel.clientHeight - panel.scrollTop > 2)),
      focus: () => panel.focus?.({ preventScroll: true }),
    };
  }

  /** Pushes a panel screen that BACK, back or confirm closes and up / down scroll (see scroller). */
  private pushScrolling(el: HTMLElement, panel: HTMLElement): void {
    const row = h('div', 'row-end');
    const back = h('button', 'btn primary', 'BACK');
    back.addEventListener('click', () => this.pop());
    row.appendChild(back);
    panel.appendChild(row);
    const scroll = this.scroller(panel);
    el.appendChild(panel);
    this.push({ el, input: (ui) => (ui.back || ui.confirm ? this.pop() : scroll.input(ui)), tick: scroll.tick });
    scroll.focus();
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
      ['Side job / Street run', k('KeyT')],
      ['Camera distance', k('KeyV')],
      ['Map', k('KeyM')],
      ['Pause', `Esc / ${k('KeyP')}`],
    ];
    // As Input.poll() binds them: several buttons do one thing on foot and another in a vehicle.
    const pad: Array<[string, string]> = [
      ['Move / Steer', 'Left stick'],
      ['Look', 'Right stick'],
      ['Shoot (on foot) / Accelerate', 'RT'],
      ['Aim (on foot) / Brake', 'LT'],
      ['Jump (on foot)', 'X'],
      ['Shoot from a vehicle', 'X'],
      ['Handbrake', 'RB / A'],
      ['Sprint', 'A'],
      ['Enter / Exit', 'Y'],
      ['Reload', 'B'],
      ['Weapons (LB in a vehicle)', 'LB / RB'],
      ['Horn (in a vehicle)', 'L3'],
      ['Camera distance', 'R3'],
      ['Interact', 'D-pad up'],
      ['Radio', 'D-pad left/right'],
      ['Side job / Street run', 'D-pad down'],
      ['Map / Pause', 'Back / Start'],
    ];
    const grid = (rows: Array<[string, string]>) => `<div class="keys">${rows.map(([a, b]) => `<div><span>${a}</span><span>${escapeHtml(b)}</span></div>`).join('')}</div>`;
    panel.innerHTML = `<h2>CONTROLS</h2><h3>Keyboard &amp; mouse</h3>${grid(kb)}<h3>Gamepad</h3>${grid(pad)}
      <h3>Tips</h3><p>Steal any car with <kbd>${escapeHtml(k('KeyF'))}</kbd>, even with someone inside. Lose the cops by breaking line of sight or by driving into a Spray Shack. Hidden packages, stunt ramps and rampages are scattered across San Azura. Drive a taxi or police car and press <kbd>${escapeHtml(k('KeyT'))}</kbd> for side jobs.</p>
      <h3>Street runs</h3><p>Choose a course from the title screen, or press <kbd>${escapeHtml(k('KeyT'))}</kbd> in an ordinary road car to find the nearest run. Stop in the start gate, then follow the gold route through every checkpoint in order. Brake before the corners and use the handbrake to turn sharply. Gold, silver and bronze finishes pay cash; your best time is saved. Press <kbd>${escapeHtml(k('KeyT'))}</kbd> again to cancel.</p>`;
    this.pushScrolling(el, panel);
  }

  showCredits(): void {
    const el = h('div', 'screen dim');
    const panel = h('div', 'panel credits-roll');
    panel.innerHTML = `<h2>CREDITS</h2>
      <p><b>GTA 7: Grand Turbo Anarchy</b><br>An original open-world sandbox built for the browser.</p>
      <p>Everything you see and hear is generated at runtime: the city, the cars, the people, the textures, the sound effects and the three radio stations.</p>
      <p>Built with three.js, TypeScript and Vite. Fonts: Anton &amp; Rajdhani (SIL Open Font License).</p>
      <p>All characters, places, vehicles and brands are fictional. Any resemblance to real persons or businesses is coincidental. This is a fan-made parody and is not affiliated with Rockstar Games or Take-Two Interactive.</p>`;
    this.pushScrolling(el, panel);
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
    const runs = sim.activities.streetRunCourses().map((c) => {
      const record = p.streetRuns[c.id];
      return `<span>${escapeHtml(c.name)}</span><span>${record ? `${formatRunTime(record.bestTime)} · ${record.medal.toUpperCase()} · ${record.finishes} finish${record.finishes === 1 ? '' : 'es'}` : 'NO TIME SET'}</span>`;
    }).join('');
    panel.innerHTML = `<h2>STATS</h2><div class="stat-grid">${rows.map(([a, b]) => `<span>${a}</span><span>${b}</span>`).join('')}</div><h3>Street run records</h3><div class="run-records">${runs}</div>`;
    this.pushScrolling(el, panel);
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
      // As in ButtonList: only a real mouse move picks a row, and never a skipped one (DELETE SAVE greyed out).
      r.el.addEventListener('mousemove', () => {
        if (i !== sel && !r.skip?.()) select(i);
      });
      r.el.addEventListener('focusin', () => {
        if (!r.skip?.()) select(i);
      });
    };
    const slider = (label: string, key: 'master' | 'music' | 'sfx' | 'sensitivity' | 'fov', min: number, max: number, stepv: number, keyStep: number, fmt: (v: number) => string) => {
      const row = h('div', 'setting');
      const lab = h('span', '', label);
      const input = h('input');
      input.type = 'range';
      input.ariaLabel = label;
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
    const qualities = ['auto', 'low', 'medium', 'high'] as const;
    const qinfo = this.host.quality?.() ?? null;
    const qrow = h('div', 'setting');
    const qsel = h('select');
    qsel.ariaLabel = 'Graphics quality';
    for (const q of qualities) {
      const o = h('option');
      o.value = q;
      o.textContent = q === 'auto' && qinfo ? `AUTO (${qinfo.auto.toUpperCase()})` : q.toUpperCase();
      if (s.quality === q) o.selected = true;
      qsel.appendChild(o);
    }
    // Everything else applies at once; anti-aliasing is fixed when the renderer is created.
    const qnote = h('div', 'setting-note');
    const showNote = () => {
      if (qinfo?.software) {
        qnote.textContent = 'Software rendering detected. Hardware acceleration improves performance.';
        qnote.classList.remove('hidden');
        return;
      }
      const tier = s.quality === 'auto' ? qinfo?.auto : s.quality;
      const msaa = tier ? QUALITY[tier].msaa : null;
      const pending = qinfo !== null && msaa !== null && msaa !== qinfo.msaa;
      qnote.textContent = pending ? `Anti-aliasing turns ${msaa ? 'on' : 'off'} after a reload.` : '';
      qnote.classList.toggle('hidden', !pending);
    };
    const setQuality = (q: Settings['quality']) => {
      s.quality = q;
      qsel.value = q;
      showNote();
      apply();
    };
    qsel.addEventListener('change', () => setQuality(qsel.value as Settings['quality']));
    qrow.append(h('span', '', 'Graphics quality'), qsel, h('span', '', ''), qnote);
    showNote();
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
    // On / off rows: a checkbox, with its state spelled out in the value column like the sliders'.
    const toggle = (label: string, key: 'invertY' | 'hints' | 'lightningFlashes') => {
      const row = h('div', 'setting');
      const box = h('input');
      box.type = 'checkbox';
      box.ariaLabel = label;
      box.checked = s[key];
      box.style.pointerEvents = 'auto';
      const val = h('span', '', s[key] ? 'On' : 'Off');
      const set = (v: boolean) => {
        s[key] = v;
        box.checked = v;
        val.textContent = v ? 'On' : 'Off';
        apply();
      };
      box.addEventListener('change', () => set(box.checked));
      row.append(h('span', '', label), box, val);
      panel.appendChild(row);
      addRow({ el: row, adjust: () => set(!s[key]), activate: () => set(!s[key]) });
    };
    toggle('Invert look Y', 'invertY');
    toggle('Tutorial hints', 'hints');
    const weathers: ReadonlyArray<readonly [Settings['weather'], string]> = [['dynamic', 'Dynamic'], ['clear', 'Always clear']];
    const wrow = h('div', 'setting');
    const wsel = h('select');
    wsel.ariaLabel = 'Weather';
    for (const [v, label] of weathers) {
      const o = h('option');
      o.value = v;
      o.textContent = label;
      if (s.weather === v) o.selected = true;
      wsel.appendChild(o);
    }
    const setWeather = (v: Settings['weather']) => {
      s.weather = v;
      wsel.value = v;
      apply();
    };
    wsel.addEventListener('change', () => setWeather(wsel.value === 'clear' ? 'clear' : 'dynamic'));
    wrow.append(h('span', '', 'Weather'), wsel, h('span', '', ''));
    panel.appendChild(wrow);
    addRow({ el: wrow, adjust: () => setWeather(s.weather === 'clear' ? 'dynamic' : 'clear'), activate: () => setWeather(s.weather === 'clear' ? 'dynamic' : 'clear') });
    toggle('Lightning flashes', 'lightningFlashes');
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
      r.addEventListener('mousemove', () => {
        if (sel === i) return;
        sel = i;
        render();
      });
      rows.push(r);
      list.appendChild(r);
    });
    render();
    panel.append(head, money, list, msg);
    // How to buy, for the device in use (Enter has no pad button, and Start, the pad's Esc, does not leave), beside LEAVE.
    const row = h('div', 'row-end');
    const how = h('div', 'shop-how');
    let howDevice: InputDevice | null = null;
    const showHow = () => {
      howDevice = this.device;
      how.innerHTML = this.device === 'pad' ? `${padGlyph('up')}${padGlyph('down')} to choose · ${padGlyph('a')} to buy · ${padGlyph('b')} to leave` : 'Click or press <kbd>Enter</kbd> to buy, <kbd>Esc</kbd> to leave.';
    };
    showHow();
    const back = h('button', 'btn primary', 'LEAVE');
    back.addEventListener('click', () => {
      this.pop();
    });
    row.append(how, back);
    panel.appendChild(row);
    el.appendChild(panel);
    this.push({
      el,
      tick: () => {
        if (howDevice !== this.device) showHow();
      },
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
    // The cross in the middle, where the keyboard and a pad set the waypoint: the view centre (cx, cz) is
    // drawn at the middle of the canvas, which fills the screen, so CSS puts it there at any pixel ratio.
    el.appendChild(h('div', 'map-cross'));
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
          ['#3a6bff', 'Police station'],
          ['#ff3030', 'Police unit'],
          ['rgba(255, 48, 48, 0.55)', 'Search area'],
          ['#c04fff', 'Waypoint'],
        ]
          .map(([c, t]) => `<div><i style="background:${c}"></i>${t}</div>`)
          .join(''),
      ),
    );
    // What to press, for the device in use: the keyboard and a pad set the waypoint at the cross in the middle.
    const hint = h('div', 'map-hint');
    el.appendChild(hint);
    let hintDevice: InputDevice | null = null;
    const showHint = () => {
      hintDevice = this.device;
      hint.innerHTML =
        this.device === 'pad'
          ? `${padGlyph('a')} waypoint at the cross (again to clear it) · Left stick or D-pad to pan · ${padGlyph('lb')} ${padGlyph('rb')} to zoom · ${padGlyph('b')} to close`
          : `Click, or <kbd>Enter</kbd> at the cross, to set a waypoint (again to clear it) · Drag or arrow keys to pan · Wheel or <kbd>+</kbd> <kbd>-</kbd> to zoom · <kbd>${escapeHtml(this.keys.label('KeyM'))}</kbd>/<kbd>Esc</kbd> to close`;
    };
    showHint();
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
    // A direction held since before the map opened (W while driving, the left stick while steering) must not pan it by
    // itself: each axis pans only once it has been seen at rest since the map opened. tick() watches from the first
    // frame on, the input guard included, so a key pressed right after the map opened still pans. Presses still step.
    let freeX = false;
    let freeY = false;
    // The map's size on the page (CSS px), measured at each draw: the view, clicks, the waypoint's 16 px and the pan
    // speed are all in it, whatever the canvas's backing store (see draw).
    let vw = window.innerWidth;
    let vh = window.innerHeight;
    const scale = () => {
      const base = Math.min(vw / (this.map.canvas.width / MAP_SCALE), vh / (this.map.canvas.height / MAP_SCALE));
      return base * Math.pow(1.5, zoom);
    };
    const toWorld = (sx: number, sy: number) => {
      const k = scale();
      return { x: cx + (sx - vw / 2) / k, z: cz + (sy - vh / 2) / k };
    };
    const draw = (time: number) => {
      vw = Math.max(1, el.clientWidth || window.innerWidth);
      vh = Math.max(1, el.clientHeight || window.innerHeight);
      // Backed at the device pixel ratio (at most 2; read every frame, as browser zoom and another monitor change it),
      // so lines and labels are sharp on HiDPI screens. Everything below is drawn in CSS px through the transform,
      // which resizing the canvas resets.
      const dpr = Math.min(2, window.devicePixelRatio > 0 ? window.devicePixelRatio : 1);
      const bw = Math.max(1, Math.round(vw * dpr));
      const bh = Math.max(1, Math.round(vh * dpr));
      if (canvas.width !== bw || canvas.height !== bh) {
        canvas.width = bw;
        canvas.height = bh;
      }
      ctx.setTransform(bw / vw, 0, 0, bh / vh, 0, 0);
      const k = scale();
      ctx.fillStyle = '#08111a';
      ctx.fillRect(0, 0, vw, vh);
      ctx.save();
      ctx.translate(vw / 2, vh / 2);
      ctx.scale(k / MAP_SCALE, k / MAP_SCALE);
      ctx.translate(-(cx - this.map.minX) * MAP_SCALE, -(cz - this.map.minZ) * MAP_SCALE);
      ctx.drawImage(this.map.canvas, 0, 0);
      drawPoliceOverlay(ctx, sim, this.map, time, k / MAP_SCALE);
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
        let mx = group.reduce((a, b) => a + (b.rect.minX + b.rect.maxX) / 2, 0) / group.length;
        let mz = group.reduce((a, b) => a + (b.rect.minZ + b.rect.maxZ) / 2, 0) / group.length;
        // The middle of a district wrapped round another (Midtown round Downtown) lies in that one: there the label goes
        // on the district's own block nearest to it.
        if (sim.world.zoneName(mx, mz) !== blk.zone) {
          const centre = (b: (typeof group)[number]) => ({ x: (b.rect.minX + b.rect.maxX) / 2, z: (b.rect.minZ + b.rect.maxZ) / 2 });
          const near = group.map(centre).reduce((a, c) => (Math.hypot(c.x - mx, c.z - mz) < Math.hypot(a.x - mx, a.z - mz) ? c : a));
          mx = near.x;
          mz = near.z;
        }
        const sx = vw / 2 + (mx - cx) * k;
        const sy = vh / 2 + (mz - cz) * k;
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
      for (const b of blips) drawBlip(ctx, b, vw / 2 + (b.x - cx) * k, vh / 2 + (b.z - cz) * k, 18);
      const p = sim.playerPos();
      const ph = sim.player.vehicle ? sim.player.vehicle.heading : sim.player.heading;
      ctx.save();
      ctx.translate(vw / 2 + (p.x - cx) * k, vh / 2 + (p.z - cz) * k);
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
    /** Sets a waypoint at a point of the world, or clears the one within 16 px of it on the map. */
    const toggleWaypointAt = (w: { x: number; z: number }) => {
      const cur = this.host.waypoint();
      if (cur && Math.hypot(cur.x - w.x, cur.z - w.z) * scale() < 16) this.host.setWaypoint(null);
      else this.host.setWaypoint(w);
      this.host.click();
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
      toggleWaypointAt(toWorld(e.clientX - r.left, e.clientY - r.top));
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
      input: (ui, dt) => {
        if (ui.back || ui.map || ui.pause) {
          this.pop();
          return;
        }
        if (ui.confirm) toggleWaypointAt({ x: cx, z: cz });
        if (ui.zoomIn) zoom = clamp(zoom + 0.5, 0, 4);
        if (ui.zoomOut) zoom = clamp(zoom - 0.5, 0, 4);
        // Each press (arrows / WASD, the D-pad) steps the view 60 px, also a tap whose key is up again before
        // Input polls and so is never seen held. Held, they and the left stick pan it on, by up to 0.8 of its
        // height a second (its size on the page, as the pointer handlers measure it), once let go since it opened.
        const k = scale();
        cx += (((ui.right ? 1 : 0) - (ui.left ? 1 : 0)) * 60) / k;
        cz += (((ui.down ? 1 : 0) - (ui.up ? 1 : 0)) * 60) / k;
        const speed = (0.8 * Math.min(vw, vh)) / k;
        if (freeX) cx += (ui.panX ?? 0) * speed * dt;
        if (freeY) cz += (ui.panY ?? 0) * speed * dt;
      },
      tick: (dt, ui) => {
        if (!ui.panX) freeX = true;
        if (!ui.panY) freeY = true;
        t += dt;
        if (hintDevice !== this.device) showHint();
        draw(t);
      },
      close: onClose,
      pans: true,
    });
  }
}
