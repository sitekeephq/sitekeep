/**
 * ISO 19650 CDE events (docs/features/CDE_STATES.md, docs/features/AUDIT_LOG.md): what the audit
 * trail records about reading and state changes, together with the client's IP and user agent (D-9).
 *   file.viewed    a version opened in a viewer; one row per user, version and 15 minutes
 *   cde.transition a document changed state (direct move, approved review copy, automatic step)
 *
 * Recording never fails the request: errors are logged and swallowed here, not in the callers.
 */
import { and, eq, gt, sql } from "drizzle-orm";
import type { CdeState, CdeTransitionMode } from "@sitekeep/shared";
import type { Db } from "../db/index.js";
import { auditLog } from "../db/schema.js";
import { audit, type ClientInfo } from "../core/platform/audit.js";

export { clientInfo, type ClientInfo } from "../core/platform/audit.js";

/** A repeated view of the same version by the same person within this window is not recorded again. */
export const VIEW_DEDUPE_MS = 15 * 60 * 1000;
/** Which viewer opened the content. */
export type CdeViewKind = "preview" | "pdf" | "media" | "model";

export interface ViewEvent {
  projectId: string;
  userId: string;
  fileId: string;
  versionId: string;
  kind: CdeViewKind;
  client?: ClientInfo;
}

/** A person opened a version in a viewer (not a download: that is `file.downloaded`). */
export async function recordView(db: Db, e: ViewEvent): Promise<void> {
  try {
    const since = new Date(Date.now() - VIEW_DEDUPE_MS);
    const [seen] = await db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.targetType, "file"),
          eq(auditLog.targetId, e.fileId),
          eq(auditLog.action, "file.viewed"),
          eq(auditLog.userId, e.userId),
          gt(auditLog.at, since),
          sql`${auditLog.details}->>'versionId' = ${e.versionId}`,
        ),
      )
      .limit(1);
    if (seen) return;
    await audit(db, {
      projectId: e.projectId,
      userId: e.userId,
      action: "file.viewed",
      targetType: "file",
      targetId: e.fileId,
      details: { versionId: e.versionId, kind: e.kind },
      client: e.client,
    });
  } catch (err) {
    console.warn("audit: file.viewed not recorded", err);
  }
}

export interface TransitionEvent {
  projectId: string;
  /** null: the system (approved review copy, automatic archive). */
  userId: string | null;
  fileId: string;
  versionId?: string | null;
  fromFolderId: string | null;
  toFolderId: string;
  fromState: CdeState | null;
  toState: CdeState | null;
  /** How it happened: a direct move, an approved review, an automatic step. */
  mode: CdeTransitionMode;
  reviewId?: string | null;
  reason?: string | null;
  client?: ClientInfo;
}

/** A document changed state (moved, copied on approval, archived, returned). */
export async function recordTransition(db: Db, e: TransitionEvent): Promise<void> {
  // A direct move between two folders of the same state is no transition (file.moved records it).
  if (e.mode === "direct" && e.fromState === e.toState) return;
  try {
    await audit(db, {
      projectId: e.projectId,
      userId: e.userId,
      action: "cde.transition",
      targetType: "file",
      targetId: e.fileId,
      details: {
        fromState: e.fromState,
        toState: e.toState,
        mode: e.mode,
        fromFolderId: e.fromFolderId,
        toFolderId: e.toFolderId,
        ...(e.versionId && { versionId: e.versionId }),
        ...(e.reviewId && { reviewId: e.reviewId }),
        ...(e.reason && { reason: e.reason }),
      },
      client: e.client,
    });
  } catch (err) {
    console.warn("audit: cde.transition not recorded", err);
  }
  // ISO-1 sets status flags (returned, superseded, withdrawn) here.
}
