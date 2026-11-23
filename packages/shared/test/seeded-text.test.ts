/** #139: seeded roles, folders and field options shown in the reader's language; stored values stay. */
import { describe, expect, it } from "vitest";
import {
  ALL_BUILT_IN_WORK_TYPES,
  DEFAULT_PROJECT_ROLES,
  SEEDED_TEXT_LABELS_TR,
  defaultStatuses,
  fieldValueLabel,
  labelText,
  localizedWorkType,
  seededText,
  shownFolderName,
  shownRole,
  shownRoleName,
} from "../src/index.js";

const TURKISH = /[çğıöşüÇĞİÖŞÜ]/;

describe("seeded texts", () => {
  it("has an English text without Turkish letters for every seeded text", () => {
    for (const k of Object.keys(SEEDED_TEXT_LABELS_TR)) {
      const en = labelText("en", "seededText", k);
      expect(TURKISH.test(en), `${k} → ${en}`).toBe(false);
    }
    expect(seededText("Düşük", "en")).toBe("Low");
    expect(seededText("Düşük", "tr")).toBe("Düşük");
    expect(seededText("Benim değerim", "en")).toBe("Benim değerim");
  });

  it("translates the default roles while unchanged", () => {
    const admin = DEFAULT_PROJECT_ROLES.find((r) => r.projectAdmin)!;
    expect(shownRole({ name: admin.name, description: admin.description }, "en")).toEqual({
      name: "Administrator",
      description: "Manages folder permissions and opens the project settings.",
    });
    // A changed description stays; a custom role stays.
    expect(shownRole({ name: admin.name, description: "Bizim tanım" }, "en")).toEqual({ name: "Administrator", description: "Bizim tanım" });
    expect(shownRole({ name: "Saha Ekibi", description: null }, "en").name).toBe("Saha Ekibi");
    expect(shownRoleName("Görüntüleyici", "en")).toBe("Viewer");
    expect(shownRoleName("Görüntüleyici", "tr")).toBe("Görüntüleyici");
  });

  it("translates built-in folders only at their place", () => {
    expect(shownFolderName("Proje Dosyaları", "root", "en")).toBe("Project Files");
    expect(shownFolderName("Proje Dosyaları", "rootChild", "en")).toBe("Proje Dosyaları");
    expect(shownFolderName("Yazılar", "rootChild", "en")).toBe("Letters");
    expect(shownFolderName("Gönderim formları", "rootChild", "en")).toBe("Transmittal covers");
    expect(shownFolderName("01-WIP (Çalışmada)", "rootChild", "en")).toBe("01-WIP");
    expect(shownFolderName("Yazılar", "other", "en")).toBe("Yazılar");
    expect(shownFolderName("Yazılar", "rootChild", "tr")).toBe("Yazılar");
    // Written in English by an English creator: still the seeded default, shown in the reader's language.
    expect(shownFolderName("Project Files", "root", "tr")).toBe("Proje Dosyaları");
    expect(shownFolderName("Project Files", "root", "en")).toBe("Project Files");
    expect(shownFolderName("01-WIP", "rootChild", "tr")).toBe("01-WIP (Çalışmada)");
    expect(shownFolderName("Project Files", "rootChild", "tr")).toBe("Project Files");
    expect(shownFolderName("Letters", "rootChild", "tr")).toBe("Letters");
  });

  it("labels the seeded options of built-in fields, values unchanged", () => {
    const def = ALL_BUILT_IN_WORK_TYPES.find((t) => t.key === "rfi")!;
    const stored = {
      key: def.key,
      name: def.name,
      builtIn: true,
      fields: def.fields.map((f) => (f.key === "oncelik" ? { ...f, options: [...f.options!, "Çok acil"] } : { ...f })),
      statuses: defaultStatuses(def.category),
      settings: {},
    };
    const en = localizedWorkType(stored, "en");
    const prio = en.fields.find((f) => f.key === "oncelik")!;
    expect(prio.options).toEqual(["Düşük", "Normal", "Yüksek", "Acil", "Çok acil"]);
    expect(fieldValueLabel(prio, "Yüksek")).toBe("High");
    expect(fieldValueLabel(prio, "Çok acil")).toBe("Çok acil");
    expect(fieldValueLabel(en.fields.find((f) => f.key === "disiplin"), "M - Mekanik")).toBe("M - Mechanical");
    expect(localizedWorkType(stored, "tr").fields.find((f) => f.key === "oncelik")!.optionLabels).toBeUndefined();
  });
});
