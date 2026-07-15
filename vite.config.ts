import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Frontend lives in ./frontend and builds to ./dist, which wrangler serves as
// Workers Assets. During `npm run dev:web`, proxy the data/API routes to a
// locally-running `npm run dev:api` (wrangler dev on :8787) so the UI gets real
// data with HMR.
export default defineConfig({
  root: "frontend",
  plugins: [react()],
  build: {
    outDir: "../dist",
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/calendar": "http://localhost:8787",
      "/poll": "http://localhost:8787",
    },
  },
});
