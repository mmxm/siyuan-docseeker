import { defineConfig } from "vitest/config";

/** Mesures hors `npm test` : `npm run measure:memory`. Le GC est exposé pour des mesures de tas fiables. */
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/perf/**/*.measure.test.ts"],
    pool: "forks",
    execArgv: ["--expose-gc"],
    testTimeout: 600_000,
    fileParallelism: false,
  },
});
