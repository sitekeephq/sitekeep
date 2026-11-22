/**
 * Yönetim → Lisans (docs/onprem/lisanslama.md §7.3), system administrators only:
 *   GET    /admin/license   status, installation id, seats in use
 *   PUT    /admin/license   { file } install a licence (checked: signature, installation)
 *   DELETE /admin/license   remove it (SiteKeep Community again)
 *   POST   /admin/license/activate  { key } online activation (docs/onprem/licensing-online.md)
 *   POST   /admin/license/refresh   check the online licence now (also nightly, license/online.ts)
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { ResolvedDeps } from "../app/deps.js";
import { audit } from "../core/platform/audit.js";
import { HttpError, forbidden } from "../core/platform/http.js";
import { msg } from "../i18n/index.js";
import { activateLicense, licensingUrls, refreshApplies, refreshLicense, type OnlineOutcome } from "./online.js";
import { currentLicense, installLicense, onlineState, refreshSeats, removeLicense } from "./state.js";

/** Reasons with their own message under admin:license.online.reasons; any other is "rejected". */
const ONLINE_REASONS = ["key_format", "not_found", "revoked", "expired", "bound_to_other_installation", "trial_used", "not_online", "rejected"] as const;
type OnlineReason = (typeof ONLINE_REASONS)[number];

function requireAdmin(req: FastifyRequest) {
  if (!req.user?.isAdmin) throw forbidden(msg("admin:license.adminOnly"));
}

export async function licenseRoutes(api: FastifyInstance, deps: ResolvedDeps) {
  const { db } = deps;

  async function dto() {
    const seatsUsed = await refreshSeats(db);
    const v = currentLicense();
    return {
      installationId: v.installationId,
      status: v.status,
      problem: v.problem,
      enforced: v.enforced,
      clockBehind: v.clockBehind,
      daysLeft: v.daysLeft,
      readOnlyAt: v.readOnlyAt,
      seatsUsed,
      seatsOver: v.seatsOver,
      onlineProblem: v.onlineProblem,
      online: { ...onlineState(), refreshes: refreshApplies(), service: licensingUrls()[0]! },
      license: v.payload && {
        lid: v.payload.lid,
        customer: v.payload.customer.name,
        edition: v.payload.edition,
        plan: v.payload.plan ?? null,
        onlineMode: v.payload.online,
        seats: v.payload.seats,
        modules: v.payload.modules,
        validFrom: v.payload.validFrom,
        validUntil: v.payload.validUntil,
        supportUntil: v.payload.supportUntil,
        graceDays: v.payload.graceDays,
      },
    };
  }

  api.get("/admin/license", async (req) => {
    requireAdmin(req);
    return dto();
  });

  api.put("/admin/license", async (req) => {
    requireAdmin(req);
    const body = z.object({ file: z.string().min(1).max(50_000) }).safeParse(req.body);
    if (!body.success) throw new HttpError(400, "validation", msg("admin:license.fileRequired"));
    const r = await installLicense(db, body.data.file, req.user!.id);
    if (!r.ok) throw new HttpError(400, `license_${r.problem}`, msg(`admin:license.problems.${r.problem}`));
    const v = currentLicense();
    await audit(db, { userId: req.user!.id, action: "license.installed", details: { lid: v.payload?.lid, modules: v.payload?.modules, validUntil: v.payload?.validUntil } });
    return dto();
  });

  /** Turns a failed online call into the API error the screen shows. */
  function onlineError(r: Exclude<OnlineOutcome, { ok: true }>): HttpError {
    if (r.kind === "unreachable") return new HttpError(502, "license_unreachable", msg("admin:license.online.unreachable"));
    if (r.kind === "invalid_licence") return new HttpError(400, `license_${r.problem}`, msg(`admin:license.problems.${r.problem}`));
    const reason: OnlineReason = (ONLINE_REASONS as readonly string[]).includes(r.reason) ? (r.reason as OnlineReason) : "rejected";
    return new HttpError(400, `license_${reason}`, msg(`admin:license.online.reasons.${reason}`));
  }

  api.post("/admin/license/activate", async (req) => {
    requireAdmin(req);
    const body = z.object({ key: z.string().min(1).max(100) }).safeParse(req.body);
    if (!body.success) throw new HttpError(400, "validation", msg("admin:license.online.keyRequired"));
    const r = await activateLicense(db, body.data.key, req.user!.id);
    if (!r.ok) throw onlineError(r);
    const v = currentLicense();
    await audit(db, { userId: req.user!.id, action: "license.activated", details: { lid: v.payload?.lid, plan: v.payload?.plan ?? null, modules: v.payload?.modules, validUntil: v.payload?.validUntil } });
    return dto();
  });

  api.post("/admin/license/refresh", async (req) => {
    requireAdmin(req);
    const before = currentLicense().payload?.issuedAt ?? null;
    const r = await refreshLicense(db, req.user!.id);
    // A refused licence (revoked) is a result to show, not an error: the grace period has started.
    if (!r.ok && r.kind !== "rejected") throw onlineError(r);
    if (!r.ok && r.reason === "not_online") throw onlineError(r);
    const v = currentLicense();
    if (r.ok && r.changed && v.payload?.issuedAt !== before)
      await audit(db, { userId: req.user!.id, action: "license.refreshed", details: { lid: v.payload?.lid, modules: v.payload?.modules, validUntil: v.payload?.validUntil } });
    return dto();
  });

  api.delete("/admin/license", async (req) => {
    requireAdmin(req);
    const before = currentLicense().payload?.lid ?? null;
    await removeLicense(db, req.user!.id);
    await audit(db, { userId: req.user!.id, action: "license.removed", details: { lid: before } });
    return dto();
  });
}
