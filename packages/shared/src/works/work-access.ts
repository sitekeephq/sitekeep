/** Work visibility and edit-access rules. */
import { WORK_STATUS } from "./work-catalog.js";

// ---- Visibility -----------------------------------------------------------------------------

export interface WorkViewer {
  userId: string;
  /** Company the user represents in the project. */
  companyId: string | null;
  isProjectAdmin: boolean;
}

export interface WorkVisibilityInfo {
  status: string;
  createdBy: string;
  assigneeUserId: string | null;
  ownerCompanyId: string | null;
  fromCompanyId: string | null;
  toCompanyIds: readonly string[];
  ccCompanyIds: readonly string[];
  /**
   * Delegates of the assignee when the work was assigned ("vekâlet", issue #190): they see and act
   * on the work like the assignee.
   */
  assigneeDelegates?: readonly { forUserId: string; userId: string }[] | null;
}

/** The viewer is the assignee's delegate on this work (assigned during a delegation). */
export function isAssigneeDelegate(w: Pick<WorkVisibilityInfo, "assigneeUserId" | "assigneeDelegates">, userId: string): boolean {
  return !!w.assigneeUserId && !!w.assigneeDelegates?.some((d) => d.userId === userId && d.forUserId === w.assigneeUserId);
}

/** The viewer's company created (owns) or sends the work. */
export function isWorkOwnerSide(w: WorkVisibilityInfo, v: WorkViewer): boolean {
  return !!v.companyId && (v.companyId === w.ownerCompanyId || v.companyId === w.fromCompanyId);
}

/** The viewer's company is an action ("gereği") or info ("bilgi") recipient. */
export function isWorkAddressee(w: WorkVisibilityInfo, v: WorkViewer): boolean {
  return !!v.companyId && (w.toCompanyIds.includes(v.companyId) || w.ccCompanyIds.includes(v.companyId));
}

/**
 * Who sees a work:
 * - project administrators: everything;
 * - the creator and the assignee;
 * - members of the owner company (creator's company) and of the sender company;
 * - members of addressed companies (to / cc) once the work is no longer a draft.
 */
export function canSeeWork(w: WorkVisibilityInfo, v: WorkViewer): boolean {
  if (v.isProjectAdmin) return true;
  if (w.createdBy === v.userId || w.assigneeUserId === v.userId || isAssigneeDelegate(w, v.userId)) return true;
  if (isWorkOwnerSide(w, v)) return true;
  return w.status !== WORK_STATUS.draft && isWorkAddressee(w, v);
}

/** Who may edit fields, links and status: admins, creator, assignee (and their delegate), owner/sender company members. */
export function canEditWork(w: WorkVisibilityInfo, v: WorkViewer): boolean {
  return (
    v.isProjectAdmin || w.createdBy === v.userId || w.assigneeUserId === v.userId || isAssigneeDelegate(w, v.userId) || isWorkOwnerSide(w, v)
  );
}
