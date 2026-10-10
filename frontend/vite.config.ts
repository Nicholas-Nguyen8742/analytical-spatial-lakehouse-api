/// <reference types="vitest/config" />
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
  },
  build: {
    rollupOptions: {
      output: {
        // Vite 8 builds through Rolldown, which only accepts the function form of
        // manualChunks — the object shorthand is Rollup-only and fails typecheck.
        // Splitting the two WebGL stacks keeps either one off the entry chunk.
        manualChunks(id: string): string | undefined {
          if (!id.includes("node_modules")) return undefined;
          if (id.includes("maplibre-gl")) return "maplibre";
          if (
            id.includes("@deck.gl") ||
            id.includes("@luma.gl") ||
            id.includes("@loaders.gl") ||
            id.includes("@math.gl") ||
            id.includes("@probe.gl") ||
            id.includes("mjolnir.js")
          ) {
            return "deck";
          }
          return undefined;
        },
      },
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    css: false,
    restoreMocks: true,
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        "src/test/**",
        "src/**/*.d.ts",
        "src/main.tsx",
        // WebGL-only: driven through MapView, which jsdom cannot host.
        "src/components/MapView.tsx",
        // Declaration-only and constant-only modules have no runtime statements to cover.
        "src/api/types.ts",
        "src/map/config.ts",
        "**/*.test.{ts,tsx}",
      ],
    },
  },
});
