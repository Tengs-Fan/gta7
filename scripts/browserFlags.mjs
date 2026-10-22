// Browser executable and GPU flags shared by playwright.config.ts and scripts/playtest.mjs.
// browserLaunch() is pure apart from the injected `exists` check, so the platform defaults are unit-testable.

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

export const MAC_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

/**
 * Whether GTA7_SWIFTSHADER asks for software rendering. "" and "0" always mean off; in 'one' mode
 * only "1" means on, in 'set' mode any other value does.
 * @param {string | undefined} value
 * @param {'one' | 'set'} mode
 */
export function swiftshaderFromEnv(value, mode) {
  if (value === undefined || value === '' || value === '0') return false;
  return mode === 'set' || value === '1';
}

/**
 * @param {object} o
 * @param {string} o.platform process.platform
 * @param {Record<string, string | undefined>} o.env process.env
 * @param {(path: string) => boolean} o.exists file existence check
 * @param {{ chromium?: string, headlessShell?: string }} [o.bundled] paths of Playwright's own
 *   Chromium and headless shell (installed or not)
 * @param {boolean} [o.headless] Playwright launches the headless shell when headless, full Chromium when headed
 * @param {boolean} [o.software] force SwiftShader
 * @param {'one' | 'set'} [o.swiftshaderEnv] how GTA7_SWIFTSHADER is read (see swiftshaderFromEnv)
 * @returns {{ executablePath: string | undefined, args: string[] }}
 */
export function browserLaunch({ platform, env, exists, bundled = {}, headless = true, software = false, swiftshaderEnv = 'set' }) {
  const swift = software || swiftshaderFromEnv(env.GTA7_SWIFTSHADER, swiftshaderEnv);
  // Chrome on macOS has no Vulkan backend and silently falls back to SwiftShader with it.
  const angle = env.GTA7_ANGLE || (platform === 'darwin' ? 'metal' : 'vulkan');
  const args = swift
    ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']
    : [`--use-angle=${angle}`, '--enable-gpu', '--ignore-gpu-blocklist'];
  let executablePath = env.GTA7_BROWSER || undefined;
  const needed = headless ? bundled.headlessShell : bundled.chromium;
  if (!executablePath && platform === 'darwin' && !(needed && exists(needed)) && exists(MAC_CHROME)) {
    executablePath = MAC_CHROME;
  }
  return { executablePath, args: [...args, '--autoplay-policy=no-user-gesture-required'] };
}

/** Paths of Playwright's bundled Chromium and headless shell, given its `chromium` browser type. */
export function bundledExecutables(chromium) {
  /** @type {{ chromium?: string, headlessShell?: string }} */
  const out = {};
  try {
    out.chromium = chromium.executablePath();
  } catch {
    // executablePath() throws when the platform has no bundled build.
  }
  try {
    // The headless shell path is only exposed through playwright-core's internal registry; if that
    // moves, the shell counts as missing and macOS falls back to the installed Chrome.
    const { registry } = createRequire(import.meta.url)('playwright-core/lib/coreBundle').registry;
    out.headlessShell = registry.findExecutable('chromium-headless-shell')?.executablePath() ?? undefined;
  } catch {
    out.headlessShell = undefined;
  }
  return out;
}

/**
 * browserLaunch() for the current process, given Playwright's `chromium` browser type.
 * @param {*} chromium
 * @param {{ headless?: boolean, software?: boolean, swiftshaderEnv?: 'one' | 'set' }} [o]
 */
export function currentBrowserLaunch(chromium, { headless = true, software = false, swiftshaderEnv = 'set' } = {}) {
  return browserLaunch({ platform: process.platform, env: process.env, exists: existsSync, bundled: bundledExecutables(chromium), headless, software, swiftshaderEnv });
}
