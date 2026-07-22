// Package-local vitest config so the README-documented
// `pnpm --filter @nbe-theta/contracts test` actually finds the tests.
// (Without this, vitest run from this cwd matched nothing and exited 1.)
// The root vitest config also picks these tests up via packages/** —
// both entrypoints run the same files.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/ts/**/*.{test,spec}.ts"],
  },
});
