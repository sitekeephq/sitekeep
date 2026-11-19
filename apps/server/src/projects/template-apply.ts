import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import {
  applySetupOverrides,
  checkAttributeDefinition,
  checkSetupDetails,
  checkSetupPeople,
  checkProjectTemplate,
  checkStandard,
  countTemplate,
  dimensionDtos,
  expandGrants,
  expandProjectTemplate,
  isGroupAddress,
  previewTree,
  rank,
  resolveModules,
  resolveNamingTokens,
  sharedText,
  templateDimensions,
  type AttributeDefinition,
  type ExpandedFolder,
  type FinalOutcomeMap,
  type NamingStandard,
  type PermissionLevel,
  type ProjectSetupPersonReportDto,
  type ProjectSetupPreviewDto,
  type ProjectTemplate,
  type ReviewChainConfig,
  type TemplateAssignee,
  type TemplateCounts,
  type TemplateGrant,
  type TemplatePreviewDto,
  type TemplateRootSettings,
  type TemplateSlot,
  type VirtualFolderSpec,
  type WorkflowAssignee,
  type WorkflowKind,
  type WorkflowStep,
} from "@sitekeep/shared";
import { audit, type AuditEvent } from "../core/platform/audit.js";
import { ensureDefaultProjectRoles, ensureProjectAdminsHoldAdminRole } from "../core/security/default-roles.js";
import { badRequest, conflict } from "../core/platform/http.js";
import { DEFAULT_LANGUAGE, msg, tFor } from "../i18n/index.js";
import type { AuthUser } from "../core/security/access.js";
import { deliverInvitation, ensurePendingUser, invitationLanguage, invitedName, issueInvitation } from "../auth/invitations.js";
import type { LetterMailer } from "../works/letter.js";
import type { Db } from "../db/index.js";
import {
  attributeDefinitions,
  companies,
  folderAttributeBindings,
  folderGrants,
  folderSettings,
  folderVirtualChildren,
  folders,
  memberRoles,
  namingStandards,
  projectMembers,
  projectSlots,
  projectTemplateOrigins,
  projects,
  users,
  workflowTemplates,
} from "../db/schema.js";
import { normaliseChainTemplate, withRuleAssignees } from "../workflow/chain-template.js";
import { checkTemplate as checkWorkflowSteps } from "../workflow/engine.js";
import { syncProjectCompanies } from "./companies.js";
import { templateFromRequest } from "./template-built-ins.js";
import { parseProjectTemplate } from "./template-schemas.js";
import { applyTemplateCde } from "../cde/settings.js";
import { assignWipOwnerTeams, ensureCompanyTeams, type TeamSeedCompany } from "../cde/teams.js";
import { applyTemplateDeliveryPlan } from "../cde/delivery-plan.js";
import { applyTemplateParts, insertTemplateRoles, templatePartAvailabilityOf } from "./template-parts.js";
import {
  createRequestSchema,
  previewRequestSchema,
  type CreateRequest,
  type PreviewRequest,
} from "./template-schemas.js";

interface SlotResolution {
  slot: TemplateSlot;
  companyId: string | null;
  companyName: string | null;
  code: string | null;
}

interface Prepared {
  template: ProjectTemplate;
  errors: string[];
  warnings: string[];
  folders: ExpandedFolder[];
  counts: TemplateCounts;
  slots: Map<string, SlotResolution>;
  mappedSlots: string[];
  naming: NamingStandard[];
  attributes: { name: string; type: AttributeDefinition["type"]; options: string[]; required: boolean }[];
  /** Ids of the template's project roles (`roles[].key`), chosen before creation. */
  roleIds: Map<string, string>;
  workflows: {
    name: string;
    kind: WorkflowKind;
    steps: WorkflowStep[];
    finalOutcomes: FinalOutcomeMap;
    chain: ReviewChainConfig;
    copyFolder: string | null;
  }[];
  dimensions: Record<string, string[]>;
}

function splitPath(p: string): string[] {
  return p.split("/").map((n) => n.trim()).filter(Boolean);
}

function findExpanded(list: ExpandedFolder[], names: string[]): ExpandedFolder[] | null {
  const chain: ExpandedFolder[] = [];
  let level = list;
  for (const n of names) {
    const folder = level.find((x) => x.name === n);
    if (!folder) return null;
    chain.push(folder);
    level = folder.children;
  }
  return chain.length ? chain : null;
}

/**
 * The template of a request with the set-up wizard's choices applied (`setup`), and the problems of
 * the choices, the project details and the people. The result is parsed again, so a wizard project
 * goes through exactly the checks of a template project.
 */
function requestTemplate(req: PreviewRequest, language: string, lang: string): { template: ProjectTemplate; templateId: string | null; errors: string[] } {
  const { template: base, templateId } = templateFromRequest(req, language);
  const applied = req.setup ? applySetupOverrides(base, req.setup, lang) : { template: base, errors: [] };
  const template = req.setup ? parseProjectTemplate(applied.template) : base;
  const errors = [...applied.errors, ...checkSetupDetails(req.details, lang), ...checkSetupPeople(req.people, template, lang)];
  return { template, templateId, errors };
}

async function prepare(db: Db, template: ProjectTemplate, req: PreviewRequest, projectCode: string, lang: string, setupErrors: string[] = []): Promise<Prepared> {
  const t = tFor(lang);
  const errors = [...setupErrors, ...checkProjectTemplate(template, req.dimensions, lang)];
  const warnings: string[] = [];
  const slotKeys = new Set(template.slots.map((s) => s.key));
  for (const key of Object.keys(req.slotCompanies)) if (!slotKeys.has(key)) errors.push(t("projects:errors.roleNotInTemplate", { key }));
  for (const key of Object.keys(req.slotCodes)) if (!slotKeys.has(key)) errors.push(t("projects:errors.roleNotInTemplate", { key }));

  const companyIds = [...new Set(Object.values(req.slotCompanies).filter((x): x is string => !!x))];
  const companyRows = companyIds.length ? await db.select().from(companies).where(inArray(companies.id, companyIds)) : [];
  const companyById = new Map(companyRows.map((company) => [company.id, company]));
  for (const id of companyIds) if (!companyById.has(id)) errors.push(t("projects:errors.companyNotFound"));

  const slots = new Map<string, SlotResolution>();
  for (const slot of template.slots) {
    const companyId = req.slotCompanies[slot.key] ?? null;
    const company = companyId ? companyById.get(companyId) : undefined;
    const code = req.slotCodes[slot.key]?.trim() || company?.code || slot.code || null;
    slots.set(slot.key, { slot, companyId, companyName: company?.name ?? null, code });
  }
  const mappedSlots = [...slots.values()].filter((slot) => slot.companyId).map((slot) => slot.slot.key);
  const emptySlots = template.slots.filter((slot) => !slots.get(slot.key)!.companyId);
  if (emptySlots.length) {
    warnings.push(
      t("projects:warnings.rolesWithoutCompany", { roles: emptySlots.map((slot) => slot.label).join(", ") }),
    );
  }

  const tokenCtx = {
    projectCode,
    csbProjectCode: req.details?.csbProjectCode?.trim() || undefined,
    slotCodes: Object.fromEntries([...slots].map(([key, slot]) => [key, slot.code ?? undefined])),
    slotNames: Object.fromEntries([...slots].map(([key, slot]) => [key, slot.companyName ?? slot.slot.label])),
  };
  const naming = (template.namingStandards ?? []).map((standard) => {
    const resolved = resolveNamingTokens(standard, tokenCtx);
    for (const problem of checkStandard(resolved, lang)) errors.push(`${standard.name}: ${problem}`);
    return resolved;
  });
  const attributes = (template.attributes ?? []).map((attribute) => {
    const definition = {
      name: attribute.name,
      type: attribute.type,
      options: attribute.type === "list" ? (attribute.options ?? []).map((option) => option.trim()) : [],
      required: attribute.required ?? false,
    };
    for (const problem of checkAttributeDefinition(definition, lang)) errors.push(`${attribute.name}: ${problem}`);
    return definition;
  });

  const expanded = expandProjectTemplate(template, req.dimensions, lang);
  const roleIds = new Map((template.roles ?? []).map((role) => [role.key, randomUUID()]));
  const toAssignees = (list: readonly TemplateAssignee[]): WorkflowAssignee[] => {
    const out: WorkflowAssignee[] = [];
    for (const assignee of list) {
      const companyId = "slot" in assignee ? slots.get(assignee.slot)?.companyId : null;
      const projectRoleId = "projectRole" in assignee ? roleIds.get(assignee.projectRole) : undefined;
      const resolved: WorkflowAssignee | null =
        "role" in assignee
          ? { type: "role", id: assignee.role }
          : projectRoleId
            ? { type: "role", id: projectRoleId }
            : companyId
              ? { type: "company", id: companyId }
              : null;
      if (resolved && !out.some((item) => item.type === resolved.type && item.id === resolved.id)) out.push(resolved);
    }
    return out;
  };

  const workflows: Prepared["workflows"] = [];
  for (const workflow of template.workflows ?? []) {
    const steps: WorkflowStep[] = workflow.steps.map((source) => {
      const assignees = toAssignees(source.assignees);
      const step: WorkflowStep = {
        name: source.name,
        assignees,
        rule: source.rule,
        days: source.days,
        outcomes: source.outcomes,
      };
      if (source.outcomeOptions?.length) step.outcomeOptions = source.outcomeOptions;
      if (source.stage !== undefined) step.stage = source.stage;
      if (source.requiredAttributes?.length) step.requiredAttributes = source.requiredAttributes;
      if (source.assigneeRule) {
        const map: Record<string, WorkflowAssignee[]> = {};
        for (const [value, list] of Object.entries(source.assigneeRule.map)) {
          const resolved = toAssignees(list);
          if (resolved.length) map[value] = resolved;
        }
        const fallback = toAssignees(source.assigneeRule.fallback ?? []);
        if (Object.keys(map).length || fallback.length) {
          step.assigneeRule = {
            type: "by_attribute",
            attribute: source.assigneeRule.attribute,
            map,
            ...(fallback.length ? { fallback } : {}),
          };
        } else {
          warnings.push(t("projects:warnings.attributeRuleWithoutCompany", { workflow: workflow.name, step: source.name }));
        }
      }
      if (!assignees.length && !step.assigneeRule) {
        assignees.push({ type: "role", id: "project_admin" });
        warnings.push(t("projects:warnings.stepWithoutCompany", { workflow: workflow.name, step: source.name }));
      }
      return step;
    });
    const rawChain = workflow.chain ?? {};
    const copyTarget = rawChain.copyTarget;
    const normalized = await normaliseChainTemplate(db, "", steps, {
      ...rawChain,
      copyTarget: copyTarget
        ? {
            folderId: null,
            pattern: copyTarget.pattern,
            ...(copyTarget.onUnresolved ? { onUnresolved: copyTarget.onUnresolved } : {}),
          }
        : null,
    });
    for (const problem of [...normalized.problems, ...checkWorkflowSteps(normalized.steps.map(withRuleAssignees))]) {
      errors.push(`${workflow.name}: ${problem}`);
    }
    let copyFolder: string | null = null;
    if (copyTarget?.folder) {
      const names = splitPath(copyTarget.folder);
      const along = findExpanded(expanded.folders, names);
      if (!along) {
        warnings.push(t("projects:warnings.copyFolderMissing", { workflow: workflow.name, folder: copyTarget.folder }));
      } else {
        for (const folder of along) folder.virtual = false;
        copyFolder = names.join("/");
        normalized.chain.copyTarget = {
          folderId: null,
          pattern: copyTarget.pattern,
          ...(copyTarget.onUnresolved ? { onUnresolved: copyTarget.onUnresolved } : {}),
        };
      }
    }
    workflows.push({
      name: workflow.name,
      kind: workflow.kind ?? "review",
      steps: normalized.steps,
      finalOutcomes: workflow.finalOutcomes ?? {},
      chain: normalized.chain,
      copyFolder,
    });
  }

  const { dimensions } = templateDimensions(template, req.dimensions);
  const counts = countTemplate(template, expanded.folders, mappedSlots);
  return {
    template,
    errors: [...new Set(errors)],
    warnings: [...new Set(warnings)],
    folders: expanded.folders,
    counts,
    slots,
    mappedSlots,
    naming,
    attributes,
    roleIds,
    workflows,
    dimensions: Object.fromEntries(
      Object.entries(dimensions).map(([key, values]) => [key, values.map((value) => (typeof value === "string" ? value : value.name))]),
    ),
  };
}

/**
 * `lang`: the requester's language, for the errors and warnings of the preview. The template's
 * per-language values are read in the project language (`language` of the request, else `lang`).
 */
export async function previewProjectTemplate(db: Db, body: unknown, lang: string = DEFAULT_LANGUAGE): Promise<TemplatePreviewDto> {
  const req = previewRequestSchema.parse(body);
  const { template, errors } = requestTemplate(req, req.language ?? lang, lang);
  const prepared = await prepare(db, template, req, req.code || "PROJE", lang, errors);
  const { dimensions } = templateDimensions(template, req.dimensions);
  return {
    ok: prepared.errors.length === 0,
    errors: prepared.errors,
    warnings: prepared.warnings,
    name: template.name,
    description: template.description ?? "",
    slots: template.slots,
    dimensions: dimensionDtos(dimensions),
    counts: prepared.counts,
    tree: previewTree(prepared.folders),
    parts: templatePartAvailabilityOf(template),
  };
}

type SetupPersonInput = NonNullable<PreviewRequest["people"]>[number];

/**
 * People of the wizard by e-mail: existing users are added; with `invite` on the request, people
 * without an account (or invited earlier and not yet accepted) are invited; otherwise they are reported.
 */
async function resolvePeople(db: Db, req: Pick<PreviewRequest, "people" | "invite">, lang: string) {
  const list = req.people ?? [];
  const emails = [...new Set(list.map((p) => p.email))];
  const rows = emails.length ? await db.select().from(users).where(inArray(users.email, emails)) : [];
  const byEmail = new Map(rows.map((u) => [u.email, u]));
  const report: ProjectSetupPersonReportDto[] = [];
  const warnings: string[] = [];
  const add: { person: SetupPersonInput; userId: string; companyId: string | null }[] = [];
  const invite: SetupPersonInput[] = [];
  for (const person of list) {
    const user = byEmail.get(person.email);
    if (isGroupAddress(person.email)) {
      report.push({ email: person.email, status: "group_address" });
      warnings.push(sharedText(lang, "setup.groupAddress", { email: person.email }));
    } else if (user && !user.disabled) {
      report.push({ email: person.email, status: "added", userId: user.id, name: user.name });
      add.push({ person, userId: user.id, companyId: user.companyId });
    } else if (req.invite && (!user || user.pending)) {
      report.push({ email: person.email, status: "invite", ...(user ? { userId: user.id, name: user.name } : person.name ? { name: person.name } : {}) });
      invite.push(person);
    } else {
      report.push({ email: person.email, status: "no_account" });
      warnings.push(sharedText(lang, "setup.noAccount", { email: person.email }));
    }
  }
  return { report, warnings, add, invite };
}

/**
 * The set-up wizard's dry run: the template preview with the wizard's choices, plus what only the
 * server knows (the project code is free, the accounts of the people). Nothing is written.
 */
export async function dryRunProjectSetup(db: Db, body: unknown, lang: string = DEFAULT_LANGUAGE): Promise<ProjectSetupPreviewDto> {
  const req = previewRequestSchema.parse(body);
  const preview = await previewProjectTemplate(db, req, lang);
  const errors = [...preview.errors];
  if (req.code) {
    const [taken] = await db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.code, req.code), eq(projects.archived, false)));
    if (taken) errors.push(sharedText(lang, "setup.codeTaken", { code: req.code }));
  }
  const people = await resolvePeople(db, req, lang);
  return {
    ...preview,
    ok: errors.length === 0,
    errors,
    warnings: [...new Set([...preview.warnings, ...people.warnings])],
    people: people.report,
  };
}

function chunks<T>(list: T[], size = 500): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/** Codes are unique among active projects only; a deleted (archived) project does not hold its code. */
export async function assertProjectCodeFree(db: Db, code: string, selfId?: string) {
  const [taken] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.code, code), eq(projects.archived, false)));
  if (taken && taken.id !== selfId) throw conflict(msg("projects:errors.codeTaken", { code }));
}

/**
 * Creates a project from a template. `lang`: the requester's language (errors, warnings, part notes);
 * the project language (`language` of the request, else `lang`) picks the template's per-language values.
 * The v2 parts are applied after the project exists; `parts` reports each one (applied, skipped …).
 */
export async function createProjectFromTemplate(
  db: Db,
  user: AuthUser,
  body: unknown,
  lang: string = DEFAULT_LANGUAGE,
  /** Invitations of the wizard: the SMTP sender and the web address of the links. */
  opts: { mailer?: LetterMailer | null; baseUrl?: string } = {},
) {
  const req: CreateRequest = createRequestSchema.parse(body);
  const language = req.language ?? lang;
  const { template, templateId, errors: setupErrors } = requestTemplate(req, language, lang);
  const prepared = await prepare(db, template, req, req.code, lang, setupErrors);
  if (prepared.errors.length) throw badRequest(prepared.errors.join(" "), prepared.errors);
  await assertProjectCodeFree(db, req.code);
  const people = await resolvePeople(db, req, lang);
  const inviteLanguage = invitationLanguage(req.invite?.language);
  const issuedInvitations: { id: string; token: string; expiresAt: Date; email: string; name: string }[] = [];
  // Audit rows of the invitations, written after the transaction (the audit chain lock, AUDIT_LOG.md).
  const invitationAudits: AuditEvent[] = [];
  const details = req.details && Object.fromEntries(Object.entries(req.details).filter(([, v]) => v));

  const projectId = randomUUID();
  const rootId = randomUUID();
  const namingIds = new Map(prepared.naming.map((standard) => [standard.name, randomUUID()]));
  const attributeIds = new Map(prepared.attributes.map((attribute) => [attribute.name, randomUUID()]));
  const resolveGrants = (grants: readonly TemplateGrant[] | undefined) => {
    const best = new Map<string, PermissionLevel>();
    for (const grant of expandGrants(grants, prepared.mappedSlots)) {
      const companyId = prepared.slots.get(grant.slot)?.companyId;
      if (!companyId) continue;
      const current = best.get(companyId);
      if (!current || rank(grant.level) > rank(current)) best.set(companyId, grant.level);
    }
    return [...best].map(([subjectId, level]) => ({ subjectType: "company" as const, subjectId, level }));
  };

  type FolderRow = typeof folders.$inferInsert;
  const folderRows: FolderRow[] = [
    { id: rootId, projectId, parentId: null, name: tFor(language)("projects:seed.rootFolder"), createdBy: user.id, namingStandardId: null },
  ];
  const grantRows: (typeof folderGrants.$inferInsert)[] = [];
  const bindingRows: (typeof folderAttributeBindings.$inferInsert)[] = [];
  const gateRows: (typeof folderSettings.$inferInsert)[] = [];
  const virtualRows: (typeof folderVirtualChildren.$inferInsert)[] = [];
  const applySettings = (folderId: string, settings: TemplateRootSettings | undefined) => {
    if (!settings) return;
    for (const grant of resolveGrants(settings.grants)) grantRows.push({ folderId, ...grant });
    for (const name of new Set(settings.attributes ?? [])) bindingRows.push({ folderId, definitionId: attributeIds.get(name)! });
    if (settings.gate) gateRows.push({ folderId, requireApprovedReview: true });
  };
  const toSpec = (folder: ExpandedFolder): VirtualFolderSpec => {
    const spec: VirtualFolderSpec = { name: folder.name };
    if (folder.state) spec.state = folder.state;
    if (folder.stateLabel) spec.stateLabel = folder.stateLabel;
    if (folder.naming) spec.namingStandardId = namingIds.get(folder.naming)!;
    if (folder.attributes?.length) spec.attributeDefinitionIds = [...new Set(folder.attributes)].map((name) => attributeIds.get(name)!);
    const grants = resolveGrants(folder.grants);
    if (grants.length) spec.grants = grants;
    if (folder.gate) spec.gate = true;
    if (folder.children.length) spec.children = folder.children.map(toSpec);
    return spec;
  };
  const realPaths = new Map<string, string>();
  const walk = (list: readonly ExpandedFolder[], parentId: string, parentPath = "") => {
    const virtual: VirtualFolderSpec[] = [];
    for (const folder of list) {
      if (folder.virtual) {
        virtual.push(toSpec(folder));
        continue;
      }
      const id = randomUUID();
      const folderPath = parentPath ? `${parentPath}/${folder.name}` : folder.name;
      realPaths.set(folderPath, id);
      folderRows.push({
        id,
        projectId,
        parentId,
        name: folder.name,
        state: folder.state ?? null,
        stateLabel: folder.stateLabel ?? null,
        namingStandardId: folder.naming ? namingIds.get(folder.naming)! : null,
        createdBy: user.id,
      });
      applySettings(id, folder);
      walk(folder.children, id, folderPath);
    }
    if (virtual.length) virtualRows.push({ folderId: parentId, children: virtual });
  };
  if (template.root?.naming) folderRows[0]!.namingStandardId = namingIds.get(template.root.naming)!;
  applySettings(rootId, template.root);
  walk(prepared.folders, rootId);

  const { row: project, workflowIds } = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(projects)
      .values({
        id: projectId,
        code: req.code,
        name: req.name,
        description: req.description ?? null,
        rootFolderId: rootId,
        createdBy: user.id,
        settings: {
          modules: resolveModules(template.modules),
          language,
          ...(details && Object.keys(details).length ? { details } : {}),
          ...(template.issues && resolveModules(template.modules).issues
            ? {
                issueTypes: template.issues.categories,
                ...(template.issues.customFields?.length ? { issueFields: template.issues.customFields } : {}),
              }
            : {}),
        },
      })
      .returning();
    await tx.insert(projectMembers).values({ projectId, userId: user.id, companyId: user.companyId, isProjectAdmin: true });
    if (prepared.naming.length) {
      await tx
        .insert(namingStandards)
        .values(prepared.naming.map((standard) => ({ id: namingIds.get(standard.name)!, projectId, definition: standard })));
    }
    if (prepared.attributes.length) {
      await tx
        .insert(attributeDefinitions)
        .values(prepared.attributes.map((attribute) => ({ id: attributeIds.get(attribute.name)!, projectId, ...attribute })));
    }
    for (const chunk of chunks(folderRows)) await tx.insert(folders).values(chunk);
    for (const chunk of chunks(grantRows)) await tx.insert(folderGrants).values(chunk);
    for (const chunk of chunks(bindingRows)) await tx.insert(folderAttributeBindings).values(chunk);
    for (const chunk of chunks(gateRows)) await tx.insert(folderSettings).values(chunk);
    for (const chunk of chunks(virtualRows, 100)) await tx.insert(folderVirtualChildren).values(chunk);
    // Template project roles first: workflow steps may name them ({ projectRole }).
    await insertTemplateRoles(tx as unknown as Db, projectId, template, prepared.roleIds, prepared.slots);
    const workflowIds = new Map<string, string>();
    if (prepared.workflows.length) {
      const inserted = await tx.insert(workflowTemplates).values(
        prepared.workflows.map((workflow) => ({
          projectId,
          kind: workflow.kind,
          name: workflow.name,
          steps: workflow.steps,
          finalOutcomes: workflow.finalOutcomes ?? {},
          chainConfig:
            workflow.chain.copyTarget && workflow.copyFolder
              ? { ...workflow.chain, copyTarget: { ...workflow.chain.copyTarget, folderId: realPaths.get(workflow.copyFolder) ?? null } }
              : workflow.chain,
          createdBy: user.id,
        })),
      ).returning({ id: workflowTemplates.id, name: workflowTemplates.name });
      for (const w of inserted) if (!workflowIds.has(w.name)) workflowIds.set(w.name, w.id);
    }
    // ISO 19650 CDE settings: the template's "cde" block, or the defaults (enforcement off).
    await applyTemplateCde(tx as unknown as Db, projectId, template.cde, workflowIds, realPaths, namingIds);
    if (template.slots.length) {
      await tx.insert(projectSlots).values(
        template.slots.map((slot, position) => {
          const resolved = prepared.slots.get(slot.key)!;
          return {
            projectId,
            key: slot.key,
            label: slot.label,
            party: slot.party ?? null,
            code: resolved.code,
            description: slot.description ?? null,
            companyId: resolved.companyId,
            position,
          };
        }),
      );
    }
    await tx.insert(projectTemplateOrigins).values({
      projectId,
      templateId,
      templateName: template.name,
      dimensions: Object.keys(req.dimensions).length ? prepared.dimensions : null,
    });
    const txDb = tx as unknown as Db;
    // People of the set-up wizard: members in the company of their party, with their project roles.
    // People without an account become pending members with an invitation (docs/features/INVITATIONS.md).
    const pendingIds = new Set<string>();
    const invitees: { person: SetupPersonInput; userId: string; companyId: string | null }[] = [];
    for (const person of people.invite) {
      const slotCompany = person.slot ? (prepared.slots.get(person.slot)?.companyId ?? null) : null;
      const pending = await ensurePendingUser(txDb, { email: person.email, name: person.name, companyId: slotCompany, invitedBy: user.id }, invitationAudits);
      pendingIds.add(pending.id);
      invitees.push({ person, userId: pending.id, companyId: pending.companyId });
    }
    const added = [...people.add, ...invitees].filter((p) => p.userId !== user.id || p.person.slot || p.person.roles?.length || p.person.projectAdmin);
    for (const { person, userId, companyId } of added) {
      const slotCompany = person.slot ? prepared.slots.get(person.slot)?.companyId : null;
      const values = { companyId: slotCompany ?? companyId, isProjectAdmin: userId === user.id || !!person.projectAdmin };
      await tx
        .insert(projectMembers)
        .values({ projectId, userId, ...values })
        .onConflictDoUpdate({ target: [projectMembers.projectId, projectMembers.userId], set: values });
      const roles = (person.roles ?? []).map((key) => prepared.roleIds.get(key)).filter((id): id is string => !!id);
      if (roles.length) await tx.insert(memberRoles).values(roles.map((roleId) => ({ projectId, userId, roleId }))).onConflictDoNothing();
      if (pendingIds.has(userId)) {
        const issued = await issueInvitation(txDb, {
          userId,
          email: person.email,
          projectId,
          companyId: values.companyId,
          roleIds: roles,
          isProjectAdmin: values.isProjectAdmin,
          language: inviteLanguage,
          invitedBy: user.id,
          viaWizard: true,
        }, invitationAudits);
        issuedInvitations.push({ ...issued, email: person.email, name: invitedName(person.email, person.name) });
      }
    }
    const roleIds = await ensureDefaultProjectRoles(txDb, projectId, rootId);
    const adminRoleId = roleIds["Yönetici"];  // i18n-ok: data (default role name)
    if (adminRoleId) await ensureProjectAdminsHoldAdminRole(txDb, projectId, adminRoleId);
    // ISO 19650 task teams (ISO-5): one per slot company (code from the slot), or per slot listed in
    // the template's cde.taskTeams (with the lead flag), and the creator's company; WIP folders
    // granted to one slot company belong to its team. Members of a team's company join it.
    const teamSlots = template.cde?.taskTeams;
    const slotTeams: TeamSeedCompany[] = teamSlots
      ? teamSlots.flatMap((team) => {
          const slot = prepared.slots.get(team.slot);
          return slot?.companyId ? [{ companyId: slot.companyId, code: slot.code, lead: !!team.lead }] : [];
        })
      : [...prepared.slots.values()].filter((s) => s.companyId).map((s) => ({ companyId: s.companyId!, code: s.code }));
    const { teams } = await ensureCompanyTeams(txDb, projectId, [...slotTeams, ...(user.companyId ? [{ companyId: user.companyId }] : [])]);
    await assignWipOwnerTeams(txDb, projectId, teams);
    // ISO 19650 delivery plan (ISO-7): the template's milestones, dated from the project start.
    const start = details?.startDate && /^\d{4}-\d{2}-\d{2}$/.test(details.startDate) ? new Date(`${details.startDate}T00:00:00Z`) : new Date();
    await applyTemplateDeliveryPlan(txDb, projectId, template.deliveryPlan, start);
    return { row: row!, workflowIds };
  });
  // Every company the new project refers to goes on it (docs/features/COMPANIES.md), before the parts check them.
  await syncProjectCompanies(db, projectId);
  // Template format v2 parts: transmittal (core), RFI, submittals, meetings (Manage), forms (Field).
  const parts = await applyTemplateParts(db, template, {
    projectId,
    projectCode: req.code,
    userId: user.id,
    language,
    requesterLanguage: lang,
    slots: new Map(
      [...prepared.slots].map(([key, s]) => [key, { label: s.slot.label, companyId: s.companyId, code: s.code }]),
    ),
    workflowIds,
    roleIds: prepared.roleIds,
    folderIds: realPaths,
  });
  await syncProjectCompanies(db, projectId);
  for (const e of invitationAudits) await audit(db, e);
  // Invitations after the project exists: e-mailed when SMTP is configured and allowed, else the link.
  for (const issued of issuedInvitations) {
    const delivery = await deliverInvitation(db, opts.mailer, {
      ...issued,
      language: inviteLanguage,
      inviterName: user.name,
      projectName: req.name,
      baseUrl: opts.baseUrl ?? "",
    });
    const entry = people.report.find((p) => p.email === issued.email && p.status === "invite");
    if (entry) Object.assign(entry, { status: "invited", name: entry.name ?? issued.name, invitation: delivery });
  }
  await audit(db, {
    projectId,
    userId: user.id,
    action: "project.created_from_template",
    details: {
      code: req.code,
      name: req.name,
      templateId,
      templateName: template.name,
      slotCompanies: req.slotCompanies,
      counts: prepared.counts,
      language,
      ...(req.setup ? { setup: req.setup } : {}),
      ...(people.report.length ? { people: people.report.map((p) => ({ email: p.email, status: p.status })) } : {}),
      parts: parts.map((p) => ({ part: p.part, status: p.status, ...(p.reason ? { reason: p.reason } : {}) })),
    },
  });
  return {
    project,
    warnings: [...new Set([...prepared.warnings, ...people.warnings])],
    counts: prepared.counts,
    parts,
    people: people.report,
  };
}
