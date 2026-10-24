// The order boot runs in: loading screen, fonts, assets, then the game. Kept apart from main.ts so a test can run it
// with stand-ins and check that nothing is built before the assets have settled.

export interface BootSteps {
  /** Shows the loading screen and returns false when the browser cannot run the game. */
  showLoading(): boolean;
  fonts(): Promise<void>;
  /** Resolves when every asset is loaded or has fallen back; reports progress 0..1 as bytes arrive. */
  assets(onProgress: (fraction: number) => void): Promise<unknown>;
  onProgress(fraction: number): void;
  /** Lets the loading screen paint before the heavy synchronous build. */
  paint(): Promise<void>;
  startGame(): void;
}

export async function runBoot(steps: BootSteps): Promise<boolean> {
  if (!steps.showLoading()) return false;
  await steps.fonts();
  await steps.assets(steps.onProgress);
  steps.onProgress(1);
  await steps.paint();
  steps.startGame();
  return true;
}
