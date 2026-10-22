export declare const MAC_CHROME: string;

export interface BrowserLaunch {
  executablePath: string | undefined;
  args: string[];
}

export declare function browserLaunch(o: {
  platform: string;
  env: Record<string, string | undefined>;
  exists: (path: string) => boolean;
  bundledChromium?: string;
  software?: boolean;
}): BrowserLaunch;

export declare function currentBrowserLaunch(chromium: { executablePath(): string }, software?: boolean): BrowserLaunch;
