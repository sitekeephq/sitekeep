import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  ALL_BUILT_IN_WORK_TYPES,
  BUILT_IN_WORK_TYPE_OLD_NAMES,
  WORK_STATUS,
  canEditWork,
  canSeeWork,
  defaultStatuses,
  isSeededDefaultLabel,
  numberingScope,
  renderWorkNumber,
  type WorkEventKind,
  type WorkFieldDef,
  type WorkStatusDef,
  type WorkSummaryDto,
  type WorkTypeDto,
  type WorkViewer,
  projectPath,
} from "@sitekeep/shared";
import type { ProjectAccess } from "../core/security/access.js";
import { badRequest, conflict, forbidden, notFound } from "../core/platform/http.js";
import { msg } from "../i18n/index.js";
import type { Storage } from "../core/platform/storage.js";
import type { Db } from "../db/index.js";
import {
  companies,
  projectMembers,
  workCounters,
  workEvents,
  workTypes,
  works,
} from "../db/schema.js";
import { participantWorkIds } from "./participants.js";

export type TypeRow = typeof workTypes.$inferSelect;
export type WorkRow = typeof works.$inferSelect;

export interface WorksCtx {
  db: Db;
  storage: Storage;
}

export const COVER_FOLDER_NAME = "Gönderim formları"; // i18n-ok: folder name stored as data
export const COVER_FOLDER_OLD_NAMES = ["Transmittaller"];
export const LETTER_FOLDER_NAME = "Yazılar"; // i18n-ok: folder name stored as data
export const INTAKE_FOLDER_NAME = "Gelen belgeler";

export function workLink(projectId: string, workId: string) {
  return projectPath(projectId, `works/${workId}`);
}

function seededLabelsOf(fields: readonly WorkFieldDef[], statuses: readonly WorkStatusDef[]): Record<string, string> {
  return Object.fromEntries([...fields.map((f) => [`f:${f.key}`, f.label]), ...statuses.map((s) => [`s:${s.key}`, s.label])]);
}

export async function ensureBuiltInTypes(db: Db, projectId: string): Promise<void> {
  const existing = await db
    .select()
    .from(workTypes)
    .where(and(eq(workTypes.projectId, projectId), eq(workTypes.builtIn, true)));
  const have = new Set(existing.map((r) => r.key));
  for (const row of existing) {
    const def = ALL_BUILT_IN_WORK_TYPES.find((t) => t.key === row.key);
    if (!def) continue;
    const seeded = new Set(row.settings.seededKeys ?? [...row.fields.map((f) => `f:${f.key}`), ...row.statuses.map((x) => `s:${x.key}`)]);
    const addFields = def.fields.filter((f) => !seeded.has(`f:${f.key}`) && !row.fields.some((x) => x.key === f.key));
    const defStatuses = def.statuses ?? defaultStatuses(def.category);
    const addStatuses = defStatuses.filter((x) => !seeded.has(`s:${x.key}`) && !row.statuses.some((y) => y.key === x.key));
    const allKeys = [...def.fields.map((f) => `f:${f.key}`), ...defStatuses.map((x) => `s:${x.key}`)];
    const markOnly = !row.settings.seededKeys || allKeys.some((k) => !seeded.has(k));
    const seededName = row.settings.seededName;
    const rename = isSeededDefaultLabel(row.name, def.name, seededName, BUILT_IN_WORK_TYPE_OLD_NAMES[row.key]);
    const remembered = row.settings.seededLabels;
    const defLabels = seededLabelsOf(def.fields, defStatuses);
    let relabelled = 0;
    const relabel = <T extends { key: string; label: string }>(x: T, kind: "f" | "s"): T => {
      const current = defLabels[`${kind}:${x.key}`];
      if (current === undefined || !isSeededDefaultLabel(x.label, current, remembered?.[`${kind}:${x.key}`])) return x;
      relabelled++;
      return { ...x, label: current };
    };
    const fields = row.fields.map((f) => relabel(f, "f"));
    const statuses = row.statuses.map((s) => relabel(s, "s"));
    const labelsKnown = !!remembered && Object.entries(defLabels).every(([k, v]) => remembered[k] === v);
    if (!addFields.length && !addStatuses.length && !markOnly && !rename && seededName === def.name && !relabelled && labelsKnown) continue;
    await db
      .update(workTypes)
      .set({
        fields: [...fields, ...addFields],
        statuses: [...statuses, ...addStatuses],
        ...(rename && { name: def.name }),
        settings: {
          ...row.settings,
          seededKeys: [...new Set([...seeded, ...allKeys])],
          seededName: def.name,
          seededLabels: { ...remembered, ...defLabels },
        },
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(workTypes.id, row.id),
          row.settings.seededKeys
            ? sql`${workTypes.settings}->'seededKeys' = ${JSON.stringify(row.settings.seededKeys)}::jsonb`
            : sql`${workTypes.settings}->'seededKeys' IS NULL`,
        ),
      );
  }
  const missing = ALL_BUILT_IN_WORK_TYPES.filter((t) => !have.has(t.key));
  if (!missing.length) return;
  await db
    .insert(workTypes)
    .values(
      missing.map((t) => {
        const statuses = t.statuses ?? defaultStatuses(t.category);
        return {
          projectId,
          key: t.key,
          name: t.name,
          category: t.category,
          numberingPattern: t.numberingPattern,
          counterGroup: t.counterGroup,
          fields: t.fields,
          statuses,
          settings: {
            ...t.settings,
            seededKeys: [...t.fields.map((f) => `f:${f.key}`), ...statuses.map((x) => `s:${x.key}`)],
            seededName: t.name,
            seededLabels: seededLabelsOf(t.fields, statuses),
          },
          icon: t.icon,
          color: t.color,
          builtIn: true,
        };
      }),
    )
    .onConflictDoNothing();
}

export async function projectTypes(db: Db, projectId: string): Promise<TypeRow[]> {
  await ensureBuiltInTypes(db, projectId);
  return db.select().from(workTypes).where(eq(workTypes.projectId, projectId)).orderBy(asc(workTypes.createdAt));
}

export function toTypeDto(t: TypeRow): WorkTypeDto {
  return {
    id: t.id,
    projectId: t.projectId,
    key: t.key,
    name: t.name,
    category: t.category,
    numberingPattern: t.numberingPattern,
    counterGroup: t.counterGroup,
    fields: t.fields,
    statuses: t.statuses,
    settings: t.settings,
    defaultWorkflowTemplateId: t.defaultWorkflowTemplateId,
    icon: t.icon,
    color: t.color,
    builtIn: t.builtIn,
    archived: !!t.archivedAt,
  };
}

export function statusDef(t: TypeRow, key: string): WorkStatusDef {
  return t.statuses.find((s) => s.key === key) ?? { key, label: key, tone: "" };
}

export function initialStatus(t: TypeRow): string {
  const keys = t.statuses.map((s) => s.key);
  if (t.settings.incoming && keys.includes(WORK_STATUS.received)) return WORK_STATUS.received;
  if (keys.includes(WORK_STATUS.draft)) return WORK_STATUS.draft;
  return keys[0] ?? WORK_STATUS.draft;
}

export function viewerOf(a: ProjectAccess): WorkViewer {
  return { userId: a.user.id, companyId: a.principal.companyId ?? null, isProjectAdmin: a.isProjectAdmin };
}

export async function loadVisibleWork(db: Db, a: ProjectAccess, wid: string): Promise<{ work: WorkRow; type: TypeRow }> {
  const [row] = await db
    .select({ work: works, type: workTypes })
    .from(works)
    .innerJoin(workTypes, eq(workTypes.id, works.typeId))
    .where(and(eq(works.id, wid), eq(works.projectId, a.project.id)));
  if (!row) throw notFound(msg("works:entities.work"));
  if (!canSeeWork(row.work, viewerOf(a)) && !(await participantWorkIds(db, a, [row.work.id])).has(row.work.id))
    throw notFound(msg("works:entities.work"));
  return row;
}

export function requireEdit(work: WorkRow, a: ProjectAccess) {
  if (!canEditWork(work, viewerOf(a)))
    throw forbidden(msg("works:errors.editNotAllowed"));
}

export async function allocateNumber(
  tx: Db,
  projectId: string,
  type: TypeRow,
  ctx: {
    projectCode: string;
    fromCompany: string | null;
    fromCode?: string | null;
    toCompany: string | null;
    toCode?: string | null;
    date: Date;
    values?: Record<string, string>;
    subject?: string | null;
  },
): Promise<{ number: string; seq: number }> {
  const nctx = { ...ctx, typeKey: type.key };
  const scope = `${type.counterGroup ? `g:${type.counterGroup}` : `t:${type.key}`}|${numberingScope(type.numberingPattern, nctx)}`;
  for (let attempt = 0; attempt < 100; attempt++) {
    const [row] = await tx
      .insert(workCounters)
      .values({ projectId, scope, value: 1 })
      .onConflictDoUpdate({
        target: [workCounters.projectId, workCounters.scope],
        set: { value: sql`${workCounters.value} + 1` },
      })
      .returning({ value: workCounters.value });
    const seq = row!.value;
    const number = renderWorkNumber(type.numberingPattern, nctx, seq);
    const [taken] = await tx
      .select({ id: works.id })
      .from(works)
      .where(and(eq(works.projectId, projectId), eq(works.typeId, type.id), eq(works.number, number)));
    if (!taken) return { number, seq };
  }
  throw conflict(msg("works:errors.numberFailed"));
}

export async function companyNames(db: Db, ids: (string | null | undefined)[]): Promise<Map<string, string>> {
  const rows = await companyRows(db, ids);
  return new Map([...rows].map(([id, r]) => [id, r.name]));
}

export async function companyRows(db: Db, ids: (string | null | undefined)[]): Promise<Map<string, { name: string; code: string | null }>> {
  const unique = [...new Set(ids.filter((x): x is string => !!x))];
  if (!unique.length) return new Map();
  const rows = await db.select().from(companies).where(inArray(companies.id, unique));
  return new Map(rows.map((r) => [r.id, { name: r.name, code: r.code }]));
}

export async function checkCompanies(db: Db, ids: string[]) {
  const unique = [...new Set(ids)];
  if (!unique.length) return;
  const found = await companyNames(db, unique);
  if (found.size !== unique.length) throw badRequest(msg("works:errors.companyNotFound"));
}

export async function checkMember(db: Db, projectId: string, userId: string | null | undefined) {
  if (!userId) return;
  const [m] = await db
    .select()
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)));
  if (!m) throw badRequest(msg("works:errors.assigneeNotMember"));
}

export async function companyMembers(db: Db, projectId: string, companyIds: string[]): Promise<string[]> {
  if (!companyIds.length) return [];
  const rows = await db
    .select({ userId: projectMembers.userId })
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), inArray(projectMembers.companyId, companyIds)));
  return rows.map((r) => r.userId);
}

export async function addEvent(
  db: Db,
  workId: string,
  kind: WorkEventKind,
  userId: string | null,
  message: string | null = null,
  details: Record<string, unknown> | null = null,
) {
  await db.insert(workEvents).values({ workId, kind, userId, message, details });
}

export function todayIso(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

export function addDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() + days);
  return todayIso(d);
}

export function isClosed(t: TypeRow, status: string): boolean {
  return !!statusDef(t, status).closed;
}

export function toSummary(w: WorkRow, t: TypeRow, names: Map<string, string>, today = todayIso()): WorkSummaryDto {
  const s = statusDef(t, w.status);
  return {
    id: w.id,
    projectId: w.projectId,
    typeId: t.id,
    typeKey: t.key,
    typeName: t.name,
    category: t.category,
    number: w.number,
    title: w.title,
    status: w.status,
    statusLabel: s.label,
    statusTone: s.tone,
    closed: !!s.closed,
    fromCompanyId: w.fromCompanyId,
    toCompanyIds: w.toCompanyIds,
    ccCompanyIds: w.ccCompanyIds,
    assigneeUserId: w.assigneeUserId,
    dueDate: w.dueDate,
    replyRequired: w.replyRequired,
    overdue: !s.closed && !!w.dueDate && w.dueDate < today,
    createdBy: w.createdBy,
    createdByName: names.get(w.createdBy),
    createdAt: w.createdAt.toISOString(),
    updatedAt: w.updatedAt.toISOString(),
    sentAt: w.sentAt?.toISOString() ?? null,
    parentWorkId: w.parentWorkId,
  };
}
