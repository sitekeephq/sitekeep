/// <reference types="node" />
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);

/** Version of an installed package, read from its package.json. */
function installed(name: string): string {
  let dir = path.dirname(require.resolve(name));
  while (!dir.endsWith(path.join("node_modules", ...name.split("/")))) dir = path.dirname(dir);
  return (JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as { version: string }).version;
}

describe("e2e fixtures", () => {
  it("were built with the installed Fragments / web-ifc (else run `npm run fixtures`)", () => {
    const stamp = JSON.parse(readFileSync(path.join(root, "e2e/fixtures/frags/BUILT_WITH.json"), "utf8")) as Record<string, string>;
    expect(stamp).toEqual({ "@thatopen/fragments": installed("@thatopen/fragments"), "web-ifc": installed("web-ifc") });
  });
});
