/**
 * Changes a project's built-in work type from outside the work type editor: project templates
 * (template format v2, docs/features/PROJECT_TEMPLATES.md) set the transmittal numbering (core) and,
 * through the SDK, Manage sets its RFI, submittal and meeting types.
 */
import { and, eq } from "drizzle-orm";
import { checkNumberingPattern, type WorkTypeSettings } from "@sitekeep/shared";
import type { Db } from "../db/index.js";
import { workTypes } from "../db/schema.js";
import { DEFAULT_LANGUAGE } from "../i18n/index.js";
import { ensureBuiltInTypes } from "./work-core.js";

export interface WorkTypePatch {
  name?: string;
  /** Checked against the type's fields; refused (reported) when invalid. */
  numberingPattern?: string;
  /** New choices of list fields, by field key ("disiplin": ["A - Architect", …]); unknown keys are reported. */
  fieldOptions?: Record<string, string[]>;
  /** Merged into the type's settings (dueDays …). */
  settings?: Partial<WorkTypeSettings>;
  /** Workflow template of the project started for new works of the type. */
  defaultWorkflowTemplateId?: string | null;
}

export interface WorkTypePatchResult {
  /** False when the project has no type with that key. */
  found: boolean;
  /** Something was written. */
  changed: boolean;
  /** What was not applied, in `lang`. */
  problems: string[];
}

/** Applies `patch` to the project's work type `key` (built-in types are seeded first). */
export async function patchWorkType(
  db: Db,
  projectId: string,
  key: string,
  patch: WorkTypePatch,
  lang: string = DEFAULT_LANGUAGE,
): Promise<WorkTypePatchResult> {
  await ensureBuiltInTypes(db, projectId);
  const [type] = await db.select().from(workTypes).where(and(eq(workTypes.projectId, projectId), eq(workTypes.key, key)));
  if (!type) return { found: false, changed: false, problems: [] };
  const problems: string[] = [];
  const set: Partial<typeof workTypes.$inferInsert> = {};
  if (patch.name?.trim()) set.name = patch.name.trim();
  let fields = type.fields;
  for (const [fieldKey, options] of Object.entries(patch.fieldOptions ?? {})) {
    const field = fields.find((f) => f.key === fieldKey && f.type === "list");
    if (!field) {
      problems.push(fieldKey);
      continue;
    }
    fields = fields.map((f) => (f === field ? { ...f, options: [...new Set(options.map((o) => o.trim()).filter(Boolean))] } : f));
  }
  if (fields !== type.fields) set.fields = fields;
  if (patch.numberingPattern) {
    const errors = checkNumberingPattern(patch.numberingPattern, fields, lang);
    if (errors.length) problems.push(`${patch.numberingPattern}: ${errors.join(" ")}`);
    else set.numberingPattern = patch.numberingPattern;
  }
  if (patch.settings) set.settings = { ...type.settings, ...patch.settings };
  if (patch.defaultWorkflowTemplateId !== undefined) set.defaultWorkflowTemplateId = patch.defaultWorkflowTemplateId;
  if (!Object.keys(set).length) return { found: true, changed: false, problems };
  await db.update(workTypes).set({ ...set, updatedAt: new Date() }).where(eq(workTypes.id, type.id));
  return { found: true, changed: true, problems };
}
