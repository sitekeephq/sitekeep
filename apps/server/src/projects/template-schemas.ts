import { z } from "zod";
import {
  ATTRIBUTE_TYPES,
  OUTCOME_CODES,
  PARTIES,
  PERMISSION_LEVELS,
  PROJECT_MODULES,
  WORKFLOW_KINDS,
  WORKFLOW_ROLES,
  type ProjectTemplate,
  type TemplateFolder,
} from "@sitekeep/shared";
import { chainBaseShape, chainStepFields } from "../workflow/chain-template.js";

const FOLDER_STATES = ["wip", "shared", "published", "archived"] as const;
const name200 = z.string().min(1).max(200);
const grantSchema = z.object({ slot: z.string().trim().min(1).max(64), level: z.enum(PERMISSION_LEVELS) });
const settingsShape = {
  naming: z.string().trim().min(1).max(200).optional(),
  attributes: z.array(z.string().trim().min(1).max(100)).max(200).optional(),
  grants: z.array(grantSchema).max(100).optional(),
  gate: z.boolean().optional(),
};
const skeletonSchema = z.object({
  order: z.array(z.string().trim().min(1).max(100)).min(1).max(12),
  onDemand: z.string().trim().min(1).max(100).optional(),
});
const folderSchema: z.ZodType<TemplateFolder> = z.lazy(() =>
  z.object({
    name: name200,
    state: z.enum(FOLDER_STATES).optional(),
    stateLabel: z.string().trim().min(1).max(80).optional(),
    ...settingsShape,
    lazy: z.boolean().optional(),
    children: z.array(z.union([name200, folderSchema])).max(5000).optional(),
    skeleton: skeletonSchema.optional(),
  }),
);
const dimensionValueSchema = z.union([
  name200,
  z.object({ name: name200, insert: z.array(z.string().trim().min(1).max(100)).max(12).optional(), stop: z.boolean().optional() }),
]);

/**
 * Naming standards are kept loose (unknown properties pass through) so that new optional field
 * properties (variable digits, fields outside the name …) survive templates unchanged.
 */
const namingValueSchema = z.looseObject({ code: z.string().trim().min(1).max(100), description: z.string().max(500).optional() });
const namingFieldSchema = z
  .looseObject({
    name: z.string().trim().min(1).max(100),
    type: z.enum(["list", "text", "number"]),
    values: z.array(namingValueSchema).max(5000).optional(),
    minLength: z.number().int().min(0).optional(),
    maxLength: z.number().int().min(1).optional(),
    digits: z.number().int().min(1).max(12).optional(),
  })
  .superRefine((f, ctx) => {
    if (f.type === "list" && !f.values) ctx.addIssue({ code: "custom", message: `"${f.name}": liste alanı için values gerekli.` }); // i18n-ok: zod issue detail, fixed at schema build time (later wave)
  });
export const namingStandardSchema = z.looseObject({
  name: z.string().trim().min(1).max(200),
  delimiter: z.string().length(1),
  fields: z.array(namingFieldSchema).min(1).max(30),
  allowSuffix: z.boolean().optional(),
});

const attributeSchema = z.object({
  name: z.string().trim().min(1).max(100),
  type: z.enum(ATTRIBUTE_TYPES),
  options: z.array(z.string().trim().min(1).max(200)).max(500).optional(),
  required: z.boolean().optional(),
});
const assigneeSchema = z.union([
  z.object({ slot: z.string().trim().min(1).max(64) }),
  z.object({ role: z.enum(WORKFLOW_ROLES) }),
]);
const outcome = z.enum(OUTCOME_CODES);
const workflowSchema = z.object({
  name: z.string().trim().min(1).max(200),
  kind: z.enum(WORKFLOW_KINDS).optional(),
  steps: z
    .array(
      z
        .object({
          name: z.string().trim().min(1).max(120),
          assignees: z.array(assigneeSchema).max(50),
          rule: z.enum(["any", "all"]),
          days: z.number().int().min(0).max(365),
          outcomes: z.array(outcome).max(OUTCOME_CODES.length).default([]),
          ...chainStepFields(assigneeSchema),
        })
        .refine((s) => s.assignees.length > 0 || !!s.assigneeRule, { message: "Adımda en az bir atanan gerekli." }) // i18n-ok: zod issue detail, fixed at schema build time (later wave)
        .refine((s) => s.outcomes.length > 0 || !!s.outcomeOptions?.length, { message: "Adımda en az bir sonuç kodu gerekli." }), // i18n-ok: zod issue detail, fixed at schema build time (later wave)
    )
    .min(1)
    .max(20),
  finalOutcomes: z.partialRecord(outcome, outcome).optional(),
  chain: z
    .object({
      ...chainBaseShape,
      copyTarget: z
        .object({
          folder: z.string().trim().max(2000).nullable().default(null),
          pattern: z.string().trim().max(300).default(""),
          onUnresolved: z.enum(["fail", "base"]).optional(),
        })
        .nullable()
        .optional(),
    })
    .optional(),
});
const slotSchema = z.object({
  key: z.string().trim().min(1).max(64),
  label: z.string().trim().min(1).max(100),
  party: z.enum(PARTIES).optional(),
  code: z.string().trim().min(1).max(20).optional(),
  description: z.string().max(500).optional(),
});

/** Unknown top-level keys are ignored (stripped). */
export const projectTemplateSchema = z.object({
  format: z.string().max(100).optional(),
  name: z.string().trim().min(1).max(200),
  description: z.string().max(4000).optional(),
  slots: z.array(slotSchema).max(30).default([]),
  dimensions: z.record(z.string().trim().min(1).max(100), z.array(dimensionValueSchema).max(2000)).optional(),
  root: z.object(settingsShape).optional(),
  folders: z.array(z.union([name200, folderSchema])).max(1000),
  namingStandards: z.array(namingStandardSchema).max(20).optional(),
  attributes: z.array(attributeSchema).max(200).optional(),
  workflows: z.array(workflowSchema).max(100).optional(),
  issueTypes: z.array(z.unknown()).max(200).optional(),
  notes: z.array(z.string().max(1000)).max(50).optional(),
  modules: z.partialRecord(z.enum(PROJECT_MODULES), z.boolean()).optional(),
});

export function parseProjectTemplate(input: unknown): ProjectTemplate {
  return projectTemplateSchema.parse(input) as ProjectTemplate;
}

const slotMapSchema = z.record(z.string().max(64), z.string().uuid().nullable()).default({});
const slotCodeSchema = z.record(z.string().max(64), z.string().trim().max(20)).default({});
const dimensionOverrideSchema = z.record(z.string().max(100), z.array(z.string().max(200)).max(2000)).default({});

export const previewRequestSchema = z.object({
  code: z.string().trim().max(40).optional(),
  templateId: z.string().max(100).optional(),
  template: z.unknown().optional(),
  slotCompanies: slotMapSchema,
  slotCodes: slotCodeSchema,
  dimensions: dimensionOverrideSchema,
});

export const createRequestSchema = previewRequestSchema.extend({
  code: z.string().trim().min(1).max(40),
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).optional(),
});

export type PreviewRequest = z.infer<typeof previewRequestSchema>;
export type CreateRequest = z.infer<typeof createRequestSchema>;
