/** The SDK package forwards exactly what the core's SDK exports (packages/sdk/scripts/gen-shims.mjs). */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as shared from "@sitekeep/shared";
import * as sdk from "../../src/sdk/index.js";

const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../packages/sdk");
const listed = (file: string) => [...readFileSync(path.join(pkg, file), "utf8").matchAll(/^ {2}(\w+),$/gm)].map((m) => m[1]).sort();

describe("SDK shim", () => {
  it("lists every value the core's SDK exports", () => {
    expect(listed("server.js")).toEqual(Object.keys(sdk).sort());
    expect(listed("shared.js")).toEqual(Object.keys(shared).sort());
  });

  it("is bound by the module list before modules load", async () => {
    await import("../../src/app/modules.js");
    expect((globalThis as Record<symbol, unknown>)[Symbol.for("sitekeep.sdk.server")]).toBeDefined();
    expect((globalThis as Record<symbol, unknown>)[Symbol.for("sitekeep.sdk.shared")]).toBeDefined();
  });
});
