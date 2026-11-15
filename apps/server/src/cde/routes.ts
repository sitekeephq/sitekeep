/**
 * CDE settings API (docs/features/CDE_STATES.md):
 *   GET /projects/:pid/cde/settings   any project member
 *   PUT /projects/:pid/cde/settings   project administrators; audit "cde.settings_updated"
 */
import type { FastifyInstance } from "fastify";
import type { CdeSettingsDto } from "@sitekeep/shared";
import type { AppDeps } from "../app/deps.js";
import { projectAccess, requireProjectAdmin } from "../core/security/access.js";
import { audit } from "../core/platform/audit.js";
import { cdeSettingsInputSchema, loadCdeSettings, saveCdeSettings } from "./settings.js";

export async function cdeRoutes(api: FastifyInstance, deps: AppDeps) {
  const { db } = deps;

  api.get<{ Params: { pid: string } }>("/projects/:pid/cde/settings", async (req): Promise<CdeSettingsDto> => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    return loadCdeSettings(db, a.project.id);
  });

  api.put<{ Params: { pid: string } }>("/projects/:pid/cde/settings", async (req): Promise<CdeSettingsDto> => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    requireProjectAdmin(a);
    const input = cdeSettingsInputSchema.parse(req.body);
    const before = await loadCdeSettings(db, a.project.id);
    const after = await saveCdeSettings(db, a.project.id, input);
    const changed = Object.keys(input).filter(
      (k) => JSON.stringify(before[k as keyof CdeSettingsDto]) !== JSON.stringify(after[k as keyof CdeSettingsDto]),
    );
    await audit(db, {
      projectId: a.project.id,
      userId: a.user.id,
      action: "cde.settings_updated",
      targetType: "project",
      targetId: a.project.id,
      details: { changed, ...input },
    });
    return after;
  });
}
