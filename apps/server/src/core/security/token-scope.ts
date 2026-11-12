import type { FastifyRequest } from "fastify";
import { oauthApiAccess } from "@sitekeep/shared";
import { tokenAllowsProject } from "./access.js";
import { forbidden, notFound } from "../platform/http.js";
import { msg } from "../../i18n/index.js";

/** POST routes that only read data; read-only API tokens may call them. */
const READ_ONLY_POSTS = new Set([
  "/api/v1/projects/:pid/naming/validate",
  "/api/v1/templates/preview",
  // "Sor" assistant: reads with the caller's rights; its own tool calls are read-only.
  "/api/v1/projects/:pid/ask",
  "/api/v1/projects/:pid/ask/:jobId/cancel",
  "/api/v1/projects/:pid/schedules/:sid/summary",
  "/api/v1/projects/:pid/docintel/suggest",
  "/api/v1/projects/:pid/versions/:vid/docintel/suggest",
  "/api/v1/projects/:pid/doc-compare/:cid/report",
  // "Modele sor" and the comparison summary only read (the report draft is not saved).
  "/api/v1/projects/:pid/versions/:vid/model-query",
  "/api/v1/projects/:pid/versions/:vid/model-ask",
  "/api/v1/projects/:pid/versions/:vid/model-query/report-draft",
  "/api/v1/projects/:pid/compare/summary",
  // Parameter change preview and the sentence → {query, set} plan save nothing.
  "/api/v1/projects/:pid/param-changes/preview",
  "/api/v1/projects/:pid/param-changes/ai-plan",
  // Report queries run with the caller's rights and save nothing (cde_report_run, "Sor").
  "/api/v1/projects/:pid/reports/query",
  // 4D / 5D rule previews and proposals store nothing.
  "/api/v1/projects/:pid/schedules/:sid/link-rules/preview",
  "/api/v1/projects/:pid/schedules/:sid/link-rules/suggest",
  "/api/v1/projects/:pid/cost-rules/preview",
  // BCF export (JSON with link / base64) and the import preview store nothing.
  "/api/v1/projects/:pid/bcf/export",
  "/api/v1/projects/:pid/bcf/import/preview",
]);

/**
 * Routes API tokens may never call (whatever the scope): token and password management, revoking
 * connected OAuth applications.
 */
const SESSION_ONLY = [/^\/api\/v1\/auth\/tokens/, /^\/api\/v1\/auth\/password$/, /^\/api\/v1\/auth\/oauth-apps/];
/** OAuth consent: a token must never approve access for another application, not even read it. */
const CONSENT = /^\/api\/v1\/oauth\//;

/**
 * Central API-token restrictions, applied before any route handler:
 * - token management, password change and admin changes need a browser session (a token cannot
 *   mint a broader token or change governance settings);
 * - read tokens may use GET/HEAD and the read-only POST allowlist;
 * - project-restricted tokens get 404 for other projects and cannot change system-level data.
 * OAuth access tokens of OpenCDE clients (kind "oauth") follow the same rules; their read/write
 * scope maps to `scope`, and a token with only OpenCDE scopes (bcf, documents) cannot use /api/v1.
 * Session cookies are unaffected.
 */
export function enforceTokenScope(req: FastifyRequest) {
  const token = req.user?.token;
  if (!token || (token.kind !== "api" && token.kind !== "oauth")) return;
  const route = req.routeOptions.url ?? req.url.split("?")[0]!;
  const method = req.method.toUpperCase();
  const reading = method === "GET" || method === "HEAD";

  if (CONSENT.test(route)) throw forbidden(msg("errors:tokenScope.consentSessionOnly"));

  if (!reading && (SESSION_ONLY.some((r) => r.test(route)) || route.startsWith("/api/v1/admin/")))
    throw forbidden(msg("errors:tokenScope.sessionRequired"));
  if (SESSION_ONLY.some((r) => r.test(route)) && route.startsWith("/api/v1/auth/tokens"))
    throw forbidden(msg("errors:tokenScope.tokensSessionOnly"));

  if (token.kind === "oauth" && !oauthApiAccess(token.oauthScopes ?? []))
    throw forbidden(msg("errors:tokenScope.openCdeOnly"));

  const pid = (req.params as { pid?: string } | undefined)?.pid;
  if (token.projectIds) {
    if (pid !== undefined && !tokenAllowsProject(req.user!, pid)) throw notFound(msg("errors:entities.project"));
    if (!reading && pid === undefined) throw forbidden(msg("errors:tokenScope.projectLimited"));
  }

  if (token.scope === "read" && !reading && !(method === "POST" && READ_ONLY_POSTS.has(route)))
    throw forbidden(msg("errors:tokenScope.readOnly"));
}
