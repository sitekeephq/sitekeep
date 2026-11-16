import { describe, expect, it } from "vitest";
import {
  ISO_UK_NA,
  LEGACY_R,
  LETTER_REV,
  allowedSuitability,
  codeProfile,
  defaultSuitability,
  initialRevision,
  isKnownRevision,
  isKnownSuitability,
  letterIndex,
  letterRevision,
  nextRevision,
  normaliseRevision,
  normaliseSuitability,
  validateCodes,
} from "../src/index.js";

describe("ISO19650-2 5.1.7(b) / UK NA suitability: normalising", () => {
  it("reads suitability codes the way people and older clients write them", () => {
    expect(normaliseSuitability(" s2 ")).toBe("S2");
    expect(normaliseSuitability("S2 · For Information")).toBe("S2");
    expect(normaliseSuitability("A")).toBe("A1");
    expect(normaliseSuitability("b")).toBe("B1");
    expect(normaliseSuitability("A02")).toBe("A2");
    expect(normaliseSuitability("cr")).toBe("CR");
    expect(normaliseSuitability("")).toBeNull();
    expect(normaliseSuitability(null)).toBeNull();
  });

  it("reads revisions in their canonical form", () => {
    expect(normaliseRevision("p1")).toBe("P01");
    expect(normaliseRevision("P1.2")).toBe("P01.02");
    expect(normaliseRevision("p01.01")).toBe("P01.01");
    expect(normaliseRevision("C 1")).toBe("C01");
    expect(normaliseRevision("Rev 3")).toBe("R03");
    expect(normaliseRevision("r1")).toBe("R01");
    expect(normaliseRevision("3")).toBe("3");
    expect(normaliseRevision("3", LEGACY_R)).toBe("R03");
    expect(normaliseRevision("B")).toBe("B");
    expect(normaliseRevision("  ")).toBeNull();
  });
});

describe("ISO19650-2 5.1.7(b) / UK NA suitability: codes per state", () => {
  it("offers S0 in WIP, S1–S4 in Shared, A/B/CR in Published (no S5–S7)", () => {
    expect(allowedSuitability(ISO_UK_NA, "wip")).toEqual(["S0"]);
    expect(allowedSuitability(ISO_UK_NA, "shared")).toEqual(["S1", "S2", "S3", "S4"]);
    expect(allowedSuitability(ISO_UK_NA, "published")).toEqual(["A1", "A2", "A3", "B1", "B2", "B3", "CR"]);
    expect(allowedSuitability(ISO_UK_NA, null)).toContain("S0");
    expect(allowedSuitability(ISO_UK_NA, null)).not.toContain("S5");
    expect(defaultSuitability(ISO_UK_NA, "wip")).toBe("S0");
    expect(defaultSuitability(ISO_UK_NA, "shared")).toBeNull();
  });

  it("validates suitability and revision against the state", () => {
    expect(validateCodes(ISO_UK_NA, "wip", { suitabilityCode: "s0", revisionCode: "p1.1" })).toEqual({
      ok: true,
      codes: { suitabilityCode: "S0", revisionCode: "P01.01" },
      errors: [],
    });
    expect(validateCodes(ISO_UK_NA, "shared", { suitabilityCode: "S2", revisionCode: "P01" }).ok).toBe(true);
    expect(validateCodes(ISO_UK_NA, "published", { suitabilityCode: "A7", revisionCode: "C03" }).ok).toBe(true);
    expect(validateCodes(ISO_UK_NA, "published", { suitabilityCode: "CR", revisionCode: "C01" }).ok).toBe(true);

    const wrong = validateCodes(ISO_UK_NA, "wip", { suitabilityCode: "S2", revisionCode: "C01" });
    expect(wrong.ok).toBe(false);
    expect(wrong.errors.map((e) => [e.field, e.kind])).toEqual([
      ["suitabilityCode", "suitabilityState"],
      ["revisionCode", "revisionState"],
    ]);
    expect(wrong.errors[0]!.allowed).toBe("S0");
    expect(wrong.errors[1]!.allowed).toBe("P01.01");

    const unknown = validateCodes(ISO_UK_NA, "shared", { suitabilityCode: "S6", revisionCode: "R01" });
    expect(unknown.errors.map((e) => e.kind)).toEqual(["suitabilityUnknown", "revisionFormat"]);
    // Published: preliminary revisions are not contractual.
    expect(validateCodes(ISO_UK_NA, "published", { revisionCode: "P02" }).errors[0]!.kind).toBe("revisionState");
    // Archived keeps what the publication had; a folder without a state takes any code.
    expect(validateCodes(ISO_UK_NA, "archived", { suitabilityCode: "A1", revisionCode: "C02" }).ok).toBe(true);
    expect(validateCodes(ISO_UK_NA, null, { suitabilityCode: "S3", revisionCode: "P01.04" }).ok).toBe(true);
    // Nothing given: nothing to check.
    expect(validateCodes(ISO_UK_NA, "published", {}).ok).toBe(true);
  });

  it("knows the profile's codes regardless of state (migration)", () => {
    expect(isKnownSuitability(ISO_UK_NA, "A")).toBe(true);
    expect(isKnownSuitability(ISO_UK_NA, "S7")).toBe(false);
    expect(isKnownRevision(ISO_UK_NA, "P02")).toBe(true);
    expect(isKnownRevision(ISO_UK_NA, "R02")).toBe(false);
    expect(isKnownRevision(LEGACY_R, "R02")).toBe(true);
    expect(isKnownRevision(LEGACY_R, "P02")).toBe(false);
  });
});

describe("ISO19650-2 5.1.7(b) / UK NA suitability: revision sequence", () => {
  it("counts WIP versions, shares them as P0n and publishes C0n", () => {
    expect(initialRevision(ISO_UK_NA, "wip")).toBe("P01.01");
    expect(initialRevision(ISO_UK_NA, "shared")).toBe("P01");
    expect(initialRevision(ISO_UK_NA, "published")).toBe("C01");
    expect(nextRevision(ISO_UK_NA, "P01.01", "wip", "wip")).toBe("P01.02");
    expect(nextRevision(ISO_UK_NA, "P01.03", "wip", "shared")).toBe("P01");
    // P01 was shared already: the next free number.
    expect(nextRevision(ISO_UK_NA, "P01.04", "wip", "shared", ["P01.01", "P01"])).toBe("P02");
    expect(nextRevision(ISO_UK_NA, "P01", "shared", "shared")).toBe("P02");
    expect(nextRevision(ISO_UK_NA, "P02", "shared", "published")).toBe("C01");
    expect(nextRevision(ISO_UK_NA, "P03", "shared", "published", ["C01"])).toBe("C02");
    expect(nextRevision(ISO_UK_NA, "C01", "published", "published")).toBe("C02");
    // Back to WIP: the next preliminary revision starts.
    expect(nextRevision(ISO_UK_NA, "P01", "shared", "wip")).toBe("P02.01");
    expect(nextRevision(ISO_UK_NA, "C01", "published", "wip", ["P01", "P02"])).toBe("P03.01");
    expect(nextRevision(ISO_UK_NA, "C02", "published", "archived")).toBe("C02");
    // A folder without a state: the next revision of the same form, nothing for a new document.
    expect(nextRevision(ISO_UK_NA, "P01.01", null, null)).toBe("P01.02");
    expect(nextRevision(ISO_UK_NA, null, null, null)).toBeNull();
  });
});

describe("ISO19650-2 5.1.7(b) / UK NA suitability: legacy profile", () => {
  it("uses R00, R01 … in any state with no S/A split", () => {
    expect(initialRevision(LEGACY_R, "wip")).toBe("R00");
    expect(nextRevision(LEGACY_R, "R00", "wip", "wip")).toBe("R01");
    expect(nextRevision(LEGACY_R, "R01", "wip", "shared")).toBe("R01");
    expect(nextRevision(LEGACY_R, "R01", "shared", "shared")).toBe("R02");
    expect(validateCodes(LEGACY_R, "wip", { suitabilityCode: "A1", revisionCode: "r2" })).toMatchObject({ ok: true, codes: { revisionCode: "R02" } });
    expect(validateCodes(LEGACY_R, "published", { suitabilityCode: "S0", revisionCode: "R05" }).ok).toBe(true);
    expect(validateCodes(LEGACY_R, "wip", { revisionCode: "P01.01" }).errors[0]!.kind).toBe("revisionFormat");
  });
});

describe("ISO19650-2 5.1.7(b) / UK NA suitability: project overrides", () => {
  it("replaces the suitability list with the project's own codes", () => {
    const p = codeProfile({
      codeScheme: "custom",
      suitabilityCodes: [
        { code: "s0", states: ["wip"] },
        { code: "D1", description: "For costing", states: ["shared"] },
        { code: "X" },
      ],
    });
    expect(p.customSuitability).toBe(true);
    expect(allowedSuitability(p, "wip")).toEqual(["S0", "X"]);
    expect(allowedSuitability(p, "shared")).toEqual(["D1", "X"]);
    expect(validateCodes(p, "shared", { suitabilityCode: "D1", revisionCode: "P01" }).ok).toBe(true);
    expect(validateCodes(p, "shared", { suitabilityCode: "S2" }).errors[0]!.kind).toBe("suitabilityUnknown");
    // The scheme's own list when the override is empty.
    expect(codeProfile({ codeScheme: "legacy_r", suitabilityCodes: [] }).customSuitability).toBe(false);
  });
});

describe("ISO19650-2 5.1.7(b) / letter revisions: Forma / ACC profile", () => {
  const LETTER = codeProfile({ codeScheme: "letter_rev" });

  it("is the letter_rev scheme with the ISO suitability codes in any state", () => {
    expect(LETTER).toMatchObject({ scheme: "letter_rev", customSuitability: false });
    expect(LETTER.revisions).toEqual(LETTER_REV.revisions);
    expect(allowedSuitability(LETTER, "wip")).toEqual(allowedSuitability(LETTER, "published"));
    expect(allowedSuitability(LETTER, "wip")).toEqual(expect.arrayContaining(["S0", "S2", "A1", "CR"]));
    expect(defaultSuitability(LETTER, "wip")).toBe("S0");
  });

  it("reads letter revisions the way people and Forma write them", () => {
    expect(normaliseRevision("rev b", LETTER)).toBe("B");
    expect(normaliseRevision("REVİZYON c", LETTER)).toBe("C");
    expect(normaliseRevision(" a ", LETTER)).toBe("A");
    expect(normaliseRevision("ab", LETTER)).toBe("AB");
    expect(normaliseRevision("Rev. D")).toBe("D");
    // Without the profile a bare letter stays as written (and is not an ISO revision).
    expect(normaliseRevision("b")).toBe("B");
    expect(isKnownRevision(ISO_UK_NA, "B")).toBe(false);
    expect(isKnownRevision(LETTER, "b")).toBe(true);
    expect(isKnownRevision(LETTER, "P01")).toBe(false);
    expect(isKnownRevision(LETTER, "ABC")).toBe(false);
    expect(isKnownRevision(LETTER, "1")).toBe(false);
  });

  it("allows any letter revision and any suitability code in any state", () => {
    for (const state of ["wip", "shared", "published", "archived", null] as const) {
      expect(validateCodes(LETTER, state, { suitabilityCode: "s2", revisionCode: "rev b" })).toEqual({
        ok: true,
        codes: { suitabilityCode: "S2", revisionCode: "B" },
        errors: [],
      });
    }
    expect(validateCodes(LETTER, "wip", { revisionCode: "P01.01" }).errors[0]).toMatchObject({ kind: "revisionFormat", allowed: "A" });
    expect(validateCodes(LETTER, "wip", { suitabilityCode: "Approved" }).errors[0]!.kind).toBe("suitabilityUnknown");
  });

  it("counts A → B … Z → AA, keeps the revision on a state change", () => {
    expect(initialRevision(LETTER, "wip")).toBe("A");
    expect(initialRevision(LETTER, null)).toBe("A");
    expect(nextRevision(LETTER, "A", "wip", "wip")).toBe("B");
    expect(nextRevision(LETTER, "B", "shared", "shared")).toBe("C");
    expect(nextRevision(LETTER, "Z", "wip", "wip")).toBe("AA");
    expect(nextRevision(LETTER, "AZ", null, null)).toBe("BA");
    expect(nextRevision(LETTER, "ZZ", "wip", "wip")).toBeNull();
    expect(nextRevision(LETTER, "B", "wip", "shared")).toBe("B");
    expect(nextRevision(LETTER, "C", "published", "archived")).toBe("C");
    // Never reuses a letter of the history; a non-letter current revision starts after the highest letter.
    expect(nextRevision(LETTER, "B", "wip", "wip", ["A", "D"])).toBe("E");
    expect(nextRevision(LETTER, "R03", "wip", "wip", ["C"])).toBe("D");
    expect(letterIndex("A")).toBe(1);
    expect(letterIndex("AA")).toBe(27);
    expect(letterRevision(702)).toBe("ZZ");
    expect(letterRevision(703)).toBeNull();
  });

  it("keeps the project's own suitability list and its states", () => {
    const own = codeProfile({ codeScheme: "letter_rev", suitabilityCodes: [{ code: "S2", states: ["shared"] }, { code: "X" }] });
    expect(own).toMatchObject({ scheme: "letter_rev", customSuitability: true });
    expect(validateCodes(own, "shared", { suitabilityCode: "S2", revisionCode: "C" }).ok).toBe(true);
    expect(validateCodes(own, "wip", { suitabilityCode: "S2" }).errors[0]!.kind).toBe("suitabilityState");
    expect(validateCodes(own, "wip", { suitabilityCode: "X", revisionCode: "A" }).ok).toBe(true);
  });
});
