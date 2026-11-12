import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import {
  checkAttributeDefinition,
  checkProjectTemplate,
  checkStandard,
  countTemplate,
  dimensionDtos,
  expandGrants,
  expandProjectTemplate,
  previewTree,
  rank,
  resolveModules,
  resolveNamingTokens,
  templateDimensions,
  type AttributeDefinition,
  type ExpandedFolder,
  type FinalOutcomeMap,
  type NamingStandard,
  type PermissionLevel,
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
import { audit } from "../core/platform/audit.js";
import { ensureDefaultProjectRoles, ensureProjectAdminsHoldAdminRole } from "../core/security/default-roles.js";
import { badRequest, conflict } from "../core/platform/http.js";
import { DEFAULT_LANGUAGE, msg, tFor } from "../i18n/index.js";
import type { AuthUser } from "../core/security/access.js";
import type { Db } from "../db/index.js";
import {
  attributeDefinitions,
  companies,
  folderAttributeBindings,
  folderGrants,
  folderSettings,
  folderVirtualChildren,
  folders,
  namingStandards,
  projectMembers,
  projectSlots,
  projectTemplateOrigins,
  projects,
  workflowTemplates,
} from "../db/schema.js";
import { normaliseChainTemplate, withRuleAssignees } from "../workflow/chain-template.js";
import { checkTemplate as checkWorkflowSteps } from "../workflow/engine.js";
import { templateFromRequest } from "./template-built-ins.js";
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

async function prepare(db: Db, template: ProjectTemplate, req: PreviewRequest, projectCode: string, lang: string): Promise<Prepared> {
  const t = tFor(lang);
  const errors = checkProjectTemplate(template, req.dimensions, lang);
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
  const toAssignees = (list: readonly TemplateAssignee[]): WorkflowAssignee[] => {
    const out: WorkflowAssignee[] = [];
    for (const assignee of list) {
      const companyId = "slot" in assignee ? slots.get(assignee.slot)?.companyId : null;
      const resolved: WorkflowAssignee | null =
        "role" in assignee ? { type: "role", id: assignee.role } : companyId ? { type: "company", id: companyId } : null;
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
    workflows,
    dimensions: Object.fromEntries(
      Object.entries(dimensions).map(([key, values]) => [key, values.map((value) => (typeof value === "string" ? value : value.name))]),
    ),
  };
}

/** `lang`: the requester's language, for the errors and warnings of the preview. */
export async function previewProjectTemplate(db: Db, body: unknown, lang: string = DEFAULT_LANGUAGE): Promise<TemplatePreviewDto> {
  const req = previewRequestSchema.parse(body);
  const { template } = templateFromRequest(req);
  const prepared = await prepare(db, template, req, req.code || "PROJE", lang);
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

export async function createProjectFromTemplate(db: Db, user: AuthUser, body: unknown, lang: string = DEFAULT_LANGUAGE) {
  const req: CreateRequest = createRequestSchema.parse(body);
  const { template, templateId } = templateFromRequest(req);
  const prepared = await prepare(db, template, req, req.code, lang);
  if (prepared.errors.length) throw badRequest(prepared.errors.join(" "), prepared.errors);
  await assertProjectCodeFree(db, req.code);

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
    { id: rootId, projectId, parentId: null, name: "Proje Dosyaları", createdBy: user.id, namingStandardId: null },  // i18n-ok: data
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

  const project = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(projects)
      .values({
        id: projectId,
        code: req.code,
        name: req.name,
        description: req.description ?? null,
        rootFolderId: rootId,
        createdBy: user.id,
        settings: { modules: resolveModules(template.modules) },
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
    if (prepared.workflows.length) {
      await tx.insert(workflowTemplates).values(
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
      );
    }
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
    return row!;
  });
  const roleIds = await ensureDefaultProjectRoles(db, projectId, rootId);
  const adminRoleId = roleIds["Yönetici"];  // i18n-ok: data (default role name)
  if (adminRoleId) await ensureProjectAdminsHoldAdminRole(db, projectId, adminRoleId);
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
    },
  });
  return { project, warnings: prepared.warnings, counts: prepared.counts };
}
