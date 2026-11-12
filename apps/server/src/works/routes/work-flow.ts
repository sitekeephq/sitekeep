/**
 * Workflow of works (iş akışlı işler: RFI, submittal, generic works with a template): submit,
 * respond, revise, cancel, and the "otomatik transmittal" listener. Manage adds its categories'
 * builders (packages, meetings, registers) in its own package.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ResolvedDeps } from "../../app/deps.js";
import { isUuid, projectAccess } from "../../core/security/access.js";
import { notFound } from "../../core/platform/http.js";
import { msg } from "../../i18n/index.js";
import { onWorkflowEvent } from "../../workflow/service.js";
import { loadVisibleWork } from "../service.js";
import { cancelWork, respondWork, reviseWork, submitWork, workAutoTransmittalListener } from "../workflow.js";

export async function workFlowRoutes(api: FastifyInstance, deps: ResolvedDeps) {
  const { db, storage } = deps;
  const off = onWorkflowEvent(db, workAutoTransmittalListener({ db, storage }));
  api.addHook("onClose", async () => off());

  async function load(pid: string, wid: string, user: NonNullable<Parameters<typeof projectAccess>[2]>) {
    const a = await projectAccess(db, pid, user);
    if (!isUuid(wid)) throw notFound(msg("works:entities.work"));
    const { work, type } = await loadVisibleWork(db, a, wid);
    return { a, work, type };
  }

  // ---- Workflow ---------------------------------------------------------------------------------

  api.post<{ Params: { pid: string; wid: string } }>("/projects/:pid/works/:wid/submit", async (req) => {
    const { a, work, type } = await load(req.params.pid, req.params.wid, req.user!);
    const body = z.object({ comment: z.string().trim().max(5000).nullish() }).parse(req.body ?? {});
    await submitWork(db, a, work, type, body.comment || null);
    return { id: work.id };
  });

  api.post<{ Params: { pid: string; wid: string } }>("/projects/:pid/works/:wid/respond", async (req) => {
    const { a, work, type } = await load(req.params.pid, req.params.wid, req.user!);
    const body = z
      .object({
        outcome: z.string().min(1).max(60),
        comment: z.string().trim().max(10000).nullish(),
        response: z.string().trim().max(20000).nullish(),
      })
      .parse(req.body);
    await respondWork(db, a, work, type, body);
    return { id: work.id };
  });

  api.post<{ Params: { pid: string; wid: string } }>("/projects/:pid/works/:wid/revise", async (req) => {
    const { a, work, type } = await load(req.params.pid, req.params.wid, req.user!);
    await reviseWork(db, a, work, type);
    return { id: work.id };
  });

  api.post<{ Params: { pid: string; wid: string } }>("/projects/:pid/works/:wid/cancel", async (req) => {
    const { a, work, type } = await load(req.params.pid, req.params.wid, req.user!);
    const body = z.object({ comment: z.string().trim().max(5000).nullish() }).parse(req.body ?? {});
    await cancelWork(db, a, work, type, body.comment || null);
    return { id: work.id };
  });
}
