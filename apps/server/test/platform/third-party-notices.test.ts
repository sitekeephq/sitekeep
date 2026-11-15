import { describe, expect, it } from "vitest";
// @ts-expect-error -- plain ESM script without type declarations
import * as notices from "../../../../tools/third-party-notices.mjs";

type Item = { name: string; version: string; licence: string };
const { licenceAllowed, licenceOf, licenceProblems, reachable, enterpriseOnlyPaths, shippedPackages, splitCopyright } = notices as {
  licenceAllowed: (expr: unknown) => boolean;
  licenceOf: (pkg: unknown) => string;
  licenceProblems: (items: Item[], missing?: string[]) => string[];
  reachable: (packages: Record<string, unknown>, roots: string[], skip?: (n: string) => boolean) => { paths: Set<string>; missing: string[] };
  enterpriseOnlyPaths: (lock: unknown) => string[];
  shippedPackages: (lock: unknown) => { list: { name: string; version: string }[]; missing: string[] };
  splitCopyright: (text: string) => { copyright: string[]; body: string };
};

describe("tools/third-party-notices.mjs: licence check", () => {
  it("allows the listed licences and expressions of them", () => {
    for (const ok of ["MIT", "Apache-2.0", "(MIT OR GPL-3.0-or-later)", "(MIT AND Zlib)", "BSD-3-Clause OR MIT", "(MPL-2.0 OR Apache-2.0)"])
      expect(licenceAllowed(ok), ok).toBe(true);
    for (const bad of ["GPL-3.0-only", "AGPL-3.0-only", "SSPL-1.0", "UNLICENSED", "SEE LICENSE IN LICENSE.md", "MIT AND GPL-2.0", "", undefined, "(MIT", "GPL-2.0 WITH Classpath-exception-2.0"])
      expect(licenceAllowed(bad), String(bad)).toBe(false);
  });

  it("reads old and new package.json licence fields", () => {
    expect(licenceOf({ license: "ISC" })).toBe("ISC");
    expect(licenceOf({ license: { type: "MIT" } })).toBe("MIT");
    expect(licenceOf({ licenses: [{ type: "MIT" }, { type: "Apache-2.0" }] })).toBe("(MIT OR Apache-2.0)");
    expect(licenceOf({})).toBe("");
  });

  it("fails on a missing or disallowed licence and on forbidden packages; exceptions pass", () => {
    const items: Item[] = [
      { name: "ok", version: "1.0.0", licence: "MIT" },
      { name: "nolicence", version: "1.0.0", licence: "" },
      { name: "copyleft", version: "2.0.0", licence: "GPL-3.0-only" },
      { name: "@cursor/sdk", version: "1.0.38", licence: "SEE LICENSE IN LICENSE.md" },
      { name: "@7dimensions-project/bim-viewer", version: "0.4.6", licence: "AGPL-3.0-only" },
      { name: "jszip", version: "3.10.1", licence: "MIT" },
    ];
    expect(licenceProblems(items, ["x (needed by apps/web)"])).toEqual([
      "missing from package-lock.json: x (needed by apps/web)",
      "nolicence@1.0.0: no licence",
      'copyleft@2.0.0: licence "GPL-3.0-only" is not on the allow-list',
      "@cursor/sdk@1.0.38: must not ship (proprietary (Anysphere Inc.); only the closed AI module may depend on it, never SiteKeep Community)",
    ]);
  });
});

describe("tools/third-party-notices.mjs: what ships", () => {
  const lock = {
    packages: {
      "": { name: "root", devDependencies: { vite: "1" } },
      "apps/web": { name: "@sitekeep/web", version: "0.1.0", dependencies: { a: "1", "@sitekeep/shared": "0.1.0" }, optionalDependencies: { "@7dimensions-project/sitekeep-ee-ai": "1" } },
      "packages/shared": { name: "@sitekeep/shared", version: "0.1.0", dependencies: { c: "1" } },
      "node_modules/@sitekeep/shared": { resolved: "packages/shared", link: true },
      "node_modules/a": { version: "1.0.0", license: "MIT", dependencies: { b: "2" }, peerDependencies: { p: "1", q: "1" }, peerDependenciesMeta: { q: { optional: true } } },
      "node_modules/a/node_modules/b": { version: "2.0.0", license: "ISC" },
      "node_modules/b": { version: "1.0.0", license: "ISC" },
      "node_modules/c": { version: "1.0.0", license: "MIT" },
      "node_modules/p": { version: "1.0.0", license: "MIT" },
      "node_modules/q": { version: "1.0.0", license: "MIT", dev: true },
      "node_modules/vite": { version: "1.0.0", license: "MIT", dev: true },
      "node_modules/@7dimensions-project/sitekeep-ee-ai": { version: "1.0.0", license: "UNLICENSED", optional: true, dependencies: { "@cursor/sdk": "1", c: "1" } },
      "node_modules/@cursor/sdk": { version: "1.0.38", optional: true },
    },
  };

  it("follows dependencies the way Node resolves them, without dev packages, own packages and Enterprise modules", () => {
    expect(shippedPackages(lock).list.map((p) => `${p.name}@${p.version}`)).toEqual(["a@1.0.0", "b@2.0.0", "c@1.0.0", "p@1.0.0"]);
  });

  it("names what only the Enterprise modules need", () => {
    expect(enterpriseOnlyPaths(lock)).toEqual(["node_modules/@7dimensions-project/sitekeep-ee-ai", "node_modules/@cursor/sdk"]);
  });

  it("reports a required dependency that is not in the lockfile", () => {
    const { missing } = reachable({ "apps/x": { name: "x", dependencies: { gone: "1" } } }, ["apps/x"]);
    expect(missing).toEqual(["gone (needed by apps/x)"]);
  });

  it("keeps copyright lines apart from the shared licence body", () => {
    const { copyright, body } = splitCopyright("MIT License\n\nCopyright (c) 2020 Someone\n\nPermission is hereby granted\n   APPENDIX: Copyright [yyyy] [name of copyright owner]");
    expect(copyright).toEqual(["Copyright (c) 2020 Someone"]);
    expect(body).toBe("MIT License\n\nPermission is hereby granted\n   APPENDIX: Copyright [yyyy] [name of copyright owner]");
  });

  it("the committed THIRD_PARTY_NOTICES.md lists no Enterprise module and no closed package", async () => {
    const fs = await import("node:fs");
    const text = fs.readFileSync(new URL("../../../../THIRD_PARTY_NOTICES.md", import.meta.url), "utf8");
    expect(text).not.toMatch(/sitekeep-ee-|@cursor\/sdk|@sitekeep\//);
    expect(text).toContain("| jszip |");
  });
});
