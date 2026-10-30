import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ACTIONS, DEFAULT_BINDINGS, Keymap, parseBindings, rebind } from '../../src/input/bindings';
import { Input } from '../../src/input/input';
import { CameraController } from '../../src/render/camera';
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from '../../src/settings';
import { registerActivity, unregisterActivity, type ActivityDef } from '../../src/sim/activities';
import { completionPercent, completionRows, registerCompletion, unregisterCompletion } from '../../src/sim/completion';
import { registerContact, unregisterContact } from '../../src/sim/missions/contacts';
import { registerContactMissions, unregisterContactMissions } from '../../src/sim/missions/index';
import type { MissionDef } from '../../src/sim/missions/runner';
import { PACKAGE_COUNT } from '../../src/sim/pickups';
import { formatKeys } from '../../src/ui/glyphs';
import { collectBlips, MAP_CATEGORIES } from '../../src/ui/mapRender';
import { makeSim } from './helpers';

function ev(type: string, props: Record<string, unknown> = {}): Event {
  const e = new Event(type, { cancelable: true });
  for (const [k, v] of Object.entries(props)) Object.defineProperty(e, k, { value: v });
  if (type.startsWith('key') && !('getModifierState' in props)) Object.defineProperty(e, 'getModifierState', { value: () => false });
  return e;
}

/** A page for Input and the settings: window and document as event targets, a localStorage. */
function page() {
  const items = new Map<string, string>();
  const localStorage = { getItem: (k: string) => items.get(k) ?? null, setItem: (k: string, v: string) => void items.set(k, v), removeItem: (k: string) => void items.delete(k) };
  const win = Object.assign(new EventTarget(), { localStorage, innerWidth: 1280, innerHeight: 720 });
  const doc = Object.assign(new EventTarget(), { pointerLockElement: null, exitPointerLock: () => undefined });
  vi.stubGlobal('window', win);
  vi.stubGlobal('document', doc);
  vi.stubGlobal('navigator', { getGamepads: () => [] });
  return { win, items };
}

afterEach(() => vi.unstubAllGlobals());

describe('key bindings', () => {
  it('a stored binding round-trips; unknown codes, reserved keys and duplicates fall back to defaults', () => {
    const b = { ...DEFAULT_BINDINGS, forward: 'KeyI', phone: 'KeyB' };
    expect(parseBindings(JSON.parse(JSON.stringify(b)))).toEqual(b);
    expect(parseBindings({ ...b, forward: 'NotAKey', jump: 'ArrowUp', bogus: 'KeyZ' })).toEqual({ ...DEFAULT_BINDINGS, phone: 'KeyB' });
    expect(parseBindings({ ...DEFAULT_BINDINGS, map: 'KeyE' })).toEqual(DEFAULT_BINDINGS);
    expect(parseBindings('x')).toEqual(DEFAULT_BINDINGS);
    console.log('round trip ok; NotAKey, ArrowUp (reserved) and a duplicate fall back to defaults');
  });

  it('a key another action has is refused naming it (the one rule); a reserved key too; reset restores every default', () => {
    const cases = [
      ['job', 'KeyR'],
      ['map', 'KeyE'],
      ['forward', 'Escape'],
      ['jump', 'Digit3'],
      ['phone', 'KeyB'],
    ] as const;
    let b = { ...DEFAULT_BINDINGS };
    const out: string[] = [];
    for (const [a, code] of cases) {
      const r = rebind(b, a, code);
      out.push(`${a} -> ${code}: ${r.ok ? 'bound' : r.taken ? `refused, used by ${r.taken}` : `refused, reserved for ${r.reserved}`}`);
      if (r.ok) b = r.bindings;
    }
    console.log(out.join('\n'));
    expect(out).toEqual([
      'job -> KeyR: refused, used by reload',
      'map -> KeyE: refused, used by interact',
      'forward -> Escape: refused, reserved for pause and back',
      'jump -> Digit3: refused, reserved for weapon slots',
      'phone -> KeyB: bound',
    ]);
    expect(new Set(Object.values(b)).size).toBe(ACTIONS.length);
    const km = new Keymap();
    km.set(b);
    expect(km.isDefault).toBe(false);
    km.set({ ...DEFAULT_BINDINGS });
    expect(km.isDefault).toBe(true);
  });

  describe('in play', () => {
    let inp: Input;
    beforeEach(() => {
      page();
      const canvas = Object.assign(new EventTarget(), { requestPointerLock: () => undefined });
      inp = new Input(canvas as unknown as HTMLCanvasElement);
      inp.attach();
    });
    afterEach(() => inp.detach());
    const press = (code: string, key = code.replace(/^Key/, '').toLowerCase()) => {
      window.dispatchEvent(ev('keydown', { code, key, repeat: false }));
      const fi = inp.poll(1 / 60);
      inp.endFrame();
      window.dispatchEvent(ev('keyup', { code, key }));
      inp.poll(1 / 60);
      inp.endFrame();
      return fi;
    };

    it('the new key does the action and the old one no longer does; labels follow', () => {
      inp.keymap.set({ ...DEFAULT_BINDINGS, forward: 'KeyI', job: 'KeyG', interact: 'KeyC', phone: 'KeyB', sprint: 'ControlLeft' });
      expect(press('KeyI').player.moveZ).toBe(1);
      expect(press('KeyW').player.moveZ).toBe(0);
      expect(press('KeyG').player.job).toBe(true);
      expect(press('KeyT').player.job).toBe(false);
      expect(press('KeyB').ui.phone).toBe(true);
      expect(press('Tab', 'Tab').ui.phone).toBe(false);
      // Menus follow the movement keys too (and the arrows always).
      expect(press('KeyI').ui.up).toBe(true);
      expect(press('ArrowUp', 'ArrowUp').ui.up).toBe(true);
      expect(inp.labels.label('KeyW')).toBe('I');
      expect(inp.labels.label('ShiftLeft')).toBe('Ctrl');
      const ctx = { labels: inp.labels };
      const lines = [formatKeys('Press T to start a taxi job', 'kb', ctx), formatKeys('Press E to shop', 'kb', ctx), formatKeys('<kbd>Tab</kbd> phone', 'kb', ctx), formatKeys('<kbd>Shift</kbd> Sprint', 'kb', ctx)];
      console.log(lines.join('\n'));
      expect(lines).toEqual(['Press <kbd>G</kbd> to start a taxi job', 'Press <kbd>C</kbd> to shop', '<kbd>B</kbd> phone', '<kbd>Ctrl</kbd> Sprint']);
      inp.keymap.set(DEFAULT_BINDINGS);
      expect(formatKeys('Press T to start a taxi job', 'kb', ctx)).toBe('Press <kbd>T</kbd> to start a taxi job');
      expect(press('KeyW').player.moveZ).toBe(1);
    });

    it('cheat codes still work when typed, with their letters rebound', () => {
      inp.keymap.set({ ...DEFAULT_BINDINGS, job: 'KeyC', interact: 'KeyL' });
      for (const ch of 'CHILLOUT') press(`Key${ch}`, ch.toLowerCase());
      expect(inp.takeCheats().map((t) => t.code)).toContain('CHILLOUT');
    });

    it('a pending rebind takes the next key and nothing else sees it', () => {
      const got: string[] = [];
      inp.captureKey((c) => got.push(c));
      const fi = press('KeyT');
      expect(got).toEqual(['KeyT']);
      expect(fi.player.job).toBe(false);
      expect(press('KeyT').player.job).toBe(true);
    });
  });
});

describe('new settings', () => {
  it('an old settings object keeps its values and gets the new ones at their defaults', () => {
    const { items } = page();
    const old = { quality: 'low', master: 0.3, music: 0.2, sfx: 0.4, sensitivity: 2, invertY: true, fov: 80, hints: false, hintsSeen: ['drive'], weather: 'clear', lightningFlashes: false };
    items.set('gta7.settings.v1', JSON.stringify(old));
    const s = loadSettings();
    expect(s).toEqual({ ...old, bindings: DEFAULT_BINDINGS, resolutionScale: 1, fpsCap: 0, subtitleSize: 'normal', cameraShake: true, mapLayers: {} });
  });

  it('each bad new value falls back to its default without touching the others', () => {
    const { items } = page();
    const bad = { ...DEFAULT_SETTINGS, master: 0.3, resolutionScale: 0.1, fpsCap: 45, subtitleSize: 'huge', cameraShake: 'yes', bindings: { forward: 'Keyboard' }, mapLayers: { missions: false, 'Bad Key': false, shops: 'no' } };
    items.set('gta7.settings.v1', JSON.stringify(bad));
    const s = loadSettings();
    const out = { master: s.master, resolutionScale: s.resolutionScale, fpsCap: s.fpsCap, subtitleSize: s.subtitleSize, cameraShake: s.cameraShake, bindings: s.bindings === DEFAULT_BINDINGS || JSON.stringify(s.bindings) === JSON.stringify(DEFAULT_BINDINGS), mapLayers: s.mapLayers };
    console.log(JSON.stringify(out));
    expect(out).toEqual({ master: 0.3, resolutionScale: 1, fpsCap: 0, subtitleSize: 'normal', cameraShake: true, bindings: true, mapLayers: { missions: false } });
    // A good set survives a save and a load.
    saveSettings({ ...s, resolutionScale: 0.75, fpsCap: 30, subtitleSize: 'large', cameraShake: false, bindings: { ...DEFAULT_BINDINGS, phone: 'KeyB' } });
    expect(loadSettings()).toMatchObject({ resolutionScale: 0.75, fpsCap: 30, subtitleSize: 'large', cameraShake: false, bindings: { phone: 'KeyB' } });
  });
});

describe('camera shake setting', () => {
  it('off, blasts and crashes add no shake; on, as before', () => {
    const cam = new CameraController(16 / 9);
    cam.addShake(1.2);
    expect(cam.shake).toBeCloseTo(1.2);
    cam.shakeEnabled = false;
    expect(cam.shake).toBe(0);
    cam.addShake(1.2);
    cam.addKick(1, 0, 30);
    expect(cam.shake).toBe(0);
    cam.shakeEnabled = true;
    cam.addShake(0.5);
    expect(cam.shake).toBeCloseTo(0.5);
  });
});

describe('map legend', () => {
  it('lists missions, shops, properties and collectibles; switching one off hides exactly its icons', () => {
    const sim = makeSim({ ambient: false });
    expect(MAP_CATEGORIES.map((c) => c.id)).toEqual(expect.arrayContaining(['missions', 'shops', 'properties', 'collectibles']));
    const all = collectBlips(sim, 0, 0, { map: true });
    const key = (b: { x: number; z: number; label: string; category?: string }) => `${b.category ?? '-'}:${b.label}:${b.x.toFixed(1)},${b.z.toFixed(1)}`;
    const rows: string[] = [];
    for (const c of MAP_CATEGORIES) {
      const shown = collectBlips(sim, 0, 0, { map: true, hidden: new Set([c.id]) }).map(key);
      const expected = all.filter((b) => b.category !== c.id).map(key);
      expect(shown).toEqual(expected);
      rows.push(`${c.id} off: ${all.length - shown.length} of ${all.length} icons hidden`);
    }
    console.log(rows.join('\n'));
    expect(all.filter((b) => b.category === 'collectibles').length).toBe(PACKAGE_COUNT + 3);
    // The radar shows no collectibles.
    expect(collectBlips(sim, 0, 0).some((b) => b.category === 'collectibles')).toBe(false);
  });

  it('tells found collectibles from those still to find', () => {
    const sim = makeSim({ ambient: false });
    sim.progress.packages.push(0);
    sim.progress.rampages.push('rampage:1');
    const c = collectBlips(sim, 0, 0, { map: true }).filter((b) => b.category === 'collectibles');
    expect(c.filter((b) => b.shape === 'ring')).toHaveLength(2);
    expect(c.filter((b) => b.shape !== 'ring')).toHaveLength(PACKAGE_COUNT + 1);
  });

  it("files the garage and Pier Arcade under properties and Azura Customs under shops, by the economy's marker kinds", () => {
    const sim = makeSim({ ambient: false });
    const icons = (hidden: string[]) => collectBlips(sim, 0, 0, { map: true, hidden: new Set(hidden) }).map((b) => `${b.category ?? '-'}:${b.label}`);
    const all = icons([]);
    expect(all).toEqual(expect.arrayContaining(['properties:G', 'properties:$', 'shops:C']));
    expect(icons(['properties'])).not.toEqual(expect.arrayContaining(['properties:G']));
    expect(icons(['shops'])).not.toContain('shops:C');
    const props = MAP_CATEGORIES.find((c) => c.id === 'properties')!;
    expect(props.swatches.map((w) => w.label ?? '')).toEqual(['G', '$', '']);
  });
});

describe('completion checklist', () => {
  const extraContact = { id: 'chk_test', name: 'Check Test', phoneName: 'Check Test (phone)', color: '#123456', cssClass: 'chk_test', poiId: 'lou', mapLabel: 'C' };
  const extraMission: MissionDef = { id: 'chk_m', title: 'Check M', giver: 'chk_test', reward: 1, requires: [], blurb: 'x', *run() {} };
  afterEach(() => {
    unregisterCompletion('test_entry');
    unregisterActivity('chk_activity');
    unregisterContactMissions([extraMission]);
    unregisterContact(extraContact.id);
  });

  const table = (sim: ReturnType<typeof makeSim>) => completionRows(sim, sim.players[0]!).map((r) => `${r.group}/${r.label}: ${r.done}/${r.total}`);

  it('counts story per contact, packages, stunts, rampages and activities; the percentage is the old formula', () => {
    const fresh = makeSim({ ambient: false });
    const played = makeSim({ ambient: false });
    const p = played.progress;
    for (const id of ['wheels', 'delivery', 'repo', 'loose_lips']) p.markDone(id);
    p.packages.push(1, 2, 3);
    p.stunts.push(0, 1);
    p.rampages.push('rampage:0');
    p.stats.taxiFares = 4;
    for (const sim of [fresh, played]) console.log(table(sim).join('\n'), `\n${completionPercent(sim, sim.players[0]!)}%`);
    expect(table(played)).toEqual(expect.arrayContaining(['story/Mama Lou: 3/3', 'story/Dex Moreau: 1/3', 'collectibles/Hidden packages: 3/20', 'collectibles/Rampages: 1/3', 'activities/Taxi fares (to 10): 4/10']));
    const old = (sim: ReturnType<typeof makeSim>) => {
      const q = sim.progress;
      const done = sim.missions.defs.filter((d) => q.hasDone(d.id)).length;
      return Math.round(((done / sim.missions.defs.length) * 0.5 + (q.packages.length / PACKAGE_COUNT) * 0.2 + (q.stunts.length / sim.world.layout.ramps.length) * 0.15 + (q.rampages.length / 3) * 0.15) * 100);
    };
    expect(completionPercent(played, played.players[0]!)).toBe(old(played));
    expect(completionPercent(fresh, fresh.players[0]!)).toBe(0);
  });

  it('a test entry in the contact, activity or completion registry appears without other code changes', () => {
    registerContact(extraContact);
    registerContactMissions(extraContact.id, [extraMission]);
    registerActivity({ kind: 'chk_activity', canStart: () => false, prompt: () => null, start: () => false, update: () => undefined, end: () => undefined, objectives: () => [], status: () => null, completion: () => ({ label: 'Check activity', done: 1, total: 2 }) } as ActivityDef);
    registerCompletion({ id: 'test_entry', group: 'properties', rows: () => [{ id: 'garage_test', group: 'properties', label: 'Test garage', done: 0, total: 1 }] });
    const sim = makeSim({ ambient: false });
    const rows = table(sim);
    console.log(rows.join('\n'));
    expect(rows).toEqual(expect.arrayContaining(['story/Check Test: 0/1', 'activities/Check activity: 1/2', 'properties/Test garage: 0/1']));
  });
});
