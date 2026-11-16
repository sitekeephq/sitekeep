import { z } from "zod";
import {
  ATTRIBUTE_TYPES,
  CDE_STATES,
  CDE_WIP_POLICIES,
  OUTCOME_CODES,
  PROJECT_SETUP_CODE_SCHEMES,
  PROJECT_SETUP_MAX_EXTRA_PARTIES,
  PROJECT_SETUP_MAX_FOLDER_EDITS,
  PROJECT_SETUP_MAX_PEOPLE,
  INVITATION_LANGUAGES,
  PARTIES,
  PERMISSION_LEVELS,
  PROJECT_MODULES,
  TEMPLATE_ISSUE_FIELD_TYPES,
  TEMPLATE_RFI_PERMISSION_ROLES,
  WORKFLOW_KINDS,
  WORKFLOW_ROLES,
  type ProjectTemplate,
  type TemplateFolder,
} from "@sitekeep/shared";
import { chainBaseShape, chainStepFields } from "../workflow/chain-template.js";
import { templateCdeSchema } from "../cde/settings.js";

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
  z.object({ projectRole: z.string().trim().min(1).max(64) }),
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

// ---- Format v2 parts (template-v2.ts in @sitekeep/shared) ----
const key64 = z.string().trim().min(1).max(64);
const text200 = z.string().trim().min(1).max(200);
const keyList = z.array(key64).max(50);
const codeNameSchema = z.object({ code: z.string().trim().min(1).max(40), name: text200 });
const pattern = z.string().trim().min(1).max(200);
const roleSchema = z.object({
  key: key64,
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(500).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  slot: key64.optional(),
});
const issueSettingsSchema = z.object({
  categories: z
    .array(z.object({ category: text200, types: z.array(text200).max(100) }))
    .max(50),
  customFields: z
    .array(z.object({ name: z.string().trim().min(1).max(100), type: z.enum(TEMPLATE_ISSUE_FIELD_TYPES), options: z.array(text200).max(200).optional() }))
    .max(30)
    .optional(),
});
const transmittalSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  numbering: pattern.optional(),
  attributes: z.array(z.string().trim().min(1).max(100)).max(30).optional(),
});
const rfiSchema = z.object({
  types: z.array(codeNameSchema).max(100).optional(),
  defaultType: z.string().trim().min(1).max(40).optional(),
  categories: z.array(text200).max(50).optional(),
  responseDays: z.number().int().min(0).max(365).optional(),
  numbering: pattern.optional(),
  workflow: text200.optional(),
  permissions: z.partialRecord(z.enum(TEMPLATE_RFI_PERMISSION_ROLES), keyList).optional(),
});
const submittalSchema = z.object({
  itemTypes: z.array(text200).max(100).optional(),
  responses: z.array(z.object({ label: text200, code: outcome })).max(OUTCOME_CODES.length * 2).optional(),
  specSections: z.array(codeNameSchema).max(500).optional(),
  responseDays: z.number().int().min(0).max(365).optional(),
  numbering: pattern.optional(),
  workflow: text200.optional(),
  watchers: keyList.optional(),
});
const meetingSchema = z.object({
  name: text200,
  agenda: z.array(z.string().trim().min(1).max(500)).max(50),
  attendees: keyList.optional(),
  minutesFolder: z.string().trim().min(1).max(2000).optional(),
});
const formSchema = z.object({
  key: z.string().trim().min(1).max(20),
  name: text200,
  category: z.string().trim().min(1).max(100).optional(),
  workflow: text200.optional(),
  sections: z.array(z.object({ name: text200, editor: key64.optional() })).min(1).max(50),
});

/** Unknown top-level keys are ignored (stripped). Per-language values are resolved before (localizeTemplate). */
export const projectTemplateSchema = z.object({
  format: z.string().max(100).optional(),
  name: z.string().trim().min(1).max(200),
  description: z.string().max(4000).optional(),
  language: z.string().trim().min(2).max(10).optional(),
  family: z.string().trim().min(1).max(100).optional(),
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
  cde: templateCdeSchema.optional(),
  deliveryPlan: z
    .object({
      milestones: z
        .array(z.object({ code: z.string().trim().max(20).optional(), name: z.string().trim().min(1).max(200), offsetDays: z.number().int().min(-3650).max(36500).optional() }))
        .max(100),
    })
    .optional(),
  roles: z.array(roleSchema).max(200).optional(),
  issues: issueSettingsSchema.optional(),
  transmittal: transmittalSchema.optional(),
  rfi: rfiSchema.optional(),
  submittals: submittalSchema.optional(),
  meetings: z.array(meetingSchema).max(50).optional(),
  forms: z.array(formSchema).max(100).optional(),
});

export function parseProjectTemplate(input: unknown): ProjectTemplate {
  return projectTemplateSchema.parse(input) as ProjectTemplate;
}

const slotMapSchema = z.record(z.string().max(64), z.string().uuid().nullable()).default({});
const slotCodeSchema = z.record(z.string().max(64), z.string().trim().max(20)).default({});
const dimensionOverrideSchema = z.record(z.string().max(100), z.array(z.string().max(200)).max(2000)).default({});

/**
 * The set-up wizard's choices (ProjectSetupOverrides in @sitekeep/shared). Structure only: the
 * references are checked by applySetupOverrides and checkProjectTemplate on the resulting template.
 */
const setupSchema = z.object({
  parties: z.array(slotSchema).max(PROJECT_SETUP_MAX_EXTRA_PARTIES).optional(),
  taskTeams: z.array(z.object({ slot: key64, lead: z.boolean().optional() })).max(30).optional(),
  folders: z
    .object({
      add: z.array(z.object({ parent: z.string().trim().min(1).max(2000), name: z.string().max(200) })).max(PROJECT_SETUP_MAX_FOLDER_EDITS).optional(),
      remove: z.array(z.string().trim().min(1).max(2000)).max(PROJECT_SETUP_MAX_FOLDER_EDITS).optional(),
    })
    .optional(),
  containerStandard: z.string().trim().min(1).max(200).optional(),
  naming: z
    .array(
      z.object({
        standard: z.string().trim().min(1).max(200),
        field: z.string().trim().min(1).max(100),
        values: z.array(z.object({ code: z.string().max(100), description: z.string().max(500).optional() })).max(5000),
      }),
    )
    .max(50)
    .optional(),
  workflows: z
    .array(
      z.object({
        workflow: z.string().trim().min(1).max(200),
        step: z.number().int().min(0).max(19),
        assignees: z.array(assigneeSchema).max(50).optional(),
        days: z.number().int().optional(),
        rule: z.enum(["any", "all"]).optional(),
      }),
    )
    .max(500)
    .optional(),
  transitions: z
    .array(z.object({ from: z.enum(CDE_STATES).nullable(), to: z.enum(CDE_STATES), workflow: z.string().trim().min(1).max(200).nullable() }))
    .max(40)
    .optional(),
  cde: z
    .object({
      codeScheme: z.enum(PROJECT_SETUP_CODE_SCHEMES).optional(),
      enforceTransitions: z.boolean().optional(),
      wipPolicy: z.enum(CDE_WIP_POLICIES).optional(),
      adminSeesWip: z.boolean().optional(),
    })
    .optional(),
  modules: z.partialRecord(z.enum(PROJECT_MODULES), z.boolean()).optional(),
});

const detailsSchema = z.object({
  startDate: z.string().trim().max(10).optional(),
  endDate: z.string().trim().max(10).optional(),
  location: z.string().trim().max(200).optional(),
  client: z.string().trim().max(200).optional(),
});

const personSchema = z.object({
  email: z.string().trim().toLowerCase().max(320),
  name: z.string().trim().max(200).optional(),
  slot: key64.nullable().optional(),
  roles: z.array(key64).max(50).optional(),
  projectAdmin: z.boolean().optional(),
});

export const previewRequestSchema = z.object({
  code: z.string().trim().max(40).optional(),
  templateId: z.string().max(100).optional(),
  template: z.unknown().optional(),
  slotCompanies: slotMapSchema,
  slotCodes: slotCodeSchema,
  dimensions: dimensionOverrideSchema,
  /** Project language: picks the template's per-language values (default: the requester's language). */
  language: z.string().trim().min(2).max(10).optional(),
  /** The set-up wizard's choices, applied to the template before it is checked. */
  setup: setupSchema.optional(),
  /** Project details and people of the set-up wizard (checked by the dry run, applied by create). */
  details: detailsSchema.optional(),
  people: z.array(personSchema).max(PROJECT_SETUP_MAX_PEOPLE).optional(),
  /** People without an account are invited (docs/features/INVITATIONS.md) instead of only reported. */
  invite: z.object({ language: z.enum(INVITATION_LANGUAGES).optional() }).optional(),
});

export const createRequestSchema = previewRequestSchema.extend({
  code: z.string().trim().min(1).max(40),
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).optional(),
});

export type PreviewRequest = z.infer<typeof previewRequestSchema>;
export type CreateRequest = z.infer<typeof createRequestSchema>;
