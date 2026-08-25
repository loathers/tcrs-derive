import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [reactRouter()],
  // Vite 8 resolves tsconfig `paths` natively; no vite-tsconfig-paths needed.
  resolve: { tsconfigPaths: true },
  server: {
    port: 3000,
    watch: {
      // Do NOT watch the data dir. Every KoLmafia JVM writes a full mafia data
      // tree into data/work/<user>/ — settings, sessions, images, relay/*.html —
      // and Vite was treating those as source edits and firing HMR page reloads
      // mid-run, while scanning ~50-100MB per concurrent JVM.
      ignored: ["**/data/**", "**/out/**", "**/logs/**", "**/tcrs-out/**"],
    },
  },
});
