/**
 * ISO-12 (ISO 19650-1 §12.5): reads the supersession links of versions, both ways. Written by
 * cde/archive.ts (`recordArchive`) when a publication archives the current one; migration 0050
 * backfills the archive copies made before it. The other side is linked only when the caller may
 * see it (view on its folder, or its own upload where the folder allows uploads; not hidden by the
 * task-team WIP rule; not in the trash); otherwise only its name and codes are returned.
 */
import { and, eq, inArray, or } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { can, type SupersessionLinkDto } from "@sitekeep/shared";
import type { Db } from "../db/index.js";
import { cdeSupersessions, fileVersions, files } from "../db/schema.js";
import { hiddenByWipRule, type FolderTree, type ProjectAccess } from "../core/security/access.js";

export interface VersionSupersessions {
  supersededBy: SupersessionLinkDto[];
  supersedes: SupersessionLinkDto[];
}

type FileLite = { id: string; folderId: string; name: string; createdBy: string | null; deletedAt: Date | null };
type VersionLite = { id: string; version: number; revisionCode: string | null; suitabilityCode: string | null };

function canSee(tree: FolderTree, a: Pick<ProjectAccess, "principal" | "user">, f: FileLite): boolean {
  if (f.deletedAt || !tree.byId.has(f.folderId)) return false;
  const perm = tree.permission(a.principal, f.folderId);
  return can(perm.level, "view") || (perm.canUpload && f.createdBy === a.user.id);
}

function link(tree: FolderTree, a: Pick<ProjectAccess, "principal" | "user">, f: FileLite, v: VersionLite, at: Date): SupersessionLinkDto {
  const visible = canSee(tree, a, f);
  const hidden = !visible && hiddenByWipRule(tree, a.principal, f.folderId);
  return {
    fileId: visible ? f.id : null,
    folderId: visible ? f.folderId : null,
    versionId: visible ? v.id : null,
    name: hidden ? "…" : f.name,
    version: v.version,
    revisionCode: v.revisionCode ?? null,
    suitabilityCode: v.suitabilityCode ?? null,
    at: at.toISOString(),
  };
}

/** Supersession links of the given versions (one project), keyed by version id; versions without any are left out. */
export async function supersessionsOf(
  db: Db,
  projectId: string,
  versionIds: string[],
  tree: FolderTree,
  a: Pick<ProjectAccess, "principal" | "user">,
): Promise<Map<string, VersionSupersessions>> {
  const out = new Map<string, VersionSupersessions>();
  if (!versionIds.length) return out;
  const rows = await db
    .select()
    .from(cdeSupersessions)
    .where(
      and(
        eq(cdeSupersessions.projectId, projectId),
        or(inArray(cdeSupersessions.versionId, versionIds), inArray(cdeSupersessions.supersededVersionId, versionIds)),
      ),
    );
  if (!rows.length) return out;
  const otherIds = [...new Set(rows.flatMap((r) => [r.versionId, r.supersededVersionId]))];
  const v = alias(fileVersions, "v");
  const others = await db
    .select({
      file: { id: files.id, folderId: files.folderId, name: files.name, createdBy: files.createdBy, deletedAt: files.deletedAt },
      version: { id: v.id, version: v.version, revisionCode: v.revisionCode, suitabilityCode: v.suitabilityCode },
    })
    .from(v)
    .innerJoin(files, eq(files.id, v.fileId))
    .where(and(inArray(v.id, otherIds), eq(files.projectId, projectId)));
  const byId = new Map(others.map((o) => [o.version.id, o]));
  const entry = (id: string) => {
    let e = out.get(id);
    if (!e) out.set(id, (e = { supersededBy: [], supersedes: [] }));
    return e;
  };
  const wanted = new Set(versionIds);
  for (const r of rows.sort((x, y) => x.createdAt.getTime() - y.createdAt.getTime())) {
    const newer = byId.get(r.versionId);
    const older = byId.get(r.supersededVersionId);
    if (wanted.has(r.supersededVersionId) && newer) entry(r.supersededVersionId).supersededBy.push(link(tree, a, newer.file, newer.version, r.createdAt));
    if (wanted.has(r.versionId) && older) entry(r.versionId).supersedes.push(link(tree, a, older.file, older.version, r.createdAt));
  }
  return out;
}
