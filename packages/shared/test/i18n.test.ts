/**
 * Shared texts in the reader's language (docs/architecture/i18n.md §9): the English and Turkish
 * catalogs match, English enum labels cover the *_LABELS_TR tables, and functions answer in the
 * language they are given (Turkish without one).
 */
import { describe, expect, it } from "vitest";
import enLabels from "../src/locales/en/labels.json" with { type: "json" };
import enMessages from "../src/locales/en/messages.json" with { type: "json" };
import trMessages from "../src/locales/tr/messages.json" with { type: "json" };
import {
  checkProjectTemplate,
  evaluateCapacity,
  explainAccess,
  ifcClassLabel,
  labelText,
  sharedText,
  turkishLabelTables,
  validateName,
  type NamingStandard,
} from "../src/index.js";

type Tree = { [key: string]: string | Tree };

function flatten(tree: Tree, prefix = ""): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of Object.entries(tree)) {
    if (typeof v === "string") out.set(prefix + k, v);
    else for (const [kk, vv] of flatten(v, `${prefix}${k}.`)) out.set(kk, vv);
  }
  return out;
}

const placeholders = (s: string) => [...s.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)].map((m) => m[1]).filter((p) => p !== "count").sort();

describe("shared catalogs", () => {
  const en = flatten(enMessages as Tree);
  const tr = flatten(trMessages as Tree);

  it("English and Turkish messages have the same keys, placeholders and no empty values", () => {
    expect([...tr.keys()].filter((k) => !en.has(k)), "missing in en/messages.json").toEqual([]);
    expect([...en.keys()].filter((k) => !tr.has(k)), "missing in tr/messages.json").toEqual([]);
    const mismatched = [...en].filter(([k, v]) => placeholders(v).join() !== placeholders(tr.get(k) ?? "").join()).map(([k]) => k);
    expect(mismatched).toEqual([]);
    expect([...en, ...tr].filter(([, v]) => !v.trim()).map(([k]) => k)).toEqual([]);
  });

  it("English labels cover every shared *_LABELS_TR table and key", () => {
    const enL = flatten(enLabels as Tree);
    const trL = flatten(turkishLabelTables() as Tree);
    expect([...trL.keys()].filter((k) => !enL.has(k)), "add these to en/labels.json").toEqual([]);
    expect([...enL.keys()].filter((k) => !trL.has(k)), "no such shared table / key").toEqual([]);
  });
});

describe("functions answer in the given language", () => {
  const standard: NamingStandard = {
    name: "Test",
    delimiter: "-",
    fields: [
      { name: "Proje", type: "list", values: [{ code: "PKF" }] },
      { name: "No", type: "number", digits: 3 },
    ],
  };

  it("sharedText and labelText", () => {
    expect(sharedText("en", "template.nameEmpty")).toBe("The template name is empty.");
    expect(sharedText("tr", "template.nameEmpty")).toBe("Şablon adı boş.");
    expect(sharedText("en-GB", "template.nameEmpty")).toBe("The template name is empty.");
    expect(sharedText("xx", "template.nameEmpty"), "unknown language → English").toBe("The template name is empty.");
    expect(labelText("en", "issueStatus", "open")).toBe("Open");
    expect(labelText("tr", "issueStatus", "open")).toBe("Açık");
    expect(ifcClassLabel("IfcDoor", "en")).toBe("Door");
    expect(ifcClassLabel("IfcDoor")).toBe("Kapı");
  });

  it("validateName and checkProjectTemplate", () => {
    expect(validateName(standard, "XYZ-001.pdf", "en").errors).toEqual(['Proje: "XYZ" is not one of the allowed values']);
    expect(validateName(standard, "XYZ-001.pdf").errors).toEqual(['Proje: "XYZ" izinli değerlerden biri değil']);
    expect(checkProjectTemplate({ name: "", slots: [], folders: [] } as never, {}, "en")).toContain("The template name is empty.");
  });

  it("capacity findings", () => {
    const hardware = { cpuCount: 2, cpuModel: "x", memoryBytes: 4 * 1024 ** 3, disk: null, os: "linux" };
    const counts = { registered: 8, active: 5 };
    const now = new Date("2026-10-26T00:00:00Z");
    expect(evaluateCapacity({ hardware, counts, now, lang: "en" }).findings.find((f) => f.key === "memory")!.action).toBe("Increase RAM to at least 8 GB.");
    expect(evaluateCapacity({ hardware, counts, now }).findings.find((f) => f.key === "memory")!.action).toBe("RAM'i en az 8 GB yapın.");
  });

  it("explainAccess", () => {
    const entry = {
      name: "Ali",
      level: "edit" as const,
      canSee: true,
      canUpload: true,
      reasons: [{ via: "role" as const, subjectName: "Mimari Ekip", level: "edit" as const, inherited: false, decisive: true }],
    };
    expect(explainAccess(entry)).toBe('Ali görebilir (Düzenle) — "Mimari Ekip" rolü üzerinden: Düzenle.');
    expect(explainAccess(entry, "en")).toBe('Ali can see (Edit) — via role "Mimari Ekip": Edit.');
  });
});
