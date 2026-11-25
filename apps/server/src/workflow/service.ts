/** Database helpers around the pure engine: actors, assignee resolution, notifications, folder gate. */
import { and, eq, inArray } from "drizzle-orm";
import type { WorkflowAssignee } from "@sitekeep/shared";
import type { AuthUser, FolderTree } from "../core/security/access.js";
import type { Db } from "../db/index.js";
import { folderSettings, memberRoles, notifications, projectMembers } from "../db/schema.js";
import { forbidden } from "../core/platform/http.js";
import { DEFAULT_LANGUAGE, isMsg, msg, render, type Msg } from "../i18n/index.js";
import type { ActorContext } from "./engine.js";
import { cdeWriteGate } from "../cde/transitions.js";
import { dispatchNotificationMail } from "./notification-mail.js";

/** A project membership plus the project roles (teams) the member holds. */
export type Member = typeof projectMembers.$inferSelect & { roleIds?: string[] };

/** Adds roleIds to membership rows (rows of several projects are fine). */
export async function withRoleIds<M extends typeof projectMembers.$inferSelect>(
  db: Db,
  members: M[],
): Promise<(M & { roleIds: string[] })[]> {
  if (!members.length) return [];
  const rows = await db
    .select()
    .from(memberRoles)
    .where(
      inArray(
        memberRoles.userId,
        [...new Set(members.map((m) => m.userId))],
      ),
    );
  return members.map((m) => ({
    ...m,
    roleIds: rows.filter((r) => r.projectId === m.projectId && r.userId === m.userId).map((r) => r.roleId),
  }));
}

export async function projectMemberRows(db: Db, projectId: string): Promise<Member[]> {
  return withRoleIds(db, await db.select().from(projectMembers).where(eq(projectMembers.projectId, projectId)));
}

/** One membership with roles (undefined for non-members, e.g. system admins). */
export async function memberWithRoles(db: Db, projectId: string, userId: string): Promise<Member | undefined> {
  const rows = await db
    .select()
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)));
  return (await withRoleIds(db, rows))[0];
}

/** Engine view of a user in a project. */
export function actorFor(
  user: Pick<AuthUser, "id" | "companyId" | "isAdmin">,
  member: Member | undefined,
  startedBy: string | null,
): ActorContext {
  return {
    userId: user.id,
    companyId: member?.companyId ?? user.companyId ?? null,
    isProjectAdmin: user.isAdmin || !!member?.isProjectAdmin,
    isStarter: !!startedBy && startedBy === user.id,
    roleIds: member?.roleIds ?? [],
  };
}

/** Project members an assignee list points at (for notifications and task lists). */
export function resolveAssigneeUsers(
  assignees: readonly WorkflowAssignee[],
  members: readonly Member[],
  startedBy: string | null,
): string[] {
  const out = new Set<string>();
  for (const a of assignees) {
    if (a.type === "user" && members.some((m) => m.userId === a.id)) out.add(a.id);
    if (a.type === "company") for (const m of members) if (m.companyId === a.id) out.add(m.userId);
    if (a.type === "role" && a.id === "project_admin") for (const m of members) if (m.isProjectAdmin) out.add(m.userId);
    if (a.type === "role" && a.id === "starter" && startedBy) out.add(startedBy);
    if (a.type === "role") for (const m of members) if (m.roleIds?.includes(a.id)) out.add(m.userId);
  }
  return [...out];
}

export interface NewNotification {
  projectId: string | null;
  kind: string;
  /** A Msg is shown in each reader's language; a string (user-written text) as is. */
  title: Msg | string;
  body?: Msg | string | null;
  link?: string | null;
  /** Due date of the step or record: shown in the e-mail (workflow/notification-mail.ts). */
  due?: Date | string | null;
  /** Who caused the event: gets no e-mail (the in-app row is for the callers to filter). */
  actorId?: string | null;
}

/** In-app notification rows; assignment, reminder and outcome kinds are e-mailed as well (notification-mail.ts). */
export async function notify(db: Db, userIds: readonly string[], n: NewNotification): Promise<void> {
  const unique = [...new Set(userIds)];
  if (!unique.length) return;
  const translated = isMsg(n.title) || isMsg(n.body);
  await db.insert(notifications).values(
    unique.map((userId) => ({
      userId,
      projectId: n.projectId,
      kind: n.kind,
      title: render(DEFAULT_LANGUAGE, n.title),
      body: n.body == null ? null : render(DEFAULT_LANGUAGE, n.body),
      message: translated ? { title: isMsg(n.title) ? n.title : msg("workflow:notifications.text", { text: n.title }), body: isMsg(n.body) ? n.body : null } : null,
      link: n.link ?? null,
    })),
  );
  dispatchNotificationMail(unique, n);
}

// ---- Folder gate (ISO 19650 state transition) -----------------------------------------------

export interface GateInfo {
  gated: boolean;
  /** Folder that switches the gate on (the folder itself or a parent). */
  byFolderId: string | null;
  /**
   * Why (when the ISO 19650 transition rules close the folder: they name the way in). Missing:
   * the review gate of the folder settings (GATE_MESSAGE).
   */
  message?: Msg;
}

/**
 * The gate applies to the folder where it is set and to every folder below it. With the ISO 19650
 * transition rules enforced (docs/features/CDE_STATES.md), a folder whose state cannot be written
 * directly (transition upload → state other than `direct`) is gated as well.
 */
export async function folderGate(db: Db, tree: FolderTree, folderId: string): Promise<GateInfo> {
  const chain = tree.ancestry(folderId);
  const rows = await db
    .select()
    .from(folderSettings)
    .where(and(inArray(folderSettings.folderId, chain), eq(folderSettings.requireApprovedReview, true)));
  if (!rows.length) {
    const cde = await cdeWriteGate(db, tree, folderId);
    return cde ? { gated: true, byFolderId: cde.byFolderId, message: cde.message } : { gated: false, byFolderId: null };
  }
  const on = new Set(rows.map((r) => r.folderId));
  const by = [...chain].reverse().find((id) => on.has(id)) ?? null;
  return { gated: true, byFolderId: by };
}

/** A Msg: render it in the reader's language (`render(lang, GATE_MESSAGE)`). */
export const GATE_MESSAGE: Msg = msg("workflow:errors.folderGated");

/**
 * Rejects direct uploads/moves into a gated folder (approved review copies bypass this). With the
 * ISO 19650 transition rules enforced it also rejects writes into a state that only a review (or
 * the system) may bring documents into, for everyone: modules (Connect import, WOPI, Field / Manage)
 * included. Project administrators use the override route instead.
 */
export async function assertDirectWriteAllowed(db: Db, tree: FolderTree, folderId: string): Promise<void> {
  const gate = await folderGate(db, tree, folderId);
  if (gate.gated) throw forbidden(gate.message ?? GATE_MESSAGE);
}

// ---- Workflow events (extension point) --------------------------------------------------------

/** Emitted after a workflow instance changed state and the change was committed. */
export interface WorkflowEvent {
  type: "completed";
  kind: string;
  projectId: string;
  /** What the workflow ran on, e.g. ("review", reviews.id). */
  subjectType: string;
  subjectId: string;
  instanceId: string;
  templateId: string | null;
  actorId: string | null;
}

export type WorkflowListener = (event: WorkflowEvent) => Promise<void>;

/** Listeners per database handle, so several apps in one process (tests) stay apart. */
const workflowListeners = new WeakMap<object, Set<WorkflowListener>>();

/** Registers a listener; returns a function that removes it. */
export function onWorkflowEvent(db: Db, listener: WorkflowListener): () => void {
  let set = workflowListeners.get(db);
  if (!set) workflowListeners.set(db, (set = new Set()));
  set.add(listener);
  return () => set.delete(listener);
}

/** Runs every listener; a failing listener is logged and never breaks the workflow itself. */
export async function emitWorkflowEvent(db: Db, event: WorkflowEvent): Promise<void> {
  for (const listener of workflowListeners.get(db) ?? []) {
    try {
      await listener(event);
    } catch (err) {
      console.error(`workflow listener failed (${event.type} ${event.subjectType} ${event.subjectId})`, err);
    }
  }
}
