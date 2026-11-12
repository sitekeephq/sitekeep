import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const root = import.meta.dirname;

export default defineConfig({
  root,
  appType: "mpa",
  publicDir: path.join(root, "public"),
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 4177,
    strictPort: true,
  },
});
