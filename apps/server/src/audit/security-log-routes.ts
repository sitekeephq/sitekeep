/**
 * Security log and security alerts API (docs/features/SECURITY_LOG.md). Readers are system
 * administrators and auditors (core/security/system-roles.ts); only administrators change anything.
 *
 *   GET  /admin/security-log                  security events, filters type / userId / from / to / ip
 *   GET  /admin/security-log.csv              the same rows as CSV (IP and user agent while kept)
 *   GET  /admin/security-alerts               ?status=open|acknowledged|dismissed|all (scans first)
 *   POST /admin/security-alerts/:id/acknowledge, /dismiss   administrators; audited
 *   GET  /admin/security-alerts/settings      thresholds, rules, recipients, whether mail can go out
 *   PUT  /admin/security-alerts/settings      administrators; audited as security.alert_settings
 */
import { Readable } from "node:stream";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  SECURITY_ALERT_LIMITS,
  SECURITY_ALERT_MAX_RECIPIENTS,
  SECURITY_ALERT_RULES,
  type AuditPageDto,
  type SecurityAlertRule,
  type SecurityAlertSettingsDto,
} from "@sitekeep/shared";
import type { AppDeps } from "../app/deps.js";
import { audit } from "../core/platform/audit.js";
import { forbidden, notFound } from "../core/platform/http.js";
import { requireSecurityReader } from "../core/security/system-roles.js";
import { DEFAULT_LANGUAGE, msg, render, supportedLanguage, tFor, tReq } from "../i18n/index.js";
import { auditCsvLines } from "./csv.js";
import { auditPage, toAuditDtos } from "./query.js";
import { securityLogQuery, securityLogWhere } from "./security-log.js";
import {
  handleSecurityAlert,
  listSecurityAlerts,
  saveSecurityAlertSettings,
  scanSecurityEvents,
  securityAlertSettingsDto,
} from "./security-alerts.js";

function requireAdmin(req: FastifyRequest) {
  if (!req.user?.isAdmin) throw forbidden(msg("admin:errors.adminOnly"));
}

const stamp = () => new Date().toISOString().slice(0, 10);

export async function securityLogRoutes(api: FastifyInstance, deps: AppDeps) {
  const { db } = deps;
  const alertDeps = { db, mailer: deps.mailer, log: (m: string, e?: unknown) => api.log.warn({ err: e }, m) };

  api.get("/admin/security-log", async (req): Promise<AuditPageDto> => {
    requireSecurityReader(req);
    const q = securityLogQuery.parse(req.query);
    const page = await auditPage(db, securityLogWhere(q), q.limit, q.cursor);
    return { entries: await toAuditDtos(db, page.rows, { client: true, projectCodes: true, userTargets: true }), nextCursor: page.nextCursor };
  });

  api.get("/admin/security-log.csv", async (req, reply) => {
    requireSecurityReader(req);
    const q = securityLogQuery.parse(req.query);
    const asked = supportedLanguage(q.lang);
    const t = asked ? tFor(asked) : tReq(req);
    // Taking the log out is itself on the record.
    await audit(db, { userId: req.user!.id, action: "audit.exported", details: { log: "security", query: req.query as Record<string, unknown> } });
    reply.header("Content-Type", "text/csv; charset=utf-8");
    reply.header("Content-Disposition", `attachment; filename="security-log-${stamp()}.csv"`);
    reply.header("Cache-Control", "no-store");
    return reply.send(Readable.from(auditCsvLines(db, securityLogWhere(q), t, { client: true, userTargets: true })));
  });

  api.get("/admin/security-alerts", async (req) => {
    requireSecurityReader(req);
    const q = z
      .object({ status: z.enum(["open", "acknowledged", "dismissed", "all"]).default("open"), limit: z.coerce.number().int().min(1).max(500).default(100) })
      .parse(req.query);
    // The dashboard is fresh: whatever happened since the last background scan is looked at now.
    await scanSecurityEvents(alertDeps).catch((e) => alertDeps.log("security alert scan failed", e));
    return listSecurityAlerts(db, q);
  });

  for (const [path, status] of [
    ["acknowledge", "acknowledged"],
    ["dismiss", "dismissed"],
  ] as const)
    api.post<{ Params: { id: string } }>(`/admin/security-alerts/:id/${path}`, async (req) => {
      requireAdmin(req);
      const id = z.string().uuid().parse(req.params.id);
      if (!(await handleSecurityAlert(db, id, status, req.user!.id))) throw notFound(msg("admin:entities.securityAlert"));
      return { ok: true };
    });

  api.get("/admin/security-alerts/settings", async (req): Promise<SecurityAlertSettingsDto> => {
    requireSecurityReader(req);
    return securityAlertSettingsDto(alertDeps);
  });

  api.put("/admin/security-alerts/settings", async (req): Promise<SecurityAlertSettingsDto> => {
    requireAdmin(req);
    const range = (k: keyof typeof SECURITY_ALERT_LIMITS) => z.number().int().min(SECURITY_ALERT_LIMITS[k][0]).max(SECURITY_ALERT_LIMITS[k][1]).optional();
    const body = z
      .object({
        failedSignInsAccount: range("failedSignInsAccount"),
        failedSignInsGlobal: range("failedSignInsGlobal"),
        failedSignInsWindowMinutes: range("failedSignInsWindowMinutes"),
        bulkDownloadFiles: range("bulkDownloadFiles"),
        bulkDownloadWindowMinutes: range("bulkDownloadWindowMinutes"),
        disabledRules: z.array(z.enum(SECURITY_ALERT_RULES as [SecurityAlertRule, ...SecurityAlertRule[]])).max(SECURITY_ALERT_RULES.length).optional(),
        emailTo: z
          .array(z.string().trim().max(200).pipe(z.email(render(DEFAULT_LANGUAGE, msg("admin:errors.invalidEmail")))))
          .max(SECURITY_ALERT_MAX_RECIPIENTS)
          .optional(),
      })
      .strict()
      .parse(req.body);
    await saveSecurityAlertSettings(db, body, req.user!.id);
    return securityAlertSettingsDto(alertDeps);
  });
}
