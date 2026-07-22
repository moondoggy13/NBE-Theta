import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  test: {
    environment: "node",
    include: [
      "src/**/*.{test,spec}.ts",
      "worker/**/*.{test,spec}.ts",
      "packages/**/*.{test,spec}.ts",
    ],
    coverage: {
      provider: "v8",
      include: ["src/lib/**", "worker/**", "packages/**"],
      exclude: ["**/*.d.ts", "**/__tests__/**", "**/generated/**"],
    },
  },
});
