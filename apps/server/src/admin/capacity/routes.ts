/**
 * Yönetim → Sistem Durumu → Kapasite (docs/onprem/kapasite.md §8). System administrators only.
 *
 *   GET  /admin/capacity                    card: hardware, counts, findings, last / running test
 *   GET  /admin/capacity/runs               history, newest first (without samples)
 *   POST /admin/capacity/runs  {mode}       start a test (409 while one runs)
 *   GET  /admin/capacity/runs/:id           one run; the screen polls it once a second
 *   POST /admin/capacity/runs/:id/cancel    Durdur
 *   GET  /admin/capacity/runs/:id/report    ?format=html (print → PDF) | json (package for 7D)
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  CAPACITY_CONCURRENCY,
  CAPACITY_MEASURED_AT,
  evaluateCapacity,
  type AdminCapacityDto,
  type CapacityRunDto,
} from "@sitekeep/shared";
import type { AppDeps } from "../../app/deps.js";
import { audit } from "../../core/platform/audit.js";
import { badRequest, notFound } from "../../core/platform/http.js";
import { packageVersion } from "../status.js";
import { DemoEngine } from "./demo-engine.js";
import { capacityReportHtml, capacityReportJson } from "./report.js";
import { CapacityRuns } from "./runs.js";
import { DEMO_COUNTS, capacityDemoOn, demoHardware, readCounts, readHardware } from "./snapshot.js";
import { msg, requestLanguage } from "../../i18n/index.js";

/** CAPACITY_LOAD_TEST=0 hides the full load test on an installation (quick check stays). */
function loadTestEnabled(env = process.env): boolean {
  return env.CAPACITY_LOAD_TEST !== "0";
}

export function capacityRoutes(api: FastifyInstance, deps: AppDeps, requireAdmin: (req: FastifyRequest) => void) {
  const demo = capacityDemoOn();
  const hardware = () => (demo ? Promise.resolve(demoHardware()) : readHardware(deps));
  const counts = () => (demo ? Promise.resolve(DEMO_COUNTS) : readCounts(deps));

  // Only the sample engine exists today; QuickCheckEngine / LoadTestEngine replace it (§12).
  const runs = new CapacityRuns(new DemoEngine(() => Number(process.env.CAPACITY_DEMO_TICK_MS) || 250), async (run) => {
    const c = await counts();
    return (lang) => evaluateCapacity({ hardware: run.hardware, counts: c, lastRun: run, lang }).findings;
  });
  api.addHook("onClose", async () => {
    const running = runs.running;
    if (running) runs.cancel(running.id);
    await runs.settle();
  });

  /** Runs are shown in the viewer's language (stage, checks, stop reason). */
  async function card(lang: string): Promise<AdminCapacityDto> {
    const [hw, c] = await Promise.all([hardware(), counts()]);
    const lastRun = runs.lastFinished();
    const e = evaluateCapacity({ hardware: hw, counts: c, lastRun, lang });
    return {
      demo,
      measuredAt: CAPACITY_MEASURED_AT,
      concurrency: CAPACITY_CONCURRENCY,
      hardware: hw,
      counts: c,
      level: e.level,
      neededTier: e.needed.id,
      hardwareTier: e.hardware?.id ?? null,
      findings: e.findings,
      lastRun: lastRun ? brief(lastRun, lang) : null,
      running: runs.running ? brief(runs.running, lang) : null,
      loadTestEnabled: loadTestEnabled(),
    };
  }

  /** Lists leave the per-second points out. */
  const brief = (run: CapacityRunDto, lang: string): CapacityRunDto => ({ ...runs.view(run, lang), samples: [] });

  const find = (id: string) => {
    const run = runs.get(id);
    if (!run) throw notFound(msg("admin:entities.capacityRun"));
    return run;
  };

  api.get("/admin/capacity", async (req) => {
    requireAdmin(req);
    return card(requestLanguage(req));
  });

  api.get("/admin/capacity/runs", async (req) => {
    requireAdmin(req);
    const lang = requestLanguage(req);
    return runs.list().map((r) => brief(r, lang));
  });

  api.post("/admin/capacity/runs", async (req) => {
    requireAdmin(req);
    const { mode } = z.object({ mode: z.enum(["quick", "load"]) }).parse(req.body);
    if (mode === "load" && !loadTestEnabled()) throw badRequest(msg("admin:errors.loadTestOff"));
    const run = runs.start({ mode, hardware: await hardware(), startedBy: req.user!.id, appVersion: packageVersion() });
    await audit(deps.db, { userId: req.user!.id, action: "capacity.run", targetType: "capacity_run", targetId: run.id, details: { mode, demo: run.demo } });
    return runs.view(run, requestLanguage(req));
  });

  api.get("/admin/capacity/runs/:id", async (req) => {
    requireAdmin(req);
    return runs.view(find((req.params as { id: string }).id), requestLanguage(req));
  });

  api.post("/admin/capacity/runs/:id/cancel", async (req) => {
    requireAdmin(req);
    const run = find((req.params as { id: string }).id);
    runs.cancel(run.id);
    return runs.view(run, requestLanguage(req));
  });

  api.get("/admin/capacity/runs/:id/report", async (req, reply) => {
    requireAdmin(req);
    const lang = requestLanguage(req);
    const run = runs.view(find((req.params as { id: string }).id), lang);
    if (run.status === "running") throw badRequest(msg("admin:errors.reportWhileRunning"));
    const { format } = z.object({ format: z.enum(["html", "json"]).default("html") }).parse(req.query);
    const stamp = run.startedAt.slice(0, 10);
    const capacity = await card(lang);
    if (format === "json") {
      return reply
        .header("content-disposition", `attachment; filename="7d-kapasite-${stamp}.json"`)
        .send(capacityReportJson(run, capacity));
    }
    return reply
      .type("text/html; charset=utf-8")
      .header("content-disposition", `attachment; filename="7d-kapasite-${stamp}.html"`)
      .send(capacityReportHtml(run, capacity, lang));
  });
}
