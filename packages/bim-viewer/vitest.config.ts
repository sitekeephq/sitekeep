import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "happy-dom",
    include: ["tests/**/*.{test,spec}.{ts,tsx}"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      // index files only re-export.
      exclude: ["src/**/index.ts"],
      reporter: ["text-summary", "html"],
      reportsDirectory: "coverage",
      // Just under today's unit coverage (the e2e suite covers the WebGL paths); CI fails on a drop.
      thresholds: { statements: 70, branches: 54, functions: 68, lines: 73 },
    },
  },
});
