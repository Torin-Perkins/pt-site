import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Served from /portal/ on the marketing site (see scripts/build.sh).
export default defineConfig({
  base: "/portal/",
  plugins: [react()],
  server: { port: 5173, host: "127.0.0.1" },
  // Firebase is most of the bundle; 300 kB gzipped is expected.
  build: { outDir: "dist", sourcemap: false, chunkSizeWarningLimit: 1200 },
});
