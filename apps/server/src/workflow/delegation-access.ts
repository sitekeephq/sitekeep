/**
 * Approval delegation (issue #190): what a delegate could not see. A delegation never widens folder
 * permissions; when it is saved the module warns about the gaps this file finds:
 *   - folders the person can view and the delegate cannot (top-most only);
 *   - files of the person's open review steps in such folders.
 * SDK 0.20.0.
 */
import { and, eq, inArray } from "drizzle-orm";
import { can } from "@sitekeep/shared";
import type { Db } from "../db/index.js";
import { reviewFiles, reviews, files, users, workflowInstances } from "../db/schema.js";
import { FolderTree, projectAccess, type AuthUser, type ProjectAccess } from "../core/security/access.js";
import { folderPath } from "./chain-service.js";
import { isAssignee } from "./engine.js";
import { actorFor, memberWithRoles } from "./service.js";
import { SUBJECT_REVIEW } from "./review-types.js";

export interface DelegateAccessGaps {
  /** Folders (paths) the person can view and the delegate cannot; top-most first, at most `limit`. */
  folders: string[];
  /** Folders beyond the limit. */
  moreFolders: number;
  /** Files of the person's open review steps the delegate cannot view: "#3 Name: file.pdf". */
  openStepFiles: string[];
}

async function accessOf(db: Db, projectId: string, userId: string): Promise<ProjectAccess | null> {
  const [u] = await db.select().from(users).where(eq(users.id, userId));
  if (!u) return null;
  const user: AuthUser = { id: u.id, email: u.email, name: u.name, isAdmin: u.isAdmin, companyId: u.companyId };
  try {
    return await projectAccess(db, projectId, user);
  } catch {
    return null;
  }
}

/** True when the user may view files in the folder (project member, folder permissions). */
export async function userCanReadFolder(db: Db, projectId: string, userId: string, folderId: string): Promise<boolean> {
  const a = await accessOf(db, projectId, userId);
  if (!a) return false;
  const tree = await FolderTree.load(db, projectId);
  if (!tree.byId.has(folderId)) return false;
  return can(tree.permission(a.principal, folderId).level, "view");
}

/** What the delegate could not see of the person's work in a project (see the file header). */
export async function delegateAccessGaps(
  db: Db,
  input: { projectId: string; personId: string; delegateId: string; lang?: string; limit?: number },
): Promise<DelegateAccessGaps> {
  const out: DelegateAccessGaps = { folders: [], moreFolders: 0, openStepFiles: [] };
  const [person, delegate] = await Promise.all([accessOf(db, input.projectId, input.personId), accessOf(db, input.projectId, input.delegateId)]);
  if (!person) return out;
  const tree = await FolderTree.load(db, input.projectId);
  const sees = (a: ProjectAccess | null, id: string) => !!a && can(tree.permission(a.principal, id).level, "view");
  const gap = new Set<string>();
  for (const id of tree.byId.keys()) if (sees(person, id) && !sees(delegate, id)) gap.add(id);
  // Top-most only: a gap folder whose parent is a gap too is covered by the parent.
  const top = [...gap].filter((id) => {
    const parent = tree.byId.get(id)?.parentId;
    return !parent || !gap.has(parent);
  });
  const paths = top.map((id) => folderPath(tree, id, input.lang)).sort((x, y) => x.localeCompare(y));
  const limit = input.limit ?? 10;
  out.folders = paths.slice(0, limit);
  out.moreFolders = Math.max(0, paths.length - limit);

  // Files of the person's open review steps.
  const running = await db
    .select({ i: workflowInstances, r: reviews })
    .from(workflowInstances)
    .innerJoin(reviews, and(eq(workflowInstances.subjectType, SUBJECT_REVIEW), eq(reviews.id, workflowInstances.subjectId)))
    .where(and(eq(workflowInstances.projectId, input.projectId), eq(workflowInstances.status, "running")));
  if (!running.length) return out;
  const member = await memberWithRoles(db, input.projectId, input.personId);
  const mine = running.filter(({ i }) => isAssignee(i.template.steps[i.stepIndex]!, actorFor(person.user, member, i.startedBy)));
  if (!mine.length) return out;
  const rows = await db
    .select({ reviewId: reviewFiles.reviewId, name: files.name, folderId: files.folderId })
    .from(reviewFiles)
    .innerJoin(files, eq(files.id, reviewFiles.fileId))
    .where(inArray(reviewFiles.reviewId, mine.map((x) => x.r.id)));
  for (const f of rows) {
    if (tree.byId.has(f.folderId) && sees(delegate, f.folderId)) continue;
    const r = mine.find((x) => x.r.id === f.reviewId)!.r;
    out.openStepFiles.push(`${r.code ?? `#${r.number}`} ${r.name}: ${f.name}`);
  }
  return out;
}
