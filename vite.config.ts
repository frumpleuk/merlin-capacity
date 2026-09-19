import fs from "node:fs";
import path from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

// Menu photos live in R2 in production (uploaded by scripts/menus/publish.mjs,
// served by the worker's /menus/ route). Locally they're just files in the repo,
// one folder deeper — /menus/<park>/<venue>/<date>/<name>.jpg is
// contrib/menus/merlin/<park>/<venue>/<date>/web/<name>.jpg — so serve them
// straight off disk and the Food tab looks the same as deployed.
function menuPhotos(): Plugin {
  const ROOT = path.resolve(__dirname, "contrib/menus/merlin");
  return {
    name: "menu-photos",
    configureServer(server) {
      server.middlewares.use("/menus", (req, res, next) => {
        const rel = decodeURIComponent((req.url ?? "").split("?")[0]).replace(/^\/+/, "");
        const file = path.join(ROOT, path.dirname(rel), "web", path.basename(rel));
        if (!file.startsWith(ROOT) || !file.endsWith(".jpg") || !fs.existsSync(file)) return next();
        res.setHeader("content-type", "image/jpeg");
        fs.createReadStream(file).pipe(res);
      });
    },
  };
}

// Frontend lives in ./frontend and builds to ./dist, which wrangler serves as
// Workers Assets. During `npm run dev:web`, proxy the data/API routes to a
// locally-running `npm run dev:api` (wrangler dev on :8787) so the UI gets real
// data with HMR.
export default defineConfig({
  root: "frontend",
  plugins: [react(), menuPhotos()],
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
