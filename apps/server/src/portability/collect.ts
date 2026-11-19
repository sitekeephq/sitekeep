/**
 * What a full project export holds (docs/features/PROJECT_EXPORT.md#format): the folders, files and
 * versions the person who asked can see (everything for a system administrator), and the metadata
 * parts: project, folders with their permissions, members, roles and task teams, reviews with their
 * approval steps, transmittals and ISO-12 supersession links. The file bytes are not read here.
 */
import { and, asc, eq, inArray, or } from "drizzle-orm";
import { can, type ExportFolderEntry, type ExportPerson, type ProjectExportScope } from "@sitekeep/shared";
import type { Db } from "../db/index.js";
import {
  cdeSupersessions,
  companies,
  folderSettings,
  memberRoles,
  namingStandards,
  projectCdeSettings,
  projectMembers,
  projectRoles,
  reviewFiles,
  reviewMarks,
  reviews,
  users,
  workEvents,
  workLinks,
  workReceipts,
  workflowActions,
  workflowInstances,
  works,
} from "../db/schema.js";
import { FolderTree, type ProjectAccess } from "../core/security/access.js";
import { cdeStateOf } from "../cde/state.js";
import { chunks, folderPathOf, pickFolders, planVersions, type PlannedEntry } from "../closeout/collect.js";
import { projectTypes, viewerOf } from "../works/work-core.js";
import { canSeeWork } from "@sitekeep/shared";
import { participantWorkIds } from "../works/participants.js";

/** Who asked and what they may see. `full` (system administrators) ignores folder permissions. */
export interface ExportViewer {
  access: ProjectAccess;
  scope: ProjectExportScope;
}

export function exportScopeOf(a: ProjectAccess): ProjectExportScope {
  return a.user.isAdmin ? "full" : "visible";
}

/** True when the viewer's export holds the folder's files. */
export function folderReader(tree: FolderTree, v: ExportViewer): (folderId: string) => boolean {
  if (v.scope === "full") return () => true;
  return (folderId) => tree.byId.has(folderId) && can(tree.permission(v.access.principal, folderId).level, "view");
}

/** The versions of the export (every version of every file the viewer can see). */
export async function planExport(db: Db, v: ExportViewer, tree?: FolderTree): Promise<{ tree: FolderTree; entries: PlannedEntry[] }> {
  tree ??= await FolderTree.load(db, v.access.project.id);
  const reads = folderReader(tree, v);
  const folderMap = pickFolders(tree, (id) => reads(id));
  return { tree, entries: await planVersions(db, v.access.project.id, folderMap, "all") };
}

/** People by id with their e-mail (the key a restore matches them by). */
export class PersonBook {
  private readonly rows = new Map<string, ExportPerson>();
  constructor(private readonly db: Db) {}

  async load(ids: (string | null | undefined)[]): Promise<void> {
    const want = [...new Set(ids.filter((x): x is string => !!x && !this.rows.has(x)))];
    for (const part of chunks(want)) {
      for (const u of await this.db.select({ id: users.id, email: users.email, name: users.name }).from(users).where(inArray(users.id, part))) this.rows.set(u.id, u);
    }
  }

  get(id: string | null | undefined): ExportPerson | null {
    if (!id) return null;
    return this.rows.get(id) ?? { id, email: null, name: null };
  }

  email(id: string | null | undefined): string | null {
    return id ? (this.rows.get(id)?.email ?? null) : null;
  }
}

/** project.json */
export async function projectPart(db: Db, a: ProjectAccess) {
  const p = a.project;
  const [cde] = await db.select().from(projectCdeSettings).where(eq(projectCdeSettings.projectId, p.id));
  const standards = await db.select().from(namingStandards).where(eq(namingStandards.projectId, p.id));
  return {
    id: p.id,
    code: p.code,
    name: p.name,
    description: p.description,
    rootFolderId: p.rootFolderId,
    settings: p.settings,
    createdAt: p.createdAt.toISOString(),
    closedAt: p.closedAt?.toISOString() ?? null,
    cdeSettings: cde
      ? {
          enforceTransitions: cde.enforceTransitions,
          codeScheme: cde.codeScheme,
          suitabilityCodes: cde.suitabilityCodes,
          revisionRules: cde.revisionRules,
          archiveFolderId: cde.archiveFolderId,
          containerStandardId: cde.containerStandardId,
          wipPolicy: cde.wipPolicy,
          adminSeesWip: cde.adminSeesWip,
        }
      : null,
    namingStandards: standards.map((s) => ({ id: s.id, definition: s.definition })),
  };
}

/** folders.json: the folders the viewer sees (or that lead to something they see), with permissions. */
export async function foldersPart(db: Db, tree: FolderTree, v: ExportViewer): Promise<ExportFolderEntry[]> {
  const ids = [...tree.byId.keys()].filter((id) => v.scope === "full" || tree.visible(v.access.principal, id));
  const settings = new Map<string, boolean>();
  for (const part of chunks(ids))
    for (const s of await db.select().from(folderSettings).where(inArray(folderSettings.folderId, part))) settings.set(s.folderId, s.requireApprovedReview);
  const out: ExportFolderEntry[] = ids.map((id) => {
    const f = tree.get(id);
    return {
      id: f.id,
      parentId: f.parentId,
      path: folderPathOf(tree, f.id),
      name: f.name,
      description: f.description,
      state: f.state,
      cdeState: cdeStateOf(tree, f.id),
      stateLabel: f.stateLabel,
      namingStandardId: f.namingStandardId,
      ownerTeamId: f.ownerTeamId,
      requireApprovedReview: settings.get(f.id) ?? false,
      createdAt: f.createdAt.toISOString(),
      grants: tree.grants.filter((g) => g.folderId === f.id).map((g) => ({ subjectType: g.subjectType, subjectId: g.subjectId, level: g.level })),
    };
  });
  // Parents before children (a restore creates them in this order).
  const depth = (f: ExportFolderEntry) => tree.ancestry(f.id).length;
  return out.sort((x, y) => depth(x) - depth(y) || x.path.localeCompare(y.path, "tr"));
}

/** members.json: companies, members, roles and task teams. */
export async function membersPart(db: Db, projectId: string, people: PersonBook) {
  const members = await db.select().from(projectMembers).where(eq(projectMembers.projectId, projectId));
  const roles = await db.select().from(projectRoles).where(eq(projectRoles.projectId, projectId)).orderBy(asc(projectRoles.name));
  const held = await db.select().from(memberRoles).where(eq(memberRoles.projectId, projectId));
  await people.load(members.map((m) => m.userId));
  const companyIds = [...new Set([...members.map((m) => m.companyId), ...roles.map((r) => r.companyId)].filter((x): x is string => !!x))];
  const companyRows = companyIds.length ? await db.select().from(companies).where(inArray(companies.id, companyIds)) : [];
  return {
    companies: companyRows.map((c) => ({ id: c.id, name: c.name, code: c.code })),
    members: members.map((m) => ({
      userId: m.userId,
      email: people.email(m.userId),
      name: people.get(m.userId)?.name ?? null,
      companyId: m.companyId,
      isProjectAdmin: m.isProjectAdmin,
      roleIds: held.filter((h) => h.userId === m.userId).map((h) => h.roleId),
      addedAt: m.addedAt.toISOString(),
    })),
    roles: roles.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      color: r.color,
      kind: r.kind,
      companyId: r.companyId,
      code: r.code,
      isLead: r.isLead,
    })),
  };
}

/**
 * reviews.json: reviews with their workflow, step actions and the reviewed files with every
 * reviewer's mark. `visible` exports keep only the files in the export (and the reviews with any).
 */
export async function reviewsPart(db: Db, projectId: string, inExport: Set<string>, pathOf: Map<string, string>, scope: ProjectExportScope, people: PersonBook) {
  const all = await db.select().from(reviews).where(eq(reviews.projectId, projectId)).orderBy(asc(reviews.number));
  const rf: (typeof reviewFiles.$inferSelect)[] = [];
  for (const part of chunks(all.map((r) => r.id))) rf.push(...(await db.select().from(reviewFiles).where(inArray(reviewFiles.reviewId, part))));
  const keep = scope === "full" ? rf : rf.filter((f) => inExport.has(f.fileVersionId) || (f.copiedVersionId !== null && inExport.has(f.copiedVersionId)));
  const reviewIds = scope === "full" ? all.map((r) => r.id) : [...new Set(keep.map((f) => f.reviewId))];
  const list = all.filter((r) => reviewIds.includes(r.id));
  const marks: (typeof reviewMarks.$inferSelect)[] = [];
  for (const part of chunks(keep.map((f) => f.id))) marks.push(...(await db.select().from(reviewMarks).where(inArray(reviewMarks.reviewFileId, part))));
  const instances: (typeof workflowInstances.$inferSelect)[] = [];
  for (const part of chunks(reviewIds))
    instances.push(...(await db.select().from(workflowInstances).where(and(eq(workflowInstances.subjectType, "review"), inArray(workflowInstances.subjectId, part)))));
  const actions: (typeof workflowActions.$inferSelect)[] = [];
  for (const part of chunks(instances.map((i) => i.id)))
    actions.push(...(await db.select().from(workflowActions).where(inArray(workflowActions.instanceId, part)).orderBy(asc(workflowActions.at))));
  await people.load([...list.map((r) => r.createdBy), ...marks.map((m) => m.userId), ...actions.map((x) => x.userId), ...instances.map((i) => i.startedBy)]);

  return list.map((r) => {
    const inst = instances.find((i) => i.subjectId === r.id);
    return {
      id: r.id,
      number: r.number,
      code: r.code,
      name: r.name,
      note: r.note,
      targetFolderId: r.targetFolderId,
      createdBy: people.get(r.createdBy),
      createdAt: r.createdAt.toISOString(),
      workflow: inst
        ? {
            name: inst.template.name,
            status: inst.status,
            stepIndex: inst.stepIndex,
            steps: inst.template.steps,
            startedBy: people.get(inst.startedBy),
            createdAt: inst.createdAt.toISOString(),
            completedAt: inst.completedAt?.toISOString() ?? null,
            actions: actions
              .filter((x) => x.instanceId === inst.id)
              .map((x) => ({ step: x.stepIndex + 1, kind: x.kind, by: people.get(x.userId), outcome: x.outcome, comment: x.comment, details: x.details, at: x.at.toISOString() })),
          }
        : null,
      files: keep
        .filter((f) => f.reviewId === r.id)
        .map((f) => ({
          fileId: f.fileId,
          versionId: f.fileVersionId,
          path: pathOf.get(f.fileVersionId) ?? null,
          finalStatus: f.finalStatus,
          finalLabel: f.finalLabel,
          decidedAt: f.decidedAt?.toISOString() ?? null,
          stepResults: f.stepResults,
          stepCodes: f.stepCodes,
          stoppedAtStep: f.stoppedAtStep,
          copiedFileId: f.copiedFileId,
          copiedVersionId: f.copiedVersionId,
          copiedPath: f.copiedVersionId ? (pathOf.get(f.copiedVersionId) ?? null) : null,
          marks: marks
            .filter((m) => m.reviewFileId === f.id)
            .sort((x, y) => x.stepIndex - y.stepIndex || x.at.getTime() - y.at.getTime())
            .map((m) => ({ step: m.stepIndex + 1, by: people.get(m.userId), outcome: m.outcome, optionCode: m.optionCode, comment: m.comment, at: m.at.toISOString() })),
        })),
    };
  });
}

/** transmittals.json: works of the transmittal category the viewer sees, with links, events and receipts. */
export async function transmittalsPart(db: Db, v: ExportViewer, inExport: Set<string>, pathOf: Map<string, string>, people: PersonBook) {
  const a = v.access;
  const types = (await projectTypes(db, a.project.id)).filter((t) => t.category === "transmittal");
  if (!types.length) return [];
  let rows = await db
    .select()
    .from(works)
    .where(and(eq(works.projectId, a.project.id), inArray(works.typeId, types.map((t) => t.id))))
    .orderBy(asc(works.createdAt));
  if (v.scope === "visible") {
    const viewer = viewerOf(a);
    const hidden = rows.filter((w) => !canSeeWork(w, viewer)).map((w) => w.id);
    const extra = await participantWorkIds(db, a, hidden);
    rows = rows.filter((w) => canSeeWork(w, viewer) || extra.has(w.id));
  }
  const ids = rows.map((w) => w.id);
  const links: (typeof workLinks.$inferSelect)[] = [];
  const events: (typeof workEvents.$inferSelect)[] = [];
  const receipts: (typeof workReceipts.$inferSelect)[] = [];
  for (const part of chunks(ids)) {
    links.push(...(await db.select().from(workLinks).where(inArray(workLinks.workId, part))));
    events.push(...(await db.select().from(workEvents).where(inArray(workEvents.workId, part)).orderBy(asc(workEvents.at))));
    receipts.push(...(await db.select().from(workReceipts).where(inArray(workReceipts.workId, part))));
  }
  const companyIds = [...new Set(rows.flatMap((w) => [w.fromCompanyId, w.ownerCompanyId, ...w.toCompanyIds, ...w.ccCompanyIds]).concat(receipts.map((r) => r.companyId)).filter((x): x is string => !!x))];
  const companyRows = companyIds.length ? await db.select().from(companies).where(inArray(companies.id, companyIds)) : [];
  const company = (id: string | null) => {
    const c = id ? companyRows.find((x) => x.id === id) : undefined;
    return c ? { id: c.id, name: c.name, code: c.code } : id ? { id, name: null, code: null } : null;
  };
  await people.load([...rows.flatMap((w) => [w.createdBy, w.assigneeUserId]), ...events.map((e) => e.userId), ...receipts.map((r) => r.receivedBy)]);
  return rows.map((w) => {
    const type = types.find((t) => t.id === w.typeId)!;
    return {
      id: w.id,
      type: { key: type.key, name: type.name },
      number: w.number,
      title: w.title,
      status: w.status,
      fields: w.fields,
      from: company(w.fromCompanyId),
      to: w.toCompanyIds.map(company),
      cc: w.ccCompanyIds.map(company),
      assignee: people.get(w.assigneeUserId),
      dueDate: w.dueDate,
      replyRequired: w.replyRequired,
      delivery: w.delivery,
      createdBy: people.get(w.createdBy),
      createdAt: w.createdAt.toISOString(),
      sentAt: w.sentAt?.toISOString() ?? null,
      closedAt: w.closedAt?.toISOString() ?? null,
      // A visible export names a file version only when that version is in it.
      links: links
        .filter((l) => l.workId === w.id && (l.kind !== "file_version" || v.scope === "full" || inExport.has(l.targetId)))
        .map((l) => ({ kind: l.kind, targetId: l.targetId, role: l.role, meta: l.meta, path: l.kind === "file_version" ? (pathOf.get(l.targetId) ?? null) : null })),
      events: events.filter((e) => e.workId === w.id).map((e) => ({ kind: e.kind, by: people.get(e.userId), message: e.message, details: e.details, at: e.at.toISOString() })),
      receipts: receipts.filter((r) => r.workId === w.id).map((r) => ({ company: company(r.companyId), by: people.get(r.receivedBy), at: r.receivedAt.toISOString() })),
    };
  });
}

/** supersessions.json: ISO-12 links between versions in the export. */
export async function supersessionsPart(db: Db, projectId: string, inExport: Set<string>) {
  const ids = [...inExport];
  const rows: (typeof cdeSupersessions.$inferSelect)[] = [];
  for (const part of chunks(ids))
    rows.push(
      ...(await db
        .select()
        .from(cdeSupersessions)
        .where(and(eq(cdeSupersessions.projectId, projectId), or(inArray(cdeSupersessions.versionId, part), inArray(cdeSupersessions.supersededVersionId, part))))),
    );
  const seen = new Set<string>();
  return rows
    .filter((r) => inExport.has(r.versionId) && inExport.has(r.supersededVersionId))
    .filter((r) => {
      const k = `${r.versionId}:${r.supersededVersionId}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .map((r) => ({ versionId: r.versionId, supersededVersionId: r.supersededVersionId, reviewId: r.reviewId, createdAt: r.createdAt.toISOString() }));
}
