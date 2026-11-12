/** Interface text lives in the translation files, not in code (docs/architecture/i18n.md §6). */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error -- plain ESM script without type declarations
import { findHardcodedTexts } from "../../scripts/check-i18n.mjs";

type Result = { files: number; problems: string[] };
const scan = findHardcodedTexts as (dir?: string) => Result;

describe("hard-coded interface text", () => {
  it("apps/web/src has none", () => {
    const { files, problems } = scan();
    expect(files).toBeGreaterThan(150);
    expect(problems).toEqual([]);
  });

  it("flags JSX text, text attributes and Turkish strings, not keys, acronyms, imports or marked lines", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "i18n-scan-"));
    try {
      fs.writeFileSync(
        path.join(dir, "Sample.tsx"),
        [
          'import { t } from "./i18n";',
          "// Kaydet düğmesi (yorum)",
          'export const A = () => <button>Save</button>;',
          'export const B = () => <button title="Kapat">{t("common:actions.close")}</button>;',
          'export const C = () => <span className="badge">PDF · CDE ⌘K</span>;',
          'export const D = () => <input placeholder={t("search.placeholder")} aria-label="IFC" />;',
          'export const E = (n: number) => `${n} dosya yüklendi`;',
          'const route: "files" | "reviews" = "files";',
          'export const F = "Örnek İnşaat"; // i18n-ok',
          "export const G = { yazismalar: route };",
        ].join("\n"),
      );
      expect(scan(dir).problems).toEqual([
        'Sample.tsx:3  JSX text: "Save"',
        'Sample.tsx:4  title=: "Kapat"',
        'Sample.tsx:7  Turkish template: "dosya yüklendi"',
      ]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
