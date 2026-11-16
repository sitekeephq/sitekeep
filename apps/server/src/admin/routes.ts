import { asc, eq, isNotNull } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { companyCodeProblem, normalizeCompanyCode, normalizeGoogleDomain } from "@sitekeep/shared";
import type { AppDeps } from "../app/deps.js";
import { audit } from "../core/platform/audit.js";
import { hashPassword, passwordProblem } from "../core/security/auth.js";
import { companies, users, userTwoFactor } from "../db/schema.js";
import { badRequest, conflict, forbidden, notFound } from "../core/platform/http.js";
import { prefsForPassword, toUserDto } from "../auth/dto.js";
import { endSessions } from "../auth/sign-in-security.js";
import { canReadSecurityRecords } from "../core/security/system-roles.js";
import { getGoogleAuthSettings, putGoogleAuthSettings } from "../auth/google-settings.js";
import { adminSettingsRoutes } from "./settings.js";
import { adminStatus } from "./status.js";
import { capacityRoutes } from "./capacity/routes.js";
import { DEFAULT_LANGUAGE, msg, render } from "../i18n/index.js";
import { refreshSeats } from "../license/state.js";

function requireAdmin(req: FastifyRequest) {
  if (!req.user?.isAdmin) throw forbidden(msg("admin:errors.adminOnly"));
}

export async function adminRoutes(api: FastifyInstance, deps: AppDeps) {
  await adminSettingsRoutes(api, deps.db);
  const { db } = deps;

  api.get("/admin/status", async (req) => {
    requireAdmin(req);
    return adminStatus(deps);
  });

  capacityRoutes(api, deps, requireAdmin);


  api.get("/admin/google-auth", async (req) => {
    requireAdmin(req);
    return getGoogleAuthSettings(db);
  });

  api.put("/admin/google-auth", async (req) => {
    requireAdmin(req);
    const body = z
      .object({
        domainAllowlistEnabled: z.boolean(),
        domains: z.array(z.string()).max(50),
      })
      .parse(req.body);
    const domains: string[] = [];
    const seen = new Set<string>();
    for (const raw of body.domains) {
      const domain = normalizeGoogleDomain(raw);
      if (!domain) throw badRequest(msg("admin:errors.invalidDomain", { domain: raw.trim() || "—" }));
      if (seen.has(domain)) continue;
      seen.add(domain);
      domains.push(domain);
    }
    const next = await putGoogleAuthSettings(db, { domainAllowlistEnabled: body.domainAllowlistEnabled, domains }, req.user!.id);
    await audit(db, {
      userId: req.user!.id,
      action: "auth.google_settings",
      details: { domainAllowlistEnabled: next.domainAllowlistEnabled, domains: next.domains },
    });
    return next;
  });
  // Companies are visible to every signed-in user (needed for member and permission pickers).
  api.get("/companies", async () => db.select().from(companies).orderBy(asc(companies.name)));

  /** Optional short code: normalised (Turkish-aware, ASCII), 2–8 letters/digits, unique. */
  const codeField = z
    .string()
    .max(40)
    .nullable()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined) return undefined;
      const code = normalizeCompanyCode(v);
      const problem = code ? companyCodeProblem(code, DEFAULT_LANGUAGE) : null;
      if (problem) ctx.addIssue({ code: "custom", message: problem });
      return code;
    });
  const checkCodeFree = async (code: string | null | undefined, selfId?: string) => {
    if (!code) return;
    const [other] = await db.select({ id: companies.id, name: companies.name }).from(companies).where(eq(companies.code, code));
    if (other && other.id !== selfId) throw conflict(msg("admin:errors.codeInUse", { code, company: other.name }));
  };
  const checkNameFree = async (name: string | undefined, selfId?: string) => {
    if (!name) return;
    const [other] = await db.select({ id: companies.id }).from(companies).where(eq(companies.name, name));
    if (other && other.id !== selfId) throw conflict(msg("admin:errors.companyExists", { name }));
  };

  /** Optional contact data (recipient of official letters); empty → null. */
  const addressField = z.string().trim().max(1000).nullable().optional().transform((v) => (v === undefined ? undefined : v || null));
  const emailField = z
    .union([z.literal(""), z.null(), z.string().trim().max(200).pipe(z.email(render(DEFAULT_LANGUAGE, msg("admin:errors.invalidEmail"))))])
    .optional()
    .transform((v) => (v === undefined ? undefined : v || null));

  api.post("/companies", async (req) => {
    requireAdmin(req);
    const body = z
      .object({ name: z.string().trim().min(1).max(200), code: codeField, address: addressField, email: emailField })
      .parse(req.body);
    await checkNameFree(body.name);
    await checkCodeFree(body.code);
    const [row] = await db
      .insert(companies)
      .values({ name: body.name, code: body.code ?? null, address: body.address ?? null, email: body.email ?? null })
      .returning();
    await audit(db, { userId: req.user!.id, action: "company.created", targetType: "company", targetId: row!.id, details: { code: row!.code } });
    return row;
  });

  api.patch<{ Params: { id: string } }>("/companies/:id", async (req) => {
    requireAdmin(req);
    const id = z.string().uuid().parse(req.params.id);
    const body = z
      .object({ name: z.string().trim().min(1).max(200).optional(), code: codeField, address: addressField, email: emailField })
      .parse(req.body);
    const [existing] = await db.select().from(companies).where(eq(companies.id, id));
    if (!existing) throw notFound(msg("admin:entities.company"));
    await checkNameFree(body.name, id);
    await checkCodeFree(body.code, id);
    const [row] = await db
      .update(companies)
      .set({
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.code !== undefined ? { code: body.code } : {}),
        ...(body.address !== undefined ? { address: body.address } : {}),
        ...(body.email !== undefined ? { email: body.email } : {}),
      })
      .where(eq(companies.id, id))
      .returning();
    await audit(db, {
      userId: req.user!.id,
      action: "company.updated",
      targetType: "company",
      targetId: id,
      details: { name: body.name, code: body.code, address: body.address !== undefined, email: body.email },
    });
    return row;
  });

  api.get("/users", async (req) => {
    const rows = await db.select().from(users).orderBy(asc(users.name));
    // Non-admins get a directory without the disabled flag; nobody gets password hashes.
    if (!canReadSecurityRecords(req.user)) return rows.filter((u) => !u.disabled).map(toUserDto);
    // System administrators and auditors also see who has two-factor on (reset, docs/features/SIGN_IN_SECURITY.md).
    const withTwoFactor = new Set(
      (await db.select({ id: userTwoFactor.userId }).from(userTwoFactor).where(isNotNull(userTwoFactor.enabledAt))).map((r) => r.id),
    );
    return rows.map((u) => ({ ...toUserDto(u), twoFactor: withTwoFactor.has(u.id) }));
  });

  api.post("/users", async (req) => {
    requireAdmin(req);
    const body = z
      .object({
        email: z.string().trim().toLowerCase().email(),
        name: z.string().trim().min(1),
        password: z.string(),
        companyId: z.string().uuid().nullable().optional(),
        isAdmin: z.boolean().optional(),
        isAuditor: z.boolean().optional(),
        mustChangePassword: z.boolean().optional(),
      })
      .parse(req.body);
    const problem = passwordProblem(body.password, { email: body.email, name: body.name });
    if (problem) throw badRequest(problem);
    const prefs = prefsForPassword({}, body.password);
    if (body.mustChangePassword) prefs.mustChangePassword = true;
    const [row] = await db
      .insert(users)
      .values({
        email: body.email,
        name: body.name,
        passwordHash: await hashPassword(body.password),
        companyId: body.companyId ?? null,
        isAdmin: body.isAdmin ?? false,
        isAuditor: body.isAuditor ?? false,
        prefs,
      })
      .returning();
    // System roles given at creation are on the record (security log, the "new administrator" alert).
    await audit(db, {
      userId: req.user!.id,
      action: "user.created",
      targetType: "user",
      targetId: row!.id,
      ...((row!.isAdmin || row!.isAuditor) && { details: { ...(row!.isAdmin && { isAdmin: true }), ...(row!.isAuditor && { isAuditor: true }) } }),
    });
    await refreshSeats(db);
    return toUserDto(row!);
  });

  api.patch<{ Params: { id: string } }>("/users/:id", async (req) => {
    requireAdmin(req);
    const body = z
      .object({
        name: z.string().trim().min(1).optional(),
        companyId: z.string().uuid().nullable().optional(),
        isAdmin: z.boolean().optional(),
        /** Read-only auditor (docs/features/SECURITY_LOG.md#auditor). */
        isAuditor: z.boolean().optional(),
        disabled: z.boolean().optional(),
        password: z.string().optional(),
      })
      .parse(req.body);
    if (req.params.id === req.user!.id && (body.isAdmin === false || body.disabled))
      throw badRequest(msg("admin:errors.selfLockout"));
    const patch: Partial<typeof users.$inferInsert> = {
      name: body.name,
      companyId: body.companyId,
      isAdmin: body.isAdmin,
      isAuditor: body.isAuditor,
      disabled: body.disabled,
      // Enabling an invited account by hand ends its invitation (the person signs in with the password set here).
      ...(body.disabled === false ? { pending: false } : {}),
    };
    if (body.password !== undefined) {
      const [existing] = await db.select({ prefs: users.prefs, email: users.email, name: users.name }).from(users).where(eq(users.id, req.params.id));
      const problem = passwordProblem(body.password, { email: existing?.email, name: body.name ?? existing?.name });
      if (problem) throw badRequest(problem);
      patch.passwordHash = await hashPassword(body.password);
      patch.prefs = prefsForPassword(existing?.prefs, body.password);
    }
    const [row] = await db.update(users).set(patch).where(eq(users.id, req.params.id)).returning();
    if (body.disabled !== undefined) await refreshSeats(db);
    if (!row) throw notFound(msg("admin:entities.user"));
    // A new password ends the user's sessions (G-4); an administrator setting their own keeps this one.
    const sessionsEnded =
      body.password !== undefined ? await endSessions(db, row.id, row.id === req.user!.id ? (req.user!.token?.id ?? null) : null) : undefined;
    await audit(db, {
      userId: req.user!.id,
      action: "user.updated",
      targetType: "user",
      targetId: row.id,
      details: { ...body, password: body.password ? "***" : undefined, ...(sessionsEnded !== undefined && { sessionsEnded }) },
    });
    return toUserDto(row);
  });
}
