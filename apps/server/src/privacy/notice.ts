/**
 * Privacy notice on the sign-in and invitation pages ("aydınlatma metni", docs/features/PRIVACY_NOTICE.md,
 * issue #85 P3). Stored in system_settings ("privacy.notice"); acceptances in privacy_notice_acceptances.
 *
 *   GET  /auth/privacy-notice      public: what the sign-in and invitation pages show
 *   GET  /admin/privacy/notice     system administrators: settings, version, acceptances of the version
 *   PUT  /admin/privacy/notice     system administrators: a changed text bumps the version
 *
 * With "I have read it" required, POST /auth/login, POST /invitations/accept and the Google flows
 * carry the version the person ticked (`privacyNoticeVersion`, for Google and OIDC a short cookie) and are
 * refused with 400 privacy_notice_required while the account has not accepted the version in force:
 * the current one, or with "ask again" off any earlier one.
 */
import { and, count, eq } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  PRIVACY_NOTICE_DEFAULTS,
  PRIVACY_NOTICE_MAX_LENGTH,
  type PrivacyNoticeAdminDto,
  type PrivacyNoticePublicDto,
  type PrivacyNoticeSettings,
} from "@sitekeep/shared";
import type { ResolvedDeps } from "../app/deps.js";
import type { Db } from "../db/index.js";
import { privacyNoticeAcceptances, systemSettings, users } from "../db/schema.js";
import { audit } from "../core/platform/audit.js";
import { HttpError, badRequest, forbidden } from "../core/platform/http.js";
import { msg } from "../i18n/index.js";

const KEY = "privacy.notice";

/** Carries the ticked version through the Google or OpenID Connect round trip (only to those routes). */
export const NOTICE_COOKIE = "cde_privacy_notice";
const GOOGLE_PATH = "/api/v1/auth/google";

/** How the person accepted: the page and the sign-in method. */
export type NoticeVia = "password" | "google" | "oidc" | "invitation" | "invitation_google" | "invitation_oidc";

interface StoredNotice extends PrivacyNoticeSettings {
  version: number;
  updatedAt: string | null;
}

function clean(v: Partial<StoredNotice> | undefined): StoredNotice {
  const text = { en: String(v?.text?.en ?? ""), tr: String(v?.text?.tr ?? "") };
  const version = Math.max(0, Math.round(Number(v?.version ?? 0)) || 0);
  return {
    enabled: !!v?.enabled,
    requireAck: !!v?.requireAck,
    reaskOnChange: v?.reaskOnChange !== false,
    text,
    version,
    updatedAt: typeof v?.updatedAt === "string" ? v.updatedAt : null,
  };
}

const hasText = (n: PrivacyNoticeSettings) => !!(n.text.en.trim() || n.text.tr.trim());

export async function getPrivacyNotice(db: Db): Promise<StoredNotice & { updatedBy: string | null }> {
  const [row] = await db.select().from(systemSettings).where(eq(systemSettings.key, KEY));
  return { ...clean(row?.value as Partial<StoredNotice> | undefined), updatedBy: row?.updatedBy ?? null };
}

/** Saves the settings; a changed text (either language) is a new version. */
export async function savePrivacyNotice(
  db: Db,
  patch: Partial<PrivacyNoticeSettings>,
  userId: string | null,
): Promise<{ notice: StoredNotice; textChanged: boolean }> {
  const current = await getPrivacyNotice(db);
  const text = { ...current.text, ...(patch.text ?? {}) };
  const textChanged = text.en !== current.text.en || text.tr !== current.text.tr;
  const next = clean({
    ...current,
    ...patch,
    text,
    version: textChanged ? current.version + 1 : current.version,
    updatedAt: new Date().toISOString(),
  });
  if (next.enabled && !hasText(next)) throw badRequest(msg("privacy:errors.noticeEmpty"));
  const now = new Date();
  await db
    .insert(systemSettings)
    .values({ key: KEY, value: next, updatedBy: userId, updatedAt: now })
    .onConflictDoUpdate({ target: systemSettings.key, set: { value: next, updatedBy: userId, updatedAt: now } });
  return { notice: next, textChanged };
}

/** What the signed-out pages get: nothing but `enabled: false` while the notice is off. */
export async function publicPrivacyNotice(db: Db): Promise<PrivacyNoticePublicDto> {
  const n = await getPrivacyNotice(db);
  if (!n.enabled || !hasText(n)) return { enabled: false, requireAck: false, version: 0, text: { ...PRIVACY_NOTICE_DEFAULTS.text } };
  return { enabled: true, requireAck: n.requireAck, version: n.version, text: n.text };
}

export type NoticeCheck = { ok: true; accept: number | null } | { ok: false };

/**
 * Whether the account may sign in as far as the notice is concerned. `ack` is the version the person
 * ticked on the page; `accept` is the version to record once the sign-in goes ahead (null: nothing to record).
 */
export async function checkPrivacyNotice(db: Db, userId: string, ack: number | null | undefined): Promise<NoticeCheck> {
  const n = await getPrivacyNotice(db);
  if (!n.enabled || !n.requireAck || !hasText(n)) return { ok: true, accept: null };
  const [mine] = await db
    .select({ n: count() })
    .from(privacyNoticeAcceptances)
    .where(
      n.reaskOnChange
        ? and(eq(privacyNoticeAcceptances.userId, userId), eq(privacyNoticeAcceptances.version, n.version))
        : eq(privacyNoticeAcceptances.userId, userId),
    );
  const accepted = Number(mine?.n ?? 0) > 0;
  if (ack === n.version) return { ok: true, accept: n.version };
  return accepted ? { ok: true, accept: null } : { ok: false };
}

export const noticeRequired = () => new HttpError(400, "privacy_notice_required", msg("privacy:errors.noticeRequired"));

/** Records the acceptance once per person and version; `privacy.notice_accepted` in the audit log. */
export async function recordPrivacyNotice(db: Db, userId: string, version: number | null, via: NoticeVia): Promise<void> {
  if (!version) return;
  const inserted = await db
    .insert(privacyNoticeAcceptances)
    .values({ userId, version, via })
    .onConflictDoNothing()
    .returning({ version: privacyNoticeAcceptances.version });
  if (inserted.length) await audit(db, { userId, action: "privacy.notice_accepted", targetType: "user", targetId: userId, details: { version, via } });
}

/** The version ticked before a Google or OpenID Connect redirect, kept in a short cookie for the callback. */
export function setNoticeCookie(reply: FastifyReply, version: number | null | undefined, secure: boolean, path = GOOGLE_PATH): void {
  if (!version) return;
  reply.setCookie(NOTICE_COOKIE, String(version), { path, httpOnly: true, sameSite: "lax", secure, maxAge: 10 * 60 });
}

/** Reads and clears the cookie set by setNoticeCookie. */
export function takeNoticeCookie(req: FastifyRequest, reply: FastifyReply, path = GOOGLE_PATH): number | null {
  const raw = req.cookies[NOTICE_COOKIE];
  if (raw === undefined) return null;
  reply.clearCookie(NOTICE_COOKIE, { path });
  const v = Number(raw);
  return Number.isInteger(v) && v > 0 ? v : null;
}

const textSchema = z.string().max(PRIVACY_NOTICE_MAX_LENGTH);

export async function privacyNoticeRoutes(api: FastifyInstance, deps: ResolvedDeps) {
  const { db } = deps;

  api.get("/auth/privacy-notice", { config: { public: true } }, async () => publicPrivacyNotice(db));

  async function adminDto(): Promise<PrivacyNoticeAdminDto> {
    const n = await getPrivacyNotice(db);
    const [by] = n.updatedBy ? await db.select({ name: users.name }).from(users).where(eq(users.id, n.updatedBy)) : [];
    const [acc] = n.version
      ? await db.select({ n: count() }).from(privacyNoticeAcceptances).where(eq(privacyNoticeAcceptances.version, n.version))
      : [];
    return {
      enabled: n.enabled,
      requireAck: n.requireAck,
      reaskOnChange: n.reaskOnChange,
      text: n.text,
      version: n.version,
      updatedAt: n.updatedAt,
      updatedByName: by?.name ?? null,
      acceptedCurrent: Number(acc?.n ?? 0),
    };
  }

  api.get("/admin/privacy/notice", async (req) => {
    if (!req.user?.isAdmin) throw forbidden(msg("privacy:errors.adminOnly"));
    return adminDto();
  });

  api.put("/admin/privacy/notice", async (req) => {
    if (!req.user?.isAdmin) throw forbidden(msg("privacy:errors.adminOnly"));
    const body = z
      .object({
        enabled: z.boolean().optional(),
        requireAck: z.boolean().optional(),
        reaskOnChange: z.boolean().optional(),
        text: z.object({ en: textSchema.optional(), tr: textSchema.optional() }).optional(),
      })
      .parse(req.body);
    const current = await getPrivacyNotice(db);
    const patch: Partial<PrivacyNoticeSettings> = {
      ...(body.enabled !== undefined && { enabled: body.enabled }),
      ...(body.requireAck !== undefined && { requireAck: body.requireAck }),
      ...(body.reaskOnChange !== undefined && { reaskOnChange: body.reaskOnChange }),
      ...(body.text && { text: { en: body.text.en ?? current.text.en, tr: body.text.tr ?? current.text.tr } }),
    };
    const { notice, textChanged } = await savePrivacyNotice(db, patch, req.user.id);
    // A new version's text goes into the hash-chained log: what a person accepted stays provable after later changes.
    await audit(db, {
      userId: req.user.id,
      action: "privacy.notice_updated",
      details: {
        version: notice.version,
        textChanged,
        enabled: notice.enabled,
        requireAck: notice.requireAck,
        reaskOnChange: notice.reaskOnChange,
        ...(textChanged && { text: notice.text }),
      },
    });
    return adminDto();
  });
}
