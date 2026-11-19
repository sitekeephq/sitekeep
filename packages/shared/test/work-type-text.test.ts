/** #139: built-in work type texts in the reader's language; the admin's own texts stay. */
import { describe, expect, it } from "vitest";
import {
  ALL_BUILT_IN_WORK_TYPES,
  BUILD_NUMBERING_PRESETS,
  WORK_STATUS_LABELS_TR,
  WORK_TYPE_TEXT_LABELS_TR,
  checkNumberingPattern,
  defaultStatuses,
  labelText,
  localizedWorkType,
  type LocalizableWorkType,
} from "../src/index.js";

const TURKISH = /[çğıöşüÇĞİÖŞÜ]/;

function stored(key: string): LocalizableWorkType {
  const t = ALL_BUILT_IN_WORK_TYPES.find((x) => x.key === key)!;
  const statuses = t.statuses ?? defaultStatuses(t.category);
  return {
    key: t.key,
    name: t.name,
    builtIn: true,
    fields: t.fields.map((f) => ({ ...f })),
    statuses: statuses.map((s) => ({ ...s })),
    settings: {
      seededName: t.name,
      seededLabels: Object.fromEntries([...t.fields.map((f) => [`f:${f.key}`, f.label]), ...statuses.map((s) => [`s:${s.key}`, s.label])]),
    },
  };
}

describe("localizedWorkType", () => {
  it("has an English text for every Turkish text of every built-in type", () => {
    for (const [key, tr] of Object.entries(WORK_TYPE_TEXT_LABELS_TR)) {
      const paths = [
        `${key}.name`,
        ...Object.keys(tr.fields).map((f) => `${key}.fields.${f}`),
        ...Object.keys(tr.help).map((f) => `${key}.help.${f}`),
        ...Object.keys(tr.statuses).map((s) => `${key}.statuses.${s}`),
      ];
      for (const p of paths) {
        const en = labelText("en", "workTypeText", p);
        expect(en, p).not.toBe(p);
        expect(TURKISH.test(en), `${p}: ${en}`).toBe(false);
      }
    }
    for (const k of Object.keys(WORK_STATUS_LABELS_TR)) expect(labelText("en", "workStatus", k), k).not.toBe(k);
  });

  it("translates the seeded texts and keeps the keys", () => {
    const rfi = localizedWorkType(stored("rfi"), "en");
    expect(rfi.name).toBe("RFI");
    expect(rfi.statuses.map((s) => [s.key, s.label])).toEqual([
      ["taslak", "Draft"],
      ["acik", "Open"],
      ["cevaplandi", "Answered"],
      ["kapandi", "Closed"],
      ["iptal", "Cancelled"],
    ]);
    expect(rfi.fields.find((f) => f.key === "model_elemanlari")).toMatchObject({ label: "Related Model Elements", help: "Element IDs / GUIDs; link sheets as references" });
    // The same status key reads differently per type.
    expect(localizedWorkType(stored("toplanti"), "en").statuses.find((s) => s.key === "kapandi")!.label).toBe("Minutes Published");
  });

  it("returns Turkish, custom types and admin texts as stored", () => {
    const t = stored("rfi");
    expect(localizedWorkType(t, "tr")).toBe(t);
    expect(localizedWorkType({ ...t, builtIn: false }, "en").name).toBe("Bilgi Talebi");
    const custom = { ...t, name: "Soru Formu", statuses: t.statuses.map((s) => (s.key === "acik" ? { ...s, label: "Bekliyor" } : s)) };
    const en = localizedWorkType(custom, "en");
    expect(en.name).toBe("Soru Formu");
    expect(en.statuses.find((s) => s.key === "acik")!.label).toBe("Bekliyor");
    expect(en.statuses.find((s) => s.key === "taslak")!.label).toBe("Draft");
    // Idempotent: a translated type stays as it is.
    expect(localizedWorkType(en, "en")).toBe(en);
  });
});

describe("numbering presets", () => {
  it("has a valid project-code-first preset", () => {
    const p = BUILD_NUMBERING_PRESETS.proje.patterns;
    for (const [key, pattern] of Object.entries(p)) {
      expect(pattern.startsWith("{Proje}")).toBe(true);
      const t = ALL_BUILT_IN_WORK_TYPES.find((x) => x.key === key)!;
      expect(checkNumberingPattern(pattern, t.fields, "en")).toEqual([]);
    }
  });
});
