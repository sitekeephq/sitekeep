/** Database helpers for review chains: file fields, review numbers and smart copy folders. */
import { and, eq, isNull, sql } from "drizzle-orm";
import type { NamingStandard } from "@sitekeep/shared";
import { FolderTree } from "../core/security/access.js";
import { audit } from "../core/platform/audit.js";
import type { Db } from "../db/index.js";
import { folders, reviewCounters } from "../db/schema.js";
import { DEFAULT_LANGUAGE, render, msg } from "../i18n/index.js";
import { standardForFolder } from "../modules/documents/naming-routes.js";

/** Caches the naming standard per folder while a request runs. */
export class StandardCache {
  private readonly cache = new Map<string, NamingStandard | null>();
  constructor(
    private readonly db: Db,
    private tree: FolderTree,
  ) {}

  setTree(tree: FolderTree) {
    this.tree = tree;
    this.cache.clear();
  }

  async get(folderId: string | null | undefined): Promise<NamingStandard | null> {
    if (!folderId || !this.tree.byId.has(folderId)) return null;
    const sid = this.tree.namingStandardId(folderId) ?? "";
    if (!this.cache.has(sid)) this.cache.set(sid, await standardForFolder(this.db, this.tree, folderId));
    return this.cache.get(sid)!;
  }

  /** Standard of the source folder, else the one of the fallback (target) folder. */
  async forFile(sourceFolderId: string, fallbackFolderId: string | null): Promise<NamingStandard | null> {
    return (await this.get(sourceFolderId)) ?? (await this.get(fallbackFolderId));
  }
}

/** Next number for a review-number prefix ("MBE-RP-{0000}"), unique per project and prefix. */
export async function nextReviewCounter(tx: Db, projectId: string, scope: string): Promise<number> {
  const [row] = await tx
    .insert(reviewCounters)
    .values({ projectId, scope, value: 1 })
    .onConflictDoUpdate({
      target: [reviewCounters.projectId, reviewCounters.scope],
      set: { value: sql`${reviewCounters.value} + 1` },
    })
    .returning();
  return row!.value;
}

/** The number the next review with this prefix would get (preview only, nothing reserved). */
export async function peekReviewCounter(db: Db, projectId: string, scope: string): Promise<number> {
  const [row] = await db
    .select()
    .from(reviewCounters)
    .where(and(eq(reviewCounters.projectId, projectId), eq(reviewCounters.scope, scope)));
  return (row?.value ?? 0) + 1;
}

const SEPARATORS = [" ", "-", "_", ".", "–"];

/**
 * The child of `parentId` for a path segment: a folder with exactly that name, else one whose
 * name starts with the segment followed by a separator ("S20" → "S20 - Bölge Parkı İstasyonu").
 */
export function matchChild(tree: FolderTree, parentId: string, segment: string) {
  const kids = tree.children.get(parentId) ?? [];
  const lower = segment.toLocaleLowerCase("tr-TR");
  return (
    kids.find((f) => f.name === segment) ??
    kids.find((f) => f.name.toLocaleLowerCase("tr-TR") === lower) ??
    kids.find((f) => {
      const n = f.name.toLocaleLowerCase("tr-TR");
      return n.startsWith(lower) && SEPARATORS.includes(n.charAt(lower.length));
    })
  );
}

export interface EnsuredPath {
  folderId: string;
  /** "Base / Bölge / Disiplin" display path. */
  path: string;
  /** Display paths of the folders created. */
  created: string[];
  tree: FolderTree;
}

/**
 * Walks / creates `segments` below the base folder. New folders get no grants of their own, so
 * they inherit the permissions (and naming standard, attributes, review gate) of their parent.
 * Created with system rights; audited as folder.created with system: true.
 */
export async function ensureFolderPath(
  db: Db,
  tree: FolderTree,
  projectId: string,
  baseId: string,
  segments: readonly string[],
  createdBy: string,
  reviewId: string,
): Promise<EnsuredPath> {
  let cur = baseId;
  let current = tree;
  const created: string[] = [];
  for (const seg of segments) {
    const found = matchChild(current, cur, seg);
    if (found) {
      cur = found.id;
      continue;
    }
    let id: string;
    let isNew = false;
    try {
      const [row] = await db.insert(folders).values({ projectId, parentId: cur, name: seg, createdBy }).returning();
      id = row!.id;
      isNew = true;
      await audit(db, {
        projectId,
        userId: createdBy,
        action: "folder.created",
        targetType: "folder",
        targetId: id,
        details: { name: seg, parentId: cur, reviewId, system: true },
      });
    } catch {
      // Created concurrently: use the existing one.
      const [row] = await db
        .select()
        .from(folders)
        .where(and(eq(folders.parentId, cur), eq(folders.name, seg), isNull(folders.deletedAt)));
      if (!row) throw new Error(render(DEFAULT_LANGUAGE, msg("workflow:errors.folderNotCreated", { name: seg })));
      id = row.id;
    }
    current = await FolderTree.load(db, projectId);
    cur = id;
    if (isNew) created.push(folderPath(current, id));
  }
  const path = current
    .ancestry(cur)
    .map((id) => current.get(id).name)
    .join(" / ");
  return { folderId: cur, path, created, tree: current };
}

export function folderPath(tree: FolderTree, folderId: string, lang: string = DEFAULT_LANGUAGE): string {
  return tree.byId.has(folderId)
    ? tree
        .ancestry(folderId)
        .map((id) => tree.get(id).name)
        .join(" / ")
    : render(lang, msg("workflow:messages.deletedFolder"));
}
