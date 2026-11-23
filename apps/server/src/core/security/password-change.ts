import type { FastifyRequest } from "fastify";
import { HttpError } from "../platform/http.js";
import { msg } from "../../i18n/index.js";

/**
 * Routes a session may use while its user must still change the password: who am I, change it, sign out,
 * and the public application info. Everything else answers 403 `password_change_required`.
 */
const ALLOWED_ROUTES: ReadonlySet<string> = new Set([
  "GET /api/v1/auth/me",
  "POST /api/v1/auth/password",
  "POST /api/v1/auth/logout",
  "GET /api/v1/app-info",
  "GET /api/v1/health",
]);

/**
 * Server-side "change the password first" (the web app also shows its own screen). Applies to every
 * kind of credential: API access keys and OAuth tokens get no exception, because a key created with
 * the temporary password would otherwise outlive the forced change (and a key cannot change the password).
 */
export function enforcePasswordChange(req: FastifyRequest) {
  if (!req.user?.mustChangePassword) return;
  const route = req.routeOptions?.url ?? req.url.split("?")[0]!;
  const session = !req.user.token || req.user.token.kind === "session";
  if (session && ALLOWED_ROUTES.has(`${req.method.toUpperCase()} ${route}`)) return;
  throw new HttpError(403, "password_change_required", msg("errors:passwordChangeRequired"));
}
