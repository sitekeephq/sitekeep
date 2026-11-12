/**
 * Gizlilik Merkezi (Yönetim → Gizlilik Merkezi), system administrators only:
 *   GET  /admin/privacy                     summary (statement, AI mode, data location, settings)
 *   GET  /admin/privacy/status              { killSwitch } for the admin banner
 *   PUT  /admin/privacy/settings            retention, "iç ağ" list, redaction switches
 *   PUT  /admin/privacy/kill-switch         { on } "Tüm Dış Bağlantıları Kapat"
 *   GET  /admin/privacy/connections         every configured external connection
 *   PUT  /admin/privacy/connections/:id     { enabled }
 *   GET  /admin/privacy/outbound            outbound log (purpose, host, from, to, blocked, limit, offset)
 *   GET  /admin/privacy/outbound.csv        the same rows as CSV (at most 10 000)
 */
import { and, asc, count, desc, eq, gt, gte, isNotNull, isNull, like, lte, max, or, sql, type SQL } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { privacyStatement, type OutboundLogRowDto, type PrivacyConnectionDto, type PrivacySummaryDto } from "@sitekeep/shared";
import type { ResolvedDeps } from "../app/deps.js";
import { audit } from "../core/platform/audit.js";
import { isExternalUrl, lanEntryProblem } from "../ai/hosts.js";
import {
  getAiMode,
  getDefaultProviderId,
  getMcpSettings,
  getProviders,
  getStoredAiMode,
  getStoredAiTaskQueueSettings,
  putSetting,
} from "../ai/settings.js";
import { oauthClients, outboundLog, projectAiSettings, projects, tokens, users } from "../db/schema.js";
import { toCsv } from "../docintel/export.js";
import { badRequest, forbidden } from "../core/platform/http.js";
import { officeConverterLabel, officeEditorLabel } from "@sitekeep/shared";
import { LocalStorage } from "../core/platform/storage.js";
import { hostOf } from "./outbound.js";
import { DEFAULT_LANGUAGE, msg, render, requestLanguage, tFor, tReq } from "../i18n/index.js";
import { connectionDisabled, killSwitchOn, privacyState, savePrivacySettings, setConnectionEnabled, setKillSwitch } from "./settings.js";

function requireAdmin(req: FastifyRequest) {
  if (!req.user?.isAdmin) throw forbidden(msg("privacy:errors.adminOnly"));
}

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, render(DEFAULT_LANGUAGE, msg("privacy:errors.invalidDate")));

const logQuery = z.object({
  purpose: z.string().trim().max(120).optional(),
  host: z.string().trim().max(255).optional(),
  from: ymd.optional(),
  to: ymd.optional(),
  blocked: z.enum(["true", "false"]).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

export async function privacyRoutes(api: FastifyInstance, deps: ResolvedDeps) {
  const { db } = deps;

  async function summary(lang: string): Promise<PrivacySummaryDto> {
    const t = tFor(lang);
    const state = privacyState();
    const [mode, storedMode, external, byUser] = await Promise.all([
      getAiMode(db),
      getStoredAiMode(db),
      db
        .select({ id: projects.id, code: projects.code, name: projects.name })
        .from(projectAiSettings)
        .innerJoin(projects, eq(projects.id, projectAiSettings.projectId))
        .where(and(eq(projectAiSettings.allowExternal, true), eq(projectAiSettings.enabled, true)))
        .orderBy(asc(projects.name)),
      state.killSwitch.by
        ? db.select({ name: users.name }).from(users).where(eq(users.id, state.killSwitch.by))
        : Promise.resolve([] as { name: string }[]),
    ]);
    const storage =
      deps.dataLocation?.storage ?? (deps.storage instanceof LocalStorage ? t("privacy:data.localDisk", { root: deps.storage.root }) : t("privacy:data.configuredStorage"));
    const database = deps.dataLocation?.database ?? (deps.dbKind === "postgres" ? "PostgreSQL" : t("privacy:data.pglite"));
    return {
      statement: privacyStatement(lang),
      killSwitch: { on: state.killSwitch.on, at: state.killSwitch.at, byName: byUser[0]?.name ?? null },
      ai: { mode, storedMode, externalProjects: external },
      data: { database, storage },
      settings: {
        logRetentionDays: state.settings.logRetentionDays,
        lanHosts: state.settings.lanHosts,
        redactLocal: state.settings.redactLocal,
        redactNames: state.settings.redactNames,
      },
    };
  }

  api.get("/admin/privacy", async (req) => {
    requireAdmin(req);
    return summary(requestLanguage(req));
  });

  api.get("/admin/privacy/status", async (req) => {
    requireAdmin(req);
    return { killSwitch: killSwitchOn() };
  });

  api.put("/admin/privacy/settings", async (req) => {
    requireAdmin(req);
    const body = z
      .object({
        logRetentionDays: z.number().int().min(1).max(3650).optional(),
        lanHosts: z.array(z.string().trim().max(255)).max(200).optional(),
        redactLocal: z.boolean().optional(),
        redactNames: z.boolean().optional(),
      })
      .parse(req.body);
    if (body.lanHosts) {
      const entries = body.lanHosts.filter(Boolean);
      const problems = entries.map(lanEntryProblem).filter((p): p is string => !!p);
      if (problems.length) throw badRequest(problems.join(" "));
      body.lanHosts = entries;
    }
    await savePrivacySettings(db, body, req.user!.id);
    await audit(db, { userId: req.user!.id, action: "settings.privacy_updated", details: body });
    return summary(requestLanguage(req));
  });

  api.put("/admin/privacy/kill-switch", async (req) => {
    requireAdmin(req);
    const { on } = z.object({ on: z.boolean() }).parse(req.body);
    await setKillSwitch(db, on, req.user!.id);
    // A cached editor discovery must not outlive the switch.
    deps.office.resetDiscovery();
    await audit(db, { userId: req.user!.id, action: on ? "privacy.kill_switch_on" : "privacy.kill_switch_off" });
    return summary(requestLanguage(req));
  });

  // ---- Connections ---------------------------------------------------------------------------

  async function connections(lang: string): Promise<PrivacyConnectionDto[]> {
    const t = tFor(lang);
    const lastRows = await db
      .select({ connection: outboundLog.connection, at: max(outboundLog.at) })
      .from(outboundLog)
      .where(and(isNotNull(outboundLog.connection), eq(outboundLog.blocked, false)))
      .groupBy(outboundLog.connection);
    const last = new Map(lastRows.map((r) => [r.connection!, r.at ? new Date(r.at).toISOString() : null]));
    const loc = (url: string | null | undefined): PrivacyConnectionDto["location"] => (url && isExternalUrl(url) ? "external" : "local");
    const out: PrivacyConnectionDto[] = [];

    const [providers, defaultId, mcp, queue] = await Promise.all([getProviders(db), getDefaultProviderId(db), getMcpSettings(db), getStoredAiTaskQueueSettings(db)]);
    for (const p of providers) {
      const id = `ai:${p.id}`;
      out.push({
        id,
        kind: "ai",
        name: p.name,
        host: hostOf(p.baseUrl),
        location: loc(p.baseUrl),
        enabled: !connectionDisabled(id),
        toggleable: true,
        lastUsedAt: last.get(id) ?? null,
        notes: [p.model, ...(defaultId === p.id ? [t("privacy:connections.default")] : []), ...(p.apiKeyEnc ? [t("privacy:connections.apiKeyStored")] : [])],
      });
    }
    const envUrl = deps.reportLlm?.baseUrl;
    if (envUrl)
      out.push({
        id: "ai:env",
        kind: "ai",
        name: t("privacy:connections.reportModel"),
        host: hostOf(envUrl),
        location: loc(envUrl),
        enabled: !connectionDisabled("ai:env"),
        toggleable: true,
        lastUsedAt: last.get("ai:env") ?? null,
        notes: [t("privacy:connections.fromEnvironment")],
      });

    out.push({
      id: "smtp",
      kind: "smtp",
      name: t("privacy:connections.smtp"),
      host: deps.mailer ? (deps.mailer.host ?? null) : null,
      location: deps.mailer?.host ? loc(`smtp://${deps.mailer.host}`) : "local",
      enabled: !connectionDisabled("smtp"),
      toggleable: true,
      lastUsedAt: last.get("smtp") ?? null,
      notes: deps.mailer ? [t("privacy:connections.smtpSends")] : [t("privacy:connections.smtpNotConfigured")],
    });

    const cfg = await deps.office.config();
    const editorOn = cfg.editor.kind !== "none" && !!cfg.editor.url;
    out.push({
      id: "office:editor",
      kind: "office",
      name: editorOn ? t("privacy:connections.officeEditorWith", { name: officeEditorLabel(cfg.editor.kind, lang) }) : t("privacy:connections.officeEditor"),
      host: editorOn ? hostOf(cfg.editor.url!) : null,
      location: editorOn ? loc(cfg.editor.url) : "local",
      enabled: !connectionDisabled("office:editor"),
      toggleable: true,
      lastUsedAt: last.get("office:editor") ?? null,
      notes: editorOn ? [...(cfg.editor.publicUrl ? [t("privacy:connections.browserAddress", { host: hostOf(cfg.editor.publicUrl) })] : [])] : [t("privacy:connections.notConfigured")],
    });
    const conv = await deps.office.converterFor(cfg).catch(() => null);
    const convUrl = cfg.converter.url ?? (cfg.converter.kind === "auto" || cfg.converter.kind === cfg.editor.kind ? cfg.editor.url : null);
    const convRemote = !!conv?.converter && conv.converter.id !== "local";
    out.push({
      id: "office:converter",
      kind: "office",
      name: conv?.converter ? t("privacy:connections.officeConverterWith", { name: officeConverterLabel(conv.converter.id, lang) }) : t("privacy:connections.officeConverter"),
      host: convRemote && convUrl ? hostOf(convUrl) : null,
      location: convRemote && convUrl ? loc(convUrl) : "local",
      enabled: !connectionDisabled("office:converter"),
      toggleable: true,
      lastUsedAt: last.get("office:converter") ?? null,
      notes: conv?.converter?.id === "local" ? [t("privacy:connections.localLibreOffice")] : conv?.converter ? [] : [conv?.reason ? render(lang, conv.reason) : t("privacy:connections.notConfigured")],
    });

    const [tokenCount] = await db
      .select({ n: count() })
      .from(tokens)
      .where(and(eq(tokens.kind, "api"), or(isNull(tokens.expiresAt), gt(tokens.expiresAt, new Date()))));
    out.push({
      id: "mcp",
      kind: "mcp",
      name: t("privacy:connections.mcp"),
      host: null,
      location: "inbound",
      enabled: mcp.enabled,
      toggleable: true,
      lastUsedAt: null,
      notes: [mcp.allowWriteTokens ? t("privacy:connections.writeTokensOn") : t("privacy:connections.readOnly"), t("privacy:connections.accessTokens", { count: Number(tokenCount?.n ?? 0) })],
    });
    out.push({
      id: "ai_queue",
      kind: "ai_queue",
      name: t("privacy:connections.aiQueue"),
      host: null,
      location: "inbound",
      enabled: queue.enabled && !killSwitchOn(),
      toggleable: true,
      lastUsedAt: null,
      notes: [
        ...(queue.allowExternalClients ? [t("privacy:connections.externalClientsAllowed")] : []),
        ...(killSwitchOn() ? [t("privacy:connections.stoppedByKillSwitch")] : []),
      ],
    });
    try {
      const [o] = await db
        .select({ n: count(), on: sql<number>`count(*) filter (where ${oauthClients.enabled})` })
        .from(oauthClients);
      out.push({
        id: "oauth",
        kind: "oauth",
        name: t("privacy:connections.oauth"),
        host: null,
        location: "inbound",
        enabled: Number(o?.on ?? 0) > 0,
        toggleable: false,
        lastUsedAt: null,
        notes: [t("privacy:connections.oauthApps", { count: Number(o?.n ?? 0), enabled: Number(o?.on ?? 0) }), t("privacy:connections.oauthManaged")],
      });
    } catch {
      out.push({ id: "oauth", kind: "oauth", name: t("privacy:connections.oauth"), host: null, location: "inbound", enabled: false, toggleable: false, lastUsedAt: null, notes: [t("privacy:connections.comingSoon")] });
    }
    return out;
  }

  api.get("/admin/privacy/connections", async (req) => {
    requireAdmin(req);
    return connections(requestLanguage(req));
  });

  api.put<{ Params: { id: string } }>("/admin/privacy/connections/:id", async (req) => {
    requireAdmin(req);
    const id = z.string().min(1).max(120).parse(req.params.id);
    const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
    const uid = req.user!.id;
    if (id === "mcp") {
      await putSetting(db, "integrations.mcp", { ...(await getMcpSettings(db)), enabled }, uid);
    } else if (id === "ai_queue") {
      await putSetting(db, "ai.taskQueue", { ...(await getStoredAiTaskQueueSettings(db)), enabled }, uid);
    } else if (id === "oauth") {
      throw badRequest(msg("privacy:errors.oauthManagedElsewhere"));
    } else {
      const known = ["ai:env", "smtp", "office:editor", "office:converter", ...(await getProviders(db)).map((p) => `ai:${p.id}`)];
      if (!known.includes(id) && !connectionDisabled(id)) throw badRequest(msg("privacy:errors.unknownConnection"));
      await setConnectionEnabled(db, id, enabled, uid);
      if (id.startsWith("office:")) deps.office.resetDiscovery();
    }
    await audit(db, { userId: uid, action: "privacy.connection_updated", details: { id, enabled } });
    return connections(requestLanguage(req));
  });

  // ---- Outbound log --------------------------------------------------------------------------

  function where(q: z.infer<typeof logQuery>): SQL | undefined {
    const c: SQL[] = [];
    if (q.purpose) c.push(like(outboundLog.purpose, `${q.purpose.replace(/[\\%_]/g, "\\$&")}%`));
    if (q.host) c.push(eq(outboundLog.host, q.host));
    if (q.from) c.push(gte(outboundLog.at, new Date(`${q.from}T00:00:00`)));
    if (q.to) c.push(lte(outboundLog.at, new Date(`${q.to}T23:59:59.999`)));
    if (q.blocked) c.push(eq(outboundLog.blocked, q.blocked === "true"));
    return c.length ? and(...c) : undefined;
  }

  async function rows(q: z.infer<typeof logQuery>, limit: number, offset: number): Promise<OutboundLogRowDto[]> {
    const list = await db
      .select({ l: outboundLog, userName: users.name, projectCode: projects.code })
      .from(outboundLog)
      .leftJoin(users, eq(users.id, outboundLog.userId))
      .leftJoin(projects, eq(projects.id, outboundLog.projectId))
      .where(where(q))
      .orderBy(desc(outboundLog.at))
      .limit(limit)
      .offset(offset);
    return list.map(({ l, userName, projectCode }) => ({
      id: l.id,
      at: new Date(l.at).toISOString(),
      purpose: l.purpose,
      connection: l.connection,
      host: l.host,
      method: l.method,
      local: l.local,
      blocked: l.blocked,
      bytesOut: l.bytesOut,
      bytesIn: l.bytesIn,
      status: l.status,
      error: l.error,
      durationMs: l.durationMs,
      userName: userName ?? null,
      projectCode: projectCode ?? null,
      details: l.details ?? null,
    }));
  }

  api.get("/admin/privacy/outbound", async (req) => {
    requireAdmin(req);
    const q = logQuery.parse(req.query);
    const [list, [total], purposes, hosts] = await Promise.all([
      rows(q, q.limit, q.offset),
      db.select({ n: count() }).from(outboundLog).where(where(q)),
      db.selectDistinct({ v: outboundLog.purpose }).from(outboundLog).orderBy(asc(outboundLog.purpose)),
      db.selectDistinct({ v: outboundLog.host }).from(outboundLog).orderBy(asc(outboundLog.host)),
    ]);
    return { rows: list, total: Number(total?.n ?? 0), purposes: purposes.map((p) => p.v), hosts: hosts.map((h) => h.v) };
  });

  api.get("/admin/privacy/outbound.csv", async (req, reply) => {
    requireAdmin(req);
    const q = logQuery.parse(req.query);
    const list = await rows(q, 10_000, 0);
    const t = tReq(req);
    const columns = ["time", "purpose", "connection", "host", "method", "location", "blocked", "bytesOut", "bytesIn", "status", "error", "duration", "user", "project", "details"] as const;
    const header = columns.map((c) => t(`privacy:csv.columns.${c}`));
    const csv = toCsv(
      header,
      list.map((r) => [
        r.at,
        r.purpose,
        r.connection ?? "",
        r.host,
        r.method,
        r.local ? t("privacy:csv.local") : t("privacy:csv.external"),
        r.blocked ? t("privacy:csv.yes") : t("privacy:csv.no"),
        r.bytesOut ?? "",
        r.bytesIn ?? "",
        r.status ?? "",
        r.error ?? "",
        r.durationMs ?? "",
        r.userName ?? "",
        r.projectCode ?? "",
        r.details ? JSON.stringify(r.details) : "",
      ]),
    );
    reply.header("Content-Type", "text/csv; charset=utf-8");
    reply.header("Content-Disposition", `attachment; filename="${t("privacy:csv.fileName")}"`);
    return reply.send(csv);
  });
}
