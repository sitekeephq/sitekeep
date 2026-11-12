// Finds Turkish text written in server code instead of the translation files
// (docs/architecture/i18n.md §8): every string or template literal with a Turkish letter.
//
// Not checked: src/i18n/locales, src/dev and src/scripts (demo data, developer tools), src/db (schema, seeds).
// Text that must stay Turkish on purpose is marked:
//   - a line ending with the comment `i18n-ok: <reason>` (an AI prompt, a regex for Turkish input,
//     a default name stored as data, a log line);
//   - a whole file with `// i18n-ok-file: <reason>` in its first lines (a prompt library, demo data).
// The `*_LABELS_TR` tables of packages/shared are skipped: they are the Turkish enum labels (§5).
//
// Run: npm test -w @sitekeep/server (test/i18n/i18n.test.ts) or node apps/server/scripts/check-i18n.mjs [dir]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseSync } from "rolldown/utils"; // oxc parser, shipped with Vite (root node_modules)

const here = path.dirname(fileURLToPath(import.meta.url));
export const SERVER_SRC = path.resolve(here, "../src");
const SKIP_DIRS = new Set(["locales", "dev", "db", "scripts"]);
const SKIP_NODES = new Set(["ImportDeclaration", "ExportAllDeclaration", "ImportExpression", "TSTypeAnnotation", "TSTypeAliasDeclaration", "TSInterfaceDeclaration", "TSLiteralType"]);
const TURKISH = /[çğıöşüÇĞİÖŞÜ]/;

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) yield* walk(p);
    } else if (/\.ts$/.test(e.name) && !e.name.endsWith(".d.ts")) yield p;
  }
}

function checkFile(file, root) {
  const src = fs.readFileSync(file, "utf8");
  const rel = path.relative(root, file).replace(/\\/g, "/");
  if (/^\s*\/\/ i18n-ok-file:/m.test(src.split("\n").slice(0, 15).join("\n"))) return [];
  const lines = src.split("\n");
  let ast;
  try {
    ast = parseSync(file, src, { lang: "ts" }).program;
  } catch (e) {
    return [`${rel}: could not parse (${e.message})`];
  }
  const problems = [];
  const report = (node, text) => {
    const line = src.slice(0, node.start).split("\n").length;
    if (lines[line - 1]?.includes("i18n-ok")) return;
    problems.push(`${rel}:${line}  "${text.trim().replace(/\s+/g, " ").slice(0, 90)}"`);
  };
  const visit = (node, parent, key) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach((n) => visit(n, parent, key));
    if (typeof node.type !== "string" || SKIP_NODES.has(node.type)) return;
    // The shared *_LABELS_TR tables are the Turkish source of the enum labels (i18n.md §5).
    if (node.type === "VariableDeclarator" && /_LABELS?_TR$/.test(node.id?.name ?? "")) return;
    if (node.type === "Literal") {
      const objectKey = key === "key" && (parent?.type === "Property" || parent?.type === "PropertyDefinition");
      if (typeof node.value === "string" && !objectKey && TURKISH.test(node.value)) report(node, node.value);
      return;
    }
    if (node.type === "TemplateElement") {
      const text = node.value?.cooked ?? node.value?.raw ?? "";
      if (TURKISH.test(text)) report(node, text);
      return;
    }
    for (const k of Object.keys(node)) if (k !== "type" && k !== "start" && k !== "end" && node[k] && typeof node[k] === "object") visit(node[k], node, k);
  };
  visit(ast, null, null);
  return problems;
}

export function findServerTexts(root = SERVER_SRC) {
  const problems = [];
  let files = 0;
  for (const file of walk(root)) {
    files++;
    problems.push(...checkFile(file, root));
  }
  return { files, problems };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { files, problems } = findServerTexts(path.resolve(process.argv[2] ?? SERVER_SRC));
  if (problems.length) {
    console.error(`Turkish text in server code (${problems.length}); see docs/architecture/i18n.md §8:`);
    for (const p of problems) console.error(`  ${p}`);
    process.exit(1);
  }
  console.log(`i18n: ${files} server files scanned, no Turkish text in code.`);
}
