import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  can,
  canSeeWork,
  foldTr,
  type WorkLinkDto,
  type WorkLinkKind,
  type WorkLinkMeta,
  type WorkLinkRole,
  projectPath,
} from "@sitekeep/shared";
import { FolderTree, type ProjectAccess } from "../core/security/access.js";
import { badRequest, notFound } from "../core/platform/http.js";
import type { Db } from "../db/index.js";
import { DEFAULT_LANGUAGE, msg, tFor } from "../i18n/index.js";
import { fileVersions, files, issues, reviews, workLinks, works, workTypes } from "../db/schema.js";
import { statusDef, viewerOf, workLink } from "./work-core.js";

export type LinkRow = typeof workLinks.$inferSelect;

export interface LinkInput {
  kind: WorkLinkKind;
  targetId: string;
  role?: WorkLinkRole;
  meta?: WorkLinkMeta;
}

export function defaultRole(kind: WorkLinkKind): WorkLinkRole {
  return kind === "file_version" ? "ek" : "ilgi";
}

export function dedupeLinks(links: LinkInput[]): LinkInput[] {
  const seen = new Set<string>();
  return links.filter((l) => {
    const k = `${l.kind}:${l.targetId}:${l.role ?? defaultRole(l.kind)}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export async function checkLinkTarget(db: Db, a: ProjectAccess, input: LinkInput, selfId: string | null): Promise<void> {
  const pid = a.project.id;
  switch (input.kind) {
    case "file_version": {
      const [row] = await db
        .select({ folderId: files.folderId })
        .from(fileVersions)
        .innerJoin(files, eq(files.id, fileVersions.fileId))
        .where(and(eq(fileVersions.id, input.targetId), eq(files.projectId, pid), isNull(files.deletedAt)));
      if (!row) throw notFound(msg("works:entities.version"));
      const tree = await FolderTree.load(db, pid);
      if (!tree.byId.has(row.folderId) || !can(tree.permission(a.principal, row.folderId).level, "view"))
        throw notFound(msg("works:entities.version"));
      return;
    }
    case "review": {
      const [row] = await db.select({ id: reviews.id }).from(reviews).where(and(eq(reviews.id, input.targetId), eq(reviews.projectId, pid)));
      if (!row) throw notFound(msg("works:entities.review"));
      return;
    }
    case "issue": {
      const [row] = await db.select({ id: issues.id }).from(issues).where(and(eq(issues.id, input.targetId), eq(issues.projectId, pid)));
      if (!row) throw notFound(msg("works:entities.issue"));
      return;
    }
    case "work": {
      if (input.targetId === selfId) throw badRequest(msg("works:errors.linkToSelf"));
      const [row] = await db.select().from(works).where(and(eq(works.id, input.targetId), eq(works.projectId, pid)));
      if (!row || !canSeeWork(row, viewerOf(a))) throw notFound(msg("works:entities.work"));
    }
  }
}

export function revisionOf(attributes: Record<string, string>): string | null {
  for (const [k, v] of Object.entries(attributes)) if (foldTr(k).replace(/\s+/g, "").startsWith("rev") && v) return v;
  return null;
}

export async function resolveLinks(
  db: Db,
  a: ProjectAccess,
  rows: (LinkRow & { incoming?: boolean })[],
  lang: string = DEFAULT_LANGUAGE,
): Promise<WorkLinkDto[]> {
  const t = tFor(lang);
  const pid = a.project.id;
  const ids = (k: WorkLinkKind) => [...new Set(rows.filter((r) => r.kind === k && !r.incoming).map((r) => r.targetId))];
  const versionRows = ids("file_version").length
    ? await db
        .select({ v: fileVersions, f: files })
        .from(fileVersions)
        .innerJoin(files, eq(files.id, fileVersions.fileId))
        .where(inArray(fileVersions.id, ids("file_version")))
    : [];
  const reviewRows = ids("review").length ? await db.select().from(reviews).where(inArray(reviews.id, ids("review"))) : [];
  const issueRows = ids("issue").length ? await db.select().from(issues).where(inArray(issues.id, ids("issue"))) : [];
  const workIds = [...new Set(rows.filter((r) => r.kind === "work").map((r) => (r.incoming ? r.workId : r.targetId)))];
  const workRows = workIds.length
    ? await db
        .select({ w: works, t: workTypes })
        .from(works)
        .innerJoin(workTypes, eq(workTypes.id, works.typeId))
        .where(inArray(works.id, workIds))
    : [];
  const viewer = viewerOf(a);
  const out: WorkLinkDto[] = [];
  for (const r of rows) {
    const base = {
      id: r.id,
      kind: r.kind,
      targetId: r.targetId,
      role: r.role,
      meta: r.meta,
      createdAt: r.createdAt.toISOString(),
      ...(r.incoming ? { incoming: true, sourceWorkId: r.workId } : {}),
    };
    let target: WorkLinkDto["target"] = { label: t("works:links.missing"), link: null, missing: true };
    if (r.kind === "file_version") {
      const x = versionRows.find((v) => v.v.id === r.targetId);
      if (x)
        target = {
          label: x.f.name,
          link: x.f.name.toLowerCase().endsWith(".pdf") ? projectPath(pid, `view/${x.v.id}`) : null,
          version: x.v.version,
          fileId: x.f.id,
          revision: revisionOf(x.f.attributes),
          missing: !!x.f.deletedAt,
        };
    } else if (r.kind === "review") {
      const x = reviewRows.find((v) => v.id === r.targetId);
      if (x) target = { label: t("works:links.review", { number: x.number, name: x.name }), link: projectPath(pid, `reviews/${x.id}`) };
    } else if (r.kind === "issue") {
      const x = issueRows.find((v) => v.id === r.targetId);
      if (x) target = { label: t("works:links.issue", { number: x.number, title: x.title }), link: projectPath(pid, `issues/${x.id}`), status: x.status };
    } else {
      const wid = r.incoming ? r.workId : r.targetId;
      const x = workRows.find((v) => v.w.id === wid);
      if (x && canSeeWork(x.w, viewer))
        target = {
          label: `${x.w.number} · ${x.w.title}`,
          link: workLink(pid, x.w.id),
          status: statusDef(x.t, x.w.status).label,
        };
    }
    out.push({ ...base, target });
  }
  return out;
}
