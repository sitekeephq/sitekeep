/**
 * State of the project set-up wizard (docs/features/PROJECT_SETUP_WIZARD.md) and how it becomes a
 * request. The draft holds only the explicit choices; anything left undefined is the template's own
 * value, so changing the template never leaves stale choices behind (they are reset).
 *
 * The draft is kept per user in the browser (localStorage) so a half-done set-up survives a reload.
 */
import {
  PROJECT_SETUP_CODE_SCHEMES,
  type CdeState,
  type CdeWipPolicy,
  type ProjectModule,
  type ProjectSetupOverrides,
  type ProjectSetupRequest,
  type ProjectTemplate,
  type StepRule,
  type TemplateAssignee,
  type TemplateSlot,
  type TemplateTaskTeam,
} from "@sitekeep/shared";

/** Slot company value while a new company is being typed in (never sent). */
export const NEW_COMPANY = "__new__";

export type SetupTemplateChoice = { kind: "builtin"; id: string } | { kind: "file"; fileName: string; json: unknown };

export interface SetupPerson {
  email: string;
  slot: string;
  roles: string[];
  projectAdmin: boolean;
}

export interface SetupStepChoice {
  assignees?: TemplateAssignee[];
  days?: number;
  rule?: StepRule;
}

export interface SetupDraft {
  v: 1;
  step: number;
  /** Project language: picks the template file of a family and its per-language values. */
  language: string;
  template: SetupTemplateChoice | null;
  code: string;
  name: string;
  description: string;
  startDate: string;
  endDate: string;
  location: string;
  client: string;
  slotCompanies: Record<string, string>;
  slotCodes: Record<string, string>;
  parties: TemplateSlot[];
  /** Undefined: the template's task teams (plus the added parties). */
  taskTeams?: TemplateTaskTeam[];
  people: SetupPerson[];
  /** Editable dimensions as text, one value per line. */
  dimensions: Record<string, string>;
  folderAdds: { parent: string; name: string }[];
  folderRemoves: string[];
  containerStandard?: string;
  /** "standard\u0000field" → codes, one per line: "CODE description". */
  naming: Record<string, string>;
  /** "workflow\u0000step index" → the changed step. */
  steps: Record<string, SetupStepChoice>;
  /** Transition key ("wip>shared") → workflow name, or null for any approved review. */
  transitions: Record<string, string | null>;
  codeScheme?: (typeof PROJECT_SETUP_CODE_SCHEMES)[number];
  enforceTransitions?: boolean;
  wipPolicy?: CdeWipPolicy;
  adminSeesWip?: boolean;
  modules: Partial<Record<ProjectModule, boolean>>;
}

export function emptyDraft(language: string): SetupDraft {
  return {
    v: 1,
    step: 0,
    language,
    template: null,
    code: "",
    name: "",
    description: "",
    startDate: "",
    endDate: "",
    location: "",
    client: "",
    slotCompanies: {},
    slotCodes: {},
    parties: [],
    people: [],
    dimensions: {},
    folderAdds: [],
    folderRemoves: [],
    naming: {},
    steps: {},
    transitions: {},
    modules: {},
  };
}

/** The draft after another template was chosen: the template-specific choices are reset. */
export function withTemplate(draft: SetupDraft, template: SetupTemplateChoice | null): SetupDraft {
  const base = emptyDraft(draft.language);
  return {
    ...base,
    step: draft.step,
    template,
    code: draft.code,
    name: draft.name,
    description: draft.description,
    startDate: draft.startDate,
    endDate: draft.endDate,
    location: draft.location,
    client: draft.client,
    people: draft.people.map((p) => ({ ...p, slot: "", roles: [] })),
  };
}

export const namingKey = (standard: string, field: string) => `${standard}\u0000${field}`;
export const stepKey = (workflow: string, step: number) => `${workflow}\u0000${step}`;

/** "B1 Block 1" lines → codes with descriptions. */
export function parseCodeLines(text: string): { code: string; description?: string }[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [code, ...rest] = line.split(/\s+/);
      const description = rest.join(" ").trim();
      return description ? { code: code!, description } : { code: code! };
    });
}

/** Task teams of the template (one per slot when it lists none). */
export function templateTaskTeams(template: ProjectTemplate): TemplateTaskTeam[] {
  return template.cde?.taskTeams ?? template.slots.map((s) => ({ slot: s.key }));
}

/** The wizard's choices as overrides of the template; undefined keys keep the template's values. */
export function toSetup(draft: SetupDraft, template: ProjectTemplate): ProjectSetupOverrides {
  const setup: ProjectSetupOverrides = {};
  if (draft.parties.length) setup.parties = draft.parties;
  if (draft.taskTeams) setup.taskTeams = draft.taskTeams;
  else if (draft.parties.length) setup.taskTeams = [...templateTaskTeams(template), ...draft.parties.map((p) => ({ slot: p.key }))];
  if (draft.folderAdds.length || draft.folderRemoves.length)
    setup.folders = {
      ...(draft.folderAdds.length ? { add: draft.folderAdds } : {}),
      ...(draft.folderRemoves.length ? { remove: draft.folderRemoves } : {}),
    };
  if (draft.containerStandard !== undefined) setup.containerStandard = draft.containerStandard;
  const naming = Object.entries(draft.naming).map(([key, text]) => {
    const [standard, field] = key.split("\u0000");
    return { standard: standard!, field: field!, values: parseCodeLines(text) };
  });
  if (naming.length) setup.naming = naming;
  const steps = Object.entries(draft.steps).map(([key, choice]) => {
    const [workflow, index] = key.split("\u0000");
    return { workflow: workflow!, step: Number(index), ...choice };
  });
  if (steps.length) setup.workflows = steps;
  const transitions = Object.entries(draft.transitions).map(([key, workflow]) => {
    const [from, to] = key.split(">");
    return { from: (from === "upload" ? null : from) as CdeState | null, to: to as CdeState, workflow };
  });
  if (transitions.length) setup.transitions = transitions;
  const cde = {
    ...(draft.codeScheme ? { codeScheme: draft.codeScheme } : {}),
    ...(draft.enforceTransitions !== undefined ? { enforceTransitions: draft.enforceTransitions } : {}),
    ...(draft.wipPolicy ? { wipPolicy: draft.wipPolicy } : {}),
    ...(draft.adminSeesWip !== undefined ? { adminSeesWip: draft.adminSeesWip } : {}),
  };
  if (Object.keys(cde).length) setup.cde = cde;
  if (Object.keys(draft.modules).length) setup.modules = draft.modules;
  return setup;
}

/** Editable dimension values that differ from the template's (as the create request expects). */
export function dimensionOverrides(draft: SetupDraft, template: ProjectTemplate): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [name, text] of Object.entries(draft.dimensions)) {
    const values = text.split("\n").map((v) => v.trim()).filter(Boolean);
    const original = (template.dimensions?.[name] ?? []).map((v) => (typeof v === "string" ? v : v.name));
    if (values.join("\n") !== original.join("\n")) out[name] = values;
  }
  return out;
}

/** The create (or dry-run) request of the draft. */
export function toRequest(draft: SetupDraft, template: ProjectTemplate): ProjectSetupRequest {
  const ref =
    draft.template?.kind === "file" ? { template: draft.template.json as ProjectTemplate } : { templateId: draft.template?.kind === "builtin" ? draft.template.id : "" };
  const details = Object.fromEntries(
    (["startDate", "endDate", "location", "client"] as const).filter((k) => draft[k].trim()).map((k) => [k, draft[k].trim()]),
  );
  const setup = toSetup(draft, template);
  return {
    ...ref,
    code: draft.code.trim(),
    name: draft.name.trim(),
    ...(draft.description.trim() ? { description: draft.description.trim() } : {}),
    language: draft.language,
    slotCompanies: Object.fromEntries(Object.entries(draft.slotCompanies).filter(([, v]) => v && v !== NEW_COMPANY)),
    slotCodes: Object.fromEntries(Object.entries(draft.slotCodes).filter(([, v]) => v.trim())),
    dimensions: dimensionOverrides(draft, template),
    ...(Object.keys(setup).length ? { setup } : {}),
    ...(Object.keys(details).length ? { details } : {}),
    ...(draft.people.length
      ? {
          people: draft.people
            .filter((p) => p.email.trim())
            .map((p) => ({
              email: p.email.trim().toLowerCase(),
              ...(p.slot ? { slot: p.slot } : {}),
              ...(p.roles.length ? { roles: p.roles } : {}),
              ...(p.projectAdmin ? { projectAdmin: true } : {}),
            })),
        }
      : {}),
  };
}

/** A project code proposal from the name: initials or the first letters, upper-case ASCII. */
export function suggestCode(name: string): string {
  const ascii = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ı/g, "i")
    .toUpperCase()
    .replace(/[^A-Z0-9 ]+/g, " ")
    .trim();
  const words = ascii.split(/\s+/).filter(Boolean);
  if (!words.length) return "";
  const code = words.length > 1 ? words.map((w) => w[0]).join("") : words[0]!.slice(0, 6);
  return code.slice(0, 10);
}

// ---- Browser draft --------------------------------------------------------------------------------

const DRAFT_KEY = "sitekeep.projectSetup.draft.v1";
const keyFor = (userId: string) => `${DRAFT_KEY}.${userId}`;

export function loadDraft(userId: string): SetupDraft | null {
  try {
    const raw = window.localStorage.getItem(keyFor(userId));
    if (!raw) return null;
    const draft = JSON.parse(raw) as SetupDraft;
    return draft && draft.v === 1 ? { ...emptyDraft(draft.language || "en"), ...draft } : null;
  } catch {
    return null;
  }
}

export function saveDraft(userId: string, draft: SetupDraft): void {
  try {
    window.localStorage.setItem(keyFor(userId), JSON.stringify(draft));
  } catch {
    // Storage may be full or blocked (private mode); the wizard works without the draft.
  }
}

export function clearDraft(userId: string): void {
  try {
    window.localStorage.removeItem(keyFor(userId));
  } catch {
    // Nothing to clear.
  }
}
