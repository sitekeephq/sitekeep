/**
 * POST /api/v1/dev/tools/:name — the developer tools behind cde_dev_* (MCP). Registered only when
 * the server runs with CDE_DEV_TOOLS=1 and NODE_ENV is not production (app.ts), usable only by a
 * system administrator's API write token (while write tokens are allowed). Arguments are validated
 * with the same shapes as the MCP tools; every call is audit-logged ("dev.tool").
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { parseDevArgs } from "@sitekeep/cde-tools";
import type { ResolvedDeps } from "../app/deps.js";
import { audit } from "../core/platform/audit.js";
import { getMcpSettings } from "../ai/settings.js";
import { HttpError, forbidden, notFound } from "../core/platform/http.js";
import { createDevContext, type DevContext } from "./context.js";
import { activeModules } from "../app/modules.js";
import { devToolsEnabled, devToolsOffReason } from "./flag.js";
import { devHealth } from "./health.js";
import { devProject } from "./project.js";
import { findProject } from "./registry.js";
import { runScenarios } from "./scenarios.js";
import { devSeed } from "./seed.js";
import { devTime } from "./time.js";
import { devUpload } from "./upload.js";

type Runner = (ctx: DevContext, args: Record<string, unknown>) => Promise<unknown>;

/** Core developer tools; modules add theirs (ServerModule.devTools, e.g. AI's cde_dev_ai_eval). */
export const DEV_RUNNERS: Record<string, Runner> = {
  cde_dev_health: (ctx, a) => devHealth(ctx, { errors: a.errors as number }),
  cde_dev_seed: devSeed,
  cde_dev_project: devProject,
  cde_dev_upload: devUpload,
  cde_dev_scenario: (ctx, a) => runScenarios(ctx, a as { scenarios?: string[]; project?: string; list?: boolean }),
  cde_dev_time: devTime,
};

/** System administrator with an API write token (while the administrator allows write tokens). */
export async function requireDevCaller(req: FastifyRequest, deps: ResolvedDeps): Promise<void> {
  const user = req.user;
  const token = user?.token;
  if (!user?.isAdmin) throw forbidden("Geliştirici araçları yalnız sistem yöneticisine açıktır.");
  if (!token || token.kind !== "api" || token.scope !== "write")
    throw forbidden("Geliştirici araçları yalnız sistem yöneticisinin yazma yetkili API erişim anahtarıyla kullanılır.");
  if (!(await getMcpSettings(deps.db)).allowWriteTokens) throw forbidden("Yazma yetkili erişim anahtarları kapalı (Yönetim → Yapay Zekâ ve MCP).");
}

export async function devRoutes(api: FastifyInstance, deps: ResolvedDeps) {
  api.post<{ Params: { name: string } }>("/dev/tools/:name", async (req) => {
    // Checked again at call time: the process environment may have changed since start.
    if (!deps.devTools || process.env.NODE_ENV === "production") throw new HttpError(404, "dev_tools_off", devToolsOffReason());
    await requireDevCaller(req, deps);
    const name = req.params.name;
    const run = DEV_RUNNERS[name] ?? activeModules().find((m) => m.devTools?.[name])?.devTools?.[name];
    if (!run) throw notFound("Geliştirici aracı");
    const args = parseDevArgs(name, req.body);
    const user = req.user!;
    const ctx = createDevContext(api, deps, user);
    const t0 = Date.now();
    let projectId: string | null = null;
    if (typeof args.project === "string")
      projectId = await findProject(deps.db, args.project)
        .then((p) => p.id)
        .catch(() => null);
    let error: string | undefined;
    try {
      return await run(ctx, args);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      if (e instanceof HttpError) throw e;
      // Tool failures are the caller's input problems or a failed step: answer 400 with the reason.
      throw new HttpError(400, "dev_tool_failed", error.slice(0, 2000));
    } finally {
      ctx.close();
      await audit(deps.db, {
        userId: user.id,
        projectId,
        action: "dev.tool",
        targetType: "token",
        targetId: user.token?.id,
        details: {
          tool: name,
          ok: !error,
          ms: Date.now() - t0,
          ...(error && { error: error.slice(0, 300) }),
          args: JSON.stringify(args).slice(0, 500),
        },
      }).catch(() => {});
    }
  });
}

export { devToolsEnabled };
