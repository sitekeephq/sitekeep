/**
 * "Anonymise user" (P1-2, right to erasure by pseudonymisation: GDPR Art. 17, KVKK m.7;
 * docs/features/DATA_SUBJECT_RIGHTS.md#anonymise). Irreversible. The account becomes
 * "Deleted user #<first 8 of the id>" with a unique invalid address, cannot sign in, and keeps its id,
 * so every row it wrote (issues, comments, reviews, files, the audit log) stays and shows the pseudonym.
 *
 * Removed: password hash, sessions, API and OAuth keys, OAuth consents / codes / refresh tokens,
 * preferences, notifications, personal data exports, the personal part of the audit log
 * (eraseAuditPersonal), the user id on outbound log rows and imported BCF author addresses equal to
 * the old address; open invitations are revoked and keep the invalid address. Not touched: file
 * versions and their contents, free text (comments, letters) — that is the controller's decision.
 */
import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import type { AnonymiseResultDto } from "@sitekeep/shared";
import type { Db } from "../../db/index.js";
import { auditLog, auditPersonal, invitations, issueComments, notifications, oauthCodes, oauthConsents, oauthRefreshTokens, outboundLog, tokens, users } from "../../db/schema.js";
import type { Storage } from "../../core/platform/storage.js";
import { audit, auditEmailHash } from "../../core/platform/audit.js";
import { eraseAuditPersonal } from "../../audit/personal.js";
import { DEFAULT_LANGUAGE, tFor } from "../../i18n/index.js";
import { refreshSeats } from "../../license/state.js";
import { removeExpiredPersonalExports } from "./export.js";

/** Stored instead of a password hash: no password verifies against it (core/security/auth.ts). */
export const ANONYMISED_PASSWORD_HASH = "!anonymised";

/** Unique, syntactically valid but undeliverable address (RFC 2606 `.invalid`). */
export const anonymisedEmail = (userId: string) => `deleted-${userId}@anonymised.invalid`;

export const isAnonymised = (u: { email: string }) => u.email.endsWith("@anonymised.invalid");

/**
 * Further personal data a feature keeps per user, removed in the same transaction.
 *
 * Two-factor authentication (auth/two-factor.ts) registers one that deletes the user's TOTP secret
 * and recovery codes.
 */
export type AnonymiseHook = (tx: Db, userId: string) => Promise<void>;
const hooks: AnonymiseHook[] = [];
export function registerAnonymiseHook(fn: AnonymiseHook): void {
  hooks.push(fn);
}

/**
 * Earlier addresses of an account: `user.email_changed` rows keep the hash of the previous and of the
 * new address; the addresses themselves are found among the e-mails audit_personal still holds.
 */
async function previousAddresses(db: Db, userId: string, current: string): Promise<string[]> {
  const changes = await db
    .select({ details: auditLog.details })
    .from(auditLog)
    .where(and(eq(auditLog.action, "user.email_changed"), eq(auditLog.targetType, "user"), eq(auditLog.targetId, userId)));
  const hashes = new Set<string>();
  for (const c of changes)
    for (const k of ["previousEmailHash", "emailHash"]) if (typeof c.details?.[k] === "string") hashes.add(c.details[k] as string);
  hashes.delete(auditEmailHash(current));
  if (!hashes.size) return [];
  const known = await db.selectDistinct({ email: auditPersonal.email }).from(auditPersonal).where(isNotNull(auditPersonal.email));
  return known.map((k) => k.email!).filter((e) => hashes.has(auditEmailHash(e)));
}

export class AnonymiseRefused extends Error {
  constructor(readonly reason: "not_found" | "self" | "already") {
    super(reason);
  }
}

export async function anonymiseUser(db: Db, storage: Storage, subjectId: string, by: { userId: string }): Promise<AnonymiseResultDto> {
  if (subjectId === by.userId) throw new AnonymiseRefused("self");
  const [u] = await db.select().from(users).where(eq(users.id, subjectId));
  if (!u) throw new AnonymiseRefused("not_found");
  if (isAnonymised(u)) throw new AnonymiseRefused("already");
  const oldEmail = u.email.trim().toLowerCase();
  const shortId = u.id.slice(0, 8);
  const name = tFor(DEFAULT_LANGUAGE)("privacy:anonymise.name", { id: shortId });

  // Addresses the account had before an e-mail correction (P1-3): known by their keyed hash only.
  const previousEmails = await previousAddresses(db, u.id, oldEmail);
  // The personal part of the audit log first: it finds rows by the addresses too.
  const auditPersonalRemoved = await eraseAuditPersonal(db, { userId: u.id, email: oldEmail, previousEmails }, { userId: by.userId });
  const addresses = [oldEmail, ...previousEmails];

  const removed = await db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    await t
      .update(users)
      .set({
        name,
        email: anonymisedEmail(u.id),
        passwordHash: ANONYMISED_PASSWORD_HASH,
        prefs: {},
        disabled: true,
        pending: false,
        isAdmin: false,
      })
      .where(eq(users.id, u.id));
    const tokenRows = await t.delete(tokens).where(eq(tokens.userId, u.id)).returning({ id: tokens.id });
    await t.delete(oauthConsents).where(eq(oauthConsents.userId, u.id));
    await t.delete(oauthCodes).where(eq(oauthCodes.userId, u.id));
    await t.delete(oauthRefreshTokens).where(eq(oauthRefreshTokens.userId, u.id));
    await t.delete(notifications).where(eq(notifications.userId, u.id));
    const revoked = await t
      .update(invitations)
      .set({ revokedAt: new Date() })
      .where(and(eq(invitations.userId, u.id), isNull(invitations.acceptedAt), isNull(invitations.revokedAt)))
      .returning({ id: invitations.id });
    await t.update(invitations).set({ email: anonymisedEmail(u.id) }).where(eq(invitations.userId, u.id));
    const outbound = await t.update(outboundLog).set({ userId: null }).where(eq(outboundLog.userId, u.id)).returning({ id: outboundLog.id });
    const imported = await t
      .update(issueComments)
      .set({ importedAuthor: null })
      .where(inArray(sql`lower(trim(${issueComments.importedAuthor}))`, addresses))
      .returning({ id: issueComments.id });
    for (const hook of hooks) await hook(t, u.id);
    return { tokens: tokenRows.length, invitations: revoked.length, outboundRows: outbound.length, importedAuthor: imported.length };
  });
  await removeExpiredPersonalExports(db, storage, null, u.id);
  await refreshSeats(db);
  const result: AnonymiseResultDto = { id: u.id, name, removed: { ...removed, auditPersonal: auditPersonalRemoved } };
  // Never the old name or address: only what was removed.
  await audit(db, { userId: by.userId, action: "user.anonymised", targetType: "user", targetId: u.id, details: { pseudonym: name, removed: result.removed } });
  return result;
}
