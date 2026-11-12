// Finds user-visible texts in apps/web/src that use an English term with a Turkish name in
// docs/product/TERIMLER.md ("Review'lar" → "İncelemeler", "Issue" → "Sorun"…).
//
// Only texts are checked: JSX text, string literals and template-literal parts. Identifier-like
// strings ("review", "/issues", "&markup=", CSS classes), object keys, imports, types and comments
// are skipped, so API paths, enum values and event kinds may keep their English names.
// A line that really needs the English word can carry the comment `ui-terms-ok`.
// Since the interface moved to translation files (docs/architecture/i18n.md), the Turkish locale
// (src/i18n/locales/tr) is checked too, and `t("key")` calls are read as their Turkish text.
//
// Run: npm test -w @sitekeep/web (apps/web/test/app/ui-terms.test.ts) or node apps/web/scripts/check-ui-terms.mjs [dir]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseSync } from "rolldown/utils"; // oxc parser, shipped with Vite

const here = path.dirname(fileURLToPath(import.meta.url));
/** apps/web/src */
export const WEB_SRC = path.resolve(here, "../src");
/** Turkish translation files. */
export const TR_LOCALE = path.join(WEB_SRC, "i18n/locales/tr");

function flatten(tree, prefix = "", out = new Map()) {
  for (const [k, v] of Object.entries(tree)) {
    if (typeof v === "string") out.set(prefix + k, v);
    else if (v && typeof v === "object") flatten(v, `${prefix}${k}.`, out);
  }
  return out;
}

/** Every Turkish text by "namespace:key". */
export function turkishTexts(dir = TR_LOCALE) {
  const out = new Map();
  if (!fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".json") || f === "meta.json") continue;
    const ns = f.replace(/\.json$/, "");
    for (const [k, v] of flatten(JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")))) out.set(`${ns}:${k}`, v);
  }
  return out;
}

/** Turkish texts using an English term with a Turkish name ("tr/works.json actions.x: Review'lar"). */
export function findEnglishTermsInLocale(dir = TR_LOCALE) {
  const problems = [];
  for (const [key, text] of turkishTexts(dir)) if (DENY.test(text) && !identifierLike(text)) problems.push(`${key}  "${text}"`);
  return problems;
}

/**
 * Words with a Turkish UI name (singular, plural, "Review'lar"-style suffixes). "Aksiyon" became
 * "Eylem" by the user's decision.
 */
const DENY = /\b(reviews?|reviewers?|issues?|rfis?|submittals?|transmittals?|markups?|clash(?:es)?|dashboards?|viewers?|registers?|aksiyon(?:lar)?)\b/i;
/** Attributes whose values are never shown as text. */
const SKIP_ATTRS = new Set(["className", "key", "to", "href", "src", "id", "type", "name", "value", "role", "rel", "target", "sandbox", "allow", "accept", "htmlFor", "data-testid"]);
/** Subtrees without UI text. */
const SKIP_NODES = new Set([
  "ImportDeclaration",
  "ExportAllDeclaration",
  "ImportExpression",
  "TSTypeAnnotation",
  "TSTypeAliasDeclaration",
  "TSInterfaceDeclaration",
  "TSLiteralType",
]);

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (/\.(ts|tsx)$/.test(e.name) && !e.name.endsWith(".d.ts")) yield p;
  }
}

/** "review", "/projects/x/issues/", "?markup=", "badge warn", "var(--x)": code, not UI text. */
function identifierLike(text) {
  const t = text.trim();
  if (!t) return true;
  if (/[çğıöşüÇĞİÖŞÜ]/.test(t)) return false;
  if (!/\s/.test(t)) return !/^[A-Z]/.test(t); // one token: UI only when capitalised ("Issue")
  return /^[a-z0-9 _.:\/\-\[\]*?=&{}$#@,()%+|"']+$/.test(t) && !/^[a-z]+( [a-z]+)+$/.test(t) && /[-_:\/=]/.test(t);
}

/** Problems of one file: `file:line  "text"`. */
function checkFile(file, root) {
  const src = fs.readFileSync(file, "utf8");
  const rel = path.relative(root, file).replace(/\\/g, "/");
  const lines = src.split("\n");
  const problems = [];
  let ast;
  try {
    ast = parseSync(file, src, { lang: file.endsWith(".tsx") ? "tsx" : "ts" }).program;
  } catch (e) {
    return [`${rel}: ayrıştırılamadı (${e.message})`];
  }
  const check = (node, text, isJsxText) => {
    if (text == null || !DENY.test(text)) return;
    if (!isJsxText && identifierLike(text)) return;
    const line = src.slice(0, node.start).split("\n").length;
    if (lines[line - 1]?.includes("ui-terms-ok")) return;
    problems.push(`${rel}:${line}  "${text.trim().replace(/\s+/g, " ").slice(0, 100)}"`);
  };
  const visit = (node, parent, key) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const n of node) visit(n, parent, key);
      return;
    }
    if (typeof node.type !== "string" || SKIP_NODES.has(node.type)) return;
    if (node.type === "JSXAttribute" && SKIP_ATTRS.has(node.name?.name)) return;
    if (node.type === "Literal") {
      const objectKey = key === "key" && (parent?.type === "Property" || parent?.type === "PropertyDefinition");
      if (typeof node.value === "string" && !objectKey) check(node, node.value, false);
      return;
    }
    if (node.type === "TemplateElement") return check(node, node.value?.cooked ?? node.value?.raw, false);
    if (node.type === "JSXText") return check(node, node.value, true);
    for (const k of Object.keys(node)) {
      if (k === "type" || k === "start" || k === "end") continue;
      const v = node[k];
      if (v && typeof v === "object") visit(v, node, k);
    }
  };
  visit(ast, null, null);
  return problems;
}

/** Scans a source tree: the number of files and one entry per English UI term. */
export function findEnglishUiTerms(root = WEB_SRC) {
  const problems = [];
  let files = 0;
  for (const file of walk(root)) {
    files++;
    problems.push(...checkFile(file, root));
  }
  return { files, problems };
}

const jsxName = (el) => el.openingElement?.name?.name ?? el.openingElement?.name?.property?.name ?? null;

/** The element has an `<input type="checkbox|radio">` among its descendants. */
function hasChoiceInput(el) {
  let found = false;
  const v = (n) => {
    if (found || !n || typeof n !== "object") return;
    if (Array.isArray(n)) return n.forEach(v);
    if (n.type === "JSXElement" && jsxName(n) === "input") {
      const type = n.openingElement.attributes.find((a) => a.type === "JSXAttribute" && a.name?.name === "type")?.value?.value;
      if (type === "checkbox" || type === "radio") found = true;
    }
    for (const k of Object.keys(n)) if (k !== "type" && n[k] && typeof n[k] === "object") v(n[k]);
  };
  v(el.children);
  return found;
}

/** The label before an explanation: text up to " — " or a sentence end, outside parentheses. */
function beforeExplanation(text) {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0 && (text.startsWith(" — ", i) || text.startsWith(". ", i))) return text.slice(0, i);
  }
  return text;
}

/**
 * Static texts of checkbox and radio labels (`<label>` holding a checkbox or radio input): the
 * label's own text and its `<strong>` title, without nested notes (`<span>`). Text after " — " or
 * a full stop is an explanation and is left out. `continued` marks text that follows an expression
 * ("{n} kalemi oluştur"), where a leading conjunction may stay small. Lines with `ui-terms-ok` are
 * skipped. The Title Case check itself is in test/app/ui-terms.test.ts.
 */
export function findChoiceLabels(root = WEB_SRC, locale = TR_LOCALE) {
  const out = [];
  const tr = turkishTexts(locale);
  for (const file of walk(root)) {
    if (!file.endsWith(".tsx")) continue;
    const src = fs.readFileSync(file, "utf8");
    const rel = path.relative(root, file).replace(/\\/g, "/");
    const lines = src.split("\n");
    const ast = parseSync(file, src, { lang: "tsx" }).program;
    // `useTranslation("works")` / `useTranslation(["works", "common"])`: the namespace of plain keys.
    const ns = /useTranslation\(\s*\[?\s*"([\w-]+)"/.exec(src)?.[1] ?? "common";
    /** `{t("options.x")}` / `{t("common:options.x")}` → its Turkish text. */
    const translated = (expr) => {
      if (expr?.type !== "CallExpression") return null;
      const callee = expr.callee;
      const name = callee.type === "Identifier" ? callee.name : callee.type === "MemberExpression" ? callee.property?.name : null;
      const arg = expr.arguments?.[0];
      if (!/^t\w*$/.test(name ?? "") || arg?.type !== "Literal" || typeof arg.value !== "string") return null;
      const key = arg.value.includes(":") ? arg.value : `${ns}:${arg.value}`;
      return tr.get(key) ?? null;
    };
    const take = (children) => {
      let seen = false;
      for (const c of children) {
        const text = c.type === "JSXExpressionContainer" ? translated(c.expression) : null;
        if (text) {
          const line = src.slice(0, c.start).split("\n").length;
          if (!lines[line - 1]?.includes("ui-terms-ok")) out.push({ where: `${rel}:${line}`, text: beforeExplanation(text.trim()), continued: seen });
          seen = true;
          continue;
        }
        if (c.type === "JSXText" && c.value.trim()) {
          const line = src.slice(0, c.start).split("\n").length;
          const text = beforeExplanation(c.value.trim().replace(/\s+/g, " "));
          if (!lines[line - 1]?.includes("ui-terms-ok") && /\p{L}/u.test(text)) out.push({ where: `${rel}:${line}`, text, continued: seen });
        } else if (c.type === "JSXElement" && jsxName(c) === "strong") take(c.children);
        if (c.type === "JSXExpressionContainer" && c.expression.type !== "JSXEmptyExpression") seen = true;
        if (c.type === "JSXText" && c.value.trim()) seen = true;
      }
    };
    const visit = (n) => {
      if (!n || typeof n !== "object") return;
      if (Array.isArray(n)) return n.forEach(visit);
      if (n.type === "JSXElement" && jsxName(n) === "label" && hasChoiceInput(n)) take(n.children);
      for (const k of Object.keys(n)) if (k !== "type" && n[k] && typeof n[k] === "object") visit(n[k]);
    };
    visit(ast);
  }
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { files, problems } = findEnglishUiTerms(path.resolve(process.argv[2] ?? WEB_SRC));
  problems.push(...findEnglishTermsInLocale());
  if (problems.length) {
    console.error(`İngilizce arayüz terimi bulundu (${problems.length}). Türkçe karşılıkları için docs/product/TERIMLER.md:`);
    for (const p of problems) console.error(`  ${p}`);
    process.exit(1);
  }
  console.log(`ui-terms: ${files} dosya tarandı, İngilizce arayüz terimi yok.`);
}
