import type { FastifyReply } from "fastify";
import type { ResolvedDeps } from "../app/deps.js";
import { SESSION_COOKIE } from "../app/deps.js";
import { hashToken, newToken } from "../core/security/auth.js";
import { tokens } from "../db/schema.js";
import { setChallenge, twoFactorOf, twoFactorRequired } from "./two-factor.js";

type SessionDeps = Pick<ResolvedDeps, "db" | "secureCookies" | "signInSecurity">;

/**
 * A browser session for the user: the token in an httpOnly cookie, its hash in the database. It ends
 * after the administrator's absolute limit (default 14 days) or idle limit (default 12 hours), see
 * sign-in-security.ts.
 */
export async function createSession(deps: SessionDeps, userId: string, reply: FastifyReply) {
  const token = newToken("s");
  const { createdAt, expiresAt } = await deps.signInSecurity.sessionTimes();
  await deps.db.insert(tokens).values({ userId, kind: "session", tokenHash: hashToken(token), createdAt, expiresAt });
  reply.setCookie(SESSION_COOKIE, token, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: !!deps.secureCookies,
    expires: expiresAt,
  });
}

/**
 * After the first factor (password, Google, OpenID Connect, invitation): a session, or the second step when the user
 * has two-factor on ("verify") or the administrator requires it and it is not set up yet ("enrol":
 * the person sets it up now, before the session starts).
 */
export async function afterFirstFactor(
  deps: SessionDeps & Pick<ResolvedDeps, "secretKey">,
  user: { id: string; isAdmin: boolean },
  reply: FastifyReply,
  first: { provider: "password" | "google" | "oidc"; idp?: string; invitation?: boolean },
  opts: { providerMfa?: boolean } = {},
): Promise<{ twoFactor: "verify" | "enrol" } | null> {
  // An OpenID Connect provider the administrator trusts asserted a multi-factor sign-in (amr): no second step here.
  if (opts.providerMfa) {
    await createSession(deps, user.id, reply);
    return null;
  }
  const tf = await twoFactorOf(deps.db, user.id);
  const mode = tf?.enabledAt
    ? "verify"
    : twoFactorRequired(await deps.signInSecurity.settings(), user)
      ? "enrol"
      : null;
  if (!mode) {
    await createSession(deps, user.id, reply);
    return null;
  }
  setChallenge(reply, deps.secretKey, !!deps.secureCookies, { userId: user.id, mode, ...first });
  return { twoFactor: mode };
}
