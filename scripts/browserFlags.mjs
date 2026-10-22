// Browser executable and GPU flags shared by playwright.config.ts and scripts/playtest.mjs.
// browserLaunch() is pure apart from the injected `exists` check, so the platform defaults are unit-testable.

import { existsSync } from 'node:fs';

export const MAC_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

/**
 * @param {object} o
 * @param {string} o.platform process.platform
 * @param {Record<string, string | undefined>} o.env process.env
 * @param {(path: string) => boolean} o.exists file existence check
 * @param {string | undefined} [o.bundledChromium] path of Playwright's own Chromium (installed or not)
 * @param {boolean} [o.software] force SwiftShader (also enabled by GTA7_SWIFTSHADER)
 * @returns {{ executablePath: string | undefined, args: string[] }}
 */
export function browserLaunch({ platform, env, exists, bundledChromium, software = false }) {
  const swift = software || !!env.GTA7_SWIFTSHADER;
  // Chrome on macOS has no Vulkan backend and silently falls back to SwiftShader with it.
  const angle = env.GTA7_ANGLE || (platform === 'darwin' ? 'metal' : 'vulkan');
  const args = swift
    ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']
    : [`--use-angle=${angle}`, '--enable-gpu', '--ignore-gpu-blocklist'];
  let executablePath = env.GTA7_BROWSER || undefined;
  if (!executablePath && platform === 'darwin' && !(bundledChromium && exists(bundledChromium)) && exists(MAC_CHROME)) {
    executablePath = MAC_CHROME;
  }
  return { executablePath, args: [...args, '--autoplay-policy=no-user-gesture-required'] };
}

/** browserLaunch() for the current process, given Playwright's `chromium` browser type. */
export function currentBrowserLaunch(chromium, software = false) {
  let bundledChromium;
  try {
    bundledChromium = chromium.executablePath();
  } catch {
    bundledChromium = undefined;
  }
  return browserLaunch({ platform: process.platform, env: process.env, exists: existsSync, bundledChromium, software });
}
