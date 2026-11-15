#!/usr/bin/env node
/**
 * Third-party notices for SiteKeep Community:
 *
 *   node tools/third-party-notices.mjs             writes THIRD_PARTY_NOTICES.md
 *   node tools/third-party-notices.mjs --check     exit 1 when the file is out of date or a licence is not allowed
 *   node tools/third-party-notices.mjs --licences  only the licence allow-list check
 *   node tools/third-party-notices.mjs --ee-only   node_modules paths that only Enterprise modules need
 *                                                  (the Community image removes them, see Dockerfile)
 *
 * What ships: the packages the workspaces (server, web bundle, mcp, shared, cde-tools, sdk; the 3D viewer
 * where it is a workspace) depend on, followed through package-lock.json the way Node resolves them, without
 * devDependencies and without the Enterprise modules (closed, not listed). Licence texts come from the
 * installed packages in node_modules. Output is sorted and has no dates, so the internal repository and the
 * public one (lockfile regenerated, viewer as packages/bim-viewer) produce the same file.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const OUTPUT = "THIRD_PARTY_NOTICES.md";

/** Licences a production dependency may carry (SPDX ids); expressions combine them with OR / AND. */
export const ALLOWED_LICENCES = new Set([
  "MIT",
  "MIT-0",
  "ISC",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "0BSD",
  "Apache-2.0",
  "MPL-2.0",
  "OFL-1.1",
  "CC0-1.0",
  "CC-BY-4.0",
  "Unlicense",
  "BlueOak-1.0.0",
  "Python-2.0",
  "Zlib",
]);

/** Packages whose licence field is not used as is, with the reason (shown in the notices). */
export const LICENCE_EXCEPTIONS = {
  "@7dimensions-project/bim-viewer": {
    licence: "AGPL-3.0-only",
    reason: "SiteKeep 3D viewer, part of SiteKeep (AGPL-3.0-only, the same licence as SiteKeep; text in LICENSE).",
  },
  jszip: {
    licence: "MIT",
    reason: "Dual-licensed (MIT OR GPL-3.0-or-later); SiteKeep uses it under the MIT licence.",
  },
};

/** Never part of what ships (closed licence): a production dependency on them fails the check. */
export const FORBIDDEN_PACKAGES = {
  "@cursor/sdk": "proprietary (Anysphere Inc.); only the closed AI module may depend on it, never SiteKeep Community",
};

/** Our own packages: not third-party, not listed. */
export const isOwnPackage = (name) =>
  name.startsWith("@sitekeep/") || name === "@7dimensions-project/sitekeep-sdk" || isEnterpriseModule(name);
export const isEnterpriseModule = (name) => name.startsWith("@7dimensions-project/sitekeep-ee-");

const VIEWER = "@7dimensions-project/bim-viewer";
/** SOURCE_REPOSITORY_URL of packages/shared/src/platform/source.ts (the one place for the address). */
const PUBLIC_REPO = /SOURCE_REPOSITORY_URL = "([^"]+)"/.exec(fs.readFileSync(path.join(ROOT, "packages/shared/src/platform/source.ts"), "utf8"))[1];

// ---------------------------------------------------------------------------------------------------------
// Licence expressions

/** Tokens of an SPDX expression: ids, "(", ")", "AND", "OR", "WITH". */
function tokens(expr) {
  return expr.replace(/[()]/g, " $& ").trim().split(/\s+/).filter(Boolean);
}

/**
 * Whether an SPDX expression is allowed: an id is allowed when it is in `allowed`, `A OR B` when either is,
 * `A AND B` when both are. `WITH` exceptions and anything unparseable are not allowed.
 */
export function licenceAllowed(expr, allowed = ALLOWED_LICENCES) {
  if (typeof expr !== "string" || !expr.trim()) return false;
  const t = tokens(expr);
  let i = 0;
  const primary = () => {
    const tok = t[i++];
    if (tok === "(") {
      const v = or();
      if (t[i++] !== ")") throw new Error("unbalanced");
      return v;
    }
    if (!tok || ["AND", "OR", "WITH", ")"].includes(tok)) throw new Error("unexpected " + tok);
    if (t[i] === "WITH") throw new Error("WITH");
    return allowed.has(tok);
  };
  const and = () => {
    let v = primary();
    while (t[i] === "AND") {
      i++;
      v = primary() && v;
    }
    return v;
  };
  const or = () => {
    let v = and();
    while (t[i] === "OR") {
      i++;
      v = and() || v;
    }
    return v;
  };
  try {
    const v = or();
    return i === t.length && v;
  } catch {
    return false;
  }
}

/** A package.json's licence as one SPDX expression (also the old `licenses: [{ type }]` form). */
export function licenceOf(pkg) {
  if (!pkg) return "";
  if (typeof pkg.license === "string") return pkg.license.trim();
  if (pkg.license && typeof pkg.license.type === "string") return pkg.license.type.trim();
  if (Array.isArray(pkg.licenses)) {
    const ids = pkg.licenses.map((l) => (typeof l === "string" ? l : l?.type)).filter(Boolean);
    return ids.length > 1 ? `(${ids.join(" OR ")})` : (ids[0] ?? "");
  }
  return "";
}

// ---------------------------------------------------------------------------------------------------------
// What ships: package-lock.json walked from the workspaces

const parentOf = (p) => {
  const i = p.lastIndexOf("/node_modules/");
  return i >= 0 ? p.slice(0, i) : "";
};
const nameAt = (p, entry) => entry?.name ?? p.slice(p.lastIndexOf("node_modules/") + "node_modules/".length);

/** Lockfile path a dependency `name` of the package at `from` resolves to (Node's lookup upwards). */
export function resolveIn(packages, from, name) {
  for (let p = from; ; p = parentOf(p)) {
    const cand = (p ? p + "/node_modules/" : "node_modules/") + name;
    if (packages[cand]) return cand;
    if (!p) return null;
  }
}

function depsOf(entry) {
  const optionalPeers = new Set(Object.entries(entry.peerDependenciesMeta ?? {}).filter(([, m]) => m?.optional).map(([n]) => n));
  return [
    ...Object.keys(entry.dependencies ?? {}).map((n) => [n, false]),
    ...Object.keys(entry.optionalDependencies ?? {}).map((n) => [n, true]),
    ...Object.keys(entry.peerDependencies ?? {}).filter((n) => !optionalPeers.has(n)).map((n) => [n, true]),
  ];
}

/**
 * Lockfile paths reachable from `roots` (lockfile paths), following dependencies, optional dependencies and
 * required peers; links lead to their target. `skip(name)` stops the walk at a package.
 */
export function reachable(packages, roots, skip = () => false) {
  const seen = new Set();
  const missing = [];
  const queue = [...roots];
  while (queue.length) {
    let p = queue.shift();
    let entry = packages[p];
    if (entry?.link) {
      p = entry.resolved;
      entry = packages[p];
    }
    if (!entry || seen.has(p)) continue;
    seen.add(p);
    for (const [dep, optional] of depsOf(entry)) {
      if (skip(dep)) continue;
      const at = resolveIn(packages, p, dep);
      if (at) queue.push(at);
      else if (!optional) missing.push(`${dep} (needed by ${p || "the root"})`);
    }
  }
  return { paths: seen, missing };
}

const workspacePaths = (packages) => Object.keys(packages).filter((p) => p && !p.startsWith("node_modules/") && !p.includes("/node_modules/"));

/** The shipped third-party packages: [{ name, version, path, entry }] sorted by name and version, one per name@version. */
export function shippedPackages(lock) {
  const packages = lock.packages ?? {};
  const { paths, missing } = reachable(packages, workspacePaths(packages), isEnterpriseModule);
  const byKey = new Map();
  for (const p of paths) {
    const entry = packages[p];
    const isWorkspace = !p.startsWith("node_modules/") && !p.includes("/node_modules/");
    const name = isWorkspace ? entry.name : nameAt(p, entry);
    if (!name || isOwnPackage(name) || entry.dev) continue;
    const key = `${name}@${entry.version}`;
    const prev = byKey.get(key);
    // The same package at several places: keep the shortest path (deterministic, hoisted one first).
    if (!prev || p.length < prev.path.length || (p.length === prev.path.length && p < prev.path)) byKey.set(key, { name, version: entry.version, path: p, entry });
  }
  const list = [...byKey.values()].sort((a, b) => cmp(a.name, b.name) || cmp(a.version, b.version));
  return { list, missing };
}

/** Lockfile paths installed only because of the Enterprise modules (and the modules themselves). */
export function enterpriseOnlyPaths(lock) {
  const packages = lock.packages ?? {};
  const community = reachable(packages, workspacePaths(packages), isEnterpriseModule).paths;
  const eeRoots = Object.keys(packages).filter((p) => p.startsWith("node_modules/") && isEnterpriseModule(nameAt(p, packages[p])));
  const ee = reachable(packages, eeRoots).paths;
  return [...ee].filter((p) => !community.has(p) && p.startsWith("node_modules/")).sort(cmp);
}

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------------------------------------------------
// Licence files

const LICENCE_FILE = /^(licen[cs]e|copying|unlicense)([-._].*)?$/i;
const NOTICE_FILE = /^notice([-._].*)?$/i;

function filesMatching(dir, re) {
  let names = [];
  try {
    names = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isFile() && re.test(d.name)).map((d) => d.name);
  } catch {
    return [];
  }
  return names.sort(cmp).map((n) => ({ file: n, text: normaliseText(fs.readFileSync(path.join(dir, n), "utf8")) }));
}

export const normaliseText = (s) =>
  s
    .replace(/^﻿/, "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""))
    .join("\n")
    .replace(/^\n+|\n+$/g, "");

/** Copyright lines (a holder and a year or ©), apart from template lines such as "Copyright [yyyy] [name]". */
const isCopyrightLine = (l) =>
  (/^\s*copyright\b.*(\d{4}|\(c\)|©)/i.test(l) || /^\s*(\(c\)\s*\d{4}|©)/i.test(l)) &&
  !/\[yyyy\]|\{yyyy\}|<year>|\[year\]|\{year\}/i.test(l) &&
  !/free software foundation/i.test(l);

/** Splits a licence text into its copyright lines and the rest (the body shared by many packages). */
export function splitCopyright(text) {
  const copyright = [];
  const body = [];
  for (const line of text.split("\n")) (isCopyrightLine(line) ? copyright : body).push(line);
  return { copyright: copyright.map((l) => l.trim()), body: normaliseText(body.join("\n")).replace(/\n{3,}/g, "\n\n") };
}

const bodyKey = (body) => body.replace(/\s+/g, " ").trim();

// ---------------------------------------------------------------------------------------------------------
// The notices file

function repositoryUrl(pkg) {
  const r = typeof pkg?.repository === "string" ? pkg.repository : pkg?.repository?.url;
  if (r) {
    let u = r.trim().replace(/^git\+/, "").replace(/\.git$/, "").replace(/^git:\/\//, "https://").replace(/^ssh:\/\/git@/, "https://");
    u = u.replace(/^git@([^:]+):/, "https://$1/");
    if (/^github:/.test(u)) u = "https://github.com/" + u.slice(7);
    else if (/^(gitlab|bitbucket):/.test(u)) u = `https://${u.split(":")[0]}.${u.startsWith("gitlab") ? "com" : "org"}/${u.split(":")[1]}`;
    else if (/^[\w.-]+\/[\w.-]+$/.test(u)) u = "https://github.com/" + u;
    const dir = typeof pkg.repository === "object" && pkg.repository.directory;
    return dir && /github\.com/.test(u) ? `${u}/tree/HEAD/${dir}` : u;
  }
  return typeof pkg?.homepage === "string" ? pkg.homepage : "";
}

const readJson = (f) => {
  try {
    return JSON.parse(fs.readFileSync(f, "utf8"));
  } catch {
    return null;
  }
};

/** Everything the notices need about each shipped package (read from node_modules). */
export function collect(root = ROOT) {
  const lock = readJson(path.join(root, "package-lock.json"));
  if (!lock) throw new Error("package-lock.json not found in " + root);
  const { list, missing } = shippedPackages(lock);
  const items = list.map(({ name, version, path: p, entry }) => {
    const dir = path.join(root, p);
    // A pre-built binary for one platform (os / cpu in the lockfile): only the matching one is installed, so
    // nothing is read from node_modules for it and every platform writes the same file.
    const platform = !!(entry.os || entry.cpu);
    const pkg = platform ? null : readJson(path.join(dir, "package.json"));
    const exception = LICENCE_EXCEPTIONS[name];
    const declared = entry.license ?? licenceOf(pkg);
    return {
      name,
      version,
      platform,
      installed: platform || !!pkg,
      declared,
      licence: exception?.licence ?? declared,
      note: exception?.reason ?? "",
      url: name === VIEWER ? `${PUBLIC_REPO}/tree/main/packages/bim-viewer` : platform ? `https://www.npmjs.com/package/${name}` : repositoryUrl(pkg),
      // The viewer is SiteKeep's own code under SiteKeep's licence (LICENSE): no copy of the AGPL text here.
      licenceFiles: name === VIEWER ? [] : filesMatching(dir, LICENCE_FILE),
      noticeFiles: name === VIEWER ? [] : filesMatching(dir, NOTICE_FILE),
      author: typeof pkg?.author === "string" ? pkg.author : pkg?.author?.name ?? "",
    };
  });
  return { items, missing };
}

/** Problems of the licence check: [] when every shipped package is allowed. */
export function licenceProblems(items, missing = []) {
  const problems = missing.map((m) => `missing from package-lock.json: ${m}`);
  for (const it of items) {
    const id = `${it.name}@${it.version}`;
    if (FORBIDDEN_PACKAGES[it.name]) problems.push(`${id}: must not ship (${FORBIDDEN_PACKAGES[it.name]})`);
    else if (LICENCE_EXCEPTIONS[it.name]) continue;
    else if (!it.licence) problems.push(`${id}: no licence`);
    else if (!licenceAllowed(it.licence)) problems.push(`${id}: licence "${it.licence}" is not on the allow-list`);
  }
  return problems;
}

const fence = (text) => {
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((m) => m.length));
  const f = "`".repeat(longest + 1);
  return `${f}text\n${text}\n${f}`;
};
const cell = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");

/** Components in the image that do not come from npm. */
export function otherComponents(root = ROOT) {
  let libredwg = "";
  try {
    libredwg = /^ARG LIBREDWG_VERSION=(\S+)/m.exec(fs.readFileSync(path.join(root, "Dockerfile"), "utf8"))?.[1] ?? "";
  } catch {
    /* no Dockerfile */
  }
  const fontDir = path.join(root, "apps/server/assets/fonts");
  const liberation = fs.existsSync(path.join(fontDir, "LICENSE_LIBERATION")) ? normaliseText(fs.readFileSync(path.join(fontDir, "LICENSE_LIBERATION"), "utf8")) : "";
  return { libredwg, liberation };
}

/** The whole THIRD_PARTY_NOTICES.md text. */
export function render({ items }, other) {
  const out = [];
  out.push("# Third-Party Notices");
  out.push("");
  out.push("<!-- Generated by tools/third-party-notices.mjs from package-lock.json and node_modules. Do not edit: run `npm run notices`. -->");
  out.push("");
  out.push(
    "SiteKeep Community is free software under the GNU Affero General Public License, version 3 only (AGPL-3.0-only, see `LICENSE`). " +
      `Source code: ${PUBLIC_REPO}. It includes the third-party software listed below, each under its own licence. ` +
      "SiteKeep Enterprise modules are licensed commercially by 7Dimensions OÜ; they are not covered by this file.",
  );
  out.push("");
  out.push("## Contents");
  out.push("");
  out.push("1. npm packages (the server, the web application and the MCP server)");
  out.push("2. Other components in the SiteKeep image");
  out.push("3. Licence texts of the npm packages");
  out.push("4. NOTICE files of the npm packages");
  out.push("");
  out.push(`## 1. npm packages (${items.length})`);
  out.push("");
  out.push("| Package | Version | Licence | Source |");
  out.push("|---|---|---|---|");
  for (const it of items) out.push(`| ${cell(it.name)} | ${cell(it.version)} | ${cell(it.licence || "unknown")} | ${cell(it.url)} |`);
  const notes = items.filter((it) => it.note);
  if (notes.length) {
    out.push("");
    out.push("Notes:");
    out.push("");
    for (const it of notes) out.push(`- **${it.name}**: ${it.note}`);
  }
  out.push("");
  out.push("## 2. Other components in the SiteKeep image");
  out.push("");
  if (other.libredwg) {
    out.push(`### LibreDWG ${other.libredwg} (dwg2dxf)`);
    out.push("");
    out.push(
      "GNU LibreDWG, licensed under the GNU General Public License, version 3 or later (GPL-3.0-or-later). " +
        "The image carries the `dwg2dxf` program, built unmodified from the GNU release; SiteKeep runs it as a separate program and does not link to it. " +
        `Corresponding source: https://ftp.gnu.org/gnu/libredwg/libredwg-${other.libredwg}.tar.xz. ` +
        "Licence text: `/usr/share/sitekeep/LIBREDWG-COPYING` in the image, https://www.gnu.org/licenses/gpl-3.0.txt.",
    );
    out.push("");
  }
  if (other.liberation) {
    out.push("### Liberation Sans fonts (apps/server/assets/fonts)");
    out.push("");
    out.push(
      "LiberationSans-Regular.ttf and LiberationSans-Bold.ttf (version 1.07.4), used to write generated PDF files. " +
        "Copyright © 2007-2011 Red Hat, Inc. Licensed under the GNU General Public License, version 2, with the font exception below.",
    );
    out.push("");
    out.push(fence(other.liberation));
    out.push("");
  }
  out.push("### Debian packages and Node.js");
  out.push("");
  out.push(
    "The image is based on the official `node:22-bookworm-slim` image (Debian GNU/Linux 12 and Node.js). " +
      "Each Debian package carries its copyright and licence in `/usr/share/doc/<package>/copyright`; Node.js's licence is in `/usr/local/include/node` and https://github.com/nodejs/node/blob/main/LICENSE.",
  );
  out.push("");

  // Licence texts grouped by body; every package keeps its own copyright lines.
  const groups = new Map();
  const noText = [];
  for (const it of items) {
    if (!it.licenceFiles.length) {
      if (it.name !== VIEWER && !it.platform) noText.push(it);
      continue;
    }
    for (const f of it.licenceFiles) {
      const { copyright, body } = splitCopyright(f.text);
      const key = bodyKey(body);
      if (!groups.has(key)) groups.set(key, { body, members: [] });
      groups.get(key).members.push({ it, file: f.file, copyright });
    }
  }
  const ordered = [...groups.values()].sort((a, b) => b.members.length - a.members.length || cmp(memberId(a.members[0]), memberId(b.members[0])));
  out.push("## 3. Licence texts of the npm packages");
  out.push("");
  out.push("Packages with the same licence text share one copy of it; each package's copyright lines are listed with it.");
  out.push("");
  ordered.forEach((g, i) => {
    const licences = [...new Set(g.members.map((m) => m.it.licence || "unknown"))].sort(cmp).join(", ");
    out.push(`### 3.${i + 1} ${licences} (${g.members.length} package${g.members.length === 1 ? "" : "s"})`);
    out.push("");
    for (const m of g.members) {
      const lines = m.copyright.length ? `: ${m.copyright.map(cell).join("; ")}` : "";
      out.push(`- ${memberId(m)}${lines}`);
    }
    out.push("");
    out.push(fence(g.body || "(the licence file holds only the copyright lines above)"));
    out.push("");
  });
  if (noText.length) {
    out.push("### Packages without a licence file");
    out.push("");
    out.push("These packages declare their licence in package.json only; the standard text of that licence applies.");
    out.push("");
    for (const it of noText) out.push(`- ${it.name}@${it.version}: ${it.licence || "unknown"}${it.author ? `, ${cell(it.author)}` : ""}`);
    out.push("");
  }
  const platform = items.filter((it) => it.platform);
  if (platform.length) {
    out.push("### Pre-built binaries for one platform");
    out.push("");
    out.push("Each of these packages holds the compiled form of another package for one operating system and processor; an installation carries only the one for its platform. Their licence is the one stated, with the text and copyright of the package they belong to above.");
    out.push("");
    for (const it of platform) out.push(`- ${it.name}@${it.version}: ${it.licence || "unknown"}`);
    out.push("");
  }
  out.push("## 4. NOTICE files of the npm packages");
  out.push("");
  const withNotice = items.filter((it) => it.noticeFiles.length);
  if (!withNotice.length) out.push("None of the packages has a NOTICE file.\n");
  for (const it of withNotice)
    for (const f of it.noticeFiles) {
      out.push(`### ${it.name}@${it.version} (${f.file})`);
      out.push("");
      out.push(fence(f.text));
      out.push("");
    }
  return out.join("\n").replace(/\n+$/, "") + "\n";
}

function memberId(m) {
  const multi = m.it.licenceFiles.length > 1 ? ` (${m.file})` : "";
  return `${m.it.name}@${m.it.version}${multi}`;
}

// ---------------------------------------------------------------------------------------------------------

function main(argv) {
  const mode = argv.find((a) => a.startsWith("--")) ?? "--write";
  const root = argv.find((a) => !a.startsWith("--")) ?? ROOT;
  if (mode === "--ee-only") {
    const lock = readJson(path.join(root, "package-lock.json"));
    for (const p of enterpriseOnlyPaths(lock)) console.log(p);
    return 0;
  }
  const data = collect(root);
  const notInstalled = data.items.filter((it) => !it.installed).map((it) => `${it.name}@${it.version}`);
  if (notInstalled.length) {
    console.error(`third-party-notices: not installed (run npm ci first): ${notInstalled.join(", ")}`);
    return 1;
  }
  const problems = licenceProblems(data.items, data.missing);
  if (problems.length) {
    console.error("third-party-notices: licence check failed:\n" + problems.map((p) => "  " + p).join("\n"));
    console.error("Allowed: " + [...ALLOWED_LICENCES].join(", ") + " (tools/third-party-notices.mjs).");
  }
  if (mode === "--licences") {
    if (!problems.length) console.log(`third-party-notices: ${data.items.length} production packages, licences allowed`);
    return problems.length ? 1 : 0;
  }
  const text = render(data, otherComponents(root));
  const file = path.join(root, OUTPUT);
  if (mode === "--check") {
    const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    if (current !== text) {
      console.error(`third-party-notices: ${OUTPUT} is out of date; run \`npm run notices\` and commit it.`);
      return 1;
    }
    if (!problems.length) console.log(`third-party-notices: ${OUTPUT} is up to date (${data.items.length} packages), licences allowed`);
    return problems.length ? 1 : 0;
  }
  if (mode !== "--write") {
    console.error("usage: tools/third-party-notices.mjs [--check | --licences | --ee-only] [root]");
    return 2;
  }
  fs.writeFileSync(file, text);
  console.log(`third-party-notices: wrote ${OUTPUT} (${data.items.length} packages)`);
  return problems.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = main(process.argv.slice(2));
