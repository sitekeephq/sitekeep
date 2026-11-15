/**
 * ISO 19650 CDE events (docs/features/CDE_STATES.md): what the audit trail records about reading
 * and state changes. Foundation: no-ops; ISO-4 writes them to the audit log (`file.viewed`
 * deduplicated, `cde.transition`) together with the client's IP and user agent (D-9).
 *
 * Recording never fails the request: errors are swallowed here, not in the callers.
 */
import type { FastifyRequest } from "fastify";
import type { CdeState, CdeTransitionMode } from "@sitekeep/shared";
import type { Db } from "../db/index.js";

/** Who called, as far as the request tells (stored with audit rows, D-9). */
export interface ClientInfo {
  ip: string | null;
  userAgent: string | null;
}

export function clientInfo(req: FastifyRequest): ClientInfo {
  const ua = req.headers["user-agent"];
  return { ip: req.ip ?? null, userAgent: typeof ua === "string" ? ua.slice(0, 500) : null };
}

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
export async function recordView(_db: Db, _e: ViewEvent): Promise<void> {
  // ISO-4: audit "file.viewed", one per user, version and 15 minutes.
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
export async function recordTransition(_db: Db, _e: TransitionEvent): Promise<void> {
  // ISO-4: audit "cde.transition"; ISO-1 sets status flags (returned, superseded, withdrawn).
}
