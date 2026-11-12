// Finds interface text written in code instead of the translation files (docs/architecture/i18n.md §6):
//   - JSX text with a word ("Kaydet", "Save"),
//   - text attributes (title, aria-label, placeholder, alt, label, confirmLabel, cancelLabel) with a word,
//   - any string or template literal with a Turkish letter (messages built in code).
// Brand names, acronyms and symbols pass ("CDE", "PDF", "IFC", "⌘K", "—"): a "word" is two or
// more letters with a lowercase one. Imports, types and comments are skipped. A line that really
// needs a literal ends with the comment `i18n-ok`.
//
// Run: npm test -w @sitekeep/web (test/i18n/hardcoded.test.ts) or node apps/web/scripts/check-i18n.mjs [dir]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseSync } from "rolldown/utils"; // oxc parser, shipped with Vite

const here = path.dirname(fileURLToPath(import.meta.url));
export const WEB_SRC = path.resolve(here, "../src");

const TEXT_ATTRS = new Set(["title", "aria-label", "aria-description", "placeholder", "alt", "label", "confirmLabel", "cancelLabel"]);
const SKIP_NODES = new Set([
  "ImportDeclaration",
  "ExportAllDeclaration",
  "ImportExpression",
  "TSTypeAnnotation",
  "TSTypeAliasDeclaration",
  "TSInterfaceDeclaration",
  "TSLiteralType",
  "TSEnumDeclaration",
]);
const TURKISH = /[çğıöşüÇĞİÖŞÜ]/;
/** A word a reader sees: 2+ letters, one of them lowercase (so "PDF", "CDE" pass). */
const WORD = /\p{L}*\p{Ll}\p{L}*/u;
const hasWord = (text) => text.split(/[^\p{L}]+/u).some((w) => w.length >= 2 && WORD.test(w));

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (p.endsWith(`${path.sep}i18n${path.sep}locales`)) continue;
      yield* walk(p);
    } else if (/\.(ts|tsx)$/.test(e.name) && !e.name.endsWith(".d.ts")) yield p;
  }
}

function checkFile(file, root) {
  const src = fs.readFileSync(file, "utf8");
  const rel = path.relative(root, file).replace(/\\/g, "/");
  const lines = src.split("\n");
  let ast;
  try {
    ast = parseSync(file, src, { lang: file.endsWith(".tsx") ? "tsx" : "ts" }).program;
  } catch (e) {
    return [`${rel}: could not parse (${e.message})`];
  }
  const problems = [];
  const report = (node, text, why) => {
    const line = src.slice(0, node.start).split("\n").length;
    if (lines[line - 1]?.includes("i18n-ok")) return;
    problems.push(`${rel}:${line}  ${why}: "${text.trim().replace(/\s+/g, " ").slice(0, 80)}"`);
  };
  const visit = (node, parent, key) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const n of node) visit(n, parent, key);
      return;
    }
    if (typeof node.type !== "string" || SKIP_NODES.has(node.type)) return;
    if (node.type === "JSXText") {
      if (hasWord(node.value)) report(node, node.value, "JSX text");
      return;
    }
    if (node.type === "JSXAttribute") {
      const name = node.name?.name;
      const v = node.value;
      if (TEXT_ATTRS.has(name) && v?.type === "Literal" && typeof v.value === "string" && hasWord(v.value)) {
        report(v, v.value, `${name}=`);
        return;
      }
    }
    if (node.type === "Literal") {
      const objectKey = key === "key" && (parent?.type === "Property" || parent?.type === "PropertyDefinition");
      if (typeof node.value === "string" && !objectKey && TURKISH.test(node.value)) report(node, node.value, "Turkish string");
      return;
    }
    if (node.type === "TemplateElement") {
      const text = node.value?.cooked ?? node.value?.raw ?? "";
      if (TURKISH.test(text)) report(node, text, "Turkish template");
      return;
    }
    for (const k of Object.keys(node)) {
      if (k === "type" || k === "start" || k === "end") continue;
      const v = node[k];
      if (v && typeof v === "object") visit(v, node, k);
    }
  };
  visit(ast, null, null);
  return problems;
}

export function findHardcodedTexts(root = WEB_SRC) {
  const problems = [];
  let files = 0;
  for (const file of walk(root)) {
    files++;
    problems.push(...checkFile(file, root));
  }
  return { files, problems };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { files, problems } = findHardcodedTexts(path.resolve(process.argv[2] ?? WEB_SRC));
  if (problems.length) {
    console.error(`Text in code instead of locales (${problems.length}); see docs/architecture/i18n.md:`);
    for (const p of problems) console.error(`  ${p}`);
    process.exit(1);
  }
  console.log(`i18n: ${files} files scanned, no hard-coded interface text.`);
}
