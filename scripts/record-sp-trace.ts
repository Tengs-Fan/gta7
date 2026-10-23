// Records the single-player same-seed trace: `npx tsx scripts/record-sp-trace.ts <out.json>`.
// The committed fixture tests/unit/fixtures/sp_trace_72d0b98.json was recorded this way in a scratch worktree at 72d0b98.

import { writeFileSync } from 'node:fs';
import { recordSpTrace } from '../tests/support/spTrace';

const out = process.argv[2];
if (!out) throw new Error('usage: tsx scripts/record-sp-trace.ts <out.json>');
writeFileSync(out, `${JSON.stringify(recordSpTrace())}\n`);
