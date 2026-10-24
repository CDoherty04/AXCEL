import { defineConfig } from 'vitest/config'

// Credit-layer tests live in test/layer; test/credit.test.ts uses node:test and runs via npm test.
export default defineConfig({ test: { include: ['test-layer/**/*.test.ts'] } })
