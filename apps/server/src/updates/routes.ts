/**
 * Administration → System Status → new versions (docs/features/PRIVACY.md → Update Check), system administrators only:
 *   GET  /admin/updates        state, running version, whether a newer release is known
 *   PUT  /admin/updates        { enabled?, promptDismissed? } turn the daily check on or off; answer the one-time card
 *   POST /admin/updates/check  ask now (an explicit administrator action: works while the daily check is off,
 *                              but never past the Privacy Centre's connection switch or kill switch)
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { ResolvedDeps } from "../app/deps.js";
import { appVersion } from "../app/about.js";
import { audit } from "../core/platform/audit.js";
import { HttpError, forbidden } from "../core/platform/http.js";
import { currentLanguage, msg, render } from "../i18n/index.js";
import { checkForUpdates, updateCheckBlocked } from "./check.js";
import { isNewerRelease, parseSemver } from "./semver.js";
import { getUpdateState, saveUpdateState } from "./state.js";

function requireAdmin(req: FastifyRequest) {
  if (!req.user?.isAdmin) throw forbidden(msg("admin:updates.adminOnly"));
}

/** The running release version; null for a development build (no SITEKEEP_VERSION, or not a release number). */
export function runningRelease(): string | null {
  const v = appVersion();
  return parseSemver(v) ? v : null;
}

export async function updateRoutes(api: FastifyInstance, deps: ResolvedDeps) {
  const { db } = deps;

  async function dto() {
    const state = await getUpdateState(db);
    const current = runningRelease();
    const blocked = await updateCheckBlocked(db);
    return {
      enabled: state.enabled,
      promptDismissed: state.promptDismissed,
      current: { version: current, development: current === null },
      latest: state.latest,
      updateAvailable: !!state.latest && isNewerRelease(state.latest.version, current),
      lastCheckAt: state.lastCheckAt,
      lastError: state.lastError,
      /** Why a check cannot be made right now (Privacy Centre), in the requester's language; null when it can. */
      blockedReason: blocked ? render(currentLanguage(), blocked) : null,
    };
  }

  api.get("/admin/updates", async (req) => {
    requireAdmin(req);
    return dto();
  });

  api.put("/admin/updates", async (req) => {
    requireAdmin(req);
    const body = z.object({ enabled: z.boolean().optional(), promptDismissed: z.boolean().optional() }).strict().safeParse(req.body);
    if (!body.success || (body.data.enabled === undefined && body.data.promptDismissed === undefined)) throw new HttpError(400, "validation", msg("admin:updates.invalid"));
    const before = await getUpdateState(db);
    const patch: { enabled?: boolean; promptDismissed?: boolean } = { ...body.data };
    // Turning the check on answers the card as well.
    if (patch.enabled !== undefined) patch.promptDismissed = true;
    await saveUpdateState(db, patch, req.user!.id);
    if (patch.enabled !== undefined && patch.enabled !== before.enabled) {
      await audit(db, { userId: req.user!.id, action: patch.enabled ? "updates.enabled" : "updates.disabled", details: {} });
      // One click, one answer: look right away. A failure (offline, blocked) is shown by the state, not as an error.
      if (patch.enabled) await checkForUpdates(db, req.user!.id);
    }
    return dto();
  });

  api.post("/admin/updates/check", async (req) => {
    requireAdmin(req);
    const r = await checkForUpdates(db, req.user!.id);
    if (!r.ok && r.kind === "blocked") throw new HttpError(409, "updates_blocked", r.reason);
    if (!r.ok) throw new HttpError(502, "updates_unreachable", msg("admin:updates.unreachable"));
    return dto();
  });
}
