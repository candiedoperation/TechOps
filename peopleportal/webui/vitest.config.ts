import path from "path"
import { defineConfig } from "vitest/config"
import react from "@vitejs/plugin-react-swc"

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@root": path.resolve(__dirname),
    },
  },
  test: {
    // Match Vite's handling of the tag input's ESM/tslib dependency chain.
    server: { deps: { inline: ["emblor-maintained", "react-easy-sort", "tslib"] } },
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
  },
})
