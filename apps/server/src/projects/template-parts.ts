/**
 * Project template format v2 parts (docs/features/PROJECT_TEMPLATES.md): project roles, issue types
 * and transmittal settings are applied by the core; RFI, submittal and meeting settings (Manage) and
 * form templates (Field) are handed to the module through its `<module>.templateApply` capability.
 * A part whose module is not installed, or whose project module switch is off, is skipped and
 * reported, never fatal.
 */
import {
  TEMPLATE_PARTS,
  resolveModules,
  templatePartsOf,
  type ProjectTemplate,
  type TemplatePart,
  type TemplatePartAvailabilityDto,
  type TemplatePartReportDto,
  type TemplateSlot,
  type TemplateTransmittalSettings,
} from "@sitekeep/shared";
import type { Db } from "../db/index.js";
import { projectRoles } from "../db/schema.js";
import { capability, type TemplateApplyContext, type TemplatePartHandler } from "../sdk/capabilities.js";
import { tFor } from "../i18n/index.js";
import { moduleIds } from "../app/module-ids.js";
import { patchWorkType } from "../works/service.js";

/**
 * The module handler of a part. `installed`: the module is on (installed and licensed) or provides
 * the handlers anyway (tests); an installed module without a handler is an older version.
 */
function moduleHandler(part: TemplatePart): { installed: boolean; handler?: TemplatePartHandler<unknown> } {
  const info = TEMPLATE_PARTS.find((p) => p.part === part)!;
  if (!info.module) return { installed: true };
  const handlers = capability(`${info.module}.templateApply`) as Record<string, TemplatePartHandler<unknown> | undefined> | undefined;
  return { installed: !!handlers || moduleIds().includes(info.module), handler: handlers?.[part] };
}

/** The template's parts and whether this server applies them (preview, setup wizard). */
export function templatePartAvailabilityOf(template: ProjectTemplate): TemplatePartAvailabilityDto[] {
  return templatePartsOf(template).map((part) => {
    const module = TEMPLATE_PARTS.find((p) => p.part === part)!.module;
    return { part, module, available: !module || !!moduleHandler(part).handler };
  });
}

/** Inserts the template's project roles (kind "role") with the ids chosen before creation. */
export async function insertTemplateRoles(
  db: Db,
  projectId: string,
  template: ProjectTemplate,
  roleIds: ReadonlyMap<string, string>,
  slots: ReadonlyMap<string, { slot: TemplateSlot }>,
): Promise<void> {
  if (!template.roles?.length) return;
  await db.insert(projectRoles).values(
    template.roles.map((role) => ({
      id: roleIds.get(role.key)!,
      projectId,
      name: role.name,
      description: role.description ?? (role.slot ? (slots.get(role.slot)?.slot.label ?? null) : null),
      color: role.color ?? null,
      kind: "role" as const,
    })),
  );
}

/** Transmittal settings on the project's built-in transmittal work type (core works engine). */
async function applyTransmittal(
  db: Db,
  projectId: string,
  settings: TemplateTransmittalSettings,
  lang: string,
): Promise<Omit<TemplatePartReportDto, "part" | "module">> {
  const t = tFor(lang);
  const r = await patchWorkType(db, projectId, "transmittal", { name: settings.name, numberingPattern: settings.numbering }, lang);
  if (!r.found) return { status: "failed", reason: "error", notes: [t("projects:parts.transmittalMissing")] };
  const notes = r.problems.map((problem) => t("projects:parts.numberingRefused", { problem }));
  if (settings.attributes?.length) notes.push(t("projects:parts.transmittalAttributes"));
  return { status: notes.length ? "partial" : "applied", count: r.changed ? 1 : 0, ...(notes.length ? { notes } : {}) };
}

export interface ApplyPartsContext extends Omit<TemplateApplyContext, "db"> {}

/**
 * Applies and reports the template's v2 parts, in TEMPLATE_PARTS order. Project roles and issue
 * types were written with the project (template-apply.ts); they are only reported here.
 */
export async function applyTemplateParts(db: Db, template: ProjectTemplate, ctx: ApplyPartsContext): Promise<TemplatePartReportDto[]> {
  const modules = resolveModules(template.modules);
  const t = tFor(ctx.requesterLanguage);
  const out: TemplatePartReportDto[] = [];
  for (const part of templatePartsOf(template)) {
    const info = TEMPLATE_PARTS.find((p) => p.part === part)!;
    const base = { part, module: info.module };
    if (info.projectModule && !modules[info.projectModule]) {
      out.push({ ...base, status: "skipped", reason: "module_off" });
      continue;
    }
    try {
      if (part === "roles") {
        out.push({ ...base, status: "applied", count: template.roles!.length });
      } else if (part === "issues") {
        const count = template.issues!.categories.reduce((n, c) => n + c.types.length, 0);
        const notes = template.issues!.customFields?.length ? [t("projects:parts.issueFields")] : [];
        out.push({ ...base, status: notes.length ? "partial" : "applied", count, ...(notes.length ? { notes } : {}) });
      } else if (part === "transmittal") {
        out.push({ ...base, ...(await applyTransmittal(db, ctx.projectId, template.transmittal!, ctx.requesterLanguage)) });
      } else {
        const { installed, handler } = moduleHandler(part);
        if (!installed) out.push({ ...base, status: "skipped", reason: "module_not_installed" });
        else if (!handler) out.push({ ...base, status: "skipped", reason: "unsupported" });
        else {
          const r = await handler({ ...ctx, db }, template[part]);
          out.push({ ...base, status: r.status, ...(r.count !== undefined ? { count: r.count } : {}), ...(r.notes?.length ? { notes: r.notes } : {}) });
        }
      }
    } catch (e) {
      out.push({ ...base, status: "failed", reason: "error", notes: [(e as Error).message] });
    }
  }
  return out;
}
