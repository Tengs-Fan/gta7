import { describe, expect, it } from 'vitest';
import { browserLaunch, MAC_CHROME } from '../../scripts/browserFlags.mjs';

const BUNDLED = '/cache/ms-playwright/chromium/chrome';
const only = (...paths: string[]) => (p: string) => paths.includes(p);

describe('browser launch defaults', () => {
  it('keeps ANGLE Vulkan and the bundled Chromium on Linux', () => {
    const l = browserLaunch({ platform: 'linux', env: {}, exists: only(MAC_CHROME), bundledChromium: BUNDLED });
    expect(l.executablePath).toBeUndefined();
    expect(l.args).toEqual(['--use-angle=vulkan', '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required']);
  });

  it('uses ANGLE Metal and the installed Google Chrome on macOS without Playwright Chromium', () => {
    const l = browserLaunch({ platform: 'darwin', env: {}, exists: only(MAC_CHROME), bundledChromium: BUNDLED });
    expect(l.executablePath).toBe(MAC_CHROME);
    expect(l.args[0]).toBe('--use-angle=metal');
    expect(l.args).toContain('--enable-gpu');
  });

  it('prefers the installed Playwright Chromium on macOS', () => {
    const l = browserLaunch({ platform: 'darwin', env: {}, exists: only(MAC_CHROME, BUNDLED), bundledChromium: BUNDLED });
    expect(l.executablePath).toBeUndefined();
    expect(l.args[0]).toBe('--use-angle=metal');
  });

  it('falls back to Chrome only when it exists', () => {
    const l = browserLaunch({ platform: 'darwin', env: {}, exists: only(), bundledChromium: BUNDLED });
    expect(l.executablePath).toBeUndefined();
  });

  it('lets GTA7_ANGLE and GTA7_BROWSER override the defaults', () => {
    for (const platform of ['darwin', 'linux']) {
      const l = browserLaunch({ platform, env: { GTA7_ANGLE: 'gl', GTA7_BROWSER: '/opt/chrome' }, exists: only(MAC_CHROME), bundledChromium: BUNDLED });
      expect(l.executablePath).toBe('/opt/chrome');
      expect(l.args[0]).toBe('--use-angle=gl');
    }
  });

  it('switches to SwiftShader with GTA7_SWIFTSHADER or the software option', () => {
    const want = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'];
    expect(browserLaunch({ platform: 'linux', env: { GTA7_SWIFTSHADER: '1', GTA7_ANGLE: 'gl' }, exists: only() }).args).toEqual(want);
    expect(browserLaunch({ platform: 'darwin', env: {}, exists: only(), software: true }).args).toEqual(want);
  });
});
