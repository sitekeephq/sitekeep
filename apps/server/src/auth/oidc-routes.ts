/**
 * Sign-in with OpenID Connect (docs/features/OIDC_SIGN_IN.md):
 *   public                 GET /auth/oidc/:id/start, GET /auth/oidc/:id/callback
 *   system administrators  GET/POST /admin/oidc-providers, PUT/DELETE /admin/oidc-providers/:id,
 *                          POST /admin/oidc-providers/:id/test
 *
 * Who gets in: an existing, active account with the confirmed address; an invited (pending) person,
 * whose newest open invitation is accepted; a new person only when the provider creates accounts.
 * The address must be verified by the provider (email_verified) unless the administrator trusts it,
 * and in the provider's allowed domains when it has a list. The second step (two-factor) follows as
 * after a password, unless the provider asserted a multi-factor sign-in (amr) and the administrator
 * trusts that.
 */
import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { OIDC_DEFAULTS, amrShowsMfa, emailAllowedForOidc, type OidcButtonDto, type OidcProviderDto, type OidcProviderInput } from "@sitekeep/shared";
import type { ResolvedDeps } from "../app/deps.js";
import { audit } from "../core/platform/audit.js";
import { HttpError, badRequest, forbidden, notFound } from "../core/platform/http.js";
import { hashPassword, newToken } from "../core/security/auth.js";
import type { Db } from "../db/index.js";
import { companies, users } from "../db/schema.js";
import { msg } from "../i18n/index.js";
import { refreshSeats } from "../license/state.js";
import { publicBaseUrl } from "../oauth/config.js";
import { googleDisplayName } from "./google-settings.js";
import { acceptInvitationOfUser } from "./invitations.js";
import {
  OIDC_FLOW_COOKIE,
  OIDC_FLOW_PATH,
  OIDC_FLOW_SECONDS,
  OidcError,
  claimList,
  claimText,
  emailVerified,
  finishOidcFlow,
  forgetOidcCache,
  oidcAlgorithms,
  oidcDiscovery,
  oidcRefusal,
  openFlow,
  sealFlow,
  startOidcFlow,
} from "./oidc.js";
import {
  OIDC_MAX_PROVIDERS,
  cleanOidcInput,
  getOidcProvider,
  getOidcProviders,
  oidcClientSecret,
  oidcRedirectUri,
  putOidcProviders,
  toOidcProviderDto,
  type StoredOidcProvider,
} from "./oidc-settings.js";
import { afterFirstFactor } from "./session.js";
import { checkPrivacyNotice, recordPrivacyNotice, setNoticeCookie, takeNoticeCookie } from "../privacy/notice.js";

const providerInput = z.object({
  id: z.string().trim().toLowerCase().min(1).max(32),
  name: z.string().trim().min(1).max(100),
  enabled: z.boolean().default(OIDC_DEFAULTS.enabled),
  issuer: z.string().trim().min(1).max(500),
  clientId: z.string().trim().min(1).max(500),
  clientSecret: z.string().max(4000).nullable().optional(),
  scopes: z.string().max(1000).default(OIDC_DEFAULTS.scopes),
  buttonLabel: z.string().trim().min(1).max(100),
  buttonColor: z.string().trim().default(OIDC_DEFAULTS.buttonColor),
  allowedDomains: z.array(z.string().max(253)).max(50).default([]),
  createAccounts: z.boolean().default(OIDC_DEFAULTS.createAccounts),
  defaultCompanyId: z.string().uuid().nullable().default(null),
  emailClaim: z.string().trim().default(OIDC_DEFAULTS.emailClaim),
  nameClaim: z.string().trim().default(OIDC_DEFAULTS.nameClaim),
  trustUnverifiedEmail: z.boolean().default(OIDC_DEFAULTS.trustUnverifiedEmail),
  trustProviderMfa: z.boolean().default(OIDC_DEFAULTS.trustProviderMfa),
  groupsClaim: z.string().trim().default(OIDC_DEFAULTS.groupsClaim),
  adminGroup: z.string().max(200).nullable().default(null),
});

function requireAdmin(req: FastifyRequest) {
  if (!req.user?.isAdmin) throw forbidden(msg("admin:errors.adminOnly"));
}

function sameText(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** The sign-in page's buttons: enabled providers whose connection is on. */
export async function oidcButtons(db: Db): Promise<OidcButtonDto[]> {
  const out: OidcButtonDto[] = [];
  for (const p of await getOidcProviders(db)) if (p.enabled && !(await oidcRefusal(db, p))) out.push({ id: p.id, label: p.buttonLabel, color: p.buttonColor });
  return out;
}

export async function oidcRoutes(api: FastifyInstance, deps: ResolvedDeps) {
  const { db, secretKey, signInSecurity: security } = deps;
  const redirectBase = (req: FastifyRequest) => publicBaseUrl(deps.oauth, req);
  const toLogin = (reply: FastifyReply, code: string) => reply.redirect(`/login?authError=${code}`);

  // ---- The flow (public) ------------------------------------------------------------------------

  api.get("/auth/oidc/:id/start", { config: { public: true } }, async (req, reply) => {
    const p = await getOidcProvider(db, (req.params as { id: string }).id);
    if (!p) throw notFound(msg("auth:entities.oidcProvider"));
    if (!p.enabled || (await oidcRefusal(db, p))) return toLogin(reply, "oidc_disabled");
    try {
      const { url, flow } = await startOidcFlow(p, oidcRedirectUri(redirectBase(req), p.id));
      // The privacy notice version the person ticked on the sign-in page (privacy/notice.ts).
      const notice = z.object({ notice: z.coerce.number().int().min(1).optional() }).safeParse(req.query);
      setNoticeCookie(reply, notice.success ? notice.data.notice : null, !!deps.secureCookies, OIDC_FLOW_PATH);
      reply.setCookie(OIDC_FLOW_COOKIE, sealFlow(secretKey, flow), {
        path: OIDC_FLOW_PATH,
        httpOnly: true,
        sameSite: "lax",
        secure: !!deps.secureCookies,
        maxAge: OIDC_FLOW_SECONDS,
      });
      return reply.redirect(url);
    } catch (error) {
      api.log.warn({ err: error, provider: p.id }, "OpenID Connect sign-in could not start");
      return toLogin(reply, "oidc_failed");
    }
  });

  api.get("/auth/oidc/:id/callback", { config: { public: true } }, async (req, reply) => {
    const query = z
      .object({ code: z.string().max(4000).optional(), state: z.string().max(500).optional(), error: z.string().max(200).optional() })
      .parse(req.query);
    const flow = openFlow(secretKey, req.cookies[OIDC_FLOW_COOKIE]);
    reply.clearCookie(OIDC_FLOW_COOKIE, { path: OIDC_FLOW_PATH });
    const noticeAck = takeNoticeCookie(req, reply, OIDC_FLOW_PATH);
    const p = await getOidcProvider(db, (req.params as { id: string }).id);
    if (!p) throw notFound(msg("auth:entities.oidcProvider"));
    const idp = `oidc:${p.id}`;
    if (!p.enabled || (await oidcRefusal(db, p))) return toLogin(reply, "oidc_disabled");
    if (query.error) return toLogin(reply, query.error === "access_denied" ? "oidc_cancelled" : "oidc_failed");
    if (!flow || flow.p !== p.id || !query.code || !query.state || !sameText(query.state, flow.state)) return toLogin(reply, "oidc_invalid_state");

    /** A refused sign-in: `auth.login_failed` (the address only as its hash in the row, audit.ts). */
    const refuse = async (code: string, reason: string, email?: string | null) => {
      const [known] = email ? await db.select({ id: users.id }).from(users).where(eq(users.email, email)) : [];
      await audit(db, { userId: known?.id ?? null, action: "auth.login_failed", details: { ...(email && { email }), provider: idp, reason } });
      return toLogin(reply, code);
    };

    let claims;
    try {
      claims = await finishOidcFlow(p, oidcClientSecret(secretKey, p), flow, query.code, oidcRedirectUri(redirectBase(req), p.id));
    } catch (error) {
      api.log.warn({ err: error, provider: p.id }, "OpenID Connect sign-in failed");
      return refuse("oidc_failed", error instanceof OidcError ? error.code : "error");
    }

    const email = claimText(claims, p.emailClaim)?.toLowerCase() ?? null;
    if (!email || !z.string().email().safeParse(email).success) return refuse("oidc_no_email", "no_email");
    if (!p.trustUnverifiedEmail && !emailVerified(claims)) return refuse("oidc_email_not_verified", "email_not_verified", email);
    if (!emailAllowedForOidc(email, p.allowedDomains)) return refuse("oidc_domain_not_allowed", "domain_not_allowed", email);

    const name = claimText(claims, p.nameClaim) ?? "";
    const adminByGroup = !!p.adminGroup && claimList(claims, p.groupsClaim).includes(p.adminGroup);
    const [existing] = await db.select().from(users).where(eq(users.email, email));
    let user = existing ?? null;
    let created = false;
    let invitation = false;
    // Privacy notice (privacy/notice.ts): an existing or invited account before anything changes, a new one once created.
    let notice = existing ? await checkPrivacyNotice(db, existing.id, noticeAck) : null;
    if (notice && !notice.ok) return toLogin(reply, "privacy_notice_required");
    if (existing?.pending) {
      // Invited: the provider confirmed the invited address, as the invitation link would.
      user = await acceptInvitationOfUser(db, existing.id, { name: name || null, provider: idp });
      if (!user) return refuse("oidc_account_not_allowed", "no_open_invitation", email);
      invitation = true;
    } else if (existing?.disabled) {
      return refuse("oidc_account_not_allowed", "account_disabled", email);
    } else if (!existing) {
      if (!p.createAccounts) return refuse("oidc_account_not_allowed", "no_account", email);
      user = await createAccount(db, p, email, name, adminByGroup);
      if (!user) return refuse("oidc_account_not_allowed", "no_account", email);
      created = true;
    }
    if (!user) return refuse("oidc_account_not_allowed", "no_account", email);
    if (adminByGroup && !user.isAdmin) {
      // Group → system administrator: granted at sign-in, never taken away here (Administration → Users does that).
      const [promoted] = await db.update(users).set({ isAdmin: true }).where(eq(users.id, user.id)).returning();
      if (promoted) user = promoted;
      await audit(db, { userId: user.id, action: "user.updated", targetType: "user", targetId: user.id, details: { isAdmin: true, provider: idp, group: p.adminGroup } });
    }

    notice ??= await checkPrivacyNotice(db, user.id, noticeAck);
    if (!notice.ok) return toLogin(reply, "privacy_notice_required");
    await recordPrivacyNotice(db, user.id, notice.accept, invitation ? "invitation_oidc" : "oidc");

    const providerMfa = p.trustProviderMfa && amrShowsMfa(claims.amr);
    const challenge = await afterFirstFactor(deps, user, reply, { provider: "oidc", idp: p.id, ...(invitation && { invitation: true }) }, { providerMfa });
    if (challenge) return reply.redirect("/login?twoFactor=1");
    security.succeed(email);
    await audit(db, {
      userId: user.id,
      action: "auth.oidc_login",
      details: { provider: p.id, ...(created && { provisioned: true }), ...(invitation && { invitation: true }), ...(providerMfa && { providerMfa: true }) },
    });
    return reply.redirect("/");
  });

  // ---- Administration ---------------------------------------------------------------------------

  const list = async (req: FastifyRequest): Promise<OidcProviderDto[]> => (await getOidcProviders(db)).map((p) => toOidcProviderDto(p, redirectBase(req)));

  async function checked(req: FastifyRequest, body: OidcProviderInput, previous: StoredOidcProvider | null): Promise<StoredOidcProvider> {
    const next = cleanOidcInput(secretKey, body, previous);
    if (next.defaultCompanyId) {
      const [c] = await db.select({ id: companies.id }).from(companies).where(eq(companies.id, next.defaultCompanyId));
      if (!c) throw badRequest(msg("errors:notFound", { what: msg("auth:entities.company") }));
    }
    return next;
  }

  const summary = (p: StoredOidcProvider) => ({
    id: p.id,
    name: p.name,
    issuer: p.issuer,
    enabled: p.enabled,
    createAccounts: p.createAccounts,
    allowedDomains: p.allowedDomains,
    trustUnverifiedEmail: p.trustUnverifiedEmail,
    trustProviderMfa: p.trustProviderMfa,
    adminGroup: p.adminGroup,
  });

  api.get("/admin/oidc-providers", async (req) => {
    requireAdmin(req);
    return list(req);
  });

  api.post("/admin/oidc-providers", async (req) => {
    requireAdmin(req);
    const body = providerInput.parse(req.body) as OidcProviderInput;
    const all = await getOidcProviders(db);
    if (all.some((p) => p.id === body.id)) throw new HttpError(409, "oidc_provider_exists", msg("auth:errors.oidcProviderExists", { id: body.id }));
    if (all.length >= OIDC_MAX_PROVIDERS) throw badRequest(msg("auth:errors.oidcTooMany", { max: OIDC_MAX_PROVIDERS }));
    const next = await checked(req, body, null);
    await putOidcProviders(db, [...all, next], req.user!.id);
    await audit(db, { userId: req.user!.id, action: "auth.oidc_provider_created", details: summary(next) });
    return list(req);
  });

  api.put<{ Params: { id: string } }>("/admin/oidc-providers/:id", async (req) => {
    requireAdmin(req);
    const all = await getOidcProviders(db);
    const previous = all.find((p) => p.id === req.params.id);
    if (!previous) throw notFound(msg("auth:entities.oidcProvider"));
    const body = providerInput.parse({ ...(req.body as object), id: previous.id }) as OidcProviderInput;
    const next = await checked(req, body, previous);
    await putOidcProviders(db, all.map((p) => (p.id === previous.id ? next : p)), req.user!.id);
    forgetOidcCache(previous.id);
    await audit(db, {
      userId: req.user!.id,
      action: "auth.oidc_provider_updated",
      details: { ...summary(next), ...(body.clientSecret !== undefined && body.clientSecret !== null && { clientSecretChanged: true }) },
    });
    return list(req);
  });

  api.delete<{ Params: { id: string } }>("/admin/oidc-providers/:id", async (req) => {
    requireAdmin(req);
    const all = await getOidcProviders(db);
    const gone = all.find((p) => p.id === req.params.id);
    if (!gone) throw notFound(msg("auth:entities.oidcProvider"));
    await putOidcProviders(db, all.filter((p) => p.id !== gone.id), req.user!.id);
    forgetOidcCache(gone.id);
    await audit(db, { userId: req.user!.id, action: "auth.oidc_provider_deleted", details: { id: gone.id, name: gone.name, issuer: gone.issuer } });
    return list(req);
  });

  /** Reads the discovery document now (through the provider's connection) to check the issuer. */
  api.post<{ Params: { id: string } }>("/admin/oidc-providers/:id/test", async (req) => {
    requireAdmin(req);
    const p = await getOidcProvider(db, req.params.id);
    if (!p) throw notFound(msg("auth:entities.oidcProvider"));
    forgetOidcCache(p.id);
    try {
      const d = await oidcDiscovery(p);
      return {
        ok: true,
        issuer: d.issuer,
        authorizationEndpoint: d.authorization_endpoint,
        tokenEndpoint: d.token_endpoint,
        userinfoEndpoint: d.userinfo_endpoint ?? null,
        algorithms: oidcAlgorithms(d),
      };
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw badRequest(msg("auth:errors.oidcDiscoveryFailed", { reason: error instanceof OidcError ? error.code : String((error as Error).message ?? error).slice(0, 200) }));
    }
  });
}

/** A new, non-administrator account (administrator when the provider's admin group says so). */
async function createAccount(db: Db, p: StoredOidcProvider, email: string, name: string, isAdmin: boolean) {
  let companyId = p.defaultCompanyId;
  if (companyId) {
    const [c] = await db.select({ id: companies.id }).from(companies).where(eq(companies.id, companyId));
    if (!c) companyId = null;
  }
  try {
    const [created] = await db
      .insert(users)
      .values({ email, name: googleDisplayName(email, name), passwordHash: await hashPassword(newToken("secret")), isAdmin, companyId })
      .returning();
    if (!created) return null;
    await refreshSeats(db);
    await audit(db, {
      userId: created.id,
      action: "user.created",
      targetType: "user",
      targetId: created.id,
      details: { provider: `oidc:${p.id}`, domain: email.slice(email.lastIndexOf("@") + 1), ...(isAdmin && { isAdmin: true }) },
    });
    return created;
  } catch {
    // Created by a parallel sign-in a moment ago.
    const [again] = await db.select().from(users).where(eq(users.email, email));
    return again && !again.disabled && !again.pending ? again : null;
  }
}
