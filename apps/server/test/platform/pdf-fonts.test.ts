/** Generated PDFs (hakediş, gönderim kapağı) need the bundled fonts for Turkish glyphs. */
import { describe, expect, it } from "vitest";
import { pdfFontBytes } from "../../src/core/formats/pdf-fonts.js";

describe("PDF fonts", () => {
  it("finds Liberation Sans in apps/server/assets/fonts", () => {
    const f = pdfFontBytes();
    expect(f).not.toBeNull();
    expect(f!.regular.length).toBeGreaterThan(100_000);
    expect(f!.bold.length).toBeGreaterThan(100_000);
  });
});
