import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

// Locally the site reads /config.json from here: the local API (offline mode, sign-in bypassed).
const localConfig = { apiUrl: process.env.PERSONALFINANCE_API_URL || "http://127.0.0.1:4200", local: true };

export default defineConfig({
  plugins: [vue(), { name: "local-config", configureServer(server) { server.middlewares.use("/config.json", (_req, res) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(localConfig)); }); } }],
  build: { outDir: "dist", emptyOutDir: true, target: "es2022" }
});
