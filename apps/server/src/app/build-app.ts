import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import { and, eq, gt, isNull, or } from "drizzle-orm";
import type { AuthUser } from "../core/security/access.js";
import { hashToken } from "../core/security/auth.js";
import type { Db } from "../db/index.js";
import { oauthClients, tokens, users } from "../db/schema.js";
import { HttpError, errorHandler } from "../core/platform/http.js";
import { msg, render, requestLanguage } from "../i18n/index.js";
import { logMethodHook } from "../core/platform/error-ring.js";
import { devToolsEnabled } from "../dev/flag.js";
import { devRoutes } from "../dev/routes.js";
import { authRoutes } from "../auth/routes.js";
import { adminRoutes } from "../admin/routes.js";
import { projectRoutes } from "../projects/routes.js";
import { documentRoutes } from "../modules/documents/routes.js";
import { namingRoutes } from "../modules/documents/naming-routes.js";
import { issueRoutes } from "../coordination/routes/issues.js";
import { bcfRoutes } from "../bcf/routes.js";
import { workflowRoutes } from "../workflow/routes/workflow.js";
import { reviewRoutes } from "../workflow/routes/reviews.js";
import { notificationRoutes } from "../workflow/routes/notifications.js";
import { markupRoutes } from "../coordination/routes/markups.js";
import { compareRoutes } from "../doccompare/routes/compare.js";
import { modelRoutes } from "../model/routes.js";
import { locationRoutes } from "../locations/routes.js";
import { roleRoutes } from "../access/routes.js";
import { templateRoutes } from "../templates/routes.js";
import { worksRoutes } from "../works/routes/works.js";
import { AskBridge } from "../core/platform/ask-bridge.js";
import { coordinationRoutes } from "../coordination/routes/coordination.js";
import { idsRoutes } from "../coordination/routes/ids.js";
import { enforceTokenScope } from "../core/security/token-scope.js";
import { reportRoutes } from "../reports/routes.js";
import { docIntelRoutes } from "../docintel/routes.js";
import { docCompareRoutes } from "../doccompare/routes/doc-compare.js";
import { previewRoutes } from "../previews/routes.js";
import { Converters } from "../previews/converters.js";
import { OfficeIntegration } from "../office/service.js";
import { officeRoutes, officeSourceRoutes } from "../office/routes.js";
import { hubRoutes } from "../workflow/routes/hub.js";
import { resolveOAuthOptions } from "../oauth/config.js";
import { FailureLimiter } from "../oauth/rate-limit.js";
import { foundationRoutes } from "../oauth/foundation.js";
import { oauthServerRoutes } from "../oauth/routes.js";
import { oauthApiRoutes } from "../oauth/api-routes.js";
import { documentsApiRoutes } from "../opencde/documents.js";
import { opencdePageRoutes } from "../opencde/pages.js";
import { newCspNonce, registerSecurityHeaders, withNonce } from "../privacy/headers.js";
import { configureOutbound, withOutboundContext } from "../privacy/outbound.js";
import { privacyRoutes } from "../privacy/routes.js";
import { loadPrivacyState } from "../privacy/settings.js";
import { loadedModules } from "./modules.js";
import { initLicense, moduleReadOnly } from "../license/state.js";
import { licenseRoutes } from "../license/routes.js";
import { editionName, moduleIds } from "./module-ids.js";
import { worksCapabilities } from "../works/capabilities.js";
import { SESSION_COOKIE, type AppDeps, type ResolvedDeps } from "./deps.js";
import "./fastify-types.js";

export type { AppDeps, ResolvedDeps } from "./deps.js";
export { SESSION_COOKIE } from "./deps.js";

/** A module's routes answer only while it is on; with its licence lapsed they only read (docs/onprem/lisanslama.md §5.2). */
function moduleGuard(id: string) {
  return async (req: FastifyRequest) => {
    if (!moduleIds().includes(id)) throw new HttpError(404, "module_off", msg("errors:moduleOff"));
    if (moduleReadOnly(id) && req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS")
      throw new HttpError(402, "license_read_only", msg("errors:licenseReadOnly"));
  };
}

export async function buildApp(input: AppDeps): Promise<FastifyInstance> {
  const secretKey = input.secretKey ?? randomBytes(32);
  const converters = input.converters ?? new Converters();
  const office =
    input.office ?? new OfficeIntegration({ db: input.db, secretKey, converters, env: input.officeEnv ?? process.env });
  // Production never gets developer tools, even when a caller passes devTools: true.
  const devTools = (input.devTools ?? devToolsEnabled()) && process.env.NODE_ENV !== "production";
  const webUrl = input.webUrl ?? process.env.CDE_WEB_URL ?? "http://localhost:5173";
  const oauth = resolveOAuthOptions(input.oauth);
  const deps: ResolvedDeps = {
    ...input,
    oauth,
    oauthLimiter: new FailureLimiter(oauth.tokenFailureLimit, oauth.tokenFailureWindowMs),
    secretKey,
    askBridge: input.askBridge ?? new AskBridge(),
    converters,
    office,
    devTools,
    webUrl,
  };
  worksCapabilities();
  // The installation id and the licence (license/state.ts), before any request.
  await initLicense(deps.db);
  const app = Fastify({
    // WOPI access tokens and OAuth codes / tokens / secrets travel in query strings (the bSI OAuth
    // example sends token requests that way) and conversion tickets in the path: never log them.
    // Error lines also go to the in-memory ring of recent errors (cde_dev_health), with secrets redacted.
    logger: deps.logger
      ? {
          serializers: { req: (req) => ({ method: req.method, url: redactUrl(req.url), host: req.host, remoteAddress: req.ip }) },
          hooks: { logMethod: logMethodHook as never },
          ...(deps.logStream && { stream: deps.logStream }),
        }
      : false,
    bodyLimit: 10 * 1024 * 1024,
    ...(deps.trustProxy && { trustProxy: deps.trustProxy }),
  });
  app.setErrorHandler(errorHandler);
  await app.register(cookie);
  await app.register(multipart, {
    limits: { fileSize: deps.maxUploadBytes ?? 20 * 1024 * 1024 * 1024, files: 50 },
  });

  app.decorateRequest("user", null);
  app.addHook("onRequest", async (req) => {
    // In-process calls of the "Sor" assistant carry a short-lived bridge key instead of a token.
    const bridged = deps.askBridge.lookup(req);
    req.user = bridged !== undefined ? bridged : await authenticate(deps.db, req);
  });

  // Privacy (docs/features/PRIVACY.md): settings in memory, every outbound call logged with the request's
  // user, project and route, security headers on every response.
  configureOutbound({ db: deps.db });
  await loadPrivacyState(deps.db);
  app.addHook("preHandler", (req, _reply, done) => {
    const params = (req.params ?? {}) as Record<string, unknown>;
    const pid = typeof params.pid === "string" ? params.pid : typeof params.projectId === "string" ? params.projectId : null;
    const route = req.routeOptions.url ?? "";
    const feature = route.replace(/^\/api\/v1\/(projects\/:pid\/)?/, "") || null;
    withOutboundContext({ db: deps.db, userId: req.user?.id ?? null, projectId: pid, feature }, done);
  });
  registerSecurityHeaders(app, { editorOrigins: () => office.editorOrigins(), publicUrl: deps.oauth.publicUrl });

  await app.register(
    async (api) => {
      api.addHook("onRequest", async (req) => {
        const open = req.routeOptions.config && (req.routeOptions.config as { public?: boolean }).public;
        if (!open && !req.user) throw new HttpError(401, "unauthorized", msg("errors:unauthorized"));
        enforceTokenScope(req);
      });
      api.get("/health", { config: { public: true } }, async () => ({ ok: true }));
      // Installed SiteKeep modules (signed-in only): the stdio MCP server offers only their tools
      api.get("/modules", async () => ({ modules: moduleIds(), edition: editionName() }));
      // Before sign-in too: the web app turns on these modules and shows the edition (app/modules.ts).
      api.get("/app-info", { config: { public: true } }, async () => ({ product: "SiteKeep", edition: editionName(), modules: moduleIds() }));
      await authRoutes(api, deps);
      await adminRoutes(api, deps);
      await projectRoutes(api, deps);
      await documentRoutes(api, deps);
      await namingRoutes(api, deps);
      await issueRoutes(api, deps);
      await bcfRoutes(api, deps);
      await workflowRoutes(api, deps);
      await reviewRoutes(api, deps);
      await notificationRoutes(api, deps);
      await markupRoutes(api, deps);
      await compareRoutes(api, deps);
      await modelRoutes(api, deps);
      await locationRoutes(api, deps);
      await reportRoutes(api, deps);
      await roleRoutes(api, deps);
      await templateRoutes(api, deps);
      await worksRoutes(api, deps);
      // Every loaded module's routes, each behind its switch: off (not licensed) → 404, licence lapsed → reads only.
      for (const m of loadedModules) if (m.routes) await api.register(async (scope) => {
        scope.addHook("onRequest", moduleGuard(m.id));
        await m.routes!(scope, deps);
      });
      await licenseRoutes(api, deps);
      await coordinationRoutes(api, deps);
      await idsRoutes(api, deps);
      await docIntelRoutes(api, deps);
      await docCompareRoutes(api, deps);
      await previewRoutes(api, deps);
      await officeRoutes(api, deps);
      await hubRoutes(api, deps);
      await oauthApiRoutes(api, deps);
      await opencdePageRoutes(api, deps);
      await privacyRoutes(api, deps);
      // Developer tools: registered only on a development server (CDE_DEV_TOOLS=1, not production).
      if (deps.devTools) await devRoutes(api, deps);
    },
    { prefix: "/api/v1" },
  );


  // OpenCDE Foundation API 1.1 and the built-in OAuth2 server (docs/features/OPENCDE.md), outside /api/v1.
  await foundationRoutes(app, deps);
  await oauthServerRoutes(app, deps);
  // OpenCDE Documents API 1.0 (upload / select documents), outside /api/v1.
  await documentsApiRoutes(app, deps);
  // Office → PDF conversion source for ONLYOFFICE, outside /api/v1 (the WOPI editor routes are Connect's).
  await officeSourceRoutes(app, deps);

  // Modules' routes outside /api/v1 (AI: the hosted MCP endpoint for Claude Code / Desktop, Cline…).
  for (const m of loadedModules) if (m.rootRoutes) await app.register(async (scope) => {
    scope.addHook("onRequest", moduleGuard(m.id));
    await m.rootRoutes!(scope, deps);
  });

  if (deps.webDist && existsSync(deps.webDist)) {
    const root = path.resolve(deps.webDist);
    const indexFile = path.join(root, "index.html");
    // index.html is served below with a fresh CSP nonce on its script tags (the report iframe's
    // inline scripts carry it); the static plugin serves every other file.
    const indexHtml = existsSync(indexFile) ? readFileSync(indexFile, "utf8") : null;
    await app.register(fastifyStatic, { root, wildcard: false, ...(indexHtml !== null && { index: false, globIgnore: ["index.html"] }) });
    const sendIndex = (reply: FastifyReply) => {
      if (indexHtml === null) return reply.sendFile("index.html");
      const nonce = newCspNonce();
      reply.cspNonce = nonce;
      return reply.type("text/html; charset=utf-8").header("cache-control", "no-cache").send(withNonce(indexHtml, nonce));
    };
    if (indexHtml !== null) {
      app.get("/", (_req, reply) => sendIndex(reply));
      app.get("/index.html", (_req, reply) => sendIndex(reply));
    }
    // Single-page app: unknown non-API paths serve index.html.
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/")) {
        return reply.status(404).send({ error: "not_found", message: render(requestLanguage(req), msg("errors:routeNotFound")) });
      }
      return sendIndex(reply);
    });
  }

  return app;
}

/**
 * Query parameters that carry secrets: WOPI and OAuth tokens, OAuth codes, client secrets, PKCE
 * verifiers, OpenCDE Documents page keys.
 */
const SECRET_PARAMS = /([?&](?:access_token|refresh_token|client_secret|code_verifier|code|token|key)=)[^&#]*/gi;

/** Request URL for the logs, without WOPI access tokens, OAuth secrets and conversion tickets. */
export function redactUrl(url: string): string {
  return url
    .replace(SECRET_PARAMS, "$1***")
    .replace(/(\/wopi\/convert\/)[^/?#]+/i, "$1***")
    .replace(/(\/opencde\/sessions\/)[^/?#]+/i, "$1***");
}

async function authenticate(db: Db, req: FastifyRequest): Promise<AuthUser | null> {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice(7).trim() : req.cookies?.[SESSION_COOKIE];
  if (!token) return null;
  const now = new Date();
  const [row] = await db
    .select({
      tokenId: tokens.id,
      kind: tokens.kind,
      scope: tokens.scope,
      projectIds: tokens.projectIds,
      id: users.id,
      email: users.email,
      name: users.name,
      isAdmin: users.isAdmin,
      companyId: users.companyId,
      prefs: users.prefs,
      disabled: users.disabled,
      lastUsedAt: tokens.lastUsedAt,
      oauthClientId: tokens.oauthClientId,
      oauthScopes: tokens.oauthScopes,
      oauthClientEnabled: oauthClients.enabled,
    })
    .from(tokens)
    .innerJoin(users, eq(users.id, tokens.userId))
    .leftJoin(oauthClients, eq(oauthClients.id, tokens.oauthClientId))
    .where(and(eq(tokens.tokenHash, hashToken(token)), or(isNull(tokens.expiresAt), gt(tokens.expiresAt, now))));
  if (!row || row.disabled) return null;
  // OAuth access tokens stop working while their client is disabled.
  if (row.kind === "oauth" && !row.oauthClientEnabled) return null;
  // Touch at most once a minute.
  if (!row.lastUsedAt || now.getTime() - row.lastUsedAt.getTime() > 60_000) {
    await db.update(tokens).set({ lastUsedAt: now }).where(eq(tokens.id, row.tokenId));
  }
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    isAdmin: row.isAdmin,
    companyId: row.companyId,
    mustChangePassword: !!row.prefs?.mustChangePassword,
    language: row.prefs?.language ?? null,
    token: {
      id: row.tokenId,
      kind: row.kind,
      scope: row.kind === "session" ? "write" : row.scope,
      projectIds: row.kind === "api" ? (row.projectIds ?? null) : null,
      ...(row.kind === "oauth" && { oauthScopes: row.oauthScopes ?? [], oauthClientId: row.oauthClientId ?? undefined }),
    },
  };
}
