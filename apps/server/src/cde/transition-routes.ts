/**
 * ISO-1 administrator override (docs/features/CDE_STATES.md "Transitions"):
 *   POST /projects/:pid/files/:id/transition { toFolderId, reason }
 * Moves a file into another folder whatever the transition table says. Project administrators
 * only, with a reason; audited as `cde.override` (plus `file.moved` and `cde.transition` with the
 * reason). The naming standard and the unique document code still apply. Under enforcement this is
 * the only way an administrator gets past the rules: the ordinary routes refuse them like anyone.
 */
import { and, eq, isNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { validateName } from "@sitekeep/shared";
import type { AppDeps } from "../app/deps.js";
import { requireProjectAdmin, userNames } from "../core/security/access.js";
import { audit } from "../core/platform/audit.js";
import { badRequest, conflict, notFound } from "../core/platform/http.js";
import { fileVersions, files } from "../db/schema.js";
import { msg, requestLanguage } from "../i18n/index.js";
import { loadFile } from "../modules/documents/files.js";
import { toFileDto } from "../modules/documents/mapper.js";
import { standardForFolder } from "../modules/documents/naming-routes.js";
import { checkDocumentCode } from "./guards.js";
import { clientInfo, recordTransition } from "./events.js";
import { cdeStateOf } from "./state.js";

const bodySchema = z.object({
  toFolderId: z.string().uuid(),
  reason: z.string().trim().min(1).max(500),
});

export async function transitionRoutes(api: FastifyInstance, deps: AppDeps) {
  const { db } = deps;

  api.post<{ Params: { pid: string; id: string } }>("/projects/:pid/files/:id/transition", async (req) => {
    const { a, file, tree } = await loadFile(db, req.params.pid, req.params.id, req.user!);
    requireProjectAdmin(a);
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) {
      const reasonMissing = parsed.error.issues.some((i) => i.path[0] === "reason");
      throw badRequest(reasonMissing ? msg("cde:transitions.overrideReasonRequired") : msg("errors:validation"), parsed.error.issues);
    }
    const body = parsed.data;
    if (!tree.byId.has(body.toFolderId)) throw notFound(msg("documents:entities.folder"));
    if (body.toFolderId === file.folderId) throw badRequest(msg("cde:transitions.overrideSameFolder"));
    const lang = requestLanguage(req);
    const [collision] = await db
      .select({ id: files.id })
      .from(files)
      .where(and(eq(files.folderId, body.toFolderId), eq(files.name, file.name), isNull(files.deletedAt)));
    if (collision) throw conflict(msg("documents:errors.existsInTarget", { name: file.name }));
    const standard = await standardForFolder(db, tree, body.toFolderId);
    if (standard) {
      const r = validateName(standard, file.name, lang);
      if (!r.ok) throw badRequest(msg("documents:errors.nameNotStandard", { errors: r.errors.join("; ") }), r);
    }
    const guard = { projectId: a.project.id, access: a, tree, source: "move", lang } as const;
    const { documentCode } = await checkDocumentCode(db, {
      ...guard,
      folderId: body.toFolderId,
      name: file.name,
      fileId: file.id,
      containerId: file.containerId,
    });
    const [row] = await db
      .update(files)
      .set({ folderId: body.toFolderId, documentCode: documentCode ?? file.documentCode })
      .where(eq(files.id, file.id))
      .returning();
    const fromState = cdeStateOf(tree, file.folderId);
    const toState = cdeStateOf(tree, body.toFolderId);
    const client = clientInfo(req);
    await audit(db, {
      projectId: a.project.id,
      userId: a.user.id,
      action: "cde.override",
      targetType: "file",
      targetId: file.id,
      details: { what: "transition", name: file.name, fromFolderId: file.folderId, toFolderId: body.toFolderId, fromState, toState, reason: body.reason },
      client,
    });
    await audit(db, {
      projectId: a.project.id,
      userId: a.user.id,
      action: "file.moved",
      targetType: "file",
      targetId: file.id,
      details: { name: file.name, fromFolderId: file.folderId, toFolderId: body.toFolderId, override: true },
      client,
    });
    await recordTransition(db, {
      projectId: a.project.id,
      userId: a.user.id,
      fileId: file.id,
      fromFolderId: file.folderId,
      toFolderId: body.toFolderId,
      fromState,
      toState,
      mode: "direct",
      reason: body.reason,
      client,
    });
    const [v] = await db
      .select()
      .from(fileVersions)
      .where(and(eq(fileVersions.fileId, file.id), eq(fileVersions.version, row!.currentVersion)));
    return toFileDto(row!, v!, await userNames(db, [v!.uploadedBy]));
  });
}
