import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  root: ".",
  base: "./",
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["node_modules/**", "dist/**"]
  },
  build: {
    outDir: "dist/renderer",
    emptyOutDir: true
  }
});
