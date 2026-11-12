// Build step: tsc does not copy JSON, so the server's translation files (src/i18n/locales) are
// copied next to the compiled code (dist/i18n/locales), where src/i18n/index.ts reads them.
import { cpSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const from = path.join(root, "src/i18n/locales");
const to = path.join(root, "dist/i18n/locales");
rmSync(to, { recursive: true, force: true });
cpSync(from, to, { recursive: true });
console.log(`locales copied to ${path.relative(root, to)}`);
