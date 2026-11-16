/**
 * ISO-7: information delivery plans (ISO 19650-2 §5.4.3–§5.4.5, docs/features/DELIVERY_PLAN.md).
 *
 * - A TIDP per task team: planned deliverables with a document code (checked against the project's
 *   naming standard), title, discipline, type, the planned suitability and revision per milestone,
 *   and the due dates for Shared and for Published. The MIDP is every TIDP with the project's
 *   milestones.
 * - The status of a deliverable comes from the CDE: the document code register (document_codes)
 *   gives the container, and the most advanced live file of the container (or a file carrying the
 *   code) gives not started / WIP / Shared / Published. Late: a due date passed below its state.
 * - Who sees what: project administrators the whole MIDP; anyone else the TIDPs of their own task
 *   teams (and the team they lead). Who edits: project administrators, and a team's lead its TIDP.
 *   The matched document is named only to callers who can see its folder (folder permissions and
 *   the task-team WIP rule, docs/features/TASK_TEAMS.md); the status itself is plan data.
 */
import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import {
  codeProfile,
  deliverableLate,
  deliverableRank,
  deliverableStatus,
  fileDeliverableStatus,
  isKnownRevision,
  isKnownSuitability,
  isoDay,
  normaliseRevision,
  normaliseSuitability,
  validateName,
  type CdeCodeProfile,
  type CdeState,
  type DeliverableDocumentDto,
  type DeliverableDto,
  type DeliverableTargetDto,
  type DeliveryMilestoneDto,
  type DeliveryPlanDto,
  type DeliveryPlanTeamDto,
  type NamingStandard,
  type TemplateDeliveryPlan,
} from "@sitekeep/shared";
import type { Db } from "../db/index.js";
import {
  deliveryDeliverables,
  deliveryMilestones,
  deliveryTeamLeads,
  documentCodes,
  fileVersions,
  files,
  memberRoles,
  namingStandards,
  projectCdeSettings,
  projectRoles,
  users,
} from "../db/schema.js";
import { FolderTree, type ProjectAccess } from "../core/security/access.js";
import { tFor } from "../i18n/index.js";
import { loadCodeSettings } from "./codes.js";
import { documentCodeOf, normalizeDocumentCode } from "./document-code.js";
import { cdeStateOf } from "./state.js";

export type DeliverableRow = typeof deliveryDeliverables.$inferSelect;
export type MilestoneRow = typeof deliveryMilestones.$inferSelect;

export interface PlanTeam {
  id: string;
  name: string;
  code: string | null;
  isLead: boolean;
}

/** Task teams of the project, leads of their TIDPs, and what the caller may see and edit. */
export interface PlanScope {
  teams: PlanTeam[];
  /** team id → lead user id */
  leads: Map<string, string>;
  admin: boolean;
  userId: string;
  memberOf: Set<string>;
}

export async function loadPlanScope(db: Db, a: ProjectAccess): Promise<PlanScope> {
  const teams = await db
    .select({ id: projectRoles.id, name: projectRoles.name, code: projectRoles.code, isLead: projectRoles.isLead })
    .from(projectRoles)
    .where(and(eq(projectRoles.projectId, a.project.id), eq(projectRoles.kind, "task_team")))
    .orderBy(asc(projectRoles.name));
  const leads = await db
    .select({ teamId: deliveryTeamLeads.teamId, userId: deliveryTeamLeads.userId })
    .from(deliveryTeamLeads)
    .where(eq(deliveryTeamLeads.projectId, a.project.id));
  return {
    teams,
    leads: new Map(leads.map((l) => [l.teamId, l.userId])),
    admin: a.isProjectAdmin,
    userId: a.user.id,
    memberOf: new Set(a.principal.teamIds ?? []),
  };
}

/** The caller edits the team's TIDP: a project administrator, or the team's lead. */
export function canEditTeam(scope: PlanScope, teamId: string | null): boolean {
  if (scope.admin) return true;
  return !!teamId && scope.leads.get(teamId) === scope.userId;
}

/** The caller sees the team's TIDP: a project administrator, a member, or the lead. */
export function canViewTeam(scope: PlanScope, teamId: string | null): boolean {
  if (scope.admin) return true;
  return !!teamId && (scope.memberOf.has(teamId) || scope.leads.get(teamId) === scope.userId);
}

// ---- Document codes ---------------------------------------------------------------------------

export type CodeCheck = { ok: true; code: string; norm: string } | { ok: false; message: string };

/**
 * Checks planned document codes against the project's naming standard: the document code standard
 * (Project Settings → CDE), else any naming standard of the project. A project without a standard
 * takes any code. With `allowSuffix`, a suffix after the last field is not part of the code.
 */
export async function codeChecker(db: Db, projectId: string, lang: string): Promise<(raw: string) => CodeCheck> {
  const t = tFor(lang);
  const rows = await db
    .select({ id: namingStandards.id, definition: namingStandards.definition })
    .from(namingStandards)
    .where(eq(namingStandards.projectId, projectId));
  const [settings] = await db
    .select({ id: projectCdeSettings.containerStandardId })
    .from(projectCdeSettings)
    .where(eq(projectCdeSettings.projectId, projectId));
  const container = rows.find((r) => r.id === settings?.id);
  const candidates: NamingStandard[] = (container ? [container] : rows).map((r) => r.definition);
  return (raw: string) => {
    const input = raw.trim();
    if (!input) return { ok: false, message: t("cde:deliveryPlan.errors.codeRequired") };
    if (!candidates.length) return { ok: true, code: input, norm: normalizeDocumentCode(input) };
    // As typed, then upper-cased: the register compares codes case-insensitively.
    for (const text of new Set([input, input.toUpperCase()]))
      for (const standard of candidates) {
        if (validateName(standard, text, lang).ok) {
          const code = documentCodeOf(standard, text) ?? text;
          return { ok: true, code, norm: normalizeDocumentCode(code) };
        }
      }
    const first = candidates[0]!;
    const errors = validateName(first, input, lang).errors.join(" ");
    return { ok: false, message: t("cde:deliveryPlan.errors.codeNaming", { code: input, standard: first.name, errors }) };
  };
}

// ---- Targets ----------------------------------------------------------------------------------

/**
 * Normalises the planned suitability and revision per milestone: known milestones only, codes of
 * the project's profile (any state), one target per milestone, empty targets dropped.
 */
export function normaliseTargets(
  targets: readonly DeliverableTargetDto[],
  milestoneIds: ReadonlySet<string>,
  profile: CdeCodeProfile,
  lang: string,
): { targets: DeliverableTargetDto[] } | { error: string } {
  const t = tFor(lang);
  const out = new Map<string, DeliverableTargetDto>();
  for (const target of targets) {
    if (!milestoneIds.has(target.milestoneId)) return { error: t("cde:deliveryPlan.errors.milestoneUnknown") };
    const suitabilityCode = normaliseSuitability(target.suitabilityCode);
    const revisionCode = normaliseRevision(target.revisionCode, profile);
    if (suitabilityCode && !isKnownSuitability(profile, suitabilityCode))
      return { error: t("cde:deliveryPlan.errors.suitabilityUnknown", { value: suitabilityCode }) };
    if (revisionCode && !isKnownRevision(profile, revisionCode)) return { error: t("cde:deliveryPlan.errors.revisionUnknown", { value: revisionCode }) };
    if (!suitabilityCode && !revisionCode) out.delete(target.milestoneId);
    else out.set(target.milestoneId, { milestoneId: target.milestoneId, suitabilityCode, revisionCode });
  }
  return { targets: [...out.values()] };
}

export async function projectCodeProfile(db: Db, projectId: string): Promise<CdeCodeProfile> {
  return codeProfile(await loadCodeSettings(db, projectId));
}

// ---- Status -----------------------------------------------------------------------------------

interface MatchedFile {
  id: string;
  folderId: string;
  name: string;
  state: CdeState | null;
  flag: string | null;
  suitabilityCode: string | null;
  revisionCode: string | null;
  at: number;
}

interface CodeMatch {
  registered: boolean;
  files: MatchedFile[];
}

/**
 * The CDE files of planned codes: the containers the document code register gives, plus live files
 * carrying the code (codes from before the register). Trash is left out.
 */
async function matchCodes(db: Db, projectId: string, tree: FolderTree, norms: string[]): Promise<Map<string, CodeMatch>> {
  const out = new Map<string, CodeMatch>(norms.map((n) => [n, { registered: false, files: [] }]));
  if (!norms.length) return out;
  const registered = await db
    .select({ norm: documentCodes.codeNorm, containerId: documentCodes.containerId })
    .from(documentCodes)
    .where(and(eq(documentCodes.projectId, projectId), inArray(documentCodes.codeNorm, norms)));
  const normOfContainer = new Map<string, string>();
  for (const r of registered) {
    out.get(r.norm)!.registered = true;
    normOfContainer.set(r.containerId, r.norm);
  }
  const containers = [...normOfContainer.keys()];
  const byCode = inArray(sql`upper(${files.documentCode})`, norms);
  const rows = await db
    .select({
      id: files.id,
      folderId: files.folderId,
      name: files.name,
      containerId: files.containerId,
      documentCode: files.documentCode,
      flag: files.cdeStatus,
      suitabilityCode: fileVersions.suitabilityCode,
      revisionCode: fileVersions.revisionCode,
      at: fileVersions.uploadedAt,
    })
    .from(files)
    .leftJoin(fileVersions, and(eq(fileVersions.fileId, files.id), eq(fileVersions.version, files.currentVersion)))
    .where(and(eq(files.projectId, projectId), isNull(files.deletedAt), containers.length ? or(inArray(files.containerId, containers), byCode) : byCode));
  for (const r of rows) {
    if (!tree.byId.has(r.folderId)) continue;
    const norm = normOfContainer.get(r.containerId) ?? (r.documentCode ? normalizeDocumentCode(r.documentCode) : null);
    const match = norm ? out.get(norm) : undefined;
    if (!match) continue;
    match.files.push({
      id: r.id,
      folderId: r.folderId,
      name: r.name,
      state: cdeStateOf(tree, r.folderId),
      flag: r.flag ?? null,
      suitabilityCode: r.suitabilityCode ?? null,
      revisionCode: r.revisionCode ?? null,
      at: r.at ? r.at.getTime() : 0,
    });
  }
  return out;
}

/** The most advanced file of a match (latest version first among equals). */
function bestFile(match: CodeMatch): MatchedFile | null {
  let best: MatchedFile | null = null;
  for (const f of match.files) {
    if (!best) {
      best = f;
      continue;
    }
    const a = deliverableRank(fileDeliverableStatus(f.state, f.flag));
    const b = deliverableRank(fileDeliverableStatus(best.state, best.flag));
    if (a > b || (a === b && f.at > best.at)) best = f;
  }
  return best;
}

export function milestoneDto(m: MilestoneRow): DeliveryMilestoneDto {
  return { id: m.id, code: m.code, name: m.name, dueDate: m.dueDate, position: m.position };
}

export async function loadMilestones(db: Db, projectId: string): Promise<MilestoneRow[]> {
  return db
    .select()
    .from(deliveryMilestones)
    .where(eq(deliveryMilestones.projectId, projectId))
    .orderBy(asc(deliveryMilestones.position), asc(deliveryMilestones.dueDate), asc(deliveryMilestones.createdAt));
}

/**
 * The plan as the caller sees it: the milestones, the teams whose TIDP they see, and the rows with
 * their status. `teamId` narrows to one TIDP.
 */
export async function loadDeliveryPlan(db: Db, a: ProjectAccess, opts: { teamId?: string | null; today?: string } = {}): Promise<DeliveryPlanDto> {
  const projectId = a.project.id;
  const scope = await loadPlanScope(db, a);
  const today = opts.today ?? isoDay(new Date());
  const milestones = (await loadMilestones(db, projectId)).map(milestoneDto);
  const rows = (
    await db
      .select()
      .from(deliveryDeliverables)
      .where(eq(deliveryDeliverables.projectId, projectId))
      .orderBy(asc(deliveryDeliverables.position), asc(deliveryDeliverables.createdAt))
  ).filter((r) => canViewTeam(scope, r.teamId) && (!opts.teamId || r.teamId === opts.teamId));
  const tree = await FolderTree.load(db, projectId);
  const matches = await matchCodes(db, projectId, tree, [...new Set(rows.map((r) => r.codeNorm))]);
  const teamById = new Map(scope.teams.map((t) => [t.id, t]));
  const deliverables = rows.map((r): DeliverableDto => {
    const match = matches.get(r.codeNorm) ?? { registered: false, files: [] };
    const status = deliverableStatus(match.files);
    const best = bestFile(match);
    let document: DeliverableDocumentDto | null = null;
    if (best) {
      document = { state: best.state, suitabilityCode: best.suitabilityCode, revisionCode: best.revisionCode };
      if (tree.permission(a.principal, best.folderId).level !== "none") Object.assign(document, { fileId: best.id, folderId: best.folderId, name: best.name });
    }
    return {
      id: r.id,
      teamId: r.teamId,
      teamName: r.teamId ? (teamById.get(r.teamId)?.name ?? null) : null,
      code: r.code,
      title: r.title,
      discipline: r.discipline,
      docType: r.docType,
      targets: r.targets ?? [],
      dueShared: r.dueShared,
      duePublished: r.duePublished,
      notes: r.notes,
      status,
      late: deliverableLate(status, r, today),
      registered: match.registered,
      document,
      canEdit: canEditTeam(scope, r.teamId),
    };
  });
  const leadIds = [...new Set(scope.leads.values())];
  const leadNames = leadIds.length
    ? new Map((await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, leadIds))).map((u) => [u.id, u.name]))
    : new Map<string, string>();
  const teams = scope.teams
    .filter((t) => canViewTeam(scope, t.id))
    .map((t): DeliveryPlanTeamDto => {
      const own = deliverables.filter((d) => d.teamId === t.id);
      const leadUserId = scope.leads.get(t.id) ?? null;
      return {
        ...t,
        leadUserId,
        leadName: leadUserId ? (leadNames.get(leadUserId) ?? null) : null,
        canEdit: canEditTeam(scope, t.id),
        count: own.length,
        late: own.filter((d) => d.late).length,
      };
    });
  return { milestones, teams, deliverables, canManage: scope.admin, today };
}

/** True when the user belongs to the task team. */
export async function isTeamMember(db: Db, projectId: string, teamId: string, userId: string): Promise<boolean> {
  const [row] = await db
    .select({ userId: memberRoles.userId })
    .from(memberRoles)
    .where(and(eq(memberRoles.projectId, projectId), eq(memberRoles.roleId, teamId), eq(memberRoles.userId, userId)));
  return !!row;
}

/** Next position at the end of the project's plan. */
export async function nextPosition(db: Db, projectId: string, table: "deliverables" | "milestones"): Promise<number> {
  const t = table === "deliverables" ? deliveryDeliverables : deliveryMilestones;
  const [row] = await db
    .select({ max: sql<number | null>`max(${t.position})` })
    .from(t)
    .where(eq(t.projectId, projectId));
  return (row?.max ?? -1) + 1;
}

/**
 * A template's `deliveryPlan` block (docs/features/PROJECT_TEMPLATES.md): the milestones, dated
 * `offsetDays` after `start` when given.
 */
export async function applyTemplateDeliveryPlan(db: Db, projectId: string, plan: TemplateDeliveryPlan | undefined, start: Date): Promise<number> {
  const milestones = plan?.milestones ?? [];
  if (!milestones.length) return 0;
  await db.insert(deliveryMilestones).values(
    milestones.map((m, position) => ({
      projectId,
      code: m.code?.trim() || null,
      name: m.name.trim(),
      dueDate: m.offsetDays !== undefined ? isoDay(new Date(start.getTime() + m.offsetDays * 86_400_000)) : null,
      position,
    })),
  );
  return milestones.length;
}
