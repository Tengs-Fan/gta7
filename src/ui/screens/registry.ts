// Screens a sim-side marker can open by name ('screenOpen' events): each registers here, so adding one does not touch
// Menus or Game.

import type { MenuCtx } from './shared';

export type ScreenOpener = (ctx: MenuCtx, onClose: () => void) => boolean;

const screens = new Map<string, ScreenOpener>();

export function registerScreen(name: string, open: ScreenOpener): void {
  screens.set(name, open);
}

export function screenOpener(name: string): ScreenOpener | undefined {
  return screens.get(name);
}
