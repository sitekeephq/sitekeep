import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const supportDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(supportDir, "../..");
const serverEntry = path.join(root, "apps/server/dist/index.js");
const webDist = path.join(root, "apps/web/dist");
const webIndex = path.join(webDist, "index.html");

for (const output of [serverEntry, webIndex]) {
  if (!existsSync(output)) {
    console.error(`[e2e] Missing build output: ${output}`);
    console.error("[e2e] Run `npm run build` with Node 22 before starting Playwright.");
    process.exit(1);
  }
}

const tmpRoot = path.join(root, "e2e/.tmp");
rmSync(tmpRoot, { recursive: true, force: true });
mkdirSync(tmpRoot, { recursive: true });
const dataDir = mkdtempSync(path.join(tmpRoot, "run-"));
const port = process.env.E2E_PORT ?? "18080";
let cleaned = false;

function clean() {
  if (cleaned) return;
  cleaned = true;
  rmSync(dataDir, { recursive: true, force: true });
}

const child = spawn(process.execPath, [serverEntry], {
  cwd: root,
  stdio: "inherit",
  env: {
    ...process.env,
    DATA_DIR: dataDir,
    DATABASE_URL: "memory://",
    WEB_DIST: webDist,
    HOST: "127.0.0.1",
    PORT: port,
    ADMIN_EMAIL: "e2e-admin@7d-cde.localhost",
    ADMIN_PASSWORD: "E2e-Only!7D-CDE#2026",
    SECURE_COOKIES: "0",
    NODE_ENV: "test",
    AI_ENABLED: "0",
    CDE_DEV_TOOLS: "0",
    CDE_OFFICE_CONVERTER: "none",
    GOOGLE_CLIENT_ID: "",
    GOOGLE_CLIENT_SECRET: "",
    GOOGLE_CALLBACK_URL: "",
    AUTODESK_CLIENT_ID: "",
    AUTODESK_CALLBACK_URL: "",
    CDE_SMTP_URL: "",
    CDE_SMTP_FROM: "",
    // Kapasite sample engine: a load test plays in a few seconds instead of ~30.
    CAPACITY_DEMO_TICK_MS: "25",
  },
});

console.log(`[e2e] Starting isolated server on http://127.0.0.1:${port}`);

let stopping = false;
function stop(signal) {
  if (stopping) return;
  stopping = true;
  if (child.exitCode === null) child.kill(signal);
}

process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGINT", () => stop("SIGINT"));
process.on("exit", clean);

child.on("error", (error) => {
  console.error("[e2e] Failed to start server:", error);
  clean();
  process.exit(1);
});

child.on("exit", (code, signal) => {
  clean();
  if (!stopping && (code ?? 1) !== 0) {
    console.error(`[e2e] Server exited unexpectedly (${signal ?? code}).`);
  }
  process.exit(stopping ? 0 : (code ?? 1));
});
