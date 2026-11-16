/**
 * Sign-in security (docs/features/SIGN_IN_SECURITY.md):
 *   G-1  failed attempts per account e-mail and per client IP in a sliding window → 429 + Retry-After,
 *        the lock audited once as `auth.locked`
 *   G-4  session lifetimes (absolute and idle); ended sessions are deleted by the daily retention job
 *   G-2  who must use two-factor authentication
 *
 * Settings live in system_settings ("auth.security"), cached for a short time. Failure counts are in
 * memory per server process, like the OAuth token limiter: enough for one on-prem server.
 */
import type { FastifyRequest } from "fastify";
import { and, eq, lt, ne, or, sql, type SQL } from "drizzle-orm";
import { normalizeSignInSecurity, type SignInSecuritySettings } from "@sitekeep/shared";
import { getSetting, putSetting } from "../ai/settings.js";
import { audit, auditEmail } from "../core/platform/audit.js";
import { HttpError } from "../core/platform/http.js";
import type { Db } from "../db/index.js";
import { tokens } from "../db/schema.js";
import { msg } from "../i18n/index.js";

export const SIGN_IN_SECURITY_KEY = "auth.security";
const CACHE_MS = 30_000;
const MAX_KEYS = 20_000;

/** Failure times per key in a sliding window whose length and limit are read at each call. */
class SlidingWindow {
  private readonly failures = new Map<string, number[]>();
  constructor(private readonly now: () => number) {}

  private recent(key: string, windowMs: number): number[] {
    const since = this.now() - windowMs;
    const list = (this.failures.get(key) ?? []).filter((t) => t > since);
    if (list.length) this.failures.set(key, list);
    else this.failures.delete(key);
    return list;
  }

  /** Seconds to wait while the key is locked, else 0. */
  retryAfter(key: string, limit: number, windowMs: number): number {
    const list = this.recent(key, windowMs);
    if (list.length < limit) return 0;
    return Math.max(1, Math.ceil((list[list.length - limit]! + windowMs - this.now()) / 1000));
  }

  /** Counts a failure; true when it is the one that locks the key. */
  fail(key: string, limit: number, windowMs: number): boolean {
    const list = this.recent(key, windowMs);
    list.push(this.now());
    // Only the last `limit` failures matter for the lock.
    if (list.length > limit) list.splice(0, list.length - limit);
    this.failures.set(key, list);
    if (this.failures.size > MAX_KEYS) for (const k of [...this.failures.keys()].slice(0, 1000)) this.failures.delete(k);
    return list.length === limit;
  }

  clear(key: string): void {
    this.failures.delete(key);
  }

  clearAll(): void {
    this.failures.clear();
  }
}

export interface AttemptSubject {
  /** The account's e-mail address as typed (also for unknown addresses: no enumeration). */
  email?: string | null;
  /** The account, when the address belongs to one (audit row user). */
  userId?: string | null;
  /** What was attempted, for the audit row: "password", "invitation", "password_change", "two_factor". */
  kind: string;
}

export class SignInSecurity {
  private cached: { at: number; value: SignInSecuritySettings } | null = null;
  private readonly accounts: SlidingWindow;
  private readonly addresses: SlidingWindow;

  constructor(
    private readonly db: Db,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.accounts = new SlidingWindow(now);
    this.addresses = new SlidingWindow(now);
  }

  async settings(): Promise<SignInSecuritySettings> {
    if (this.cached && this.now() - this.cached.at < CACHE_MS) return this.cached.value;
    const value = normalizeSignInSecurity(await getSetting<Partial<SignInSecuritySettings>>(this.db, SIGN_IN_SECURITY_KEY, {}));
    this.cached = { at: this.now(), value };
    return value;
  }

  async put(next: Partial<SignInSecuritySettings>, userId: string | null): Promise<SignInSecuritySettings> {
    const value = normalizeSignInSecurity({ ...(await this.settings()), ...next });
    await putSetting(this.db, SIGN_IN_SECURITY_KEY, value, userId);
    this.cached = { at: this.now(), value };
    return value;
  }

  // ---- G-1: failed attempts --------------------------------------------------------------------

  private static accountKey(email: string): string {
    return auditEmail(email);
  }

  /** Seconds the request must wait (its IP or the account is locked), else 0. */
  async retryAfter(req: FastifyRequest, email?: string | null): Promise<number> {
    const s = await this.settings();
    const windowMs = s.failureWindowMinutes * 60_000;
    const ip = this.addresses.retryAfter(req.ip, s.ipFailureLimit, windowMs);
    const account = email ? this.accounts.retryAfter(SignInSecurity.accountKey(email), s.failureLimit, windowMs) : 0;
    return Math.max(ip, account);
  }

  /** Throws 429 with Retry-After while the IP or the account is locked. */
  async guard(req: FastifyRequest, email?: string | null): Promise<void> {
    const wait = await this.retryAfter(req, email);
    if (wait) throw lockedError(wait);
  }

  /** Counts a failed attempt; the failure that locks the IP or the account is audited as `auth.locked`. */
  async fail(req: FastifyRequest, subject: AttemptSubject): Promise<void> {
    const s = await this.settings();
    const windowMs = s.failureWindowMinutes * 60_000;
    const scopes: string[] = [];
    if (this.addresses.fail(req.ip, s.ipFailureLimit, windowMs)) scopes.push("ip");
    if (subject.email && this.accounts.fail(SignInSecurity.accountKey(subject.email), s.failureLimit, windowMs)) scopes.push("account");
    for (const scope of scopes) {
      await audit(this.db, {
        userId: scope === "account" ? (subject.userId ?? null) : null,
        action: "auth.locked",
        details: {
          scope,
          attempt: subject.kind,
          failures: scope === "ip" ? s.ipFailureLimit : s.failureLimit,
          windowMinutes: s.failureWindowMinutes,
          // The address goes to the personal part of the log (audit.ts); the row keeps its hash.
          ...(scope === "account" && subject.email ? { email: subject.email } : {}),
        },
      });
    }
  }

  /** A successful sign-in clears the account's failures (the IP's stay). */
  succeed(email: string): void {
    this.accounts.clear(SignInSecurity.accountKey(email));
  }

  /** Administrator: lift every lock now (Administration → Sign-in security). */
  clearLocks(): void {
    this.accounts.clearAll();
    this.addresses.clearAll();
  }

  // ---- G-4: sessions ---------------------------------------------------------------------------

  /** Start and expiry of a session created now (by this clock, which the limits are checked against). */
  async sessionTimes(): Promise<{ createdAt: Date; expiresAt: Date }> {
    const s = await this.settings();
    const now = this.now();
    return { createdAt: new Date(now), expiresAt: new Date(now + s.sessionAbsoluteDays * 86_400_000) };
  }

  /** Whether a session (created / last used at) is still within the absolute and idle limits. */
  async sessionAlive(createdAt: Date, lastUsedAt: Date | null): Promise<boolean> {
    const s = await this.settings();
    const now = this.now();
    if (createdAt.getTime() + s.sessionAbsoluteDays * 86_400_000 <= now) return false;
    if (s.sessionIdleHours > 0 && (lastUsedAt ?? createdAt).getTime() + s.sessionIdleHours * 3_600_000 <= now) return false;
    return true;
  }

  /** Deletes ended browser sessions (expired, past the absolute limit or idle too long); returns how many. */
  async cleanupSessions(): Promise<number> {
    const where = endedSessionsWhere(await this.settings(), this.now());
    const deleted = await this.db.delete(tokens).where(where).returning({ id: tokens.id });
    return deleted.length;
  }
}

/**
 * Browser sessions that have ended: expired, past the absolute limit or idle too long (G-4). The daily
 * retention job (privacy/retention.ts, category "sessions") deletes them; so does cleanupSessions.
 */
export function endedSessionsWhere(s: SignInSecuritySettings, nowMs: number): SQL {
  const ended: SQL[] = [lt(tokens.expiresAt, new Date(nowMs)), lt(tokens.createdAt, new Date(nowMs - s.sessionAbsoluteDays * 86_400_000))];
  if (s.sessionIdleHours > 0) ended.push(lt(sql`coalesce(${tokens.lastUsedAt}, ${tokens.createdAt})`, new Date(nowMs - s.sessionIdleHours * 3_600_000)));
  return and(eq(tokens.kind, "session"), or(...ended))!;
}

/** The stored settings, read without a SignInSecurity instance (background jobs). */
export async function readSignInSecurity(db: Db): Promise<SignInSecuritySettings> {
  return normalizeSignInSecurity(await getSetting<Partial<SignInSecuritySettings>>(db, SIGN_IN_SECURITY_KEY, {}));
}

export function lockedError(seconds: number): HttpError {
  const err = new HttpError(429, "too_many_attempts", msg("auth:errors.locked", { seconds }), { retryAfter: seconds });
  err.headers = { "retry-after": String(seconds) };
  return err;
}

/** Ends a user's browser sessions, except `keepTokenId` (the caller's own); returns how many. */
export async function endSessions(db: Db, userId: string, keepTokenId?: string | null): Promise<number> {
  const deleted = await db
    .delete(tokens)
    .where(and(eq(tokens.userId, userId), eq(tokens.kind, "session"), keepTokenId ? ne(tokens.id, keepTokenId) : undefined))
    .returning({ id: tokens.id });
  return deleted.length;
}
