// Records the single-player crowd baseline. CrowdView imports three from node_modules and needs no bundler, so this runs
// as a vitest file outside the normal suite (tsx is not installed):
//   CROWD_OUT=/tmp/out.json npx vitest run --root <worktree> --config scripts/record-crowd.vitest.config.ts
// The committed fixture tests/unit/fixtures/crowd_sp_72d0b98.json was recorded this way in a scratch worktree at 72d0b98.

import { writeFileSync } from 'node:fs';
import { it } from 'vitest';
import { installCanvasStubs } from '../tests/support/canvasStub';

it('records the crowd baseline', async () => {
  const out = process.env.CROWD_OUT;
  if (!out) throw new Error('set CROWD_OUT=<out.json>');
  installCanvasStubs();
  const { CrowdView } = await import('../src/render/crowd');
  const { recordCrowdScene } = await import('../tests/support/crowdScene');
  writeFileSync(out, `${JSON.stringify(recordCrowdScene(new CrowdView(), (sim) => sim.player.id))}\n`);
});
