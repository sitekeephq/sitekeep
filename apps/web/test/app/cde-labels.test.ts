import { describe, expect, it } from "vitest";
import { CDE_CODE_SCHEMES, CDE_FILE_STATUSES, CDE_STATES, CDE_TRANSITION_MODES, CDE_WIP_POLICIES, isTitleCaseTr } from "@sitekeep/shared";
import en from "../../src/i18n/locales/en/cde.json";
import tr from "../../src/i18n/locales/tr/cde.json";
import { SETTINGS_TABS } from "../../src/app/navigation/nav";

/** The CDE settings tab and its labels (docs/features/CDE_STATES.md, docs/product/TERMINOLOGY.md). */
describe("CDE labels", () => {
  const tables = [
    ["states", CDE_STATES],
    ["modes", CDE_TRANSITION_MODES],
    ["schemes", CDE_CODE_SCHEMES],
    ["wipPolicies", CDE_WIP_POLICIES],
    ["statuses", CDE_FILE_STATUSES],
  ] as const;

  it("names every state, mode, scheme, policy and status in English and Turkish", () => {
    for (const [table, keys] of tables)
      for (const key of keys)
        for (const texts of [en, tr]) expect((texts as Record<string, Record<string, string>>)[table]![key], `${table}.${key}`).toBeTruthy();
  });

  it("uses the ISO 19650 state names of the terminology list, in Title Case", () => {
    expect(tr.states).toEqual({ wip: "Çalışma", shared: "Paylaşılan", published: "Yayınlanan", archived: "Arşivlenen" });
    const labels = tables.flatMap(([table]) => Object.values((tr as Record<string, Record<string, string>>)[table]!));
    expect(labels.filter((l) => !isTitleCaseTr(l))).toEqual([]);
  });

  it("is an advanced project settings tab", () => {
    expect(SETTINGS_TABS.find((t) => t.key === "cde")).toMatchObject({ advanced: true });
  });
});
