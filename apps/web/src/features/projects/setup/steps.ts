/**
 * The eleven steps of the project set-up wizard and what blocks "Next" on each (pure, unit tested).
 * Each step checks only its own choices against the template; the summary step runs every check
 * and the server's dry run.
 */
import {
  applySetupOverrides,
  checkProjectTemplate,
  checkSetupDetails,
  checkSetupPeople,
  type ProjectSetupOverrides,
  type ProjectTemplate,
} from "@sitekeep/shared";
import { dimensionOverrides, toSetup, type SetupDraft } from "./draft";

export const SETUP_STEPS = [
  "language",
  "template",
  "basics",
  "parties",
  "people",
  "folders",
  "naming",
  "codes",
  "workflows",
  "rules",
  "summary",
] as const;
export type SetupStep = (typeof SETUP_STEPS)[number];

/** Languages a project's content can be set up in (template families exist in both). */
export const PROJECT_LANGUAGES = ["en", "tr"] as const;

export type ProblemKey =
  | "language"
  | "template"
  | "templateLoading"
  | "codeRequired"
  | "codeChars"
  | "codeLength"
  | "nameRequired"
  | "teamSlot"
  | "slotCode"
  | "emailRequired"
  | "standard";

/** A step's problem: a message key of `projects:setup.problems` with parameters, or a ready text. */
export type StepProblem = { key: ProblemKey; params?: Record<string, string | number> } | { text: string };

function only(setup: ProjectSetupOverrides, keys: (keyof ProjectSetupOverrides)[]): ProjectSetupOverrides {
  return Object.fromEntries(keys.filter((k) => setup[k] !== undefined).map((k) => [k, setup[k]]));
}

/**
 * What must be fixed before leaving `step`. `template` is the chosen template in the project
 * language (null while it loads); `lang` is the interface language of the messages.
 */
export function stepProblems(step: SetupStep, draft: SetupDraft, template: ProjectTemplate | null, lang: string): StepProblem[] {
  const out: StepProblem[] = [];
  const texts = (list: string[]) => list.map((text) => ({ text }));
  switch (step) {
    case "language":
      if (!(PROJECT_LANGUAGES as readonly string[]).includes(draft.language)) out.push({ key: "language" });
      return out;
    case "template":
      if (!draft.template) out.push({ key: "template" });
      else if (!template) out.push({ key: "templateLoading" });
      return out;
    case "basics": {
      const code = draft.code.trim();
      if (!code) out.push({ key: "codeRequired" });
      else if (!/^[A-Za-z0-9_.]+$/.test(code)) out.push({ key: "codeChars" });
      else if (code.length > 40) out.push({ key: "codeLength" });
      if (!draft.name.trim()) out.push({ key: "nameRequired" });
      out.push(...texts(checkSetupDetails({ startDate: draft.startDate || undefined, endDate: draft.endDate || undefined, location: draft.location, client: draft.client }, lang)));
      return out;
    }
    default:
      break;
  }
  if (!template) return [{ key: "templateLoading" }];
  const setup = toSetup(draft, template);
  const applied = (keys: (keyof ProjectSetupOverrides)[]) => applySetupOverrides(template, only(setup, keys), lang);
  switch (step) {
    case "parties": {
      const r = applied(["parties", "taskTeams"]);
      out.push(...texts(r.errors));
      const slots = new Set(r.template.slots.map((s) => s.key));
      for (const team of r.template.cde?.taskTeams ?? []) if (!slots.has(team.slot)) out.push({ key: "teamSlot", params: { slot: team.slot } });
      const codes = Object.values(draft.slotCodes).filter((c) => c.trim());
      for (const code of codes) if (!/^[A-Z0-9]{1,20}$/.test(code)) out.push({ key: "slotCode", params: { code } });
      return out;
    }
    case "people": {
      const r = applied(["parties"]);
      const missing = draft.people.filter((p) => !p.email.trim());
      if (missing.length) out.push({ key: "emailRequired" });
      const people = draft.people.filter((p) => p.email.trim()).map((p) => ({ email: p.email.trim(), slot: p.slot || null, roles: p.roles }));
      out.push(...texts(checkSetupPeople(people, r.template, lang)));
      return out;
    }
    case "folders": {
      const r = applied(["folders"]);
      out.push(...texts(r.errors));
      if (!r.errors.length) out.push(...texts(checkProjectTemplate(r.template, dimensionOverrides(draft, template), lang)));
      return out;
    }
    case "naming": {
      const r = applied(["naming", "containerStandard"]);
      out.push(...texts(r.errors));
      const standards = new Set((r.template.namingStandards ?? []).map((s) => s.name));
      if (draft.containerStandard && !standards.has(draft.containerStandard)) out.push({ key: "standard", params: { name: draft.containerStandard } });
      return out;
    }
    case "workflows": {
      const r = applied(["parties", "workflows", "transitions"]);
      out.push(...texts(r.errors));
      if (!r.errors.length) out.push(...texts(checkProjectTemplate(r.template, {}, lang)));
      return out;
    }
    case "codes":
    case "rules":
      return out;
    case "summary": {
      const r = applySetupOverrides(template, setup, lang);
      return texts([...r.errors, ...checkProjectTemplate(r.template, dimensionOverrides(draft, template), lang)]);
    }
    default:
      return out;
  }
}

/** The first step with a problem before `upTo` (to send the user back from the summary). */
export function firstBlockedStep(draft: SetupDraft, template: ProjectTemplate | null, lang: string, upTo: number = SETUP_STEPS.length - 1): number | null {
  for (let i = 0; i < upTo; i++) if (stepProblems(SETUP_STEPS[i]!, draft, template, lang).length) return i;
  return null;
}
