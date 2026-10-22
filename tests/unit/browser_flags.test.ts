import { describe, expect, it } from 'vitest';
import { browserLaunch, MAC_CHROME, swiftshaderFromEnv } from '../../scripts/browserFlags.mjs';

const FULL = '/cache/ms-playwright/chromium/chrome';
const SHELL = '/cache/ms-playwright/chromium_headless_shell/chrome-headless-shell';
const BUNDLED = { chromium: FULL, headlessShell: SHELL };
const only = (...paths: string[]) => (p: string) => paths.includes(p);
const SOFTWARE = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'];

describe('browser launch defaults', () => {
  it('keeps ANGLE Vulkan and the bundled Chromium on Linux', () => {
    const l = browserLaunch({ platform: 'linux', env: {}, exists: only(MAC_CHROME), bundled: BUNDLED });
    expect(l.executablePath).toBeUndefined();
    expect(l.args).toEqual(['--use-angle=vulkan', '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required']);
  });

  it('uses ANGLE Metal and the installed Chrome on macOS without Playwright browsers', () => {
    const l = browserLaunch({ platform: 'darwin', env: {}, exists: only(MAC_CHROME), bundled: BUNDLED });
    expect(l.executablePath).toBe(MAC_CHROME);
    expect(l.args[0]).toBe('--use-angle=metal');
    expect(l.args).toContain('--enable-gpu');
  });

  it('prefers the installed Playwright browsers on macOS', () => {
    for (const headless of [true, false]) {
      const l = browserLaunch({ platform: 'darwin', env: {}, exists: only(MAC_CHROME, FULL, SHELL), bundled: BUNDLED, headless });
      expect(l.executablePath).toBeUndefined();
      expect(l.args[0]).toBe('--use-angle=metal');
    }
  });

  it('falls back to Chrome only when it exists', () => {
    const l = browserLaunch({ platform: 'darwin', env: {}, exists: only(), bundled: BUNDLED });
    expect(l.executablePath).toBeUndefined();
  });

  it('lets GTA7_ANGLE and GTA7_BROWSER override the defaults', () => {
    for (const platform of ['darwin', 'linux']) {
      const l = browserLaunch({ platform, env: { GTA7_ANGLE: 'gl', GTA7_BROWSER: '/opt/chrome' }, exists: only(MAC_CHROME), bundled: BUNDLED });
      expect(l.executablePath).toBe('/opt/chrome');
      expect(l.args[0]).toBe('--use-angle=gl');
    }
  });
});

describe('bundled browser probe follows the executable Playwright launches', () => {
  // Playwright launches chromium-headless-shell when headless and full Chromium when headed.
  const cases: { install: string; present: string[]; headless: boolean; chrome: boolean }[] = [
    { install: 'full only', present: [FULL], headless: true, chrome: true },
    { install: 'full only', present: [FULL], headless: false, chrome: false },
    { install: 'shell only', present: [SHELL], headless: true, chrome: false },
    { install: 'shell only', present: [SHELL], headless: false, chrome: true },
    { install: 'absent', present: [], headless: true, chrome: true },
    { install: 'absent', present: [], headless: false, chrome: true },
    { install: 'full and shell', present: [FULL, SHELL], headless: true, chrome: false },
    { install: 'full and shell', present: [FULL, SHELL], headless: false, chrome: false },
  ];
  for (const c of cases) {
    it(`${c.install}, ${c.headless ? 'headless' : 'headed'} → ${c.chrome ? 'system Chrome' : 'bundled'}`, () => {
      const l = browserLaunch({ platform: 'darwin', env: {}, exists: only(MAC_CHROME, ...c.present), bundled: BUNDLED, headless: c.headless });
      expect(l.executablePath).toBe(c.chrome ? MAC_CHROME : undefined);
    });
  }

  it('treats an unknown bundled path as missing', () => {
    expect(browserLaunch({ platform: 'darwin', env: {}, exists: only(MAC_CHROME, FULL), bundled: { chromium: FULL } }).executablePath).toBe(MAC_CHROME);
    expect(browserLaunch({ platform: 'darwin', env: {}, exists: only(MAC_CHROME, FULL), bundled: { chromium: FULL }, headless: false }).executablePath).toBeUndefined();
  });

  it('never substitutes Chrome on Linux', () => {
    for (const headless of [true, false]) {
      expect(browserLaunch({ platform: 'linux', env: {}, exists: only(MAC_CHROME), bundled: BUNDLED, headless }).executablePath).toBeUndefined();
    }
  });
});

describe('GTA7_SWIFTSHADER', () => {
  const swift = (value: string | undefined, swiftshaderEnv: 'one' | 'set', software = false) =>
    browserLaunch({ platform: 'darwin', env: { GTA7_SWIFTSHADER: value, GTA7_ANGLE: 'gl' }, exists: only(), software, swiftshaderEnv }).args;

  for (const mode of ['one', 'set'] as const) {
    it(`${mode} mode: unset, "" and "0" keep the hardware GPU; "1" selects SwiftShader`, () => {
      for (const value of [undefined, '', '0']) {
        expect(swiftshaderFromEnv(value, mode)).toBe(false);
        expect(swift(value, mode)[0]).toBe('--use-angle=gl');
      }
      expect(swiftshaderFromEnv('1', mode)).toBe(true);
      expect(swift('1', mode)).toEqual(SOFTWARE);
    });

    it(`${mode} mode: the software option (--swiftshader) forces SwiftShader whatever the env`, () => {
      for (const value of [undefined, '', '0', '1']) expect(swift(value, mode, true)).toEqual(SOFTWARE);
    });
  }

  it('the Playwright config reads any other value as on, playtest only "1"', () => {
    expect(swiftshaderFromEnv('true', 'set')).toBe(true);
    expect(swiftshaderFromEnv('yes', 'set')).toBe(true);
    expect(swiftshaderFromEnv('true', 'one')).toBe(false);
    expect(swiftshaderFromEnv('yes', 'one')).toBe(false);
  });

  it('defaults to the Playwright config reading', () => {
    expect(browserLaunch({ platform: 'linux', env: { GTA7_SWIFTSHADER: 'true' }, exists: only() }).args).toEqual(SOFTWARE);
    expect(browserLaunch({ platform: 'linux', env: { GTA7_SWIFTSHADER: '0' }, exists: only() }).args[0]).toBe('--use-angle=vulkan');
  });
});
