import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { sitekeepModules } from "./sitekeep-modules";

export default defineConfig({
  plugins: [react(), sitekeepModules()],
  resolve: {
    // Modules (packages/ee-*) share the app's React, router and i18n instances.
    dedupe: ["react", "react-dom", "react-router-dom", "react-i18next", "i18next"],
    alias: { "@sitekeep/shared": path.resolve(__dirname, "../../packages/shared/src/index.ts") },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": process.env.CDE_API ?? "http://127.0.0.1:8787",
      "/mcp": process.env.CDE_API ?? "http://127.0.0.1:8787",
      "/wopi": process.env.CDE_API ?? "http://127.0.0.1:8787",
      // OpenCDE Foundation API and the OAuth2 server (docs/features/OPENCDE.md); the Host header is kept,
      // so the advertised addresses point at this dev server.
      "/foundation": process.env.CDE_API ?? "http://127.0.0.1:8787",
      "/oauth2": process.env.CDE_API ?? "http://127.0.0.1:8787",
      "/documents": process.env.CDE_API ?? "http://127.0.0.1:8787",
    },
  },
  build: { chunkSizeWarningLimit: 4000 },
});
