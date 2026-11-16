/**
 * Security alerts (G-8, docs/features/SECURITY_LOG.md#alerts). A scanner reads the audit log rows
 * written since its last run (the cursor is an audit row id in system_settings) and applies the
 * rules; a daily job walks the hash chain. A rule that fires raises an alert (security_alert, audited
 * as `security.alert_raised`), shown as a card on the Administration page until a system
 * administrator acknowledges or dismisses it, and optionally e-mailed to the configured addresses
 * through the outbound registry (only when SMTP is configured and allowed in the Privacy Centre).
 *
 *   failed_sign_ins_account   ≥ N failed sign-ins of one account (user, else e-mail hash) in the window
 *   failed_sign_ins_global    ≥ N failed sign-ins installation-wide in the window
 *   bulk_download             ≥ N files downloaded by one person in the window (ZIPs count their files)
 *   new_admin                 a user created or changed with System Administrator rights
 *   kill_switch_off           "Turn Off All External Connections" turned off again
 *   two_factor_off            the two-factor requirement set to "off"
 *   audit_chain_broken        the daily audit:verify walk found a break
 *
 * While an alert of a rule and subject is open, further matches count up its `occurrences`; after
 * it is handled, the windowed rules wait one window before raising again for the same subject.
 */
import { and, asc, desc, eq, gt, gte, inArray, isNull, lte, max, sql } from "drizzle-orm";
import {
  normalizeSecurityAlertSettings,
  type SecurityAlertDto,
  type SecurityAlertRule,
  type SecurityAlertSettings,
  type SecurityAlertSettingsDto,
  type SecurityAlertStatus,
} from "@sitekeep/shared";
import type { Db } from "../db/index.js";
import { auditLog, securityAlerts } from "../db/schema.js";
import { audit } from "../core/platform/audit.js";
import { userNames } from "../core/security/access.js";
import { getSetting, putSetting } from "../ai/settings.js";
import { mailBlocked } from "../auth/invitations.js";
import { outboundCall } from "../privacy/outbound.js";
import { DEFAULT_LANGUAGE, tFor } from "../i18n/index.js";
import type { LetterMailer } from "../works/letter.js";
import { verifyAuditChain } from "./query.js";

export const SECURITY_ALERT_SETTINGS_KEY = "security.alerts";
const CURSOR_KEY = "security.alerts.cursor";
/** Rows the scanner reads per run; the next run carries on. */
const SCAN_BATCH = 5000;
/** On the first run only the last day is looked at (no alerts about old history). */
const FIRST_LOOKBACK_MS = 24 * 60 * 60 * 1000;

const WATCHED = [
  "auth.login_failed",
  "file.downloaded",
  "file.zip_downloaded",
  "user.created",
  "user.updated",
  "privacy.kill_switch_off",
  "auth.security_settings",
];

export interface AlertDeps {
  db: Db;
  mailer?: LetterMailer | null;
  log?: (message: string, error?: unknown) => void;
}

export async function securityAlertSettings(db: Db): Promise<SecurityAlertSettings> {
  return normalizeSecurityAlertSettings(await getSetting<Partial<SecurityAlertSettings>>(db, SECURITY_ALERT_SETTINGS_KEY, {}));
}

export async function securityAlertSettingsDto(deps: AlertDeps): Promise<SecurityAlertSettingsDto> {
  const settings = await securityAlertSettings(deps.db);
  const blocked = await mailBlocked(deps.db, deps.mailer);
  return { ...settings, mail: blocked === "smtp_not_configured" || blocked === "smtp_disabled" ? blocked : null };
}

/** Saves the settings; audits what changed (`security.alert_settings`, recipients as a count only). */
export async function saveSecurityAlertSettings(db: Db, patch: Partial<SecurityAlertSettings>, userId: string): Promise<SecurityAlertSettings> {
  const before = await securityAlertSettings(db);
  const next = normalizeSecurityAlertSettings({ ...before, ...patch });
  await putSetting(db, SECURITY_ALERT_SETTINGS_KEY, next, userId);
  const changed: Record<string, { from: unknown; to: unknown }> = {};
  for (const k of Object.keys(next) as (keyof SecurityAlertSettings)[]) {
    if (k === "emailTo") {
      // Addresses are personal data: the chained row records how many, not which.
      if (before.emailTo.join(",") !== next.emailTo.join(",")) changed.emailTo = { from: before.emailTo.length, to: next.emailTo.length };
    } else if (JSON.stringify(before[k]) !== JSON.stringify(next[k])) changed[k] = { from: before[k], to: next[k] };
  }
  if (Object.keys(changed).length) await audit(db, { userId, action: "security.alert_settings", details: changed });
  return next;
}

// ---- Raising -----------------------------------------------------------------------------------------

interface Raise {
  rule: SecurityAlertRule;
  subjectKey: string;
  userId?: string | null;
  details: Record<string, unknown>;
  auditId?: number | null;
  /** Windowed rules: no new alert for the subject within this long after the last one. */
  cooldownMs?: number;
  at: Date;
}

/** Raises an alert (or counts up the open one); returns the new alert's id, else null. */
async function raise(deps: AlertDeps, settings: SecurityAlertSettings, r: Raise, now: Date): Promise<string | null> {
  const { db } = deps;
  if (settings.disabledRules.includes(r.rule)) return null;
  const [open] = await db
    .select({ id: securityAlerts.id })
    .from(securityAlerts)
    .where(and(eq(securityAlerts.rule, r.rule), eq(securityAlerts.subjectKey, r.subjectKey), eq(securityAlerts.status, "open")))
    .limit(1);
  if (open) {
    await db
      .update(securityAlerts)
      .set({ occurrences: sql`${securityAlerts.occurrences} + 1`, lastSeenAt: r.at, details: r.details, ...(r.auditId ? { auditId: r.auditId } : {}) })
      .where(eq(securityAlerts.id, open.id));
    return null;
  }
  if (r.cooldownMs) {
    const [recent] = await db
      .select({ id: securityAlerts.id })
      .from(securityAlerts)
      .where(and(eq(securityAlerts.rule, r.rule), eq(securityAlerts.subjectKey, r.subjectKey), gte(securityAlerts.createdAt, new Date(now.getTime() - r.cooldownMs))))
      .limit(1);
    if (recent) return null;
  }
  const [row] = await db
    .insert(securityAlerts)
    .values({
      rule: r.rule,
      subjectKey: r.subjectKey,
      userId: r.userId ?? null,
      details: r.details,
      auditId: r.auditId ?? null,
      createdAt: now,
      lastSeenAt: r.at,
    })
    .returning({ id: securityAlerts.id });
  await audit(db, {
    action: "security.alert_raised",
    targetType: "security_alert",
    targetId: row!.id,
    details: { rule: r.rule, ...(r.userId ? { subjectUserId: r.userId } : {}), ...(r.auditId ? { auditId: r.auditId } : {}), ...r.details },
    client: null,
  });
  await mailAlert(deps, settings, row!.id, r).catch((e) => deps.log?.("security alert e-mail failed", e));
  return row!.id;
}

/** Text of an alert in a language (mail; the web app has its own copy of the texts). */
export function alertText(lang: string, rule: SecurityAlertRule, details: Record<string, unknown>): { title: string; body: string } {
  const t = tFor(lang);
  return { title: t(`admin:securityAlerts.rules.${rule}.title`), body: t(`admin:securityAlerts.rules.${rule}.body`, details as Record<string, string>) };
}

/** E-mails a new alert to the configured addresses when SMTP is configured and allowed. */
async function mailAlert(deps: AlertDeps, settings: SecurityAlertSettings, id: string, r: Raise): Promise<void> {
  const { db, mailer } = deps;
  if (!settings.emailTo.length || !mailer || (await mailBlocked(db, mailer))) return;
  const t = tFor(DEFAULT_LANGUAGE);
  const { title, body } = alertText(DEFAULT_LANGUAGE, r.rule, r.details);
  const subject = t("admin:securityAlerts.mail.subject", { title });
  const text = t("admin:securityAlerts.mail.body", { title, body, time: r.at.toISOString() });
  await outboundCall(
    "eposta",
    mailer.host ?? "localhost",
    { connection: "smtp", method: "SMTP", bytesOut: Buffer.byteLength(text), details: { kind: "security_alert", rule: r.rule, recipients: settings.emailTo.length } },
    () =>
      mailer.transport.sendMail({
        from: mailer.from,
        to: settings.emailTo,
        subject,
        text,
        textEncoding: "quoted-printable",
        headers: { "X-Mailer": "SiteKeep" },
      }),
  );
  await db.update(securityAlerts).set({ mailedAt: new Date() }).where(eq(securityAlerts.id, id));
}

// ---- Scanning the audit log ------------------------------------------------------------------------

type Row = Pick<typeof auditLog.$inferSelect, "id" | "at" | "userId" | "action" | "targetType" | "targetId" | "details">;

/** Latest row of each key. */
function latestBy(rows: Row[], key: (r: Row) => string | null): Map<string, Row> {
  const out = new Map<string, Row>();
  for (const r of rows) {
    const k = key(r);
    if (k) out.set(k, r);
  }
  return out;
}

const minutes = (m: number) => m * 60_000;
const emailHashOf = (r: Row) => (typeof r.details?.emailHash === "string" ? r.details.emailHash : null);
/** One account: a known user, else the hash of the address typed. */
const accountKey = (r: Row) => (r.userId ? `user:${r.userId}` : emailHashOf(r) ? `email:${emailHashOf(r)}` : null);

async function countIn(db: Db, where: ReturnType<typeof and>): Promise<number> {
  const [r] = await db.select({ n: sql<number>`count(*)`.mapWith(Number) }).from(auditLog).where(where);
  return r?.n ?? 0;
}

async function applyRules(deps: AlertDeps, settings: SecurityAlertSettings, rows: Row[], now: Date): Promise<number> {
  const { db } = deps;
  let raised = 0;
  const up = (id: string | null) => {
    if (id) raised++;
  };

  // Failed sign-ins.
  const failed = rows.filter((r) => r.action === "auth.login_failed");
  if (failed.length) {
    const windowMs = minutes(settings.failedSignInsWindowMinutes);
    const common = { minutes: settings.failedSignInsWindowMinutes };
    for (const [key, last] of latestBy(failed, accountKey)) {
      const since = new Date(last.at.getTime() - windowMs);
      const same = last.userId
        ? eq(auditLog.userId, last.userId)
        : and(isNull(auditLog.userId), sql`${auditLog.details} ->> 'emailHash' = ${emailHashOf(last)}`);
      const count = await countIn(db, and(eq(auditLog.action, "auth.login_failed"), gte(auditLog.at, since), lte(auditLog.at, last.at), same));
      if (count >= settings.failedSignInsAccount)
        up(
          await raise(
            deps,
            settings,
            {
              rule: "failed_sign_ins_account",
              subjectKey: key,
              userId: last.userId,
              details: { ...common, count, threshold: settings.failedSignInsAccount },
              auditId: last.id,
              cooldownMs: windowMs,
              at: last.at,
            },
            now,
          ),
        );
    }
    const last = failed[failed.length - 1]!;
    const count = await countIn(db, and(eq(auditLog.action, "auth.login_failed"), gte(auditLog.at, new Date(last.at.getTime() - windowMs)), lte(auditLog.at, last.at)));
    if (count >= settings.failedSignInsGlobal)
      up(
        await raise(
          deps,
          settings,
          {
            rule: "failed_sign_ins_global",
            subjectKey: "all",
            details: { ...common, count, threshold: settings.failedSignInsGlobal },
            auditId: last.id,
            cooldownMs: windowMs,
            at: last.at,
          },
          now,
        ),
      );
  }

  // Bulk downloads by one person (a ZIP counts its files).
  const downloads = rows.filter((r) => (r.action === "file.downloaded" || r.action === "file.zip_downloaded") && r.userId);
  if (downloads.length) {
    const windowMs = minutes(settings.bulkDownloadWindowMinutes);
    for (const [, last] of latestBy(downloads, (r) => r.userId)) {
      const [r] = await db
        .select({
          n: sql<number>`coalesce(sum(CASE WHEN ${auditLog.action} = 'file.zip_downloaded' THEN coalesce((${auditLog.details} ->> 'count')::int, 0) ELSE 1 END), 0)`.mapWith(Number),
        })
        .from(auditLog)
        .where(
          and(
            inArray(auditLog.action, ["file.downloaded", "file.zip_downloaded"]),
            eq(auditLog.userId, last.userId!),
            gte(auditLog.at, new Date(last.at.getTime() - windowMs)),
            lte(auditLog.at, last.at),
          ),
        );
      const files = r?.n ?? 0;
      if (files >= settings.bulkDownloadFiles)
        up(
          await raise(
            deps,
            settings,
            {
              rule: "bulk_download",
              subjectKey: `user:${last.userId}`,
              userId: last.userId,
              details: { count: files, threshold: settings.bulkDownloadFiles, minutes: settings.bulkDownloadWindowMinutes },
              auditId: last.id,
              cooldownMs: windowMs,
              at: last.at,
            },
            now,
          ),
        );
    }
  }

  // One-off events.
  for (const r of rows) {
    const by = r.userId ? { byUserId: r.userId } : {};
    if ((r.action === "user.created" || r.action === "user.updated") && r.details?.isAdmin === true && r.targetId)
      up(await raise(deps, settings, { rule: "new_admin", subjectKey: `user:${r.targetId}`, userId: r.targetId, details: { ...by }, auditId: r.id, at: r.at }, now));
    else if (r.action === "privacy.kill_switch_off")
      up(await raise(deps, settings, { rule: "kill_switch_off", subjectKey: "all", details: { ...by }, auditId: r.id, at: r.at }, now));
    else if (r.action === "auth.security_settings") {
      const change = r.details?.requireTwoFactor as { from?: unknown; to?: unknown } | undefined;
      if (change && change.to === "off" && change.from !== "off")
        up(await raise(deps, settings, { rule: "two_factor_off", subjectKey: "all", details: { ...by, from: change.from }, auditId: r.id, at: r.at }, now));
    }
  }
  return raised;
}

let running: Promise<number> | null = null;

/**
 * Reads the audit rows written since the last run and applies the rules; returns how many alerts
 * were raised. One run at a time per process; the cursor makes runs of several processes add up.
 */
export function scanSecurityEvents(deps: AlertDeps, now = new Date()): Promise<number> {
  running ??= scanOnce(deps, now).finally(() => {
    running = null;
  });
  return running;
}

async function scanOnce(deps: AlertDeps, now: Date): Promise<number> {
  const { db } = deps;
  let cursor = await getSetting<number | null>(db, CURSOR_KEY, null);
  if (cursor === null) {
    const [old] = await db
      .select({ id: max(auditLog.id) })
      .from(auditLog)
      .where(sql`${auditLog.at} < ${new Date(now.getTime() - FIRST_LOOKBACK_MS)}`);
    cursor = Number(old?.id ?? 0);
  }
  const [head] = await db.select({ id: max(auditLog.id) }).from(auditLog);
  const headId = Number(head?.id ?? 0);
  if (headId <= cursor) {
    await putSetting(db, CURSOR_KEY, cursor, null);
    return 0;
  }
  const rows: Row[] = await db
    .select({
      id: auditLog.id,
      at: auditLog.at,
      userId: auditLog.userId,
      action: auditLog.action,
      targetType: auditLog.targetType,
      targetId: auditLog.targetId,
      details: auditLog.details,
    })
    .from(auditLog)
    .where(and(gt(auditLog.id, cursor), lte(auditLog.id, headId), inArray(auditLog.action, WATCHED)))
    .orderBy(asc(auditLog.id))
    .limit(SCAN_BATCH);
  // A full batch: carry on after its last row next time; else everything up to the head was seen.
  const upTo = rows.length === SCAN_BATCH ? rows[rows.length - 1]!.id : headId;
  const settings = await securityAlertSettings(db);
  const raised = rows.length ? await applyRules(deps, settings, rows, now) : 0;
  await putSetting(db, CURSOR_KEY, upTo, null);
  return raised;
}

/** The daily chain check: raises `audit_chain_broken` when the walk finds a break. */
export async function checkAuditChainForAlert(deps: AlertDeps, now = new Date()): Promise<boolean> {
  const result = await verifyAuditChain(deps.db);
  if (!result.ok && result.broken) {
    const settings = await securityAlertSettings(deps.db);
    await raise(
      deps,
      settings,
      { rule: "audit_chain_broken", subjectKey: "chain", details: { id: result.broken.id, reason: result.broken.reason, checked: result.checked }, at: now },
      now,
    );
  }
  return result.ok;
}

/** Scans every minute, checks the chain daily (first a few minutes after start). Returns a stop function. */
export function startSecurityAlerts(deps: AlertDeps): () => void {
  const scan = () => void scanSecurityEvents(deps).catch((e) => deps.log?.("security alert scan failed", e));
  const verify = () => void checkAuditChainForAlert(deps).catch((e) => deps.log?.("daily audit chain check failed", e));
  const timers = [setTimeout(scan, 30_000), setTimeout(verify, 5 * 60_000)];
  const intervals = [setInterval(scan, 60_000), setInterval(verify, 24 * 60 * 60 * 1000)];
  for (const t of [...timers, ...intervals]) t.unref?.();
  return () => {
    timers.forEach(clearTimeout);
    intervals.forEach(clearInterval);
  };
}

// ---- Reading and handling ----------------------------------------------------------------------------

export async function listSecurityAlerts(db: Db, opts: { status?: SecurityAlertStatus | "all"; limit?: number } = {}): Promise<SecurityAlertDto[]> {
  const status = opts.status ?? "open";
  const rows = await db
    .select()
    .from(securityAlerts)
    .where(status === "all" ? undefined : eq(securityAlerts.status, status))
    .orderBy(desc(securityAlerts.createdAt))
    .limit(opts.limit ?? 100);
  const names = await userNames(db, rows.flatMap((r) => [r.userId, r.handledBy]));
  return rows.map((r) => ({
    id: r.id,
    rule: r.rule,
    status: r.status,
    createdAt: r.createdAt.toISOString(),
    lastSeenAt: r.lastSeenAt.toISOString(),
    occurrences: r.occurrences,
    userId: r.userId,
    ...(r.userId && names.has(r.userId) && { userName: names.get(r.userId) }),
    details: r.details,
    auditId: r.auditId,
    handledAt: r.handledAt?.toISOString() ?? null,
    ...(r.handledBy && names.has(r.handledBy) && { handledByName: names.get(r.handledBy) }),
    mailedAt: r.mailedAt?.toISOString() ?? null,
  }));
}

/** Acknowledges or dismisses an open alert (audited); false when there is no such open alert. */
export async function handleSecurityAlert(db: Db, id: string, status: Exclude<SecurityAlertStatus, "open">, userId: string): Promise<boolean> {
  const [row] = await db
    .update(securityAlerts)
    .set({ status, handledBy: userId, handledAt: new Date() })
    .where(and(eq(securityAlerts.id, id), eq(securityAlerts.status, "open")))
    .returning({ rule: securityAlerts.rule });
  if (!row) return false;
  await audit(db, {
    userId,
    action: status === "acknowledged" ? "security.alert_acknowledged" : "security.alert_dismissed",
    targetType: "security_alert",
    targetId: id,
    details: { rule: row.rule },
  });
  return true;
}
