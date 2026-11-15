#!/usr/bin/env node
/**
 * ISO 19650 conformance pack (docs/compliance/ISO19650.md "Verification"):
 *
 *   node tools/iso19650.mjs check   every test the conformance document names exists and is in the pack;
 *                                   every tagged test file is named by the document; every repository
 *                                   path and relative link in the document resolves. Exit 1 otherwise.
 *   node tools/iso19650.mjs test    the check, then the tagged unit and API tests of packages/shared,
 *                                   apps/server and apps/web (`vitest run <tagged files> -t ISO19650`).
 *   node tools/iso19650.mjs list    the tagged test titles, per file.
 *
 * A test is in the pack when its full name (describe › test) contains the tag "ISO19650", followed by
 * the part and the clause, e.g. "ISO19650-2 5.1.7(a) unique container id". The e2e specs use the same
 * tag (`npm run e2e:iso`: `playwright test --grep ISO19650`).
 *
 * Test references in the document are written as `path/to/file.test.ts` › "describe or test title", or
 * `path/to/file.test.ts` › "describe title" › "test title".
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DOC = "docs/compliance/ISO19650.md";
const TAG = "ISO19650";
/** Workspaces with vitest suites, and the e2e specs. */
const SUITES = ["packages/shared", "apps/server", "apps/web"];
const TEST_ROOTS = [...SUITES.map((s) => `${s}/test`), "e2e/specs"];

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

function walk(rel) {
  if (!exists(rel)) return [];
  const out = [];
  for (const entry of fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
    const child = `${rel}/${entry.name}`;
    if (entry.isDirectory()) out.push(...walk(child));
    else if (/\.(test|spec)\.tsx?$/.test(entry.name)) out.push(child);
  }
  return out;
}

const unescape = (s) => s.replace(/\\(.)/g, "$1");

/**
 * Titles of a test file: top-level describes, the tests inside each (one level), and top-level tests.
 * Test files here keep one describe level, written at column 0, with their tests indented below it.
 */
export function titlesOf(source) {
  const call = /^([ \t]*)(describe|it|test)(?:\.(?:only|skip|sequential|concurrent|each\([^)]*\)))?\(\s*(["'`])((?:\\.|(?!\3)[^\\])*)\3/gm;
  const describes = [];
  const tests = []; // { describe: string | null, title: string }
  let current = null;
  for (const m of source.matchAll(call)) {
    const [, indent, kind, , raw] = m;
    const title = unescape(raw);
    if (kind === "describe") {
      if (indent === "") current = title;
      describes.push(title);
    } else {
      tests.push({ describe: indent === "" ? null : current, title });
    }
  }
  return { describes, tests };
}

function fullNames(source) {
  const { describes, tests } = titlesOf(source);
  return [...tests.map((t) => (t.describe ? `${t.describe} › ${t.title}` : t.title)), ...describes];
}

const isTagged = (rel) => fullNames(read(rel)).some((n) => n.includes(TAG));
const taggedFiles = () => TEST_ROOTS.flatMap(walk).filter(isTagged);

/** `file` › "a" › "b" references in the document. */
function references(doc) {
  const ref = /`([\w./-]+\.(?:test|spec)\.tsx?)`((?:\s*›\s*"(?:[^"\\]|\\.)*")*)/g;
  const out = [];
  for (const m of doc.matchAll(ref)) {
    const titles = [...m[2].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((t) => unescape(t[1]));
    out.push({ file: m[1], titles, line: doc.slice(0, m.index).split("\n").length });
  }
  return out;
}

function check() {
  const doc = read(DOC);
  const problems = [];
  const refs = references(doc);
  const named = new Set();
  for (const { file, titles, line } of refs) {
    const at = `${DOC}:${line}`;
    if (!exists(file)) {
      problems.push(`${at}: ${file} does not exist (paths are relative to the repository root)`);
      continue;
    }
    named.add(file);
    if (!titles.length) continue;
    const { describes, tests } = titlesOf(read(file));
    let ok;
    if (titles.length === 1) {
      const [t] = titles;
      ok = describes.includes(t) || tests.some((x) => x.describe === null && x.title === t);
    } else if (titles.length === 2) {
      ok = tests.some((x) => x.describe === titles[0] && x.title === titles[1]);
    } else ok = false;
    if (!ok) problems.push(`${at}: no ${titles.length === 2 ? "test" : "describe or top-level test"} ${titles.map((t) => `"${t}"`).join(" › ")} in ${file}`);
    else if (!titles.join(" › ").includes(TAG)) problems.push(`${at}: ${titles.map((t) => `"${t}"`).join(" › ")} in ${file} carries no ${TAG} tag, so the pack does not run it`);
  }
  for (const file of taggedFiles()) if (!named.has(file)) problems.push(`${file} has ${TAG} tests but ${DOC} does not name it`);

  // Repository paths in backticks and relative Markdown links.
  for (const m of doc.matchAll(/`((?:apps|packages|e2e|docs|tools)\/[\w./-]+\.\w+)`/g))
    if (!exists(m[1])) problems.push(`${DOC}: path ${m[1]} does not exist`);
  for (const m of doc.matchAll(/\]\((?!https?:|#|mailto:)([^)#\s]+)(?:#[^)]*)?\)/g)) {
    const target = path.normalize(path.join(path.dirname(DOC), m[1]));
    if (!exists(target)) problems.push(`${DOC}: link ${m[1]} does not resolve`);
  }

  if (problems.length) {
    console.error(`ISO 19650 conformance document: ${problems.length} problem(s)`);
    for (const p of problems) console.error(`  - ${p}`);
    return false;
  }
  console.log(`ISO 19650 conformance document: ${refs.length} test references resolve; ${named.size} test files named.`);
  return true;
}

function list() {
  for (const file of taggedFiles()) {
    console.log(file);
    for (const n of fullNames(read(file))) if (n.includes(TAG) && n.includes(" › ")) console.log(`  ${n}`);
    for (const n of titlesOf(read(file)).tests) if (!n.describe && n.title.includes(TAG)) console.log(`  ${n.title}`);
  }
}

function test() {
  if (!check()) return false;
  const files = taggedFiles();
  let ok = true;
  for (const suite of SUITES) {
    const own = files.filter((f) => f.startsWith(`${suite}/`)).map((f) => path.relative(suite, f));
    if (!own.length) continue;
    console.log(`\n== ${suite}: ${own.length} file(s) with ${TAG} tests`);
    const r = spawnSync("npx", ["vitest", "run", ...own, "-t", TAG], { cwd: path.join(ROOT, suite), stdio: "inherit", env: process.env });
    if (r.status !== 0) ok = false;
  }
  return ok;
}

const command = process.argv[2] ?? "check";
const run = { check, test, list: () => (list(), true) }[command];
if (!run) {
  console.error("usage: node tools/iso19650.mjs check | test | list");
  process.exit(1);
}
process.exit(run() ? 0 : 1);
