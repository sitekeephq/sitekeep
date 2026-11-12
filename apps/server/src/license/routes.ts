/**
 * Yönetim → Lisans (docs/onprem/lisanslama.md §7.3), system administrators only:
 *   GET    /admin/license   status, installation id, seats in use
 *   PUT    /admin/license   { file } install a licence (checked: signature, installation)
 *   DELETE /admin/license   remove it (SiteKeep Community again)
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { ResolvedDeps } from "../app/deps.js";
import { audit } from "../core/platform/audit.js";
import { HttpError, forbidden } from "../core/platform/http.js";
import { msg } from "../i18n/index.js";
import { currentLicense, installLicense, refreshSeats, removeLicense } from "./state.js";

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
      license: v.payload && {
        lid: v.payload.lid,
        customer: v.payload.customer.name,
        edition: v.payload.edition,
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

  api.delete("/admin/license", async (req) => {
    requireAdmin(req);
    const before = currentLicense().payload?.lid ?? null;
    await removeLicense(db, req.user!.id);
    await audit(db, { userId: req.user!.id, action: "license.removed", details: { lid: before } });
    return dto();
  });
}
