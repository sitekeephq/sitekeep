// Set-up wizard with the ÇŞB 2026 (EK-2) naming profile of the Turkish construction template
// (docs/features/NAMING_CSB_2026.md): the EK-1 project code in the basics step and the request,
// and the sample name of the profile.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CSB_2026_STANDARD_NAME,
  localizeTemplate,
  namingUsesToken,
  resolveNamingTokens,
  validateName,
  type ProjectTemplate,
} from "@sitekeep/shared";
import { emptyDraft, toRequest, withTemplate, type SetupDraft } from "../../src/features/projects/setup/draft";
import { stepProblems } from "../../src/features/projects/setup/steps";
import { sampleName } from "../../src/features/projects/setup/StructureSteps";

const here = path.dirname(fileURLToPath(import.meta.url));
const template = localizeTemplate(
  JSON.parse(readFileSync(path.resolve(here, "../../../server/templates/iso19650-yapim-tr.json"), "utf8")) as ProjectTemplate,
  "tr",
);

function draft(patch: Partial<SetupDraft> = {}): SetupDraft {
  return { ...emptyDraft("tr"), template: { kind: "builtin", id: "iso19650-yapim-tr" }, code: "CSB", name: "ÇŞB", ...patch };
}

describe("set-up wizard: ÇŞB 2026 profile", () => {
  it("the Turkish template asks for the EK-1 code; the request carries it upper-cased", () => {
    expect(namingUsesToken(template.namingStandards, "EK1")).toBe(true);
    const request = toRequest(draft({ csbProjectCode: " 27a001 ", containerStandard: CSB_2026_STANDARD_NAME }), template);
    expect(request.details).toEqual({ csbProjectCode: "27A001" });
    expect(request.setup?.containerStandard).toBe(CSB_2026_STANDARD_NAME);
    // Drafts saved before the field existed have no code.
    const { csbProjectCode: _, ...old } = draft();
    expect(toRequest(old as SetupDraft, template).details).toBeUndefined();
    expect(withTemplate(draft({ csbProjectCode: "270001" }), null).csbProjectCode).toBe("270001");
  });

  it("the basics step checks the EK-1 code", () => {
    const problems = (d: SetupDraft) => stepProblems("basics", d, template, "en").map((p) => ("text" in p ? p.text : p.key));
    expect(problems(draft({ csbProjectCode: "270001" }))).toEqual([]);
    expect(problems(draft({ csbProjectCode: "2700" }))).toEqual(['The ÇŞB project code (EK-1) must be six capital letters or digits (e.g. 270001): "2700".']);
  });

  it("the sample name of the profile follows it, with or without the EK-1 code", () => {
    const standard = template.namingStandards!.find((s) => s.name === CSB_2026_STANDARD_NAME)!;
    for (const csbProjectCode of ["270001", undefined]) {
      const resolved = resolveNamingTokens(standard, { projectCode: "CSB", slotCodes: {}, slotNames: {}, csbProjectCode });
      const sample = sampleName(resolved);
      expect(sample).toBe(`${csbProjectCode ?? "XXXXXX"}_00_MM_AKSS_PL_MMC_B03_01_001`);
      expect(validateName(resolved, sample).ok).toBe(true);
    }
  });
});
