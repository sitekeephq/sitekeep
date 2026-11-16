// Project set-up wizard (docs/features/PROJECT_SETUP_WIZARD.md): step validation, the request built
// from the draft, and the browser draft.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { localizeTemplate, type ProjectTemplate } from "@sitekeep/shared";
import {
  clearDraft,
  emptyDraft,
  loadDraft,
  saveDraft,
  suggestCode,
  toRequest,
  withTemplate,
  type SetupDraft,
} from "../../src/features/projects/setup/draft";
import { SETUP_STEPS, firstBlockedStep, stepProblems } from "../../src/features/projects/setup/steps";

const here = path.dirname(fileURLToPath(import.meta.url));
const template = localizeTemplate(
  JSON.parse(readFileSync(path.resolve(here, "../../../server/templates/iso19650-yapim-en.json"), "utf8")) as ProjectTemplate,
  "en",
);
const APPROVAL = "Approval: Consultant + Designer → Client acceptance → Publish";

function draft(patch: Partial<SetupDraft> = {}): SetupDraft {
  return { ...emptyDraft("en"), template: { kind: "builtin", id: "iso19650-yapim-en" }, code: "WIZ", name: "Wizard", ...patch };
}
const problems = (step: (typeof SETUP_STEPS)[number], d: SetupDraft, t: ProjectTemplate | null = template) =>
  stepProblems(step, d, t, "en").map((p) => ("text" in p ? p.text : p.key));

describe("set-up wizard steps", () => {
  it("has the eleven steps, language first and summary last", () => {
    expect(SETUP_STEPS).toHaveLength(11);
    expect(SETUP_STEPS[0]).toBe("language");
    expect(SETUP_STEPS[10]).toBe("summary");
  });

  it("language and template: a project language and a loaded template", () => {
    expect(problems("language", draft({ language: "de" }))).toEqual(["language"]);
    expect(problems("language", draft())).toEqual([]);
    expect(problems("template", draft({ template: null }))).toEqual(["template"]);
    expect(problems("template", draft(), null)).toEqual(["templateLoading"]);
    expect(problems("template", draft())).toEqual([]);
  });

  it("basics: code and name required, code characters, dates in order", () => {
    expect(problems("basics", draft({ code: "", name: "" }))).toEqual(["codeRequired", "nameRequired"]);
    expect(problems("basics", draft({ code: "A-B" }))).toEqual(["codeChars"]);
    expect(problems("basics", draft({ startDate: "2027-01-02", endDate: "2026-01-01" }))).toEqual(["The end date is before the start date."]);
    expect(problems("basics", draft({ startDate: "2026-01-01", endDate: "2027-01-01" }))).toEqual([]);
  });

  it("parties: one lead, known parties, codes in capitals", () => {
    expect(problems("parties", draft())).toEqual([]);
    expect(problems("parties", draft({ taskTeams: [{ slot: "idare", lead: true }, { slot: "yuklenici", lead: true }] }))).toEqual([
      "Only one task team can be the lead appointed party.",
    ]);
    expect(problems("parties", draft({ taskTeams: [{ slot: "ghost" }] }))).toEqual(["teamSlot"]);
    expect(problems("parties", draft({ slotCodes: { idare: "cl-1" } }))).toEqual(["slotCode"]);
    // An added party gets a task team and can be the lead.
    const added = draft({ parties: [{ key: "teknik", label: "Technical unit" }], taskTeams: [{ slot: "teknik", lead: true }] });
    expect(problems("parties", added)).toEqual([]);
    expect(toRequest(added, template).setup?.taskTeams).toEqual([{ slot: "teknik", lead: true }]);
  });

  it("people: e-mails, known parties and template roles", () => {
    const person = (p: Partial<SetupDraft["people"][number]>) => ({ email: "a@b.co", slot: "", roles: [], projectAdmin: false, ...p });
    expect(problems("people", draft({ people: [person({ email: "" })] }))).toEqual(["emailRequired"]);
    expect(problems("people", draft({ people: [person({ email: "not-an-email" })] }))).toEqual(['"not-an-email" is not an e-mail address.']);
    expect(problems("people", draft({ people: [person({ slot: "tasarimci", roles: ["tasarimci-yetki"] })] }))).toEqual([]);
    expect(problems("people", draft({ people: [person({ roles: ["nope"] })] }))).toEqual(['a@b.co: project role "nope" is not in the template.']);
  });

  it("folders: additions below template folders, no state folders left out", () => {
    expect(problems("folders", draft({ folderAdds: [{ parent: "00-GENERAL", name: "09-Photos" }], folderRemoves: ["00-GENERAL/05-User Guides"] }))).toEqual([]);
    expect(problems("folders", draft({ folderRemoves: ["40-ARCHIVED"] }))).toEqual([
      '"40-ARCHIVED" carries an ISO 19650 state or generated folders and cannot be left out.',
    ]);
    expect(problems("folders", draft({ folderAdds: [{ parent: "00-GENERAL", name: "01-Tender and Contract Documents" }] }))).toEqual([
      'Folder "00-GENERAL/01-Tender and Contract Documents" already exists.',
    ]);
  });

  it("naming: list codes only, no duplicates", () => {
    const key = (field: string) => `ISO 19650 Document Naming\u0000${field}`;
    expect(problems("naming", draft({ naming: { [key("Volume")]: "ZZ All\nB1 Block 1" } }))).toEqual([]);
    expect(problems("naming", draft({ naming: { [key("Volume")]: "ZZ\nzz" } }))).toEqual(['Field "Volume": code "ZZ" is listed twice.']);
    expect(problems("naming", draft({ containerStandard: "Nope" }))).toEqual(["standard"]);
  });

  it("workflows: approvers from the template's parties and roles", () => {
    expect(problems("workflows", draft({ steps: { [`${APPROVAL}\u00001`]: { assignees: [{ projectRole: "idare-onay" }] } } }))).toEqual([]);
    expect(problems("workflows", draft({ steps: { [`${APPROVAL}\u00001`]: { assignees: [{ slot: "ghost" }] } } }))).toEqual([
      `"${APPROVAL}" step 2: role "ghost" is not defined.`,
    ]);
    expect(problems("workflows", draft({ steps: { [`${APPROVAL}\u00001`]: { assignees: [] } } }))).toEqual([
      `"${APPROVAL}", step "Client acceptance": choose at least one approver.`,
    ]);
  });

  it("summary: every check; the first blocked step", () => {
    const bad = draft({ code: "", folderRemoves: ["40-ARCHIVED"] });
    expect(firstBlockedStep(bad, template, "en")).toBe(2);
    expect(problems("summary", bad)).toEqual(['"40-ARCHIVED" carries an ISO 19650 state or generated folders and cannot be left out.']);
    expect(firstBlockedStep(draft(), template, "en")).toBeNull();
  });
});

describe("set-up wizard request", () => {
  it("sends only the explicit choices; a draft without choices equals a template request", () => {
    expect(toRequest(draft(), template)).toEqual({
      templateId: "iso19650-yapim-en",
      code: "WIZ",
      name: "Wizard",
      language: "en",
      slotCompanies: {},
      slotCodes: {},
      dimensions: {},
    });
    const full = toRequest(
      draft({
        slotCompanies: { idare: "c1", musavir: "__new__" },
        codeScheme: "legacy_r",
        enforceTransitions: false,
        wipPolicy: "grants",
        transitions: { "wip>shared": null },
        modules: { rfi: false },
        startDate: "2026-12-01",
        location: " Ankara ",
        dimensions: { Discipline: "A\nS" },
        people: [{ email: " A@B.CO ", slot: "idare", roles: [], projectAdmin: true }],
      }),
      template,
    );
    expect(full.slotCompanies).toEqual({ idare: "c1" });
    expect(full.setup).toEqual({
      transitions: [{ from: "wip", to: "shared", workflow: null }],
      cde: { codeScheme: "legacy_r", enforceTransitions: false, wipPolicy: "grants" },
      modules: { rfi: false },
    });
    expect(full.details).toEqual({ startDate: "2026-12-01", location: "Ankara" });
    expect(full.dimensions).toEqual({ Discipline: ["A", "S"] });
    expect(full.people).toEqual([{ email: "a@b.co", slot: "idare", projectAdmin: true }]);
  });

  it("resets the template's choices when another template is chosen", () => {
    const d = withTemplate(draft({ codeScheme: "legacy_r", slotCompanies: { idare: "c1" }, people: [{ email: "a@b.co", slot: "idare", roles: ["x"], projectAdmin: false }] }), {
      kind: "builtin",
      id: "iso19650-temel",
    });
    expect(d.codeScheme).toBeUndefined();
    expect(d.slotCompanies).toEqual({});
    expect(d.code).toBe("WIZ");
    expect(d.people).toEqual([{ email: "a@b.co", slot: "", roles: [], projectAdmin: false }]);
  });

  it("proposes a project code from the name", () => {
    expect(suggestCode("Zafer Alışveriş Merkezi")).toBe("ZAM");
    expect(suggestCode("Istanbul")).toBe("ISTANB");
    expect(suggestCode("")).toBe("");
  });
});

describe("browser draft", () => {
  const g = globalThis as { window?: unknown };
  afterEach(() => {
    delete g.window;
  });

  it("keeps the draft per user and survives a missing or failing storage", () => {
    expect(loadDraft("u1")).toBeNull();
    expect(() => saveDraft("u1", draft())).not.toThrow();
    const store = new Map<string, string>();
    g.window = {
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
      },
    };
    saveDraft("u1", draft({ step: 4 }));
    expect(loadDraft("u1")?.step).toBe(4);
    expect(loadDraft("u2")).toBeNull();
    clearDraft("u1");
    expect(loadDraft("u1")).toBeNull();
    g.window = {
      localStorage: {
        getItem: () => {
          throw new Error("blocked");
        },
        setItem: () => {
          throw new Error("full");
        },
        removeItem: () => {
          throw new Error("blocked");
        },
      },
    };
    expect(loadDraft("u1")).toBeNull();
    expect(() => saveDraft("u1", draft())).not.toThrow();
    expect(() => clearDraft("u1")).not.toThrow();
  });
});
