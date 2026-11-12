// Build step: tsc emits only the JSON it imports (English, Turkish). Every language folder under
// src/locales is copied to dist/locales, where the server registers the extra ones at start-up.
import { cpSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
cpSync(path.join(root, "src/locales"), path.join(root, "dist/locales"), { recursive: true });
