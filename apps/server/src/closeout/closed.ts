/**
 * A closed project (ISO 19650-2 §5.8.1, docs/features/CLOSEOUT_ARCHIVE.md#closing-the-project) is
 * read-only: viewing and downloading go on, uploads and edits are refused. Two places refuse them:
 *
 * - enforceProjectOpen: every write request (not GET / HEAD) to a /api/v1 route with a project
 *   (`:pid`), except the routes that only read or that a closed project still needs (below);
 * - assertProjectOpen: the CDE upload and move guards (cde/guards.ts), so the write paths outside
 *   /api/v1/projects/:pid (OpenCDE Documents API, modules through the SDK) refuse as well.
 *
 * Only a system administrator reopens a closed project.
 */
import { and, eq } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import type { Db } from "../db/index.js";
import { projectMembers, projects } from "../db/schema.js";
import { HttpError } from "../core/platform/http.js";
import { READ_ONLY_POSTS } from "../core/security/token-scope.js";
import { isUuid } from "../core/security/access.js";
import { msg } from "../i18n/index.js";

/**
 * Write routes a closed project still answers: reading POSTs (as for read-only tokens), bulk
 * download and previews (viewing), the close-out archive itself and its reopening, and the members
 * and invitations (people who need to read the archived project, e.g. the operations team).
 */
const OPEN_WHEN_CLOSED = new Set([
  "/api/v1/projects/:pid/download-zip",
  "/api/v1/projects/:pid/versions/:vid/preview/:kind",
  "/api/v1/projects/:pid/reviews/preview",
  "/api/v1/projects/:pid/today/summary",
  "/api/v1/projects/:pid/closeout/archives",
  "/api/v1/projects/:pid/closeout/archives/:id",
  "/api/v1/projects/:pid/reopen",
]);
const MEMBERS = /^\/api\/v1\/projects\/:pid\/(members|invitations)(\/|$)/;

export function projectClosedError(): HttpError {
  return new HttpError(403, "project_closed", msg("closeout:errors.projectClosed"));
}

export async function projectClosedAt(db: Db, projectId: string): Promise<Date | null> {
  if (!isUuid(projectId)) return null;
  const [row] = await db.select({ closedAt: projects.closedAt }).from(projects).where(eq(projects.id, projectId));
  return row?.closedAt ?? null;
}

/** Throws 403 `project_closed` when the project is closed. */
export async function assertProjectOpen(db: Db, projectId: string): Promise<void> {
  if (await projectClosedAt(db, projectId)) throw projectClosedError();
}

/** onRequest hook of /api/v1 (after authentication): refuses writes to a closed project. */
export async function enforceProjectOpen(db: Db, req: FastifyRequest): Promise<void> {
  const method = req.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return;
  const pid = (req.params as { pid?: unknown } | undefined)?.pid;
  if (typeof pid !== "string") return;
  const route = req.routeOptions.url ?? "";
  if (OPEN_WHEN_CLOSED.has(route) || MEMBERS.test(route) || (method === "POST" && READ_ONLY_POSTS.has(route))) return;
  if (!(await projectClosedAt(db, pid))) return;
  // Someone outside the project gets the route's own answer (404): a closed project is not revealed.
  const user = req.user;
  if (!user) return;
  if (!user.isAdmin) {
    const [member] = await db
      .select({ userId: projectMembers.userId })
      .from(projectMembers)
      .where(and(eq(projectMembers.projectId, pid), eq(projectMembers.userId, user.id)));
    if (!member) return;
  }
  throw projectClosedError();
}
