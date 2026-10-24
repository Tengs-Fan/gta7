import '@fontsource/anton/latin-400.css';
import '@fontsource/rajdhani/latin-500.css';
import '@fontsource/rajdhani/latin-600.css';
import '@fontsource/rajdhani/latin-700.css';
import './ui/style.css';
import { Game } from './game';
import { installCombatDebug } from './combatDebug';
import { installDebugApi, registerDebug } from './debug';
import { netOptionsFromUrl } from './net/url';
import { runBoot } from './boot';
import { loadingMarkup, setLoadingProgress } from './loadingScreen';
import { assets, type AssetKind } from './render/assets';
import { browserBackend } from './render/assets/browser';

function webgl2Available(): boolean {
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2');
    const ok = !!gl;
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
    return ok;
  } catch {
    return false;
  }
}

function showError(ui: HTMLElement, title: string, text: string): void {
  ui.innerHTML = `<div class="error"><div><h2 style="font-family:Anton,Impact,sans-serif;font-size:44px;margin:0 0 12px">${title}</h2><p>${text}</p></div></div>`;
}

async function boot(): Promise<void> {
  const ui = document.getElementById('ui')!;
  const canvas = document.getElementById('game') as HTMLCanvasElement;
  // ?assets=0 skips the asset preload: every view then builds its procedural model.
  const useAssets = new URLSearchParams(location.search).get('assets') !== '0';
  try {
    await runBoot({
      showLoading() {
        ui.innerHTML = loadingMarkup();
        if (webgl2Available()) return true;
        showError(ui, 'WEBGL 2 REQUIRED', 'Your browser or graphics driver does not support WebGL 2. Try a recent Chrome, Edge or Firefox with hardware acceleration enabled.');
        return false;
      },
      // Fonts are used for canvas-drawn signs; wait briefly so they render with the right typeface.
      async fonts() {
        try {
          await Promise.race([
            Promise.all([document.fonts.load('400 40px Anton'), document.fonts.load('700 40px Rajdhani'), document.fonts.load('600 40px Rajdhani')]),
            new Promise((r) => setTimeout(r, 2500)),
          ]);
        } catch {
          // Fall back to system fonts.
        }
      },
      // Never rejects: assets that fail or stall fall back to the procedural models.
      assets: (onProgress) => (useAssets ? assets.preload(onProgress, { backend: browserBackend }) : Promise.resolve()),
      onProgress: (f) => setLoadingProgress(ui, f),
      paint: () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0))),
      startGame: () => startGame(ui, canvas),
    });
  } catch (err) {
    console.error(err);
    showError(ui, 'COULD NOT START', `The game failed to initialise: ${String(err instanceof Error ? err.message : err).replace(/</g, '&lt;')}`);
  }
}

function startGame(ui: HTMLElement, canvas: HTMLCanvasElement): void {
  ui.innerHTML = '';
  const game = new Game(canvas, ui);
  installDebugApi(game);
  installCombatDebug(game);
  // Errors outside the frame loop (DOM handlers, promises) never stop the game: they are logged, and the
  // crash report lists them should the game break later.
  window.addEventListener('error', (e) => {
    console.error('GTA7 uncaught error', e.error ?? e.message);
    game.noteEvent('error', String(e.message || e.error));
  });
  window.addEventListener('unhandledrejection', (e) => {
    console.error('GTA7 unhandled rejection', e.reason);
    game.noteEvent('rejection', String(e.reason instanceof Error ? e.reason.message : e.reason));
  });
  game.start();
  // ?mp=1 joins a multiplayer room straight away (no WebSocket is opened otherwise).
  const mp = netOptionsFromUrl(location.search, location, !!document.querySelector('meta[name="gta7-server"]'));
  if (mp) void game.joinMultiplayer(mp);
}

// window.__gta7.ext.assets: what the preload loaded, for the tests and the console.
registerDebug('assets', {
  report: () => ({ ...assets.report, ready: assets.ready, loadedIds: assets.ids().length }),
  ids: (kind?: AssetKind) => assets.ids(kind),
  entry: (id: string) => assets.entry(id),
  warmGroup: () => assets.warmGroup(),
  list: () => (assets.manifest?.entries ?? []).map((e) => ({ id: e.id, kind: e.kind, bytes: e.bytes, loaded: assets.has(e.id) })),
});

void boot();
