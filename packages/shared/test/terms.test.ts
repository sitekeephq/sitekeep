import { describe, expect, it } from "vitest";
import {
  ALL_BUILT_IN_WORK_TYPES,
  BUILT_IN_WORK_TYPE_OLD_NAMES,
  BUILD_NUMBERING_PRESETS,
  isSeededDefaultLabel,
  FOLDER_STATE_LABELS_TR,
  LOCATION_LINK_KIND_LABELS_TR,
  ROLE_PACKAGE_KEYS,
  rolePackage,
  STATE_LABEL_SUGGESTIONS_TR,
  UI_TERMS_TR,
  WORK_CATEGORY_LABELS_TR,
  WORKFLOW_KIND_LABELS_TR,
  termsInstructionTr,
} from "../src/index.js";

const ENGLISH = /\b(reviews?|issues?|rfi|submittals?|transmittals?|markups?|clash|dashboard|viewer|wip|shared|published|archived|as-built|aksiyon)\b/i;

describe("Turkish UI terms", () => {
  it("label tables and built-in type names have no English terms", () => {
    const labels = [
      ...Object.values(WORK_CATEGORY_LABELS_TR),
      ...Object.values(WORKFLOW_KIND_LABELS_TR),
      ...Object.values(FOLDER_STATE_LABELS_TR),
      ...Object.values(LOCATION_LINK_KIND_LABELS_TR),
      ...STATE_LABEL_SUGGESTIONS_TR.map((s) => s.label),
      ...ROLE_PACKAGE_KEYS.map((k) => rolePackage(k).description),
      ...ALL_BUILT_IN_WORK_TYPES.flatMap((t) => [t.name, ...t.fields.map((f) => `${f.label} ${f.help ?? ""}`)]),
    ];
    expect(labels.filter((l) => ENGLISH.test(l))).toEqual([]);
    expect(WORK_CATEGORY_LABELS_TR).toMatchObject({ rfi: "Bilgi Talebi", submittal: "Teknik Onay Kalemi", transmittal: "Gönderim Formu", action: "Eylem" });
  });

  it("knows the earlier name of every renamed built-in type", () => {
    for (const [key, old] of Object.entries(BUILT_IN_WORK_TYPE_OLD_NAMES)) {
      const def = ALL_BUILT_IN_WORK_TYPES.find((t) => t.key === key);
      expect(def, key).toBeTruthy();
      expect(old).not.toContain(def!.name);
    }
    // New projects number actions with EYL; projects seeded earlier keep their stored AKS pattern.
    expect(ALL_BUILT_IN_WORK_TYPES.find((t) => t.key === "aksiyon")!.numberingPattern).toBe("{Proje}-EYL-{0000}");
  });

  it("numbers new bilgi talepleri with BT and new gönderim formları with GF", () => {
    const pattern = (key: string) => ALL_BUILT_IN_WORK_TYPES.find((t) => t.key === key)!.numberingPattern;
    expect(pattern("rfi")).toBe("{Gönderen}_{Alıcı}_{Disiplin}_BT_{000}");
    expect(pattern("transmittal")).toBe("{Proje}-GF-{Gönderen}-{YYYY}-{0000}");
    expect(BUILD_NUMBERING_PRESETS.standart.patterns.rfi).toBe("{Gönderen}_{Alıcı}_{Disiplin}_BT_{000}");
    // The ZAVM preset reproduces the client's existing Forma numbers and keeps RFI.
    expect(BUILD_NUMBERING_PRESETS.zavm.patterns.rfi).toContain("_RFI_");
  });

  it("upgrades a stored default label only while it is still the seeder's", () => {
    // Seeded before labels were remembered: the sentence-case default is upgraded, other text stays.
    expect(isSeededDefaultLabel("Yazı tarihi", "Yazı Tarihi", undefined)).toBe(true);
    expect(isSeededDefaultLabel("Transmittal", "Gönderim Formu", undefined, ["Transmittal"])).toBe(true);
    expect(isSeededDefaultLabel("Tarih", "Yazı Tarihi", undefined)).toBe(false);
    // Remembered seeded label: only that exact value is upgraded.
    expect(isSeededDefaultLabel("Gönderim formu", "Gönderim Formu", "Gönderim formu")).toBe(true);
    expect(isSeededDefaultLabel("Yazı tarihi", "Yazı Tarihi", "Yazı Tarihi")).toBe(false);
    expect(isSeededDefaultLabel("Gönderim Formu", "Gönderim Formu", undefined)).toBe(false);
  });

  it("tells language models to use the same words", () => {
    const text = termsInstructionTr();
    for (const [en, tr] of UI_TERMS_TR) expect(text).toContain(`${en} → ${tr}`);
    expect(text).toContain("issue → sorun");
    expect(text).toContain("submittal → teknik onay");
  });
});
