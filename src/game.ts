// Top-level game: owns the world, the current simulation, the renderer, input,
// HUD, menus and audio, and runs the frame loop.

import { AudioEngine } from './audio/audio';
import { Input, type FrameInput } from './input/input';
import { GameRenderer } from './render/renderer';
import { deleteGame, loadGame, loadSettings, MAX_HINTS_SEEN, saveSettings, writeGame, type Settings } from './settings';
import type { Vehicle } from './sim/entities';
import { neutralInput } from './sim/input';
import { applySave, serialize, type SaveData } from './sim/progress';
import { Sim } from './sim/sim';
import { WEAPON_ORDER, type WeaponId } from './sim/specs';
import { HintSystem } from './ui/hints';
import { Hud } from './ui/hud';
import { MapImage } from './ui/mapRender';
import { Menus, type MenuHost } from './ui/menus';
import { StaticWorld } from './world/staticWorld';

export const CHEATS = ['CHILLOUT', 'GUNSGALORE', 'FIXMYRIDE', 'IMMORTAL', 'MONEYTREE', 'SUNSET', 'NIGHTOWL', 'SPAWNSPORTS', 'COPMAGNET'] as const;

/** Seconds into a fresh game before Mama Lou calls with the first mission. */
export const INTRO_DELAY = 2.5;
/** Keys are named by their QWERTY binding: the HUD draws them for the player's layout or pad. */
const WELCOME = 'Welcome to San Azura. Mama Lou has work for you: follow the <b class="lou">pink route</b> to the <b class="lou">L</b> on your radar. Steal a ride with <kbd>F</kbd>.';
/** With her call coming in, the route to her is no longer the thing to read. */
const WELCOME_CALL = 'Welcome to San Azura. Mama Lou has work for you. Steal a ride with <kbd>F</kbd>.';

/** Whether the page URL turns the opening call off (?intro=0, used by tests and playtests). */
function introOffByUrl(): boolean {
  try {
    return typeof location !== 'undefined' && new URLSearchParams(location.search).get('intro') === '0';
  } catch {
    return false;
  }
}

export class Game {
  readonly world: StaticWorld;
  readonly renderer: GameRenderer;
  readonly input: Input;
  readonly hud: Hud;
  readonly menus: Menus;
  readonly audio = new AudioEngine();
  readonly mapImage: MapImage;
  sim: Sim;
  mode: 'title' | 'game' = 'title';
  settings: Settings;
  fps = 60;
  frames = 0;
  private last = 0;
  private running = false;
  private fpsTime = 0;
  private fpsFrames = 0;
  private crashed = false;
  private unsub: Array<() => void> = [];
  private wasDown = false;
  /** Total real time spent in frames (for tests). */
  readonly perf = { frameMs: 0, simMs: 0, renderMs: 0 };
  /** ?intro=0 in the URL, read once. */
  private readonly introOff = introOffByUrl();
  /** Seconds until Lou's opening call on a fresh game; not positive when no call is pending. */
  private introTimer = -1;
  /** First-time tutorial hints and the steal prompt, remembered in the settings. */
  readonly hints = new HintSystem({
    enabled: () => this.settings.hints,
    seen: () => this.settings.hintsSeen,
    markSeen: (id) => this.markHintSeen(id),
    show: (html, duration, opts) => this.hud.help(html, duration, 'hint', opts),
    pending: (id) => this.hud.hintPending(id),
  });

  constructor(private readonly canvas: HTMLCanvasElement, private readonly ui: HTMLElement) {
    this.settings = loadSettings();
    this.world = new StaticWorld();
    this.mapImage = new MapImage(this.world);
    this.renderer = new GameRenderer(canvas, this.world, { quality: this.settings.quality, fov: this.settings.fov });
    this.input = new Input(canvas);
    this.input.attach();
    this.input.wantsPointerLock = () => this.mode === 'game' && !this.menus.open && !this.crashed;
    this.hud = new Hud(ui, this.mapImage, this.input.labels);
    this.hud.setVisible(false);
    this.menus = new Menus(ui, this.menuHost(), this.mapImage, this.input.labels);
    this.applySettings(this.settings, false);
    this.sim = this.makeTitleSim();
    this.renderer.attach(this.sim);
    this.renderer.cameraCtl.mode = 'title';
    this.menus.showTitle();

    window.addEventListener('resize', () => this.renderer.resize());
    // Input re-captures the mouse on mousedown (without firing), see wantsPointerLock.
    canvas.addEventListener('click', () => this.audio.unlock());
    window.addEventListener('keydown', () => this.audio.unlock(), { once: false });
    document.addEventListener('pointerlockchange', () => {
      if (!this.input.pointerLocked && this.mode === 'game' && !this.menus.open && !this.sim.playerDown && this.running) this.pause();
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.mode === 'game' && !this.menus.open) this.pause();
    });
  }

  private makeTitleSim(): Sim {
    const sim = new Sim({ world: this.world, ambient: true, police: false, startHour: 18.6 });
    const p = sim.player;
    const node = sim.roads.node(5, 5);
    p.pos.x = node.x + node.halfX + 2.2;
    p.pos.z = node.z + node.halfZ + 2.2;
    p.pos.y = this.world.groundHeight(p.pos.x, p.pos.z);
    sim.cheats.godMode = true;
    sim.clock.rate = 0;
    this.renderer.crowd.hiddenId = p.id;
    return sim;
  }

  private menuHost(): MenuHost {
    return {
      hasSave: () => loadGame() !== null,
      newGame: () => this.newGame(),
      continueGame: () => this.continueGame(),
      resume: () => this.resume(),
      quitToTitle: () => this.quitToTitle(),
      abandonMission: () => {
        this.sim.missions.abandon();
        this.resume();
      },
      settings: () => this.settings,
      applySettings: (s) => this.applySettings(s, true),
      deleteSave: () => deleteGame(),
      sim: () => (this.mode === 'game' ? this.sim : null),
      setWaypoint: (p) => {
        this.hud.waypoint = p;
      },
      waypoint: () => this.hud.waypoint,
      click: () => this.audio.chime('ui'),
    };
  }

  applySettings(s: Settings, persist: boolean): void {
    const qualityChanged = s.quality !== this.renderer.currentQuality;
    this.settings = { ...s };
    if (qualityChanged) this.renderer.setQuality(s.quality);
    this.renderer.setFov(s.fov);
    this.renderer.cameraCtl.sensitivity = s.sensitivity;
    this.renderer.cameraCtl.invertY = s.invertY;
    this.audio.setVolumes(s.master, s.music, s.sfx);
    if (!s.hints) this.hud.clearHints();
    if (persist) saveSettings(this.settings);
  }

  /** Remembers a read hint for good (saved with the settings). */
  private markHintSeen(id: string): void {
    const seen = this.settings.hintsSeen;
    if (seen.includes(id)) return;
    // A full list (only a bad settings file gets there) drops its oldest id rather than this one,
    // which would otherwise come round again every frame.
    this.settings = { ...this.settings, hintsSeen: [...seen, id].slice(-MAX_HINTS_SEEN) };
    saveSettings(this.settings);
  }

  // ---------------------------------------------------------------------------
  // Game lifecycle

  private startSim(save: SaveData | null, intro = false): void {
    for (const u of this.unsub) u();
    this.unsub = [];
    this.world.resetBroken();
    this.renderer.props.restoreAll();
    const sim = new Sim({ world: this.world, ambient: true, police: true, startHour: save ? save.hours : 15.5 });
    if (save) {
      applySave(sim.progress, save);
      sim.clock.day = save.day;
      for (const w of save.weapons) sim.player.inventory.give(w.id, w.ammo);
      sim.player.armor = save.armor;
      sim.pickupSys.syncCollected();
    }
    this.sim = sim;
    this.renderer.crowd.hiddenId = -1;
    this.renderer.attach(sim);
    this.hud.bind(sim);
    this.audio.attach(sim);
    const ev = sim.events;
    this.unsub.push(
      ev.on('shopOpen', () => {
        this.suspendPlay();
        this.menus.showShop(() => this.resume());
      }),
      ev.on('saveRequested', (e) => this.save(e.poi === 'auto')),
      ev.on('respawn', () => this.renderer.cameraCtl.reset(sim)),
      ev.on('missionStarted', () => {
        this.hud.waypoint = null;
      }),
    );
    this.unsub.push(
      ev.on('respawn', () => this.showNextStep()),
      ev.on('missionEnded', (e) => {
        if (e.passed) this.showNextStep();
      }),
      this.hints.bind(sim),
    );
    this.mode = 'game';
    this.renderer.cameraCtl.mode = 'play';
    this.renderer.cameraCtl.reset(sim);
    this.menus.closeAll();
    this.hud.setVisible(true);
    this.audio.unlock();
    this.audio.setPaused(false);
    this.input.requestPointerLock();
    // A fresh game gets Lou's call a moment in; the radar's pink route leads to her without it.
    this.introTimer = !save && intro ? INTRO_DELAY : -1;
    if (!save || sim.progress.missionsDone.length === 0) {
      this.hud.help(this.introTimer > 0 ? WELCOME_CALL : WELCOME, 9);
    } else {
      this.hud.help('Welcome back. Your game was loaded.', 4);
    }
    this.showNextStep();
  }

  /** Starts a fresh game; Lou's opening call is on unless opts.intro is false or the URL has intro=0. */
  newGame(opts: { intro?: boolean } = {}): void {
    this.startSim(null, opts.intro !== false && !this.introOff);
  }

  /** The 'Next: ...' line, unless Lou's call is about to tell the player anyway. */
  private showNextStep(): void {
    if (this.mode === 'game' && this.introTimer <= 0) this.hud.showNextStep(this.sim);
  }

  /** Counts down to Lou's call; menus and the wasted / busted screens hold the clock. */
  private updateIntro(dt: number): void {
    const sim = this.sim;
    if (this.introTimer <= 0 || sim.playerDown) return;
    this.introTimer -= dt;
    if (this.introTimer > 0) return;
    // Once only: a running mission or job, a wanted level or a finished Wheels call it off.
    if (!sim.missions.active && !sim.activities.busy && sim.wanted.level === 0) sim.missions.start('wheels');
    // Called off: the next-step line points the player to Lou instead.
    if (!sim.missions.active) this.showNextStep();
  }

  continueGame(): void {
    const save = loadGame();
    if (!save) {
      // The save went away after the title was built (deleted in another tab, site data
      // cleared, unreadable): say so rather than silently starting over.
      this.menus.showTitle('No saved game found.');
      return;
    }
    this.startSim(save);
  }

  private save(auto: boolean): void {
    const sim = this.sim;
    const weapons = sim.player.inventory.owned().filter((w): w is Exclude<WeaponId, 'fists'> => w !== 'fists').map((id) => ({ id, ammo: sim.player.inventory.total(id) }));
    const data = serialize(sim.progress, weapons, sim.player.armor, sim.clock.hours, sim.clock.day);
    const ok = writeGame(data);
    this.hud.toast(ok ? (auto ? 'Autosaved' : 'Game saved') : 'Could not save (storage unavailable)');
  }

  pause(): void {
    if (this.mode !== 'game' || this.menus.open || this.crashed) return;
    this.suspendPlay();
    this.menus.showPause();
  }

  /** Frees the mouse and mutes the frozen world while an in-game screen covers it; resume() undoes it. */
  private suspendPlay(): void {
    this.input.exitPointerLock();
    this.audio.setPaused(true);
  }

  resume(): void {
    this.menus.closeAll();
    this.audio.setPaused(false);
    if (this.mode === 'game') this.input.requestPointerLock();
    this.showNextStep();
  }

  private quitToTitle(): void {
    for (const u of this.unsub) u();
    this.unsub = [];
    this.mode = 'title';
    this.introTimer = -1;
    this.hud.setVisible(false);
    this.audio.setPaused(false);
    this.sim = this.makeTitleSim();
    this.renderer.attach(this.sim);
    this.audio.attach(this.sim);
    this.renderer.cameraCtl.mode = 'title';
    this.canvas.classList.remove('wasted', 'busted');
    this.menus.showTitle();
  }

  private openMap(): void {
    this.suspendPlay();
    this.menus.showMap(() => this.resume());
  }

  // ---------------------------------------------------------------------------
  // Frame loop

  start(): void {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    requestAnimationFrame(this.frame);
  }

  private readonly frame = (now: number): void => {
    if (!this.running) return;
    requestAnimationFrame(this.frame);
    const dt = Math.min(0.1, Math.max(0, (now - this.last) / 1000));
    this.last = now;
    if (dt <= 0) return;
    const t0 = performance.now();
    const fi = this.input.poll(dt);
    try {
      this.step(dt, fi);
    } catch (err) {
      this.crash(err);
    }
    this.input.endFrame();
    this.frames++;
    this.fpsTime += dt;
    this.fpsFrames++;
    if (this.fpsTime >= 1) {
      this.fps = this.fpsFrames / this.fpsTime;
      this.fpsTime = 0;
      this.fpsFrames = 0;
    }
    this.perf.frameMs = performance.now() - t0;
  };

  /** One frame of game logic + rendering (also driven directly by tests). */
  step(dt: number, fi: FrameInput): void {
    if (this.crashed) return;
    const cam = this.renderer.cameraCtl;
    if (this.mode === 'title') {
      this.menus.input(fi.ui, dt);
      const inp = neutralInput();
      inp.aimOrigin = { x: cam.camera.position.x, y: cam.camera.position.y, z: cam.camera.position.z };
      const d = cam.aimRay().dir;
      inp.aimDir = { x: d.x, y: d.y, z: d.z };
      this.sim.update(dt, inp);
      this.renderer.render(dt, false);
      this.audio.update(dt, this.sim, false);
      return;
    }
    if (this.menus.open) {
      this.menus.input(fi.ui, dt);
      this.renderer.render(0, false);
      return;
    }
    if (fi.ui.pause) {
      this.pause();
      return;
    }
    if (fi.ui.map) {
      this.openMap();
      return;
    }
    if (fi.ui.camera) cam.zoomLevel = cam.zoomLevel === 0 ? 1 : 0;
    if (fi.ui.radioNext) this.hud.showRadio(this.audio.radio.next());
    if (fi.ui.radioPrev) this.hud.showRadio(this.audio.radio.prev());
    const cheat = this.input.takeCheat(CHEATS);
    if (cheat) this.applyCheat(cheat);

    const sim = this.sim;
    cam.look(fi.lookX, fi.lookY);
    const aim = cam.aimRay();
    const inp = fi.player;
    inp.aimOrigin = aim.origin;
    inp.aimDir = aim.dir;
    inp.cameraYaw = cam.yaw;
    const ts = performance.now();
    sim.update(dt, inp);
    this.perf.simMs = performance.now() - ts;
    this.input.inVehicle = !!sim.player.vehicle;
    // The sim decides whether the player can aim (not while swimming, knocked down or climbing in).
    const aiming = sim.player.aiming && !sim.player.vehicle;
    const tr = performance.now();
    this.renderer.render(dt, aiming);
    this.perf.renderMs = performance.now() - tr;
    const cp = cam.camera.position;
    this.audio.setListener(cp.x, cp.y, cp.z, cam.yaw);
    this.audio.update(dt, sim, true);
    this.updateIntro(dt);
    this.hints.update(dt, sim, { device: fi.device, mouseFree: !this.input.pointerLocked && this.input.lockAvailable });
    const prompt = sim.interactions.prompt() ?? this.jobPrompt(sim) ?? this.hints.stealPrompt(sim);
    this.hud.device = fi.device;
    this.hud.update(dt, sim, cam.yaw, aiming, prompt, this.renderer.time);
    const down = sim.deathKind;
    this.canvas.classList.toggle('wasted', down === 'wasted');
    this.canvas.classList.toggle('busted', down === 'busted');
    if (this.wasDown && !down) cam.reset(sim);
    this.wasDown = !!down;
  }

  private jobPrompt(sim: Sim): string | null {
    const v = sim.player.vehicle;
    if (!v || sim.activities.busy || sim.missions.active) return null;
    if (v.kind === 'taxi' && v.speed < 1) return 'Press T to start a taxi job';
    if (v.spec.police && v.speed < 1) return 'Press T to start a vigilante job';
    return null;
  }

  private applyCheat(code: (typeof CHEATS)[number]): void {
    const sim = this.sim;
    const p = sim.player;
    switch (code) {
      case 'CHILLOUT':
        sim.wanted.clear();
        break;
      case 'GUNSGALORE':
        for (const w of WEAPON_ORDER) if (w !== 'fists') p.inventory.give(w, 300);
        break;
      case 'FIXMYRIDE': {
        // Typing the code presses F (enter / exit), so by the time it completes the player has
        // usually left the car: fix the one they just got out of as well.
        const v = p.vehicle ?? recentRide(sim);
        if (v) {
          v.health = v.spec.health;
          v.burning = false;
          v.burnTimer = 0;
          // A car on its roof is undrivable: put it back on its wheels.
          v.flipped = false;
          v.roll = 0;
          v.pitch = 0;
          v.rollVel = 0;
          v.pitchVel = 0;
        }
        break;
      }
      case 'IMMORTAL':
        sim.cheats.godMode = !sim.cheats.godMode;
        break;
      case 'MONEYTREE':
        sim.progress.addMoney(50000);
        sim.events.emit('money', { amount: 50000 });
        break;
      case 'SUNSET':
        sim.clock.set(18.3);
        break;
      case 'NIGHTOWL':
        sim.clock.set(23);
        break;
      case 'SPAWNSPORTS': {
        const fx = Math.sin(p.heading);
        const fz = Math.cos(p.heading);
        const spot = this.world.findFreeSpot(p.pos.x + fx * 6, p.pos.z + fz * 6, 2.4, 20);
        if (spot) sim.spawnVehicle('sports', spot.x, spot.z, p.heading);
        break;
      }
      case 'COPMAGNET':
        sim.wanted.setLevel(Math.min(5, sim.wanted.level + 2));
        break;
    }
    this.hud.toast(code === 'IMMORTAL' ? `Cheat: god mode ${sim.cheats.godMode ? 'on' : 'off'}` : 'Cheat activated');
  }

  private crash(err: unknown): void {
    if (this.crashed) return;
    this.crashed = true;
    console.error('GTA7 crashed', err);
    const el = document.createElement('div');
    el.className = 'error';
    el.innerHTML = `<div><h2 style="font-family:Anton,Impact,sans-serif;font-size:42px;margin:0 0 10px">SOMETHING BROKE</h2><p>The game hit an unexpected error and stopped to protect your save.</p><pre style="white-space:pre-wrap;opacity:.7;max-width:80vw">${String(err instanceof Error ? err.stack ?? err.message : err).slice(0, 800).replace(/</g, '&lt;')}</pre><button class="btn primary" style="pointer-events:auto" onclick="location.reload()">RELOAD</button></div>`;
    this.ui.appendChild(el);
    // Stopping the loop also keeps the pointerlockchange handler from pausing under the overlay.
    this.running = false;
    try {
      // Free the cursor for RELOAD and silence the frozen engine / siren voices.
      this.input.exitPointerLock();
      this.audio.setPaused(true);
    } catch {
      // Best effort: the error screen is already up even if input or audio is what broke.
    }
  }

  get isCrashed(): boolean {
    return this.crashed;
  }
}

/** The nearest intact car within 30 m that the player was the last to drive. */
function recentRide(sim: Sim): Vehicle | null {
  const p = sim.playerPos();
  let best: Vehicle | null = null;
  let bestD = 30;
  for (const v of sim.vehicles) {
    if (v.lastDriver !== sim.player || v.removed || v.destroyed) continue;
    const d = Math.hypot(v.pos.x - p.x, v.pos.z - p.z);
    if (d < bestD) {
      best = v;
      bestD = d;
    }
  }
  return best;
}
