/**
 * What goes into a close-out archive (docs/features/CLOSEOUT_ARCHIVE.md#contents): the versions of
 * the files in the Published and Archived folders (and Shared when asked), their paths inside the
 * ZIP, and the metadata of manifest.json: codes, state, uploader, approvals, supersession links
 * and the naming standard check.
 */
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import {
  splitExtension,
  validateName,
  type CdeState,
  type CloseoutApproval,
  type CloseoutEstimate,
  type CloseoutManifestEntry,
  type CloseoutOptions,
  type CloseoutVersionRef,
  type NamingStandard,
} from "@sitekeep/shared";
import type { Db } from "../db/index.js";
import {
  cdeSupersessions,
  fileVersions,
  files,
  namingStandards,
  reviewFiles,
  reviewMarks,
  reviews,
  workflowInstances,
} from "../db/schema.js";
import { FolderTree, userNames } from "../core/security/access.js";
import { cdeStateOf } from "../cde/state.js";
import { versionedName } from "../modules/documents/zip.js";

type FileRow = typeof files.$inferSelect;
type VersionRow = typeof fileVersions.$inferSelect;

/** One version to put in the archive. */
export interface PlannedEntry {
  path: string;
  file: FileRow;
  version: VersionRow;
  latest: boolean;
  folderPath: string;
  /** CDE state of the folder (own or nearest ancestor's); null only in a project export. */
  state: CdeState | null;
}

const CHUNK = 1000;

export function chunks<T>(list: T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/** A folder or file name as one ZIP path segment: no separators, no control characters. */
export function segment(name: string): string {
  const s = name.replace(/[\\/]/g, "_").replace(/[\u0000-\u001f]/g, "").trim();
  return s === "" || s === "." || s === ".." ? "_" : s;
}

export function statesOf(options: Pick<CloseoutOptions, "includeShared">): CdeState[] {
  return options.includeShared ? ["shared", "published", "archived"] : ["published", "archived"];
}

/**
 * Folders picked by `pick` (given the folder and its CDE state), with their path from the project
 * root (root left out) and their state. Shared with the project export (portability/collect.ts).
 */
export function pickFolders(tree: FolderTree, pick: (folderId: string, state: CdeState | null) => boolean): Map<string, { path: string; state: CdeState | null }> {
  const out = new Map<string, { path: string; state: CdeState | null }>();
  for (const f of tree.byId.values()) {
    const state = cdeStateOf(tree, f.id);
    if (!pick(f.id, state)) continue;
    out.set(f.id, { path: folderPathOf(tree, f.id), state });
  }
  return out;
}

/** A folder's path from the project root (root left out), as ZIP path segments. */
export function folderPathOf(tree: FolderTree, folderId: string): string {
  return tree
    .ancestry(folderId)
    .map((id) => tree.get(id))
    .filter((x) => x.parentId !== null)
    .map((x) => segment(x.name))
    .join("/");
}

/** The versions of the archive, in folder and name order, each with a unique path under files/. */
export async function planEntries(db: Db, projectId: string, options: Pick<CloseoutOptions, "includeShared" | "versions">, tree?: FolderTree): Promise<{ tree: FolderTree; entries: PlannedEntry[] }> {
  tree ??= await FolderTree.load(db, projectId);
  const states = statesOf(options);
  const folderMap = pickFolders(tree, (_id, state) => !!state && states.includes(state));
  return { tree, entries: await planVersions(db, projectId, folderMap, options.versions) };
}

/**
 * The versions of the files in the given folders (all, or the current one of each file), in folder
 * and name order, each with a unique path under files/: the current version keeps the file's name,
 * older ones are `name (V2).ext`, names that differ only in case get ` (2)`.
 */
export async function planVersions(
  db: Db,
  projectId: string,
  folderMap: Map<string, { path: string; state: CdeState | null }>,
  versions: CloseoutOptions["versions"],
): Promise<PlannedEntry[]> {
  const entries: PlannedEntry[] = [];
  if (!folderMap.size) return entries;
  const fileRows: FileRow[] = [];
  for (const ids of chunks([...folderMap.keys()]))
    fileRows.push(...(await db.select().from(files).where(and(eq(files.projectId, projectId), inArray(files.folderId, ids), isNull(files.deletedAt)))));
  const byFile = new Map(fileRows.map((f) => [f.id, f]));
  const versionRows: VersionRow[] = [];
  for (const ids of chunks([...byFile.keys()])) {
    const rows = await db.select().from(fileVersions).where(inArray(fileVersions.fileId, ids));
    versionRows.push(...(versions === "all" ? rows : rows.filter((v) => v.version === byFile.get(v.fileId)!.currentVersion)));
  }
  for (const v of versionRows) {
    const file = byFile.get(v.fileId)!;
    const folder = folderMap.get(file.folderId)!;
    const latest = v.version === file.currentVersion;
    const name = segment(latest ? file.name : versionedName(file.name, v.version));
    entries.push({ path: ["files", folder.path, name].filter(Boolean).join("/"), file, version: v, latest, folderPath: folder.path, state: folder.state });
  }
  entries.sort((a, b) => a.path.localeCompare(b.path, "tr") || b.version.version - a.version.version);
  // Unique paths (case-insensitive, as most file systems see them).
  const used = new Set<string>();
  for (const e of entries) {
    let p = e.path;
    for (let n = 2; used.has(p.toLowerCase()); n++) {
      const slash = e.path.lastIndexOf("/") + 1;
      const { base, extension } = splitExtension(e.path.slice(slash));
      p = `${e.path.slice(0, slash)}${base} (${n})${extension ? `.${extension}` : ""}`;
    }
    used.add(p.toLowerCase());
    e.path = p;
  }
  return entries;
}

/** Files, versions and bytes the archive would hold, for each choice of options. */
export async function estimate(db: Db, projectId: string): Promise<{ latest: CloseoutEstimate; all: CloseoutEstimate; sharedLatest: CloseoutEstimate; sharedAll: CloseoutEstimate }> {
  const tree = await FolderTree.load(db, projectId);
  const sum = (entries: PlannedEntry[]): CloseoutEstimate => ({
    files: new Set(entries.map((e) => e.file.id)).size,
    versions: entries.length,
    bytes: entries.reduce((n, e) => n + e.version.size, 0),
  });
  const [all, sharedAll] = await Promise.all([
    planEntries(db, projectId, { includeShared: false, versions: "all" }, tree),
    planEntries(db, projectId, { includeShared: true, versions: "all" }, tree),
  ]);
  return {
    latest: sum(all.entries.filter((e) => e.latest)),
    all: sum(all.entries),
    sharedLatest: sum(sharedAll.entries.filter((e) => e.latest)),
    sharedAll: sum(sharedAll.entries),
  };
}

/** What the manifest needs beyond the planned entry; `integrity` is filled while the ZIP is written. */
export type ManifestEntry = Omit<CloseoutManifestEntry, "integrity">;

/**
 * The metadata of each planned version: uploader, approvals (reviews that took it in, and the
 * review whose approved copy it is), ISO-12 supersession links and the naming standard result.
 */
export async function describeEntries(db: Db, projectId: string, tree: FolderTree, entries: PlannedEntry[]): Promise<ManifestEntry[]> {
  const versionIds = entries.map((e) => e.version.id);
  const pathByVersion = new Map(entries.map((e) => [e.version.id, e.path]));

  // Approvals.
  const rfRows: (typeof reviewFiles.$inferSelect)[] = [];
  for (const ids of chunks(versionIds))
    rfRows.push(...(await db.select().from(reviewFiles).where(or(inArray(reviewFiles.fileVersionId, ids), inArray(reviewFiles.copiedVersionId, ids)))));
  const reviewIds = [...new Set(rfRows.map((r) => r.reviewId))];
  const reviewRows: (typeof reviews.$inferSelect)[] = [];
  const instanceRows: { subjectId: string; name: string }[] = [];
  for (const ids of chunks(reviewIds)) {
    reviewRows.push(...(await db.select().from(reviews).where(inArray(reviews.id, ids))));
    const inst = await db
      .select({ subjectId: workflowInstances.subjectId, template: workflowInstances.template })
      .from(workflowInstances)
      .where(and(eq(workflowInstances.subjectType, "review"), inArray(workflowInstances.subjectId, ids)));
    instanceRows.push(...inst.map((i) => ({ subjectId: i.subjectId, name: i.template.name })));
  }
  const reviewById = new Map(reviewRows.map((r) => [r.id, r]));
  const workflowByReview = new Map(instanceRows.map((i) => [i.subjectId, i.name]));
  const marks: (typeof reviewMarks.$inferSelect)[] = [];
  for (const ids of chunks(rfRows.map((r) => r.id))) marks.push(...(await db.select().from(reviewMarks).where(inArray(reviewMarks.reviewFileId, ids))));
  const marksByRf = new Map<string, (typeof reviewMarks.$inferSelect)[]>();
  for (const m of marks) marksByRf.set(m.reviewFileId, [...(marksByRf.get(m.reviewFileId) ?? []), m]);

  // Supersession links (ISO-12) and the versions on their other side.
  const links: (typeof cdeSupersessions.$inferSelect)[] = [];
  for (const ids of chunks(versionIds))
    links.push(
      ...(await db
        .select()
        .from(cdeSupersessions)
        .where(and(eq(cdeSupersessions.projectId, projectId), or(inArray(cdeSupersessions.versionId, ids), inArray(cdeSupersessions.supersededVersionId, ids))))),
    );
  const otherIds = [...new Set(links.flatMap((l) => [l.versionId, l.supersededVersionId]))];
  const others = new Map<string, VersionRow>();
  for (const ids of chunks(otherIds)) for (const v of await db.select().from(fileVersions).where(inArray(fileVersions.id, ids))) others.set(v.id, v);
  const ref = (versionId: string): CloseoutVersionRef | null => {
    const v = others.get(versionId);
    return v ? { fileId: v.fileId, versionId: v.id, version: v.version, revision: v.revisionCode, path: pathByVersion.get(v.id) ?? null } : null;
  };

  // Naming standards.
  const standards = new Map(
    (await db.select().from(namingStandards).where(eq(namingStandards.projectId, projectId))).map((s) => [s.id, s.definition as NamingStandard]),
  );

  const names = await userNames(db, [...entries.map((e) => e.version.uploadedBy), ...marks.map((m) => m.userId)]);

  // Lookups by version id (large projects: no scans per entry).
  const group = <T,>(rows: T[], keys: (r: T) => (string | null)[]) => {
    const m = new Map<string, T[]>();
    for (const r of rows) for (const k of new Set(keys(r))) if (k) m.set(k, [...(m.get(k) ?? []), r]);
    return m;
  };
  const rfByVersion = group(rfRows, (rf) => [rf.fileVersionId, rf.copiedVersionId]);
  const supersededByOf = group(links, (l) => [l.supersededVersionId]);
  const supersedesOf = group(links, (l) => [l.versionId]);

  return entries.map((e) => {
    const v = e.version;
    const approvals: CloseoutApproval[] = (rfByVersion.get(v.id) ?? [])
      .map((rf) => {
        const r = reviewById.get(rf.reviewId);
        return {
          reviewId: rf.reviewId,
          review: r ? [r.code ?? `#${r.number}`, r.name].join(" ") : rf.reviewId,
          workflow: workflowByReview.get(rf.reviewId) ?? null,
          role: rf.fileVersionId === v.id ? "reviewed" : "result",
          outcome: rf.finalStatus ?? null,
          outcomeLabel: rf.finalLabel ?? null,
          decidedAt: rf.decidedAt?.toISOString() ?? null,
          steps: (marksByRf.get(rf.id) ?? [])
            .sort((a, b) => a.stepIndex - b.stepIndex || a.at.getTime() - b.at.getTime())
            .map((m) => ({ step: m.stepIndex + 1, by: names.get(m.userId) ?? m.userId, outcome: m.optionCode ?? m.outcome, at: m.at.toISOString(), comment: m.comment ?? null })),
        };
      });
    const standardId = tree.namingStandardId(e.file.folderId);
    const standard = standardId ? standards.get(standardId) : undefined;
    const naming = standard ? (({ ok, errors }) => ({ standard: standard.name, ok, errors }))(validateName(standard, e.file.name, "en")) : null;
    return {
      path: e.path,
      fileId: e.file.id,
      versionId: v.id,
      version: v.version,
      latest: e.latest,
      name: e.file.name,
      folderPath: e.folderPath,
      documentCode: e.file.documentCode ?? null,
      containerId: e.file.containerId,
      revision: v.revisionCode ?? null,
      suitability: v.suitabilityCode ?? null,
      cdeState: e.state ?? "",
      cdeStatus: e.file.cdeStatus ?? null,
      size: v.size,
      sha256: v.sha256,
      uploadedBy: v.uploadedBy ? (names.get(v.uploadedBy) ?? v.uploadedBy) : null,
      uploadedAt: v.uploadedAt.toISOString(),
      approvals,
      supersededBy: (supersededByOf.get(v.id) ?? []).map((l) => ref(l.versionId)).filter((x): x is CloseoutVersionRef => !!x),
      supersedes: (supersedesOf.get(v.id) ?? []).map((l) => ref(l.supersededVersionId)).filter((x): x is CloseoutVersionRef => !!x),
      naming,
    };
  });
}
