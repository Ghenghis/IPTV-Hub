import { defineConfig } from "vite";
import { resolve } from "node:path";

// Vite is configured for a Tauri 2 dev server: fixed port, no HMR overlay collision
// with the Tauri window, and explicit external paths so the frontend bundle
// references can be inspected easily during a packaging audit.

export default defineConfig({
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    host: "127.0.0.1",
  },
  envPrefix: ["VITE_", "IPTV_HUB_"],
  build: {
    target: "esnext",
    minify: "esbuild",
    sourcemap: true,
    outDir: "dist",
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
});
