/**
 * Project CDE settings and the transition table (docs/features/CDE_STATES.md): read with
 * defaults, replace, and apply a project template's "cde" block.
 */
import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  CDE_CODE_SCHEMES,
  CDE_STATES,
  CDE_TRANSITION_MODES,
  CDE_WIP_POLICIES,
  DEFAULT_CDE_SETTINGS,
  cdeTransitionKey,
  type CdeSettingsDto,
  type CdeSettingsInput,
  type CdeTransitionDto,
  type TemplateCdeSettings,
} from "@sitekeep/shared";
import { z } from "zod";
import type { Db } from "../db/index.js";
import { cdeTransitions, folders, namingStandards, projectCdeSettings, workflowTemplates } from "../db/schema.js";
import { badRequest } from "../core/platform/http.js";
import { msg } from "../i18n/index.js";

type SettingsRow = typeof projectCdeSettings.$inferSelect;
type TransitionRow = typeof cdeTransitions.$inferSelect;

const stateSchema = z.enum(CDE_STATES);
const transitionSchema = z.object({
  fromState: stateSchema.nullable(),
  toState: stateSchema,
  mode: z.enum(CDE_TRANSITION_MODES),
  workflowTemplateId: z.string().uuid().nullable().default(null),
  requireReason: z.boolean().default(false),
});
const suitabilitySchema = z.object({
  code: z.string().trim().min(1).max(20),
  description: z.string().trim().max(200).optional(),
  states: z.array(stateSchema).max(CDE_STATES.length).optional(),
});

/** Body of PUT /projects/:pid/cde/settings: every field optional, unknown fields refused. */
export const cdeSettingsInputSchema = z
  .object({
    enforceTransitions: z.boolean(),
    codeScheme: z.enum(CDE_CODE_SCHEMES),
    suitabilityCodes: z.array(suitabilitySchema).max(100).nullable(),
    revisionRules: z.looseObject({ preliminary: z.string().max(100).optional(), contractual: z.string().max(100).optional() }).nullable(),
    archiveFolderId: z.string().uuid().nullable(),
    containerStandardId: z.string().uuid().nullable(),
    wipPolicy: z.enum(CDE_WIP_POLICIES),
    adminSeesWip: z.boolean(),
    transitions: z.array(transitionSchema).max(40),
  })
  .partial()
  .strict();

/** Template "cde" block (projects/template-schemas.ts). */
export const templateCdeSchema = z.object({
  codeScheme: z.enum(CDE_CODE_SCHEMES).optional(),
  enforceTransitions: z.boolean().optional(),
  wipPolicy: z.enum(CDE_WIP_POLICIES).optional(),
  adminSeesWip: z.boolean().optional(),
  archiveFolder: z.string().trim().min(1).max(2000).optional(),
  transitions: z
    .array(
      z.object({
        from: stateSchema.nullable(),
        to: stateSchema,
        mode: z.enum(CDE_TRANSITION_MODES),
        workflow: z.string().trim().min(1).max(200).optional(),
        requireReason: z.boolean().optional(),
      }),
    )
    .max(40)
    .optional(),
});

function transitionDto(t: TransitionRow): CdeTransitionDto {
  return {
    fromState: t.fromState ?? null,
    toState: t.toState,
    mode: t.mode,
    workflowTemplateId: t.workflowTemplateId ?? null,
    requireReason: t.requireReason,
  };
}

/** Order of the table: direct uploads first, then by from / to state. */
function byStates(a: CdeTransitionDto, b: CdeTransitionDto): number {
  const rank = (s: string | null) => (s === null ? -1 : CDE_STATES.indexOf(s as (typeof CDE_STATES)[number]));
  return rank(a.fromState) - rank(b.fromState) || rank(a.toState) - rank(b.toState);
}

export async function loadCdeTransitions(db: Db, projectId: string): Promise<CdeTransitionDto[]> {
  const rows = await db.select().from(cdeTransitions).where(eq(cdeTransitions.projectId, projectId));
  return rows.map(transitionDto).sort(byStates);
}

/** The project's CDE settings; the defaults when the project has no row. */
export async function loadCdeSettings(db: Db, projectId: string): Promise<CdeSettingsDto> {
  const [row] = await db.select().from(projectCdeSettings).where(eq(projectCdeSettings.projectId, projectId));
  const transitions = await loadCdeTransitions(db, projectId);
  if (!row) return { projectId, ...DEFAULT_CDE_SETTINGS, transitions, updatedAt: null };
  return toSettingsDto(row, transitions);
}

function toSettingsDto(row: SettingsRow, transitions: CdeTransitionDto[]): CdeSettingsDto {
  return {
    projectId: row.projectId,
    enforceTransitions: row.enforceTransitions,
    codeScheme: row.codeScheme,
    suitabilityCodes: row.suitabilityCodes ?? null,
    revisionRules: row.revisionRules ?? null,
    archiveFolderId: row.archiveFolderId ?? null,
    containerStandardId: row.containerStandardId ?? null,
    wipPolicy: row.wipPolicy,
    adminSeesWip: row.adminSeesWip,
    transitions,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Checks references (folder, naming standard, workflow templates belong to the project) and the
 * transition table (no duplicate pair, nothing into the same state, nothing out of an upload
 * other than a real state). Throws 400 with the first problem.
 */
async function validateInput(db: Db, projectId: string, input: CdeSettingsInput): Promise<void> {
  if (input.archiveFolderId) {
    const [f] = await db
      .select({ id: folders.id })
      .from(folders)
      .where(and(eq(folders.id, input.archiveFolderId), eq(folders.projectId, projectId), isNull(folders.deletedAt)));
    if (!f) throw badRequest(msg("cde:errors.archiveFolderUnknown"));
  }
  if (input.containerStandardId) {
    const [n] = await db
      .select({ id: namingStandards.id })
      .from(namingStandards)
      .where(and(eq(namingStandards.id, input.containerStandardId), eq(namingStandards.projectId, projectId)));
    if (!n) throw badRequest(msg("cde:errors.namingStandardUnknown"));
  }
  if (input.transitions) {
    const seen = new Set<string>();
    for (const t of input.transitions) {
      const key = cdeTransitionKey(t.fromState, t.toState);
      if (seen.has(key)) throw badRequest(msg("cde:errors.duplicateTransition", { transition: key }));
      seen.add(key);
      if (t.fromState === t.toState) throw badRequest(msg("cde:errors.sameState", { transition: key }));
      if (t.workflowTemplateId && t.mode !== "review") throw badRequest(msg("cde:errors.workflowOnlyForReview", { transition: key }));
    }
    const ids = [...new Set(input.transitions.map((t) => t.workflowTemplateId).filter((id): id is string => !!id))];
    if (ids.length) {
      const found = await db
        .select({ id: workflowTemplates.id })
        .from(workflowTemplates)
        .where(and(eq(workflowTemplates.projectId, projectId), inArray(workflowTemplates.id, ids)));
      if (found.length !== ids.length) throw badRequest(msg("cde:errors.workflowUnknown"));
    }
  }
}

/** Writes the given fields (others keep their value) and, when given, replaces the transition table. */
export async function saveCdeSettings(db: Db, projectId: string, input: CdeSettingsInput): Promise<CdeSettingsDto> {
  await validateInput(db, projectId, input);
  const { transitions, ...fields } = input;
  await db.transaction(async (tx) => {
    const values = { ...fields, updatedAt: new Date() };
    await tx
      .insert(projectCdeSettings)
      .values({ projectId, ...values })
      .onConflictDoUpdate({ target: projectCdeSettings.projectId, set: values });
    if (transitions) {
      await tx.delete(cdeTransitions).where(eq(cdeTransitions.projectId, projectId));
      if (transitions.length)
        await tx.insert(cdeTransitions).values(
          transitions.map((t) => ({
            projectId,
            fromState: t.fromState,
            toState: t.toState,
            mode: t.mode,
            workflowTemplateId: t.workflowTemplateId ?? null,
            requireReason: t.requireReason ?? false,
          })),
        );
    }
  });
  return loadCdeSettings(db, projectId);
}

/** A settings row with the defaults for a new project (enforcement off, D-8). */
export async function ensureCdeSettings(db: Db, projectId: string): Promise<void> {
  await db.insert(projectCdeSettings).values({ projectId }).onConflictDoNothing();
}

/**
 * Applies a template's "cde" block to a new project. Workflows are resolved by name (`workflowIds`,
 * name → id of the project's workflow template) and the archive folder by path (`folderIds`).
 * Unknown names are dropped (the template check reports them before creation).
 */
export async function applyTemplateCde(
  db: Db,
  projectId: string,
  cde: TemplateCdeSettings | undefined,
  workflowIds: ReadonlyMap<string, string>,
  folderIds: ReadonlyMap<string, string>,
): Promise<void> {
  if (!cde) {
    await ensureCdeSettings(db, projectId);
    return;
  }
  const input: CdeSettingsInput = {};
  if (cde.codeScheme) input.codeScheme = cde.codeScheme;
  if (cde.enforceTransitions !== undefined) input.enforceTransitions = cde.enforceTransitions;
  if (cde.wipPolicy) input.wipPolicy = cde.wipPolicy;
  if (cde.adminSeesWip !== undefined) input.adminSeesWip = cde.adminSeesWip;
  if (cde.archiveFolder) input.archiveFolderId = folderIds.get(cde.archiveFolder.replace(/^\/+|\/+$/g, "")) ?? null;
  if (cde.transitions) {
    // The template check refuses duplicates; anything still invalid is dropped, not fatal.
    const seen = new Set<string>();
    input.transitions = cde.transitions
      .filter((t) => {
        const key = cdeTransitionKey(t.from, t.to);
        if (t.from === t.to || seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map((t) => ({
        fromState: t.from,
        toState: t.to,
        mode: t.mode,
        workflowTemplateId: t.workflow && t.mode === "review" ? (workflowIds.get(t.workflow) ?? null) : null,
        requireReason: !!t.requireReason,
      }));
  }
  await saveCdeSettings(db, projectId, input);
}
