/**
 * OpenCDE Foundation API 1.1 (https://github.com/buildingSMART/foundation-API/tree/release_1_1):
 *   GET /foundation/versions            which OpenCDE APIs this server offers (always at this path)
 *   GET /foundation/1.1/auth            OAuth2 endpoints and flows (public)
 *   GET /foundation/1.1/current-user    the caller (Bearer token)
 * Errors follow error.json ({ message }); responses carry CORS headers for browser clients.
 */
import type { FastifyInstance } from "fastify";
import type { ResolvedDeps } from "../app/deps.js";
import { HttpError } from "../core/platform/http.js";
import { oauthEndpoints, publicBaseUrl } from "./config.js";
import { setOpenCdeCors } from "./cors.js";
import { msg, render, requestLanguage } from "../i18n/index.js";

/**
 * OpenCDE APIs and their versions. An entry with a flag is advertised only when the flag is on
 * (CDE_OPENCDE_APIS): turn "bcf" on once that API is live. Documents 1.0 is live.
 */
export const OPENCDE_APIS: readonly { apiId: string; versionId: string; detailedVersion: string; flag?: string }[] = [
  { apiId: "foundation", versionId: "1.1", detailedVersion: "https://github.com/buildingSMART/foundation-API/tree/release_1_1" },
  { apiId: "bcf", versionId: "3.0", detailedVersion: "https://github.com/buildingSMART/BCF-API/tree/release_3_0", flag: "bcf" },
  // Live (opencde/documents.ts): always advertised.
  { apiId: "documents", versionId: "1.0", detailedVersion: "https://github.com/buildingSMART/documents-API/tree/release_1_0" },
];

export function advertisedApis(flags: readonly string[]) {
  return OPENCDE_APIS.filter((a) => !a.flag || flags.includes(a.flag));
}

export async function foundationRoutes(app: FastifyInstance, deps: ResolvedDeps) {
  const { oauth: opts } = deps;

  app.options("/foundation/*", async (_req, reply) => {
    setOpenCdeCors(reply);
    return reply.status(204).send();
  });

  app.get("/foundation/versions", async (req, reply) => {
    setOpenCdeCors(reply);
    const base = publicBaseUrl(opts, req);
    return {
      versions: advertisedApis(opts.apis).map((a) => ({
        api_id: a.apiId,
        version_id: a.versionId,
        detailed_version: a.detailedVersion,
        api_base_url: `${base}/${a.apiId}/${a.versionId}`,
      })),
    };
  });

  app.get("/foundation/1.1/auth", async (req, reply) => {
    setOpenCdeCors(reply);
    const e = oauthEndpoints(opts, req);
    // No dynamic client registration: clients are registered in Yönetim → OAuth Uygulamaları.
    return {
      oauth2_auth_url: e.authUrl,
      oauth2_token_url: e.tokenUrl,
      http_basic_supported: false,
      supported_oauth2_flows: ["authorization_code_grant"],
    };
  });

  app.get("/foundation/1.1/current-user", async (req, reply) => {
    setOpenCdeCors(reply);
    if (!req.user) {
      reply.header("WWW-Authenticate", 'Bearer realm="SiteKeep"');
      throw new HttpError(401, "unauthorized", msg("oauth:errors.bearerRequired"));
    }
    // The e-mail is the user id across OpenCDE APIs (BCF users[], assigned_to).
    return { id: req.user.email, name: req.user.name };
  });

  // Unknown Foundation versions and resources: JSON 404, not the web app.
  app.get("/foundation/*", async (req, reply) => {
    setOpenCdeCors(reply);
    return reply.status(404).send({ error: "not_found", message: render(requestLanguage(req), msg("oauth:errors.resourceNotFound")) });
  });
}
