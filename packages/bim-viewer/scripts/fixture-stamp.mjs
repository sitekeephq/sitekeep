/**
 * Fragments are not byte-for-byte reproducible, so CI cannot rebuild the fixtures and diff them.
 * Instead the build scripts record the converter versions next to the .frag files, and
 * tests/fixtures.test.ts fails when the installed versions differ (run `npm run fixtures`).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);

export const STAMPED_PACKAGES = ["@thatopen/fragments", "web-ifc"];

export function installedVersions() {
  return Object.fromEntries(
    STAMPED_PACKAGES.map((name) => {
      const entry = require.resolve(name);
      let dir = path.dirname(entry);
      while (!dir.endsWith(path.join("node_modules", ...name.split("/")))) dir = path.dirname(dir);
      return [name, JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")).version];
    }),
  );
}

export function writeFixtureStamp(outDir) {
  writeFileSync(path.join(outDir, "BUILT_WITH.json"), `${JSON.stringify(installedVersions(), null, 2)}\n`);
}
