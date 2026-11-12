import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import {
  PROJECT_MODULES,
  TEMPLATE_FORMAT,
  WORKFLOW_ROLES,
  resolveModules,
  type AttributeDefinition,
  type NamingStandard,
  type PermissionLevel,
  type ProjectTemplate,
  type TemplateAssignee,
  type TemplateAssigneeRule,
  type TemplateChainConfig,
  type TemplateFolder,
  type TemplateGrant,
  type TemplateRootSettings,
  type TemplateSlot,
  type TemplateWorkflow,
  type TemplateWorkflowStep,
  type VirtualFolderSpec,
  type WorkflowAssignee,
  type WorkflowRole,
} from "@sitekeep/shared";
import { notFound } from "../core/platform/http.js";
import { DEFAULT_LANGUAGE, msg, tFor } from "../i18n/index.js";
import { FolderTree } from "../core/security/access.js";
import type { Db } from "../db/index.js";
import {
  attributeDefinitions,
  companies,
  folderAttributeBindings,
  folderSettings,
  folderVirtualChildren,
  namingStandards,
  projectSlots,
  projects,
  workflowTemplates,
} from "../db/schema.js";
import { withRuleAssignees } from "../workflow/chain-template.js";

function slugify(text: string): string {
  const map: Record<string, string> = { ç: "c", ğ: "g", ı: "i", İ: "i", ö: "o", ş: "s", ü: "u" };
  return (
    text
      .replace(/[çğıİöşüÇĞÖŞÜ]/g, (char) => map[char] ?? map[char.toLowerCase()] ?? char)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "firma"
  );
}

/** The structure of a project as a template: folders, grants by slot, naming, attributes, workflows. */
/** `lang`: the language of the generated name, description and notes (the requester's). */
export async function exportProjectTemplate(db: Db, projectId: string, lang: string = DEFAULT_LANGUAGE): Promise<ProjectTemplate> {
  const t = tFor(lang);
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
  if (!project) throw notFound(msg("projects:entities.project"));
  const tree = await FolderTree.load(db, projectId);
  const ids = [...tree.byId.keys()];
  const [virtualRows, definitions, bindings, standards, gates, workflowRows, slotRows] = await Promise.all([
    ids.length ? db.select().from(folderVirtualChildren).where(inArray(folderVirtualChildren.folderId, ids)) : [],
    db
      .select()
      .from(attributeDefinitions)
      .where(eq(attributeDefinitions.projectId, projectId))
      .orderBy(asc(attributeDefinitions.createdAt), asc(attributeDefinitions.name)),
    ids.length ? db.select().from(folderAttributeBindings).where(inArray(folderAttributeBindings.folderId, ids)) : [],
    db.select().from(namingStandards).where(eq(namingStandards.projectId, projectId)).orderBy(asc(namingStandards.createdAt)),
    ids.length ? db.select().from(folderSettings).where(inArray(folderSettings.folderId, ids)) : [],
    db
      .select()
      .from(workflowTemplates)
      .where(and(eq(workflowTemplates.projectId, projectId), isNull(workflowTemplates.archivedAt)))
      .orderBy(asc(workflowTemplates.name)),
    db.select().from(projectSlots).where(eq(projectSlots.projectId, projectId)).orderBy(asc(projectSlots.position)),
  ]);
  const notes: string[] = [];

  const slots: TemplateSlot[] = slotRows.map((row) => {
    const slot: TemplateSlot = { key: row.key, label: row.label };
    if (row.party) slot.party = row.party;
    if (row.code) slot.code = row.code;
    if (row.description) slot.description = row.description;
    return slot;
  });
  const companyToSlot = new Map<string, string>();
  for (const row of slotRows) if (row.companyId && !companyToSlot.has(row.companyId)) companyToSlot.set(row.companyId, row.key);
  const virtualCompanyIds = (specs: VirtualFolderSpec[]): string[] =>
    specs.flatMap((spec) => [...(spec.grants ?? []).map((grant) => grant.subjectId), ...virtualCompanyIds(spec.children ?? [])]);
  const referenced = new Set<string>([
    ...tree.grants.filter((grant) => grant.subjectType === "company").map((grant) => grant.subjectId),
    ...workflowRows.flatMap((workflow) =>
      workflow.steps.flatMap((step) =>
        withRuleAssignees(step).assignees.filter((assignee) => assignee.type === "company").map((assignee) => assignee.id),
      ),
    ),
    ...virtualRows.flatMap((row) => virtualCompanyIds(row.children)),
  ]);
  const extra = [...referenced].filter((id) => !companyToSlot.has(id));
  if (extra.length) {
    const rows = await db.select().from(companies).where(inArray(companies.id, extra)).orderBy(asc(companies.name));
    const keys = new Set(slots.map((slot) => slot.key));
    for (const company of rows) {
      let key = slugify(company.name);
      for (let i = 2; keys.has(key); i++) key = `${slugify(company.name)}-${i}`;
      keys.add(key);
      slots.push({ key, label: company.name });
      companyToSlot.set(company.id, key);
    }
  }
  const slotOrder = new Map(slots.map((slot, index) => [slot.key, index]));

  const standardName = new Map<string, string>();
  const namingOut: NamingStandard[] = [];
  for (const standard of standards) {
    let name = standard.definition.name;
    for (let i = 2; namingOut.some((item) => item.name === name); i++) name = `${standard.definition.name} (${i})`;
    standardName.set(standard.id, name);
    namingOut.push({
      ...standard.definition,
      name,
      fields: standard.definition.fields.map((field) =>
        field.type === "list"
          ? { ...field, values: field.values.map((value) => (value.code === project.code ? { ...value, code: "{PROJE}" } : value)) }
          : field,
      ),
    });
  }
  const definitionName = new Map(definitions.map((definition) => [definition.id, definition.name]));
  const definitionOrder = new Map(definitions.map((definition, index) => [definition.id, index]));
  const bindingsByFolder = new Map<string, string[]>();
  for (const binding of bindings) {
    bindingsByFolder.set(binding.folderId, [...(bindingsByFolder.get(binding.folderId) ?? []), binding.definitionId]);
  }
  const gated = new Set(gates.filter((gate) => gate.requireApprovedReview).map((gate) => gate.folderId));
  const virtualByFolder = new Map(virtualRows.map((row) => [row.folderId, row.children]));

  let skippedGrants = 0;
  const toGrants = (list: { subjectType: string; subjectId: string; level: PermissionLevel }[]): TemplateGrant[] | undefined => {
    const out: TemplateGrant[] = [];
    for (const grant of list) {
      const slot = grant.subjectType === "company" ? companyToSlot.get(grant.subjectId) : undefined;
      if (!slot) {
        skippedGrants++;
        continue;
      }
      if (!out.some((item) => item.slot === slot)) out.push({ slot, level: grant.level });
    }
    out.sort((a, b) => slotOrder.get(a.slot)! - slotOrder.get(b.slot)!);
    return out.length ? out : undefined;
  };
  const attributeNames = (definitionIds: string[] | undefined) => {
    const list = [...new Set(definitionIds ?? [])]
      .filter((id) => definitionName.has(id))
      .sort((a, b) => definitionOrder.get(a)! - definitionOrder.get(b)!)
      .map((id) => definitionName.get(id)!);
    return list.length ? list : undefined;
  };
  const compact = (folder: TemplateFolder): string | TemplateFolder => (Object.keys(folder).length === 1 ? folder.name : folder);
  const fromSpec = (spec: VirtualFolderSpec, top: boolean): string | TemplateFolder => {
    const out: TemplateFolder = { name: spec.name };
    if (spec.state) out.state = spec.state;
    if (spec.stateLabel) out.stateLabel = spec.stateLabel;
    if (spec.namingStandardId && standardName.has(spec.namingStandardId)) out.naming = standardName.get(spec.namingStandardId)!;
    const attributes = attributeNames(spec.attributeDefinitionIds);
    if (attributes) out.attributes = attributes;
    const grants = toGrants(spec.grants ?? []);
    if (grants) out.grants = grants;
    if (spec.gate) out.gate = true;
    if (top) out.lazy = true;
    if (spec.children?.length) out.children = spec.children.map((child) => fromSpec(child, false));
    return compact(out);
  };
  const settingsOf = (id: string, out: TemplateRootSettings) => {
    const folder = tree.get(id);
    if (folder.namingStandardId && standardName.has(folder.namingStandardId)) out.naming = standardName.get(folder.namingStandardId)!;
    const attributes = attributeNames(bindingsByFolder.get(id));
    if (attributes) out.attributes = attributes;
    const grants = toGrants(tree.grants.filter((grant) => grant.folderId === id));
    if (grants) out.grants = grants;
    if (gated.has(id)) out.gate = true;
  };
  const fromFolder = (id: string): string | TemplateFolder => {
    const folder = tree.get(id);
    const out: TemplateFolder = { name: folder.name };
    if (folder.state) out.state = folder.state;
    if (folder.stateLabel) out.stateLabel = folder.stateLabel;
    settingsOf(id, out);
    const real = (tree.children.get(id) ?? []).map((child) => fromFolder(child.id));
    const realNames = new Set((tree.children.get(id) ?? []).map((child) => child.name));
    const virtual = (virtualByFolder.get(id) ?? [])
      .filter((spec) => !realNames.has(spec.name))
      .map((spec) => fromSpec(spec, true));
    if (real.length || virtual.length) out.children = [...real, ...virtual];
    return compact(out);
  };

  const rootId = project.rootFolderId!;
  const root: TemplateRootSettings = {};
  settingsOf(rootId, root);
  const top = (tree.children.get(rootId) ?? []).map((child) => fromFolder(child.id));
  const rootNames = new Set((tree.children.get(rootId) ?? []).map((child) => child.name));
  top.push(
    ...(virtualByFolder.get(rootId) ?? []).filter((spec) => !rootNames.has(spec.name)).map((spec) => fromSpec(spec, true)),
  );

  let droppedAssignees = 0;
  const toTemplateAssignees = (list: readonly WorkflowAssignee[]): TemplateAssignee[] => {
    const out: TemplateAssignee[] = [];
    for (const assignee of list) {
      let resolved: TemplateAssignee | null = null;
      if (assignee.type === "role" && (WORKFLOW_ROLES as readonly string[]).includes(assignee.id)) {
        resolved = { role: assignee.id as WorkflowRole };
      } else if (assignee.type === "company" && companyToSlot.has(assignee.id)) {
        resolved = { slot: companyToSlot.get(assignee.id)! };
      }
      if (!resolved) {
        droppedAssignees++;
        continue;
      }
      const key = JSON.stringify(resolved);
      if (!out.some((item) => JSON.stringify(item) === key)) out.push(resolved);
    }
    return out;
  };
  const folderPath = (id: string): string | null => {
    const names: string[] = [];
    let current = tree.byId.get(id);
    while (current && current.id !== project.rootFolderId) {
      names.unshift(current.name);
      current = current.parentId ? tree.byId.get(current.parentId) : undefined;
    }
    return current && names.length ? names.join("/") : null;
  };
  let lostCopyFolders = 0;
  const workflowsOut: TemplateWorkflow[] = workflowRows.map((workflow) => {
    const steps = workflow.steps.map((source) => {
      const assignees = toTemplateAssignees(source.assignees);
      const out: TemplateWorkflowStep = {
        name: source.name,
        assignees: assignees.length || source.assigneeRule ? assignees : [{ role: "project_admin" as const }],
        rule: source.rule,
        days: source.days,
        outcomes: source.outcomes,
      };
      if (source.outcomeOptions?.length) out.outcomeOptions = source.outcomeOptions;
      if (source.stage !== undefined) out.stage = source.stage;
      if (source.assigneeRule) {
        const map: Record<string, TemplateAssignee[]> = {};
        for (const [value, list] of Object.entries(source.assigneeRule.map)) {
          const mapped = toTemplateAssignees(list);
          if (mapped.length) map[value] = mapped;
        }
        const fallback = toTemplateAssignees(source.assigneeRule.fallback ?? []);
        const rule: TemplateAssigneeRule = { type: "by_attribute", attribute: source.assigneeRule.attribute, map };
        if (fallback.length) rule.fallback = fallback;
        if (Object.keys(map).length || fallback.length) out.assigneeRule = rule;
        else if (!assignees.length) out.assignees = [{ role: "project_admin" }];
      }
      if (source.requiredAttributes?.length) out.requiredAttributes = source.requiredAttributes;
      return out;
    });
    const sourceChain = workflow.chainConfig ?? {};
    const chain: TemplateChainConfig = {};
    if (sourceChain.stages?.length) chain.stages = sourceChain.stages;
    if (sourceChain.originParty) chain.originParty = sourceChain.originParty;
    if (sourceChain.namePattern) chain.namePattern = sourceChain.namePattern;
    if (sourceChain.copyTarget && (sourceChain.copyTarget.folderId || sourceChain.copyTarget.pattern)) {
      const folder = sourceChain.copyTarget.folderId ? folderPath(sourceChain.copyTarget.folderId) : null;
      if (sourceChain.copyTarget.folderId && !folder) lostCopyFolders++;
      if (folder || sourceChain.copyTarget.pattern) {
        chain.copyTarget = {
          folder,
          pattern: sourceChain.copyTarget.pattern,
          ...(sourceChain.copyTarget.onUnresolved ? { onUnresolved: sourceChain.copyTarget.onUnresolved } : {}),
        };
      }
    }
    return {
      name: workflow.name,
      kind: workflow.kind,
      steps,
      ...(Object.keys(workflow.finalOutcomes ?? {}).length ? { finalOutcomes: workflow.finalOutcomes } : {}),
      ...(Object.keys(chain).length ? { chain } : {}),
    };
  });

  if (skippedGrants) notes.push(t("projects:export.skippedGrants", { count: skippedGrants }));
  if (droppedAssignees) notes.push(t("projects:export.droppedAssignees", { count: droppedAssignees }));
  if (lostCopyFolders) notes.push(t("projects:export.lostCopyFolders", { count: lostCopyFolders }));

  const template: ProjectTemplate = {
    format: TEMPLATE_FORMAT,
    name: t("projects:export.name", { name: project.name }),
    description: t("projects:export.description", { code: project.code, date: new Date().toISOString().slice(0, 10) }),
    slots,
    folders: top,
  };
  if (Object.keys(root).length) template.root = root;
  if (namingOut.length) template.namingStandards = namingOut;
  if (definitions.length) {
    template.attributes = definitions.map((definition) => {
      const attribute: AttributeDefinition = { name: definition.name, type: definition.type };
      if (definition.type === "list") attribute.options = definition.options;
      if (definition.required) attribute.required = true;
      return attribute;
    });
  }
  if (workflowsOut.length) template.workflows = workflowsOut;
  const modules = resolveModules(project.settings?.modules);
  if (PROJECT_MODULES.some((module) => !modules[module])) template.modules = modules;
  if (notes.length) template.notes = notes;
  return template;
}
