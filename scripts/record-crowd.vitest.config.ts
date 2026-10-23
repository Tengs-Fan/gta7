import { defineConfig } from 'vitest/config';

export default defineConfig({ test: { include: ['scripts/record-crowd-baseline.test.ts'], environment: 'node', testTimeout: 120_000 } });
