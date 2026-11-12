import { describe, expect, it } from "vitest";
import { findRanges, foldKeepLength } from "../../src/viewers/office/find";

describe("find in document", () => {
  it("folds Turkish letters without changing the length", () => {
    const s = "İSTANBUL Iğdır ıŞık ÇÖĞÜ";
    const f = foldKeepLength(s);
    expect(f).toHaveLength(s.length);
    expect(f).toBe("istanbul iğdir işik çöğü");
  });

  it("finds every match, case and dotted/dotless i insensitive", () => {
    const text = "Kiriş K-101\nKIRIŞ K-102 ve kırış";
    expect(findRanges(text, "kiriş")).toEqual([
      [0, 5],
      [12, 17],
      [27, 32],
    ]);
    expect(findRanges(text, "  ")).toEqual([]);
    expect(findRanges("Yeraltı suyu", "YERALTI SUYU")).toEqual([[0, 12]]);
  });

  it("matches across a line break as a space and caps the count", () => {
    expect(findRanges("beton\ndöküm", "beton döküm")).toEqual([[0, 11]]);
    expect(findRanges("a".repeat(100), "a", 10)).toHaveLength(10);
  });
});
