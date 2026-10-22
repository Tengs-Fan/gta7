export declare const MAC_CHROME: string;

export interface BrowserLaunch {
  executablePath: string | undefined;
  args: string[];
}

export type SwiftshaderEnv = 'one' | 'set';

export interface BundledExecutables {
  chromium?: string;
  headlessShell?: string;
}

export declare function swiftshaderFromEnv(value: string | undefined, mode: SwiftshaderEnv): boolean;

export declare function browserLaunch(o: {
  platform: string;
  env: Record<string, string | undefined>;
  exists: (path: string) => boolean;
  bundled?: BundledExecutables;
  headless?: boolean;
  software?: boolean;
  swiftshaderEnv?: SwiftshaderEnv;
}): BrowserLaunch;

export declare function bundledExecutables(chromium: { executablePath(): string }): BundledExecutables;

export declare function currentBrowserLaunch(
  chromium: { executablePath(): string },
  o?: { headless?: boolean; software?: boolean; swiftshaderEnv?: SwiftshaderEnv },
): BrowserLaunch;
