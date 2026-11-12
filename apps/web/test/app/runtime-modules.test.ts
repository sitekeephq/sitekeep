/** The app turns on the modules the server runs (app/modules.ts), not every module the build carries. */
import { afterAll, describe, expect, it } from "vitest";
import { bundledModules } from "virtual:sitekeep-modules";
import { edition, editionName } from "../../src/app/brand";
import * as modules from "../../src/app/modules";

const all = bundledModules.map((m) => m.id);

describe("modules turned on at run time", () => {
  afterAll(() => modules.enableModules(all));

  it("shows only the modules the server runs, and names the edition after them", () => {
    modules.enableModules([]);
    expect(modules.webModules).toEqual([]);
    expect(edition()).toBe("Community");
    expect(editionName()).toBe("SiteKeep Community");

    const one = all.slice(0, 1);
    modules.enableModules(one);
    expect(modules.webModules.map((m) => m.id)).toEqual(one);
    expect(edition()).toBe(one.length ? "Enterprise" : "Community");
  });

  it("ignores ids the build does not carry", () => {
    modules.enableModules(["not-a-module", ...all]);
    expect(modules.webModules.map((m) => m.id)).toEqual(all);
  });
});
