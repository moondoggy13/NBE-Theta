import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      "@nbe-theta/execution-domain": path.resolve(
        __dirname,
        "packages/execution-domain/src/index.ts",
      ),
    },
  },
  test: {
    environment: "node",
    include: [
      "src/**/*.{test,spec}.ts",
      "packages/**/*.{test,spec}.ts",
      "apps/**/*.{test,spec}.ts",
    ],
    coverage: {
      provider: "v8",
      include: ["src/**", "packages/**", "apps/**"],
      exclude: ["**/*.d.ts", "**/__tests__/**", "**/generated/**"],
    },
  },
});
