import { afterEach, describe, expect, it } from "vitest";
import { TOOL_MODULES } from "@sitekeep/cde-tools";
import { cdeToolDefinitions } from "../../src/core/platform/cde-tools.js";
import { KNOWN_MODULES, modulePackageInstalled } from "../../src/app/module-ids.js";

const call = (async () => ({})) as never;
const saved = process.env.SITEKEEP_MODULES;
afterEach(() => { if (saved === undefined) delete process.env.SITEKEEP_MODULES; else process.env.SITEKEEP_MODULES = saved; });

describe("MCP tool catalogue of this installation", () => {
  it("offers only the installed modules' tools", () => {
    process.env.SITEKEEP_MODULES = "field";
    const names = cdeToolDefinitions(call, { readOnly: true }).map((d) => d.name);
    expect(names).toContain("cde_forms_list");
    expect(names).toContain("cde_works_list");
    expect(names).not.toContain("cde_schedule_list");
    expect(names).not.toContain("cde_rfi_log");
    for (const name of names) if (TOOL_MODULES[name]) expect(TOOL_MODULES[name]).toBe("field");
  });
  it.runIf(KNOWN_MODULES.every(modulePackageInstalled))("offers every tool when all modules are installed", () => {
    delete process.env.SITEKEEP_MODULES;
    const names = cdeToolDefinitions(call, { readOnly: true }).map((d) => d.name);
    expect(names).toContain("cde_schedule_list");
    expect(names).toContain("cde_rfi_log");
  });
});
