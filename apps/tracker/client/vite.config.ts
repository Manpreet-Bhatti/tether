import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const api = "http://localhost:8787";
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/push": api,
      "/pull": api,
      "/poke": { target: api, ws: true },
    },
  },
});
