import { describe, expect, it } from "vitest";
import {
  guessNewRecord,
  isGroupAddress,
  listCode,
  resolveTemplateTokens,
  revisionFromFileName,
  trimChars,
  trimSlashes,
  trimTrailingSlashes,
} from "../src/index.js";

/** Runs `fn` and fails when it needs more than `ms` (a quadratic regex takes seconds on these inputs). */
function fast<T>(fn: () => T, ms = 250): T {
  const t0 = performance.now();
  const out = fn();
  expect(performance.now() - t0).toBeLessThan(ms);
  return out;
}
const N = 200_000;

describe("trim helpers", () => {
  it("trim slashes like the regexes they replace", () => {
    expect(trimTrailingSlashes("https://x///")).toBe("https://x");
    expect(trimTrailingSlashes("a")).toBe("a");
    expect(trimSlashes("//a/b//")).toBe("a/b");
    expect(trimSlashes("///")).toBe("");
  });
  it("are linear on a long run followed by another character", () => {
    expect(fast(() => trimTrailingSlashes("/".repeat(N) + "x")).length).toBe(N + 1);
    expect(fast(() => trimSlashes("/".repeat(N) + "x" + "/".repeat(N)))).toBe("x");
  });
  it("trimChars cuts by predicate", () => {
    expect(trimChars("::a b;;", (c) => c === ":", (c) => c === ";")).toBe("a b");
    expect(fast(() => trimChars(" ".repeat(N) + "x", (c) => c === " ", null))).toBe("x");
  });
});

describe("pathological input", () => {
  it("listCode keeps its behaviour", () => {
    expect(listCode("M - Mekanik")).toBe("M");
    expect(listCode("  M  –  Mekanik ")).toBe("M");
    expect(listCode("- x - y")).toBe("- x");
    expect(listCode("plain")).toBe("plain");
    expect(listCode("- y")).toBe("- y");
  });
  it("listCode is fast on a long run of spaces", () => {
    fast(() => listCode("a" + " ".repeat(N) + "b"));
  });

  it("isGroupAddress strips a trailing number and is fast on long digit runs", () => {
    expect(isGroupAddress("info@x.com")).toBe(true);
    expect(isGroupAddress("info2@x.com")).toBe(true);
    expect(isGroupAddress("info_01@x.com")).toBe(true);
    expect(isGroupAddress("ali@x.com")).toBe(false);
    expect(fast(() => isGroupAddress("1".repeat(N) + "x@x.com"))).toBe(false);
  });

  it("template tokens resolve and stay fast on unterminated tokens", () => {
    const ctx = { projectCode: "P1", slotCodes: { a: "AA" }, slotNames: {} };
    expect(resolveTemplateTokens("{PROJE}-{slot:a}", ctx)).toBe("P1-AA");
    expect(resolveTemplateTokens("{slot:zz}", ctx)).toBeNull();
    fast(() => resolveTemplateTokens("{slot:a".repeat(40_000), ctx));
  });

  it("revisionFromFileName works and is fast on many dots", () => {
    expect(revisionFromFileName("plan_P02.pdf")?.value).toBe("P02");
    expect(revisionFromFileName("a." + ".".repeat(N) + "x")).toBeNull();
    fast(() => revisionFromFileName("a" + ".".repeat(N)));
    fast(() => revisionFromFileName("rev" + " ".repeat(5_000) + "!"));
  });

  it("guessNewRecord is fast on long separator runs", () => {
    expect(guessNewRecord("Prota'ya B3 kazısı için bilgi talebi aç").title).toContain("B3");
    fast(() => guessNewRecord("bilgi talebi aç " + ";".repeat(N) + "x" + ":".repeat(N)), 500);
  });
});
