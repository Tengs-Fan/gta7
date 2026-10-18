// Top-level game: owns the world, the current simulation, the renderer, input,
// HUD, menus and audio, and runs the frame loop.

import { AudioEngine } from './audio/audio';
import type { TypedCheat } from './input/cheats';
import { Input, type FrameInput } from './input/input';
import { pickTier, probeGpu, QUALITY, type QualitySetting, type QualityTier } from './render/quality';
import { GameRenderer } from './render/renderer';
import { deleteGame, loadGame, loadSettings, MAX_HINTS_SEEN, saveSettings, storeGame, type Settings } from './settings';
import type { Vehicle } from './sim/entities';
import { neutralInput } from './sim/input';
import { applySave, serialize, type SaveData } from './sim/progress';
import { Sim } from './sim/sim';
import { WEAPON_ORDER, type WeaponId } from './sim/specs';
import { findVehicleRoom } from './sim/vehicleRoom';
import { HintSystem } from './ui/hints';
import { Hud } from './ui/hud';
import { MapImage } from './ui/mapRender';
import { Menus, type MenuHost } from './ui/menus';
import { StaticWorld } from './world/staticWorld';

export { CHEAT_CODES as CHEATS } from './input/cheats';

/** Seconds into a fresh game before Mama Lou calls with the first mission. */
export const INTRO_DELAY = 2.5;
/**
 * Seconds the world stays muted after QUIT TO TITLE: the in-game voices (siren, engine, horn, radio) still hold the
 * frozen game's levels, and only fade (time constants up to 0.2 s) once the title's audio updates take them down, or
 * those of a game started meanwhile. Four time constants of the slowest leave under 2% of them.
 */
const TITLE_UNMUTE_DELAY = 0.8;
/**
 * Getting out at BAIL_SPEED (m/s) or faster is a bail that costs BAIL_DAMAGE health, armour or not
 * (PlayerController.driving and exitVehicle). The exit is decided before the frame's physics step, at the speed the
 * last frame ended with, which is the speed Game reads for Input.exitAtStake: no margin is needed, and none is wanted,
 * as an F held back at 10 m/s would no longer brake the car to a safe stop.
 */
const BAIL_SPEED = 11;
const BAIL_DAMAGE = 6;
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
  /** The screen (map or pause menu) gameplay last opened by its key, and that key press: a cheat code's first letters can do that. */
  private keyScreen: { screen: Menus['top']; press: number } | null = null;
  /**
   * The screen (a map, or the pause menu) that its key (P, M) last closed, whether it was a map, the screen it went back
   * to (the pause menu under it, or none: play) and that key press: a cheat code's letter can do that too.
   */
  private keyClosed: { map: boolean; under: Menus['top']; press: number } | null = null;
  /** The player's last exit from a vehicle and the key press that asked for it, for FIXMYRIDE, whose F gets him out. */
  private lastExit: { vehicle: Vehicle; press: number; bailed: boolean } | null = null;
  /** The last sim events of the session and page errors, oldest first, for the crash report. */
  private readonly recent: Array<{ t: number; type: string; text: string }> = [];
  /** The tier 'auto' stands for: picked once at boot from the GPU, never changed at run time. */
  readonly autoTier: QualityTier;
  /** The lost-context flow is on (the renderer keeps its own GL-side flag): nothing steps, the overlay is up. */
  private gfxLost = false;
  /** The lost-context overlay says the graphics could not be restored (RELOAD shown). */
  private gfxFailed = false;
  private gfxOverlay: HTMLElement | null = null;
  /** Seconds until the world is un-muted after QUIT TO TITLE (see TITLE_UNMUTE_DELAY); not positive when none is due. */
  private titleUnmute = 0;
  private gfxTimer: ReturnType<typeof setTimeout> | null = null;
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
    const gpu = probeGpu();
    this.autoTier = pickTier({ renderer: gpu.renderer, ...displayInfo() });
    this.renderer = new GameRenderer(canvas, this.world, { quality: this.tierOf(this.settings.quality), fov: this.settings.fov, gpu });
    this.input = new Input(canvas);
    this.input.attach();
    this.input.wantsPointerLock = () => this.mode === 'game' && !this.menus.open && !this.crashed;
    // The mouse's back button must not leave a game, least of all from a menu (the pointer is free there).
    this.input.guardNavigation = () => this.mode === 'game' && !this.crashed;
    this.hud = new Hud(ui, this.mapImage, this.input.labels);
    this.hud.setVisible(false);
    this.menus = new Menus(ui, this.menuHost(), this.mapImage, this.input.labels);
    this.applySettings(this.settings, false);
    this.sim = this.makeTitleSim();
    this.renderer.attach(this.sim);
    this.renderer.cameraCtl.mode = 'title';
    this.menus.showTitle();

    window.addEventListener('resize', () => this.renderer.resize());
    // Any press on the page unlocks audio: the title's menus are in #ui, not on the canvas. pointerdown is a user
    // activation (pointerup for touch) and comes before the click, so a button's own chime finds the context running.
    for (const type of ['pointerdown', 'pointerup']) document.addEventListener(type, () => this.audio.unlock(), { capture: true });
    window.addEventListener('keydown', () => this.audio.unlock(), { once: false });
    document.addEventListener('pointerlockchange', () => {
      if (!this.input.pointerLocked && this.mode === 'game' && !this.menus.open && !this.sim.playerDown && this.running) this.pause();
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.mode === 'game' && !this.menus.open) this.pause();
    });
    canvas.addEventListener('webglcontextlost', (e) => this.onContextLost(e));
    canvas.addEventListener('webglcontextrestored', () => this.onContextRestored());
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
    this.applyDensity(sim);
    this.renderer.crowd.hiddenId = p.id;
    return sim;
  }

  /**
   * Menu actions that switch state run from DOM handlers, outside the frame loop's catch: one that throws
   * shows the error screen instead of leaving the game half switched.
   */
  private guard<A extends unknown[]>(fn: (...args: A) => void): (...args: A) => void {
    return (...args) => {
      try {
        fn(...args);
      } catch (err) {
        this.crash(err);
      }
    };
  }

  private menuHost(): MenuHost {
    return {
      hasSave: () => loadGame() !== null,
      newGame: this.guard(() => this.newGame()),
      continueGame: this.guard(() => this.continueGame()),
      resume: this.guard(() => this.resume()),
      quitToTitle: this.guard(() => this.quitToTitle()),
      abandonMission: this.guard(() => {
        this.sim.missions.abandon();
        this.resume();
      }),
      settings: () => this.settings,
      applySettings: this.guard((s: Settings) => this.applySettings(s, true)),
      deleteSave: () => deleteGame(),
      sim: () => (this.mode === 'game' ? this.sim : null),
      setWaypoint: this.guard((p: { x: number; z: number } | null) => {
        this.hud.waypoint = p;
      }),
      waypoint: () => this.hud.waypoint,
      click: () => this.audio.chime('ui'),
      quality: () => ({ auto: this.autoTier, msaa: this.renderer.msaa }),
    };
  }

  applySettings(s: Settings, persist: boolean): void {
    const tier = this.tierOf(s.quality);
    const qualityChanged = tier !== this.renderer.currentQuality;
    this.settings = { ...s };
    if (qualityChanged) this.renderer.setQuality(tier);
    // Not yet during construction, which applies the settings before the first sim exists.
    if (this.sim) this.applyDensity(this.sim);
    this.renderer.setFov(s.fov);
    this.renderer.cameraCtl.sensitivity = s.sensitivity;
    this.renderer.cameraCtl.invertY = s.invertY;
    this.audio.setVolumes(s.master, s.music, s.sfx);
    if (!s.hints) this.hud.clearHints();
    if (persist) saveSettings(this.settings);
  }

  /** The concrete tier a quality setting stands for. */
  tierOf(q: QualitySetting): QualityTier {
    return q === 'auto' ? this.autoTier : q;
  }

  /** Ambient traffic and pedestrian numbers follow the graphics tier (fewer to simulate and draw on Low). */
  private applyDensity(sim: Sim): void {
    const t = QUALITY[this.tierOf(this.settings.quality)];
    sim.traffic.density = t.trafficDensity;
    sim.peds.density = t.pedDensity;
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
    this.applyDensity(sim);
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
        this.menus.showShop(this.guard(() => this.resume()));
      }),
      ev.on('saveRequested', (e) => this.save(e.poi === 'auto')),
      ev.on('respawn', () => this.renderer.cameraCtl.reset(sim)),
      ev.on('missionStarted', () => {
        this.hud.waypoint = null;
      }),
    );
    this.noteEvent('session', save ? 'continued' : 'new game');
    this.unsub.push(...this.recordEvents(sim));
    this.lastExit = null;
    this.keyClosed = null;
    // Set from each frame of play: none of the last session's (an F held back in its car) carries over.
    this.input.inVehicle = false;
    this.input.exitAtStake = false;
    this.input.skipLine = false;
    this.unsub.push(
      ev.on('vehicleExit', (e) => {
        // The exit may come a moment after its key press (braking first). A bail at speed (knocked down) cost him 6 health, unless he is invulnerable.
        if (e.character === sim.player) this.lastExit = { vehicle: e.vehicle, press: this.input.exitKeyPress, bailed: e.character.state === 'knocked' && !sim.cheats.godMode };
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
    // Started straight from QUIT TO TITLE, the old game's voices are still fading out: the wait goes on in this one.
    this.openAudio();
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
    const failed = storeGame(data);
    this.hud.toast(failed ?? (auto ? 'Autosaved' : 'Game saved'));
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
    this.openAudio();
    if (this.mode === 'game') this.input.requestPointerLock();
    this.showNextStep();
  }

  /** Opens the world's sound stage, unless the wait after QUIT TO TITLE (see TITLE_UNMUTE_DELAY) is still on. */
  private openAudio(): void {
    if (this.titleUnmute <= 0) this.audio.setPaused(false);
  }

  /**
   * Counts down the wait after QUIT TO TITLE, on the title or in a game started meanwhile; called after a frame's audio
   * update, which fades the old game's voices under the shut stage, and never while a menu holds the stage shut.
   */
  private countUnmute(dt: number): void {
    if (this.titleUnmute <= 0) return;
    this.titleUnmute -= dt;
    if (this.titleUnmute <= 0) this.audio.setPaused(false);
  }

  private quitToTitle(): void {
    for (const u of this.unsub) u();
    this.unsub = [];
    this.mode = 'title';
    this.introTimer = -1;
    this.hud.setVisible(false);
    // Still paused (by the pause menu): the title's audio updates fade the frozen game's voices out under the closed
    // stage first, then step() opens it.
    this.audio.setPaused(true);
    this.titleUnmute = TITLE_UNMUTE_DELAY;
    this.sim = this.makeTitleSim();
    this.renderer.attach(this.sim);
    this.audio.attach(this.sim);
    this.renderer.cameraCtl.mode = 'title';
    this.canvas.classList.remove('wasted', 'busted');
    this.menus.showTitle();
  }

  private openMap(): void {
    this.suspendPlay();
    this.menus.showMap(this.guard(() => this.resume()));
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
    try {
      // Reading the input can fail too (a gamepad API that throws): that shows the error screen, not a frozen black one.
      const fi = this.input.poll(dt);
      this.step(dt, fi);
      this.input.menuOpen = this.menus.open;
      this.input.endFrame();
    } catch (err) {
      this.crash(err);
    }
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
    if (this.gfxLost) {
      // Keys are ignored while the context is lost: a cheat code typed meanwhile is dropped, not applied after the restore.
      this.input.takeCheats();
      // Once restoring failed, confirm (Enter, Space, pad A) presses its RELOAD.
      if (this.gfxFailed && fi.ui.confirm) location.reload();
      return;
    }
    // Every frame, also while a screen is open: a code's first letters can open the map or the pause menu.
    for (const typed of this.input.takeCheats()) if (this.mode === 'game') this.applyCheat(typed);
    const cam = this.renderer.cameraCtl;
    if (this.mode === 'title') {
      this.menus.input(fi.ui, dt, fi.device);
      const inp = neutralInput();
      inp.aimOrigin = { x: cam.camera.position.x, y: cam.camera.position.y, z: cam.camera.position.z };
      const d = cam.aimRay().dir;
      inp.aimDir = { x: d.x, y: d.y, z: d.z };
      this.sim.update(dt, inp);
      this.renderer.render(dt, false);
      // The flyover aims with lookAt and never sets cam.yaw: the listener faces where the view looks.
      const view = cam.aimRay().dir;
      this.audio.setListener(cam.camera.position.x, cam.camera.position.y, cam.camera.position.z, Math.atan2(view.x, view.z));
      this.audio.update(dt, this.sim, false);
      this.countUnmute(dt);
      return;
    }
    if (this.menus.open) {
      const shown = this.menus.top;
      this.menus.input(fi.ui, dt, fi.device);
      // Its key (P, M) closed the pause menu or a map, back to play or to the pause menu under it: a cheat code's letter
      // can do that (MONEYTREE's M), and applyCheat puts the screen back.
      if (shown && this.menus.top !== shown && (fi.ui.pause || fi.ui.map) && this.input.screenKeyPress >= 0) {
        this.keyClosed = { map: shown.el.classList.contains('map-screen'), under: this.menus.top, press: this.input.screenKeyPress };
      }
      this.renderer.render(0, false);
      return;
    }
    if (fi.ui.pause) {
      this.pause();
      this.keyScreen = { screen: this.menus.top, press: this.input.screenKeyPress };
      return;
    }
    if (fi.ui.map) {
      this.openMap();
      this.keyScreen = { screen: this.menus.top, press: this.input.screenKeyPress };
      return;
    }
    if (fi.ui.camera) cam.zoomLevel = cam.zoomLevel === 0 ? 1 : 0;
    if (fi.ui.radioNext) this.hud.showRadio(this.audio.radio.next());
    if (fi.ui.radioPrev) this.hud.showRadio(this.audio.radio.prev());

    const sim = this.sim;
    cam.look(fi.lookX, fi.lookY);
    // This frame's look, not the last frame's view: aimRay() only catches up in render().
    const aim = cam.rayFor();
    const inp = fi.player;
    inp.aimOrigin = aim.origin;
    inp.aimDir = aim.dir;
    inp.cameraYaw = cam.yaw;
    // An F held back for FIXMYRIDE (Input.exitHeld) brakes the car below the bail speed, as the stop before getting out
    // would have: the wait must not let it speed up into a bail (the exit is decided at the speed it has by then).
    const pv = sim.player.vehicle;
    if (pv && this.input.exitHeld && pv.speed < BAIL_SPEED) {
      inp.throttle = 0;
      inp.brake = pv.forwardSpeed > 0.5 ? 1 : 0;
      inp.handbrake = pv.forwardSpeed <= 0.5;
    }
    const ts = performance.now();
    sim.update(dt, inp);
    this.perf.simMs = performance.now() - ts;
    this.input.inVehicle = !!sim.player.vehicle;
    this.input.skipLine = sim.missions.lineSkippable;
    this.input.exitAtStake = exitAtStake(sim);
    // The sim decides whether the player can aim (not while swimming, knocked down or climbing in).
    // Only the aim button zooms the view and steadies the reticle; hip fire keeps both wide.
    const aiming = sim.player.aimZoom && !sim.player.vehicle;
    const tr = performance.now();
    this.renderer.render(dt, aiming);
    this.perf.renderMs = performance.now() - tr;
    const cp = cam.camera.position;
    this.audio.setListener(cp.x, cp.y, cp.z, cam.yaw);
    this.audio.update(dt, sim, true);
    this.countUnmute(dt);
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

  private applyCheat(typed: TypedCheat): void {
    const sim = this.sim;
    const p = sim.player;
    const code = typed.code;
    // Undo the code's first letters: the M of MONEYTREE or IMMORTAL opens the map, the P of SPAWNSPORTS pauses.
    // Only a screen one of its own letters opened, and only while it is still on top.
    const ks = this.keyScreen;
    if (ks?.screen && this.menus.top === ks.screen && typed.presses.includes(ks.press)) this.resume();
    // Typed on a map or the pause menu, a letter (MONEYTREE's M) closes it instead: back it comes, if nothing else has
    // been opened since. (SPAWNSPORTS's P waits in Input for the next key there, and never closes the pause menu.)
    const kc = this.keyClosed;
    if (kc && typed.presses.includes(kc.press)) {
      this.keyClosed = null;
      if (kc.under === null && !this.menus.open) {
        if (kc.map) this.openMap();
        else this.pause();
      } else if (kc.under !== null && kc.map && this.menus.top === kc.under) this.menus.showMap();
    }
    switch (code) {
      case 'CHILLOUT':
        sim.wanted.clear();
        break;
      case 'GUNSGALORE':
        for (const w of WEAPON_ORDER) if (w !== 'fists') p.inventory.give(w, 300);
        break;
      case 'FIXMYRIDE': {
        // Its F gets the player out of the car (bailing out at speed): put him back in his seat, refunding the fall.
        // Only an exit the code's own F asked for: one he made himself before typing it stands. Where that exit could
        // not be undone (it ends a taxi or vigilante job, a bail could kill), Input held the F back and dropped it.
        const ex = this.lastExit;
        this.lastExit = null;
        if (ex && typed.presses.includes(ex.press) && !p.vehicle && p.alive && !sim.playerDown && p.state !== 'entering' && canReseat(ex.vehicle)) {
          if (ex.bailed) p.health = Math.min(p.maxHealth, p.health + 6);
          p.state = 'normal';
          p.knockTimer = 0;
          sim.seat(p, ex.vehicle, 0);
        } else if (p.vehicle && typed.presses.includes(this.input.exitKeyPress)) {
          // Between 3.5 and 11 m/s its F only braked for an exit still to come (typed fast): call it off.
          sim.playerCtl.cancelExit();
        }
        // Otherwise fix the car he last drove nearby.
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
        // In front of him where it fits: clear of walls and props, and of the cars and people there (him too).
        const spot = findVehicleRoom(sim, 'sports', p.pos.x + fx * 6, p.pos.z + fz * 6, p.heading, 20);
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
    // Stopping the loop also keeps the pointerlockchange handler from pausing under the overlay.
    this.running = false;
    try {
      this.showCrash(err);
    } catch {
      // Best effort when the DOM is what broke: the loop is stopped either way.
    }
    try {
      // Free the cursor for RELOAD, give the keyboard back to the page (Tab, Space and Enter reach the buttons once
      // Input stops cancelling them) and silence the frozen engine / siren voices.
      this.input.exitPointerLock();
      this.input.detach();
      this.audio.setPaused(true);
    } catch {
      // Best effort: the error screen is already up even if input or audio is what broke.
    }
    this.padReloads();
  }

  /**
   * On the error screen a fresh A press on a gamepad reloads: the frame loop that reads the pad has stopped. (No pad
   * button copies the report: a pad press is no user activation, so the clipboard would refuse it.)
   */
  private padReloads(): void {
    const a = () => {
      try {
        return !!this.input.standardPad()?.buttons[0]?.pressed;
      } catch {
        return false;
      }
    };
    // A held through the crash is not a press.
    let was = a();
    const tick = () => {
      const now = a();
      if (now && !was) {
        location.reload();
        return;
      }
      was = now;
      requestAnimationFrame(tick);
    };
    try {
      requestAnimationFrame(tick);
    } catch {
      // No frames to poll in: keyboard and mouse still reach the buttons.
    }
  }

  /** Focuses a screen's main button for the keyboard, ringed like a menu's selected button while it has focus. */
  private focusButton(...buttons: HTMLElement[]): void {
    for (const b of buttons) {
      b.addEventListener('focus', () => b.classList.add('sel'));
      b.addEventListener('blur', () => b.classList.remove('sel'));
    }
    buttons[0]?.focus?.();
  }

  /** The error screen: what broke, RELOAD, and COPY DETAILS for a bug report. */
  private showCrash(err: unknown): void {
    const el = document.createElement('div');
    el.className = 'error';
    const box = document.createElement('div');
    box.innerHTML = `<h2 style="font-family:Anton,Impact,sans-serif;font-size:42px;margin:0 0 10px">SOMETHING BROKE</h2><p>The game hit an unexpected error and stopped to protect your save.</p><pre style="white-space:pre-wrap;opacity:.7;max-width:80vw">${String(err instanceof Error ? err.stack ?? err.message : err).slice(0, 800).replace(/</g, '&lt;')}</pre>`;
    const reload = document.createElement('button');
    reload.className = 'btn primary';
    reload.textContent = 'RELOAD';
    reload.addEventListener('click', () => location.reload());
    const copy = document.createElement('button');
    copy.className = 'btn';
    copy.textContent = 'COPY DETAILS';
    copy.dataset.id = 'copy-report';
    const text = document.createElement('textarea');
    text.readOnly = true;
    text.hidden = true;
    // Styled like the menu panels (style.css), centred as an inline block by the overlay's text-align.
    text.className = 'crash-report';
    copy.addEventListener('click', () => {
      const report = this.crashReport(err);
      // Where the clipboard is refused (an insecure origin, a denied permission), show it selected to copy by hand.
      const byHand = () => {
        text.value = report;
        text.hidden = false;
        text.focus();
        text.select();
        // Selecting scrolls to the end: the error is at the top.
        text.scrollTop = 0;
      };
      try {
        if (!navigator.clipboard?.writeText) byHand();
        else
          navigator.clipboard.writeText(report).then(() => {
            copy.textContent = 'COPIED';
          }, byHand);
      } catch {
        byHand();
      }
    });
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:10px;justify-content:center';
    row.append(reload, copy);
    box.append(row, text);
    el.appendChild(box);
    this.ui.appendChild(el);
    // Enter or Space reloads at once; Tab goes on to COPY DETAILS.
    this.focusButton(reload, copy);
  }

  /** Plain text for a bug report: the error, the state of the session and its last events. */
  crashReport(err: unknown): string {
    const lines = [`GTA 7 crash report, ${new Date().toISOString()}`, `error: ${err instanceof Error ? err.stack ?? err.message : String(err)}`];
    // Each line on its own: whatever broke the game may break reading it too.
    const add = (label: string, value: () => string) => {
      try {
        lines.push(`${label}: ${value()}`);
      } catch (e) {
        lines.push(`${label}: unavailable (${String(e)})`);
      }
    };
    const sim = this.sim;
    add('mode', () => this.mode);
    add('sim time', () => `${sim.time.toFixed(2)} s (frame ${sim.frame}, ${sim.clock.label()}, day ${sim.clock.day})`);
    add('mission', () => sim.missions.active?.def.id ?? 'none');
    add('zone', () => {
      const q = sim.playerPos();
      return `${sim.world.zoneName(q.x, q.z)} at ${q.x.toFixed(1)}, ${q.y.toFixed(1)}, ${q.z.toFixed(1)}`;
    });
    add('player', () => {
      const p = sim.player;
      return `${p.state}, health ${Math.round(p.health)}, armor ${Math.round(p.armor)}, ${p.inventory.current}, vehicle ${p.vehicle?.kind ?? 'none'}, wanted ${sim.wanted.level}`;
    });
    add('quality', () => `${this.settings.quality} (rendering ${this.renderer.currentQuality})`);
    add('listener errors', () => String(sim.events.errors));
    add('browser', () => String(navigator.userAgent));
    lines.push(`last ${this.recent.length} events (sim time, oldest first):`);
    for (const e of this.recent) lines.push(`  ${e.t.toFixed(2)} ${e.type}${e.text ? ` ${e.text}` : ''}`);
    return lines.join('\n');
  }

  /** Adds an entry to the crash report's recent events: the session's sim events, and page errors (main.ts). */
  noteEvent(type: string, text: string): void {
    this.recent.push({ t: this.sim?.time ?? 0, type, text: text.slice(0, 200) });
    if (this.recent.length > 30) this.recent.shift();
  }

  /** Subscribes the crash report to a session's notable sim events. */
  private recordEvents(sim: Sim): Array<() => void> {
    const ev = sim.events;
    const note = (type: string, text: string) => this.noteEvent(type, text);
    return [
      ev.on('message', (e) => note('message', e.text)),
      ev.on('subtitle', (e) => note('subtitle', `${e.speaker}: ${e.text}`)),
      ev.on('big', (e) => note('big', e.sub ? `${e.text} (${e.sub})` : e.text)),
      ev.on('wanted', (e) => note('wanted', `${e.previous} -> ${e.level}`)),
      ev.on('missionStarted', (e) => note('missionStarted', e.id)),
      ev.on('missionEnded', (e) => note('missionEnded', `${e.id} ${e.passed ? 'passed' : 'failed'}`)),
      ev.on('vehicleEnter', (e) => note('vehicleEnter', `${e.character.role} into ${e.vehicle.kind}${e.jacked ? ', jacked' : ''}`)),
      ev.on('vehicleExit', (e) => note('vehicleExit', `${e.character.role} out of ${e.vehicle.kind}`)),
      ev.on('characterKilled', (e) => note('characterKilled', `${e.victim.role} by ${e.killer?.role ?? 'nobody'}`)),
      ev.on('wasted', () => note('wasted', '')),
      ev.on('busted', () => note('busted', '')),
      ev.on('respawn', (e) => note('respawn', e.where)),
      ev.on('explosion', (e) => note('explosion', `at ${e.x.toFixed(0)}, ${e.z.toFixed(0)}, radius ${e.radius}`)),
    ];
  }

  get isCrashed(): boolean {
    return this.crashed;
  }

  // ---------------------------------------------------------------------------
  // WebGL context loss (driver reset, GPU switch, a background tab under memory pressure)

  /** True while the WebGL context is lost and the game waits for it to come back. */
  get contextLost(): boolean {
    return this.gfxLost;
  }

  private onContextLost(e: Event): void {
    // three already asks the browser to restore the context; asking twice is harmless.
    e.preventDefault();
    if (this.gfxLost || this.crashed) return;
    this.gfxLost = true;
    // Frees the mouse, mutes the world and leaves the pause menu under the overlay (step() is idle meanwhile).
    if (this.mode === 'game') this.pause();
    this.input.exitPointerLock();
    this.audio.setPaused(true);
    this.showGfxOverlay(false);
    if (this.gfxTimer !== null) clearTimeout(this.gfxTimer);
    this.gfxTimer = setTimeout(() => {
      this.gfxTimer = null;
      if (this.gfxLost) this.showGfxOverlay(true);
    }, GFX_RESTORE_TIMEOUT_MS);
  }

  private onContextRestored(): void {
    if (!this.gfxLost) return;
    this.gfxLost = false;
    if (this.gfxTimer !== null) clearTimeout(this.gfxTimer);
    this.gfxTimer = null;
    this.gfxOverlay?.remove();
    this.gfxOverlay = null;
    this.gfxFailed = false;
    if (this.crashed) return;
    // Back to a rendered, paused game (the renderer rebuilt its GPU state in its own handler).
    if (this.mode === 'game') {
      if (!this.menus.open) {
        this.suspendPlay();
        this.menus.showPause();
      }
    } else {
      // Just after QUIT TO TITLE the countdown in step() opens the stage instead, once the frozen voices have faded.
      this.openAudio();
    }
  }

  private showGfxOverlay(failed: boolean): void {
    this.gfxOverlay?.remove();
    this.gfxFailed = failed;
    const el = document.createElement('div');
    el.className = 'gfx-lost';
    const box = document.createElement('div');
    const text = document.createElement('p');
    text.textContent = failed ? 'Graphics could not be restored. Reload the page.' : 'Graphics reset - restoring...';
    box.append(text);
    let reload: HTMLElement | null = null;
    if (failed) {
      reload = document.createElement('button');
      reload.className = 'btn primary';
      reload.textContent = 'RELOAD';
      reload.addEventListener('click', () => location.reload());
      box.append(reload);
    }
    el.append(box);
    this.ui.appendChild(el);
    this.gfxOverlay = el;
    // Input stays attached (the context may yet come back): step() also reloads on confirm.
    if (reload) this.focusButton(reload);
  }
}

/** How long a lost WebGL context may take to come back before the player is told to reload. */
export const GFX_RESTORE_TIMEOUT_MS = 10_000;

/** Display facts for the Auto tier pick (CSS screen size, so a window opened small still counts the full screen). */
function displayInfo(): { devicePixelRatio: number; screenWidth: number; screenHeight: number } {
  const w = typeof window === 'undefined' ? undefined : (window as Partial<Window>);
  return {
    devicePixelRatio: w?.devicePixelRatio || 1,
    screenWidth: w?.screen?.width || w?.innerWidth || 0,
    screenHeight: w?.screen?.height || w?.innerHeight || 0,
  };
}

/**
 * Whether getting out of the vehicle now is for good, so that FIXMYRIDE, whose F gets the player out, could not put
 * things back: a bail at speed would kill him, or it would end a taxi or vigilante job (with its fare or suspect and
 * streak). Input then holds an F press back until the next key shows whether it starts the code. A wrecked or sinking
 * vehicle never holds it, and a burning one only for a bail that kills: its occupants are safe until it blows up, so
 * waiting is no worse there, while any other way out of it is urgent ('Press F to get out!').
 */
function exitAtStake(sim: Sim): boolean {
  const p = sim.player;
  const v = p.vehicle;
  if (!v || sim.playerDown || !v.drivable || v.inWater) return false;
  if (!sim.cheats.godMode && v.speed >= BAIL_SPEED && p.health <= BAIL_DAMAGE) return true;
  if (v.burning) return false;
  const job = sim.activities.job;
  return !!job && job.kind !== 'rampage';
}

/** The player can be put back in a vehicle he just got out of: it still drives and its seat is free. */
function canReseat(v: Vehicle): boolean {
  return !v.removed && !v.destroyed && !v.inWater && v.driver === null;
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
