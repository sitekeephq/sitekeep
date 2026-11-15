/**
 * Unique document codes (ISO-3, docs/features/DOCUMENT_CODES.md):
 *   GET /projects/:pid/cde/code-conflicts   project administrators: live files whose code is
 *                                           registered to another document (data from before ISO-3)
 */
import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../app/deps.js";
import { projectAccess, requireProjectAdmin } from "../core/security/access.js";
import { listCodeConflicts, type CodeConflict } from "./document-code.js";

export async function documentCodeRoutes(api: FastifyInstance, deps: AppDeps) {
  const { db } = deps;

  api.get<{ Params: { pid: string } }>("/projects/:pid/cde/code-conflicts", async (req): Promise<{ conflicts: CodeConflict[] }> => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    requireProjectAdmin(a);
    return { conflicts: await listCodeConflicts(db, a.project.id, a.principal) };
  });
}
