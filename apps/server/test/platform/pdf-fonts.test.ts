/** Generated PDFs (hakediş, gönderim kapağı) need the bundled fonts for Turkish glyphs. */
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { pdfFontBytes } from "../../src/core/formats/pdf-fonts.js";
import { transmittalCoverPdf } from "../../src/works/pdf.js";

const TURKISH = "ğĞıİşŞçÇöÖüÜ"; // i18n-ok: glyph test

/** The text of every page, read back with pdf.js (the text layer, i.e. what the font's ToUnicode maps to). */
async function pdfText(bytes: Uint8Array): Promise<string> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const dir = path.dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"));
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), standardFontDataUrl: `${dir}/standard_fonts/`, verbosity: 0 });
  const doc = await task.promise;
  let text = "";
  for (let i = 1; i <= doc.numPages; i++) {
    const content = await (await doc.getPage(i)).getTextContent();
    text += content.items.map((it) => ("str" in it ? it.str : "")).join(" ") + "\n";
  }
  await task.destroy();
  return text;
}

describe("PDF fonts", () => {
  it("finds Liberation Sans in apps/server/assets/fonts", () => {
    const f = pdfFontBytes();
    expect(f).not.toBeNull();
    expect(f!.regular.length).toBeGreaterThan(100_000);
    expect(f!.bold.length).toBeGreaterThan(100_000);
  });

  it("writes Turkish letters into a generated PDF (regular and bold) and they read back unchanged", async () => {
    const bytes = await transmittalCoverPdf({
      projectCode: "PRJ",
      projectName: `Proje ${TURKISH}`, // i18n-ok: glyph test
      number: "PRJ-TRM-0001",
      title: `Başlık ${TURKISH}`, // i18n-ok: glyph test
      date: new Date("2026-01-02T00:00:00Z"),
      purpose: "Bilgi",
      from: `Gönderen ${TURKISH}`, // i18n-ok: glyph test
      to: ["Alıcı Şirketi"], // i18n-ok: glyph test
      cc: [],
      note: `Not ${TURKISH}`, // i18n-ok: glyph test
      files: [{ name: `çizim-${TURKISH}.pdf`, version: 1, revision: "P01" }],
      createdBy: "Ömer Işık", // i18n-ok: glyph test
      lang: "tr",
    });
    const text = await pdfText(bytes);
    expect(text).toContain(TURKISH);
    expect(text).toContain("Ömer Işık"); // i18n-ok: glyph test
    // The fonts are embedded (no fallback to Helvetica with transliteration).
    expect(text).not.toMatch(/Omer Isik/);
  });
});
