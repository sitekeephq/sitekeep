// Translation helpers (docs/architecture/i18n.md §1).
//
//   node apps/web/scripts/i18n.mjs new <code> <name> <short> <intl>   e.g. new es Español ES es-ES
//       Creates the language for the web app (apps/web/src/i18n/locales/<code>/) and the server
//       (apps/server/src/i18n/locales/<code>/) as "beta": meta.json plus every English namespace
//       file with the same keys and EMPTY values. Missing values fall back to English, so the
//       language can ship while it is being translated.
//   node apps/web/scripts/i18n.mjs status
//       Translated / total keys per language and namespace.
//
// Empty values are dropped when a language loads (they would otherwise hide the English fallback).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const WEB_LOCALES = path.resolve(here, "../src/i18n/locales");
const SERVER_LOCALES = path.resolve(here, "../../server/src/i18n/locales");
/** Shared package texts (enum labels, validation messages): no meta.json, the apps list the languages. */
const SHARED_LOCALES = path.resolve(here, "../../../packages/shared/src/locales");
const ROOTS = [
  ["web", WEB_LOCALES],
  ["server", SERVER_LOCALES],
  ["shared", SHARED_LOCALES],
];
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

function blank(tree) {
  return Object.fromEntries(Object.entries(tree).map(([k, v]) => [k, typeof v === "string" ? "" : blank(v)]));
}

function count(tree) {
  let total = 0;
  let filled = 0;
  for (const v of Object.values(tree)) {
    if (typeof v === "string") {
      total++;
      if (v.trim()) filled++;
    } else {
      const c = count(v);
      total += c.total;
      filled += c.filled;
    }
  }
  return { total, filled };
}

function namespaces(root) {
  return fs.readdirSync(path.join(root, "en")).filter((f) => f.endsWith(".json") && f !== "meta.json");
}

function create([code, name, short, intl]) {
  if (!code || !name || !short || !intl) throw new Error("usage: new <code> <name> <short> <intl>");
  for (const [, root] of ROOTS) if (fs.existsSync(path.join(root, code))) throw new Error(`${path.join(root, code)} already exists`);
  for (const [label, root] of ROOTS) {
    const dir = path.join(root, code);
    fs.mkdirSync(dir);
    if (label !== "shared") fs.writeFileSync(path.join(dir, "meta.json"), `${JSON.stringify({ name, short, intl, dir: "ltr", status: "beta" }, null, 2)}\n`);
    for (const f of namespaces(root)) fs.writeFileSync(path.join(dir, f), `${JSON.stringify(blank(readJson(path.join(root, "en", f))), null, 2)}\n`);
    console.log(`${label}: ${namespaces(root).length} files with empty values in ${path.relative(process.cwd(), dir)}`);
  }
  console.log(`Translate the values; set "status": "complete" in both meta.json files when done.`);
}

function status() {
  for (const [label, root] of ROOTS) {
    const en = Object.fromEntries(namespaces(root).map((f) => [f, count(readJson(path.join(root, "en", f))).total]));
    for (const code of fs.readdirSync(root).filter((d) => d !== "en" && fs.statSync(path.join(root, d)).isDirectory())) {
      const meta = fs.existsSync(path.join(root, code, "meta.json")) ? readJson(path.join(root, code, "meta.json")) : { name: code, status: "-" };
      let done = 0;
      let all = 0;
      const rows = [];
      for (const f of namespaces(root)) {
        const file = path.join(root, code, f);
        // Turkish enum labels are the *_LABELS_TR tables, not a file.
        const filled = fs.existsSync(file) ? count(readJson(file)).filled : label === "shared" && code === "tr" && f === "labels.json" ? en[f] : 0;
        done += filled;
        all += en[f];
        if (filled < en[f]) rows.push(`  ${f.padEnd(22)} ${String(filled).padStart(5)} / ${en[f]}`);
      }
      console.log(`${label} ${code} (${meta.name}, ${meta.status}): ${done} / ${all} (${Math.round((done / Math.max(all, 1)) * 100)}%)`);
      if (rows.length) console.log(rows.join("\n"));
    }
  }
}

const [command, ...args] = process.argv.slice(2);
if (command === "new") create(args);
else if (command === "status") status();
else console.log("usage: node apps/web/scripts/i18n.mjs new <code> <name> <short> <intl> | status");
