import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import * as shared from "@sitekeep/shared";
import { ALL_BUILT_IN_WORK_TYPES, defaultStatuses, isTitleCaseTr, WORK_CATEGORIES } from "@sitekeep/shared";
// @ts-expect-error -- plain ESM script without type declarations
import { findChoiceLabels, findEnglishTermsInLocale, findEnglishUiTerms } from "../../scripts/check-ui-terms.mjs";
import { i18n } from "../../src/i18n";
import {
  HUB_LABELS,
  HUB_VIEWS,
  MODEL_TABS,
  NAV_ASK_LABEL,
  NAV_ITEMS,
  NAV_SETTINGS,
  SETTINGS_ADVANCED_LABEL,
  SETTINGS_TABS,
  WORK_QUICK_FILTERS,
  WORK_SECTIONS,
} from "../../src/app/navigation/nav";

type Result = { files: number; problems: string[] };
/** Menu and tab names are "shell" keys; tests run in Turkish (test/setup.ts). */
const tr = (key: string) => i18n.t(`shell:${key}`);
const scan = findEnglishUiTerms as (dir?: string) => Result;
type ChoiceLabel = { where: string; text: string; continued: boolean };
const choiceLabels = findChoiceLabels as (dir?: string) => ChoiceLabel[];

describe("Turkish UI terms (docs/product/TERIMLER.md)", () => {
  it("apps/web/src shows no English terms such as Review, Issue, Submittal, Transmittal, Markup, Clash", () => {
    const { files, problems } = scan();
    expect(files).toBeGreaterThan(50);
    expect(problems).toEqual([]);
    expect((findEnglishTermsInLocale as () => string[])()).toEqual([]);
  });

  it("flags UI texts but not identifiers, paths, keys or comments", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ui-terms-"));
    try {
      fs.writeFileSync(
        path.join(dir, "Sample.tsx"),
        [
          'import { IssueList } from "./issues";',
          "// Review'lar listesi (yorum)",
          'const LABELS = { issue: "Sorun", review: "İnceleme" };',
          'const kind: "review" | "issue" = "review";',
          "const url = `/projects/${1}/issues/${2}?markup=${3}`;",
          "export const A = () => <h1 className=\"review-list\">Issue'lar</h1>;",
          'export const B = () => <button title="Bu incelemeyi aç">{LABELS.issue}</button>;',
          'export const C = () => <p>{kind} {url} Markup silinsin mi?</p>;',
          'export const D = "Submittal register"; // ui-terms-ok',
        ].join("\n"),
      );
      const { problems } = scan(dir);
      expect(problems).toEqual(['Sample.tsx:6  "Issue\'lar"', 'Sample.tsx:8  "Markup silinsin mi?"']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** Shared `*_LABELS_TR` tables whose values are phrases read inside sentences, not names. */
const SENTENCE_TABLES = new Set([
  "ACCESS_VIA_LABELS_TR", // "kişisel yetkisi" inside "… üzerinden: Düzenle"
  "MODEL_OP_LABELS_TR", // "içerir", "var", "yok" read inline: "Ad içerir …"
  "ROLE_PACKAGE_ACTION_LABELS_TR", // "Yeni yetki yazılacak": what applying a package does
  "STAGE_REVISE_LABELS_TR", // whole sentences as options
]);

/** Values that are not Title Case (titleCaseTr would change them), as "where: text". */
function notTitleCase(entries: [where: string, text: string][]): string[] {
  return entries.filter(([, t]) => !isTitleCaseTr(t)).map(([w, t]) => `${w}: ${t}`);
}

describe("Her Kelime Büyük Harf İle Başlasın (docs/product/TERIMLER.md)", () => {
  it("menu items, İşler views and sections, Model tabs and settings tabs are Title Case", () => {
    // Five menu items (docs/product/SADELESTIRME.md); "Model" holds the Görüntüleyici tab.
    expect(NAV_ITEMS.map((i) => tr(i.labelKey))).toEqual(["Bugün", "İşler", "Dokümanlar", "Model", "Raporlar"]);
    expect(MODEL_TABS.map((t) => tr(t.labelKey))).toEqual(["Görüntüleyici", "Koordinasyon", "İş Programı", "Parametre Değişiklikleri"]);
    expect(
      notTitleCase([
        ["Sor", tr(NAV_ASK_LABEL)],
        ["ayarlar", tr(NAV_SETTINGS.labelKey)],
        ...NAV_ITEMS.map((i): [string, string] => [`menü ${i.key}`, tr(i.labelKey)]),
        ...HUB_VIEWS.map((v): [string, string] => [`görünüm ${v.key}`, tr(v.labelKey)]),
        ...Object.entries(HUB_LABELS).map(([k, v]): [string, string] => [`hub ${k}`, tr(v)]),
        ...MODEL_TABS.map((t): [string, string] => [`model ${t.key}`, tr(t.labelKey)]),
        ...SETTINGS_TABS.map((t): [string, string] => [`ayar ${t.key}`, tr(t.labelKey)]),
        ["gelişmiş", tr(SETTINGS_ADVANCED_LABEL)],
        ...WORK_SECTIONS.flatMap((s): [string, string][] => [[`bölüm ${s.key}`, tr(s.labelKey)], [`bölüm ${s.key}`, tr(s.newLabelKey)]]),
        ...WORK_QUICK_FILTERS.map((q): [string, string] => [`hızlı filtre ${q.key}`, tr(q.labelKey)]),
      ]),
    ).toEqual([]);
  });

  it("every İşler section is a hub view with the same label", () => {
    for (const s of WORK_SECTIONS) expect(tr(HUB_VIEWS.find((v) => v.section === s.key)!.labelKey), s.key).toBe(tr(s.labelKey));
  });

  it("built-in work types, their fields and statuses are Title Case", () => {
    expect(
      notTitleCase(
        ALL_BUILT_IN_WORK_TYPES.flatMap((t): [string, string][] => [
          [`tip ${t.key}`, t.name],
          ...t.fields.map((f): [string, string] => [`alan ${t.key}.${f.key}`, f.label]),
          ...(t.statuses ?? defaultStatuses(t.category)).map((s): [string, string] => [`durum ${t.key}.${s.key}`, s.label]),
        ]),
      ),
    ).toEqual([]);
    expect(notTitleCase(WORK_CATEGORIES.flatMap((c) => defaultStatuses(c).map((s): [string, string] => [`durum ${c}`, s.label])))).toEqual([]);
  });

  it("checkbox and radio labels are Title Case", () => {
    const labels = choiceLabels();
    expect(labels.length).toBeGreaterThan(30);
    expect(labels.some((l) => l.text === "Yalnız Açık İşler")).toBe(true);
    // After an expression ("{n} kalemi…") a leading conjunction may stay small: check it as a continuation.
    const bad = labels.filter((l) => !isTitleCaseTr(l.continued ? `X ${l.text}` : l.text)).map((l) => `${l.where}: ${l.text}`);
    expect(bad).toEqual([]);
  });

  it("finds checkbox and radio labels, without notes, explanations and other labels", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ui-choice-"));
    try {
      fs.writeFileSync(
        path.join(dir, "Sample.tsx"),
        [
          'export const A = () => <label className="check"><input type="checkbox" /> Yalnız açık işler</label>;',
          'export const B = () => <label><input type="radio" /><strong>Boş Proje</strong><span className="muted">Her şeyi sonra kurarsınız.</span></label>;',
          'export const C = () => <label><input type="checkbox" /> Dış Sağlayıcılara İzin Ver — soru gönderilir</label>;',
          'export const D = () => <label>Proje adı</label>;',
          'export const E = () => <label><input type="checkbox" /> eski etiket</label>; // ui-terms-ok',
        ].join("\n"),
      );
      const found = choiceLabels(dir).map((l) => `${l.where} ${l.text}`);
      expect(found).toEqual(["Sample.tsx:1 Yalnız açık işler", "Sample.tsx:2 Boş Proje", "Sample.tsx:3 Dış Sağlayıcılara İzin Ver"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("shared label tables (statuses, categories, kinds…) are Title Case", () => {
    const tables = Object.entries(shared).filter(([name, v]) => /_LABELS_TR$/.test(name) && !SENTENCE_TABLES.has(name) && v && typeof v === "object");
    expect(tables.length).toBeGreaterThan(20);
    const entries = tables.flatMap(([name, table]) =>
      Object.values(table as Record<string, unknown>)
        .filter((v): v is string => typeof v === "string")
        .map((v): [string, string] => [name, v]),
    );
    expect(notTitleCase(entries)).toEqual([]);
  });
});
