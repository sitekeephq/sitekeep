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
 * For a closed Enterprise module (a sitekeep-<id> checkout with its package-lock.json and node_modules):
 *
 *   node tools/third-party-notices.mjs --module ../sitekeep-ai [--out FILE] [--check]
 *
 * lists the module's own runtime dependencies (dependencies and optionalDependencies, followed through the
 * module's package-lock.json; peerDependencies are provided by the core) that SiteKeep Community does not
 * already ship (compared by name@version with this checkout's package-lock.json). FILE defaults to the
 * module's THIRD_PARTY_NOTICES.md; --check exits 1 when it is out of date or a licence is not allowed.
 * Proprietary packages a module may use are listed in MODULE_ACCEPTED (docs/modules/README.md).
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
  "@sitekeephq/bim-viewer": {
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

/**
 * Packages outside the allow-list that a closed Enterprise module may ship (--module), with the note shown in
 * its notices. A key also covers its per-platform binaries (`<key>-<platform>`).
 */
export const MODULE_ACCEPTED = {
  "@cursor/sdk":
    "Proprietary, not open source. Its LICENSE.md reads: \"© Anysphere Inc. All rights reserved. Use is subject to Cursor's Terms of Service (https://cursor.com/terms-of-service).\" Only the SiteKeep AI module depends on it.",
};

/** Licences that do not require attribution: their packages are listed for completeness only. */
export const NO_ATTRIBUTION = {
  "MIT-0": "MIT No Attribution (MIT-0) does not require keeping the copyright notice or the licence text; the package is listed for completeness.",
};

/** The entry of `table` for `name` or for one of its per-platform packages (`<key>-<platform>`). */
const entryFor = (table, name) => {
  const key = Object.keys(table).find((k) => name === k || name.startsWith(k + "-"));
  return key ? table[key] : undefined;
};

/** Our own packages: not third-party, not listed. */
export const isOwnPackage = (name) =>
  name.startsWith("@sitekeep/") || name === "@sitekeephq/sitekeep-sdk" || isEnterpriseModule(name);
export const isEnterpriseModule = (name) => name.startsWith("@sitekeephq/sitekeep-ee-");

const VIEWER = "@sitekeephq/bim-viewer";
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
  return { list: packageList(packages, paths), missing };
}

/**
 * What an Enterprise module adds: the packages its own dependencies and optional dependencies reach in its
 * lockfile (`moduleLock`), apart from our own packages and from what the core (`coreLock`) already ships
 * (the same name@version). The module's peer dependencies come from the core: they are not followed, also
 * where a dependency of the module needs them as a peer (whatever version the module's lockfile holds).
 */
export function modulePackages(moduleLock, coreLock) {
  const packages = moduleLock.packages ?? {};
  const top = packages[""] ?? {};
  const roots = [];
  const missing = [];
  for (const [deps, optional] of [[top.dependencies, false], [top.optionalDependencies, true]])
    for (const name of Object.keys(deps ?? {})) {
      if (isOwnPackage(name)) continue;
      const at = resolveIn(packages, "", name);
      if (at) roots.push(at);
      else if (!optional) missing.push(`${name} (needed by the module)`);
    }
  const peers = new Set(Object.keys(top.peerDependencies ?? {}));
  const walked = reachable(packages, roots, (name) => isOwnPackage(name) || peers.has(name));
  const core = new Set(shippedPackages(coreLock).list.map((p) => `${p.name}@${p.version}`));
  const list = packageList(packages, walked.paths).filter((p) => !core.has(`${p.name}@${p.version}`));
  return { list, missing: [...missing, ...walked.missing] };
}

/** [{ name, version, path, entry }] of lockfile `paths`, sorted by name and version, one per name@version. */
function packageList(packages, paths) {
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
  return [...byKey.values()].sort((a, b) => cmp(a.name, b.name) || cmp(a.version, b.version));
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
  const { list, missing } = shippedPackages(readLock(root));
  return { items: describe(root, list), missing };
}

/** The same for an Enterprise module checkout (`moduleDir`), against the core at `coreRoot`. */
export function collectModule(moduleDir, coreRoot = ROOT) {
  const pkg = readJson(path.join(moduleDir, "package.json"));
  if (!pkg) throw new Error("package.json not found in " + moduleDir);
  const { list, missing } = modulePackages(readLock(moduleDir), readLock(coreRoot));
  return { name: pkg.name, items: describe(moduleDir, list, true), missing };
}

function readLock(root) {
  const lock = readJson(path.join(root, "package-lock.json"));
  if (!lock) throw new Error("package-lock.json not found in " + root);
  return lock;
}

/** Licence data of each package of `list`, read from `root`/node_modules. */
function describe(root, list, inModule = false) {
  return list.map(({ name, version, path: p, entry }) => {
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
      note: exception?.reason ?? (inModule ? entryFor(MODULE_ACCEPTED, name) : undefined) ?? NO_ATTRIBUTION[declared] ?? "",
      accepted: inModule && !!entryFor(MODULE_ACCEPTED, name),
      url: name === VIEWER ? `${PUBLIC_REPO}/tree/main/packages/bim-viewer` : platform ? `https://www.npmjs.com/package/${name}` : repositoryUrl(pkg),
      // The viewer is SiteKeep's own code under SiteKeep's licence (LICENSE): no copy of the AGPL text here.
      licenceFiles: name === VIEWER ? [] : filesMatching(dir, LICENCE_FILE),
      noticeFiles: name === VIEWER ? [] : filesMatching(dir, NOTICE_FILE),
      author: typeof pkg?.author === "string" ? pkg.author : pkg?.author?.name ?? "",
    };
  });
}

/** Problems of the licence check: [] when every shipped package is allowed. */
export function licenceProblems(items, missing = []) {
  const problems = missing.map((m) => `missing from package-lock.json: ${m}`);
  for (const it of items) {
    const id = `${it.name}@${it.version}`;
    if (it.accepted) continue;
    const forbidden = entryFor(FORBIDDEN_PACKAGES, it.name);
    if (forbidden) problems.push(`${id}: must not ship (${forbidden})`);
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
  const ofl = path.join(fontDir, "OFL.txt");
  const liberation = fs.existsSync(ofl) ? normaliseText(fs.readFileSync(ofl, "utf8")) : "";
  const liberationVersion = liberation ? fontVersion(path.join(fontDir, "LiberationSans-Regular.ttf")) : "";
  const passwordLicence = path.join(root, "apps/server/assets/passwords/LICENSE-SecLists.txt");
  const seclists = fs.existsSync(passwordLicence) ? normaliseText(fs.readFileSync(passwordLicence, "utf8")) : "";
  return { libredwg, liberation, liberationVersion, seclists };
}

/** The version of a TrueType font from its name table ("Version 2.1.5" gives "2.1.5"); "" when unreadable. */
export function fontVersion(file) {
  try {
    const b = fs.readFileSync(file);
    const tables = b.readUInt16BE(4);
    for (let i = 0; i < tables; i++) {
      const rec = 12 + i * 16;
      if (b.toString("latin1", rec, rec + 4) !== "name") continue;
      const at = b.readUInt32BE(rec + 8);
      const count = b.readUInt16BE(at + 2);
      const strings = at + b.readUInt16BE(at + 4);
      for (let j = 0; j < count; j++) {
        const r = at + 6 + j * 12;
        const [platform, , , nameId, length, offset] = [0, 2, 4, 6, 8, 10].map((o) => b.readUInt16BE(r + o));
        if (nameId !== 5) continue;
        const raw = b.subarray(strings + offset, strings + offset + length);
        const text = platform === 1 ? raw.toString("latin1") : Buffer.from(raw).swap16().toString("utf16le");
        const m = /(\d+(?:\.\d+)+)/.exec(text);
        if (m) return m[1];
      }
    }
  } catch {
    /* not a readable font */
  }
  return "";
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
      "SiteKeep Enterprise modules are licensed commercially by 7Dimensions OÜ; they are not covered by this file " +
      "(each module carries its own THIRD_PARTY_NOTICES.md for the third-party packages it adds).",
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
  packageTable(out, items);
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
    const v = other.liberationVersion;
    out.push(`### Liberation Sans fonts${v ? ` ${v}` : ""} (apps/server/assets/fonts)`);
    out.push("");
    out.push(
      `LiberationSans-Regular.ttf and LiberationSans-Bold.ttf${v ? ` (version ${v})` : ""}, unmodified from the official release ` +
        "(https://github.com/liberationfonts/liberation-fonts), used to write generated PDF files. " +
        "Licensed under the SIL Open Font License, version 1.1 (OFL-1.1); the licence text, also in `apps/server/assets/fonts/OFL.txt`, follows.",
    );
    out.push("");
    out.push(fence(other.liberation));
    out.push("");
  }
  if (other.seclists) {
    out.push("### Common password list (apps/server/assets/passwords)");
    out.push("");
    out.push(
      "`common-passwords.txt` is a data file derived from `Passwords/Common-Credentials/xato-net-10-million-passwords-1000000.txt` of SecLists " +
        "(https://github.com/danielmiessler/SecLists, commit c205c36a445bff37f8e58a9ec829105cd4975c58), which compiles Mark Burnett's list of ten million passwords (xato.net, 2015). " +
        "SiteKeep keeps the 50,000 most frequent entries of at least 10 characters, in lower case, and refuses them as new passwords (docs/features/SIGN_IN_SECURITY.md). " +
        "SecLists is licensed under the MIT licence; the licence text, also in `apps/server/assets/passwords/LICENSE-SecLists.txt`, follows.",
    );
    out.push("");
    out.push(fence(other.seclists));
    out.push("");
  }
  const tessdata = items.filter((it) => it.name.startsWith("@tesseract.js-data/"));
  if (tessdata.length) {
    out.push("### Tesseract OCR engine and language data");
    out.push("");
    out.push(
      "OCR of scanned drawing sheets runs the Tesseract OCR engine (Apache-2.0, https://github.com/tesseract-ocr/tesseract), compiled to WebAssembly in `tesseract.js-core`. " +
        `The language models (${tessdata.map((it) => `\`${it.name.split("/")[1]}.traineddata\``).join(", ")}, integer "best" models) come from the Tesseract project's tessdata_best repository ` +
        "(https://github.com/tesseract-ocr/tessdata_best), licensed under the Apache License, Version 2.0 (text in section 3); the `@tesseract.js-data/*` npm packages that carry them are MIT.",
    );
    out.push("");
  }
  out.push("### Debian packages and Node.js");
  out.push("");
  out.push(
    "The image is based on the official `node:22-bookworm-slim` image (Debian GNU/Linux 12 and Node.js). " +
      "Each Debian package carries its copyright and licence in `/usr/share/doc/<package>/copyright`; Node.js's licence is in `/usr/local/include/node` and https://github.com/nodejs/node/blob/main/LICENSE.",
  );
  out.push("");
  licenceTexts(out, items, 3);
  noticeTexts(out, items, 4);
  return out.join("\n").replace(/\n+$/, "") + "\n";
}

/** THIRD_PARTY_NOTICES.md of an Enterprise module (`name` is its package name). */
export function renderModule({ name, items }) {
  const out = [];
  out.push("# Third-Party Notices");
  out.push("");
  out.push(
    "<!-- Generated by tools/third-party-notices.mjs --module (SiteKeep core) from this package's package-lock.json and node_modules. Do not edit: see docs/modules/README.md in the core. -->",
  );
  out.push("");
  out.push(
    `${name} is a SiteKeep Enterprise module, licensed commercially by 7Dimensions OÜ (not open source). ` +
      "It runs inside SiteKeep; the third-party software SiteKeep itself ships is listed in SiteKeep's THIRD_PARTY_NOTICES.md " +
      `(${PUBLIC_REPO}/blob/main/THIRD_PARTY_NOTICES.md). This file lists the third-party packages the module adds: ` +
      "its own runtime dependencies (and theirs) that SiteKeep does not already ship, each under its own licence.",
  );
  out.push("");
  out.push(`## 1. npm packages (${items.length})`);
  out.push("");
  if (!items.length) out.push("The module adds no third-party packages.\n");
  else packageTable(out, items);
  licenceTexts(out, items, 2);
  noticeTexts(out, items, 3);
  return out.join("\n").replace(/\n+$/, "") + "\n";
}

function packageTable(out, items) {
  out.push("| Package | Version | Licence | Source |");
  out.push("|---|---|---|---|");
  for (const it of items) out.push(`| ${cell(it.name)} | ${cell(it.version)} | ${cell(it.licence || "unknown")} | ${cell(it.url)} |`);
  // One note per package; per-platform binaries of a package with the same note are covered by it.
  const notes = items.filter((it) => it.note && !items.some((o) => o !== it && it.name.startsWith(o.name + "-") && o.note === it.note));
  if (notes.length) {
    out.push("");
    out.push("Notes:");
    out.push("");
    for (const it of notes) out.push(`- **${it.name}**: ${it.note}`);
  }
  out.push("");
}

/** Licence texts grouped by body; every package keeps its own copyright lines. */
function licenceTexts(out, items, section) {
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
  out.push(`## ${section}. Licence texts of the npm packages`);
  out.push("");
  out.push("Packages with the same licence text share one copy of it; each package's copyright lines are listed with it.");
  out.push("");
  ordered.forEach((g, i) => {
    const ids = [...new Set(g.members.map((m) => m.it.licence || "unknown"))].sort(cmp);
    out.push(`### ${section}.${i + 1} ${ids.join(", ")} (${g.members.length} package${g.members.length === 1 ? "" : "s"})`);
    out.push("");
    if (ids.every((id) => NO_ATTRIBUTION[id])) {
      out.push(ids.map((id) => NO_ATTRIBUTION[id]).join(" "));
      out.push("");
    }
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
    out.push(
      "Each of these packages holds the compiled form of another package for one operating system and processor; an installation carries only the one for its platform. Their licence is the one stated, with the text and copyright of the package they belong to above.",
    );
    out.push("");
    for (const it of platform) out.push(`- ${it.name}@${it.version}: ${it.licence || "unknown"}`);
    out.push("");
  }
}

function noticeTexts(out, items, section) {
  out.push(`## ${section}. NOTICE files of the npm packages`);
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
}

function memberId(m) {
  const multi = m.it.licenceFiles.length > 1 ? ` (${m.file})` : "";
  return `${m.it.name}@${m.it.version}${multi}`;
}

// ---------------------------------------------------------------------------------------------------------

const VALUE_FLAGS = ["--module", "--out"];
const MODES = ["--write", "--check", "--licences", "--ee-only"];
const USAGE =
  "usage: tools/third-party-notices.mjs [--check | --licences | --ee-only] [root]\n" +
  "       tools/third-party-notices.mjs --module DIR [--out FILE] [--check | --licences] [core root]";

function main(argv) {
  const valueOf = (flag) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const modes = argv.filter((a) => a.startsWith("--") && !VALUE_FLAGS.includes(a));
  const positional = argv.filter((a, i) => !a.startsWith("--") && !VALUE_FLAGS.includes(argv[i - 1]));
  const mode = modes[0] ?? "--write";
  const moduleDir = valueOf("--module");
  const out = valueOf("--out");
  const bad =
    modes.length > 1 ||
    positional.length > 1 ||
    !MODES.includes(mode) ||
    (argv.includes("--module") && (!moduleDir || moduleDir.startsWith("--") || mode === "--ee-only")) ||
    (argv.includes("--out") && (!out || out.startsWith("--") || !moduleDir));
  if (bad) {
    console.error(USAGE);
    return 2;
  }
  const root = positional[0] ? path.resolve(positional[0]) : ROOT;
  if (mode === "--ee-only") {
    for (const p of enterpriseOnlyPaths(readLock(root))) console.log(p);
    return 0;
  }
  const data = moduleDir ? collectModule(path.resolve(moduleDir), root) : collect(root);
  const file = out ? path.resolve(out) : path.join(moduleDir ? path.resolve(moduleDir) : root, OUTPUT);
  const shown = path.relative(process.cwd(), file) || OUTPUT;
  const notInstalled = data.items.filter((it) => !it.installed).map((it) => `${it.name}@${it.version}`);
  if (notInstalled.length) {
    console.error(`third-party-notices: not installed (run npm ci first${moduleDir ? " in the module" : ""}): ${notInstalled.join(", ")}`);
    return 1;
  }
  const problems = licenceProblems(data.items, data.missing);
  if (problems.length) {
    console.error("third-party-notices: licence check failed:\n" + problems.map((p) => "  " + p).join("\n"));
    console.error("Allowed: " + [...ALLOWED_LICENCES].join(", ") + (moduleDir ? "; in a module also MODULE_ACCEPTED" : "") + " (tools/third-party-notices.mjs).");
  }
  if (mode === "--licences") {
    if (!problems.length) console.log(`third-party-notices: ${data.items.length} production packages, licences allowed`);
    return problems.length ? 1 : 0;
  }
  const text = moduleDir ? renderModule(data) : render(data, otherComponents(root));
  if (mode === "--check") {
    const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    if (current !== text) {
      const how = moduleDir ? "regenerate it with tools/third-party-notices.mjs --module (docs/modules/README.md)" : "run `npm run notices`";
      console.error(`third-party-notices: ${shown} is out of date; ${how} and commit it.`);
      return 1;
    }
    if (!problems.length) console.log(`third-party-notices: ${shown} is up to date (${data.items.length} packages), licences allowed`);
    return problems.length ? 1 : 0;
  }
  fs.writeFileSync(file, text);
  console.log(`third-party-notices: wrote ${shown} (${data.items.length} packages)`);
  return problems.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = main(process.argv.slice(2));
