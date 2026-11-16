/**
 * Two-factor authentication (G-2, docs/features/SIGN_IN_SECURITY.md): the stored TOTP secret and
 * recovery codes of a user, and the short-lived "second step" a sign-in passes through.
 *
 * The second step: after the first factor (password, Google, invitation) the server sets no session
 * but a signed cookie naming the user, what is needed ("verify" a code or "enrol" because the
 * administrator requires it) and an expiry (10 minutes). Only POST /auth/two-factor/challenge/* read it.
 * API keys and OAuth tokens are not affected: they are issued by a signed-in user and checked as
 * before.
 */
import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import type { SignInSecuritySettings, TwoFactorSetupDto } from "@sitekeep/shared";
import { decryptSecret, encryptSecret } from "../core/platform/secrets.js";
import { registerAnonymiseHook } from "../privacy/subject/anonymise.js";
import type { Db } from "../db/index.js";
import { userTwoFactor } from "../db/schema.js";
import { hashRecoveryCode, newRecoveryCodes, newTotpSecret, otpauthUrl, qrDataUrl, verifyTotp } from "./totp.js";

export type TwoFactorRow = typeof userTwoFactor.$inferSelect;

// Anonymising a user (data subject rights) deletes their TOTP secret and recovery codes in the same transaction.
registerAnonymiseHook(async (tx, userId) => {
  await removeTwoFactor(tx, userId);
});

export async function twoFactorOf(db: Db, userId: string): Promise<TwoFactorRow | null> {
  const [row] = await db.select().from(userTwoFactor).where(eq(userTwoFactor.userId, userId));
  return row ?? null;
}

export async function twoFactorEnabled(db: Db, userId: string): Promise<boolean> {
  return !!(await twoFactorOf(db, userId))?.enabledAt;
}

/** The administrator's rule ("admins" / "all") covers this user. */
export function twoFactorRequired(settings: SignInSecuritySettings, user: { isAdmin: boolean }): boolean {
  return settings.requireTwoFactor === "all" || (settings.requireTwoFactor === "admins" && user.isAdmin);
}

/**
 * Starts (or restarts) the set-up: a new secret, stored encrypted and not yet enabled. Refused by the
 * callers while two-factor is on.
 */
export async function startEnrolment(db: Db, key: Buffer, user: { id: string; email: string }): Promise<TwoFactorSetupDto> {
  const secret = newTotpSecret();
  const stored = encryptSecret(key, secret);
  await db
    .insert(userTwoFactor)
    .values({ userId: user.id, secret: stored, enabledAt: null, lastStep: null, recoveryCodes: [] })
    .onConflictDoUpdate({ target: userTwoFactor.userId, set: { secret: stored, enabledAt: null, lastStep: null, recoveryCodes: [], createdAt: new Date() } });
  const url = otpauthUrl(secret, user.email);
  return { secret, otpauthUrl: url, qrDataUrl: qrDataUrl(url) };
}

/**
 * Confirms the set-up with a code from the app: turns two-factor on and returns the 10 recovery codes
 * (shown once). Null when the code is wrong or no set-up is waiting.
 */
export async function confirmEnrolment(db: Db, key: Buffer, userId: string, code: string): Promise<string[] | null> {
  const row = await twoFactorOf(db, userId);
  if (!row || row.enabledAt) return null;
  const step = verifyTotp(decryptSecret(key, row.secret), code, null);
  if (step === null) return null;
  const codes = newRecoveryCodes();
  const updated = await db
    .update(userTwoFactor)
    .set({ enabledAt: new Date(), lastStep: step, recoveryCodes: codes.hashes })
    .where(and(eq(userTwoFactor.userId, userId), isNull(userTwoFactor.enabledAt)))
    .returning({ userId: userTwoFactor.userId });
  return updated.length ? codes.plain : null;
}

/**
 * Checks a second factor: a TOTP code (once per time step) or a recovery code (removed when used).
 * Returns what was used, or null.
 */
export async function verifySecondFactor(
  db: Db,
  key: Buffer,
  userId: string,
  input: { code?: string | null; recoveryCode?: string | null },
): Promise<"totp" | "recovery" | null> {
  const row = await twoFactorOf(db, userId);
  if (!row?.enabledAt) return null;
  if (input.code) {
    const step = verifyTotp(decryptSecret(key, row.secret), input.code, row.lastStep ?? null);
    if (step === null) return null;
    // Only one request can move last_step to this step (two at once: the second fails).
    const moved = await db
      .update(userTwoFactor)
      .set({ lastStep: step })
      .where(and(eq(userTwoFactor.userId, userId), or(isNull(userTwoFactor.lastStep), lt(userTwoFactor.lastStep, step))))
      .returning({ userId: userTwoFactor.userId });
    return moved.length ? "totp" : null;
  }
  if (input.recoveryCode) {
    const hash = hashRecoveryCode(input.recoveryCode);
    const match = row.recoveryCodes.find((h) => safeEqual(h, hash));
    if (!match) return null;
    // Removed in the same statement that checks it is still there: a code works once.
    const used = await db
      .update(userTwoFactor)
      .set({ recoveryCodes: sql`array_remove(${userTwoFactor.recoveryCodes}, ${match})` })
      .where(and(eq(userTwoFactor.userId, userId), sql`${match} = any(${userTwoFactor.recoveryCodes})`))
      .returning({ userId: userTwoFactor.userId });
    return used.length ? "recovery" : null;
  }
  return null;
}

/** New recovery codes in place of the old ones (shown once). */
export async function replaceRecoveryCodes(db: Db, userId: string): Promise<string[]> {
  const codes = newRecoveryCodes();
  await db.update(userTwoFactor).set({ recoveryCodes: codes.hashes }).where(eq(userTwoFactor.userId, userId));
  return codes.plain;
}

/** Turns two-factor off (the user, or a system administrator's reset); true when there was something to remove. */
export async function removeTwoFactor(db: Db, userId: string): Promise<boolean> {
  const deleted = await db.delete(userTwoFactor).where(eq(userTwoFactor.userId, userId)).returning({ userId: userTwoFactor.userId });
  return deleted.length > 0;
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

// ---- The second step of a sign-in ---------------------------------------------------------------

export const CHALLENGE_COOKIE = "cde_2fa";
const CHALLENGE_PATH = "/api/v1/auth/two-factor";
const CHALLENGE_SECONDS = 10 * 60;

export interface Challenge {
  /** The user who passed the first factor. */
  userId: string;
  mode: "verify" | "enrol";
  /** First factor, for the audit row of the sign-in. */
  provider: "password" | "google" | "oidc";
  /** OpenID Connect: the provider id ("entra"). */
  idp?: string;
  /** The first factor was an invitation being accepted. */
  invitation?: boolean;
  /** Expiry, ms since the epoch. */
  exp: number;
}

function challengeKey(secretKey: Buffer): Buffer {
  return Buffer.from(hkdfSync("sha256", secretKey, Buffer.alloc(0), "sitekeep.auth.challenge.v1", 32));
}

function sign(secretKey: Buffer, payload: string): string {
  return createHmac("sha256", challengeKey(secretKey)).update(payload).digest("base64url");
}

export function setChallenge(
  reply: FastifyReply,
  secretKey: Buffer,
  secure: boolean,
  c: Omit<Challenge, "exp">,
): void {
  const challenge: Challenge & { n: string } = { ...c, exp: Date.now() + CHALLENGE_SECONDS * 1000, n: randomBytes(8).toString("base64url") };
  const payload = Buffer.from(JSON.stringify(challenge)).toString("base64url");
  reply.setCookie(CHALLENGE_COOKIE, `${payload}.${sign(secretKey, payload)}`, {
    path: CHALLENGE_PATH,
    httpOnly: true,
    sameSite: "lax",
    secure,
    maxAge: CHALLENGE_SECONDS,
  });
}

export function readChallenge(req: FastifyRequest, secretKey: Buffer): Challenge | null {
  const raw = req.cookies?.[CHALLENGE_COOKIE];
  if (!raw) return null;
  const [payload, mac] = raw.split(".");
  if (!payload || !mac || !safeEqual(mac, sign(secretKey, payload))) return null;
  try {
    const c = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Challenge;
    if (typeof c.userId !== "string" || (c.mode !== "verify" && c.mode !== "enrol") || typeof c.exp !== "number") return null;
    return c.exp > Date.now() ? c : null;
  } catch {
    return null;
  }
}

export function clearChallenge(reply: FastifyReply): void {
  reply.clearCookie(CHALLENGE_COOKIE, { path: CHALLENGE_PATH });
}
