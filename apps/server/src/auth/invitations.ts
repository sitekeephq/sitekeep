/**
 * Invitations of people without an account (docs/features/INVITATIONS.md).
 *
 * An invitation creates a pending user (users.pending, disabled: no sign-in, no seat) who is at once a
 * member of the project with the chosen company, roles and task team, and a single-use token that
 * expires after INVITATION_DAYS. Only the SHA-256 of the token is stored. Accepting (name and
 * password, or Google sign-in with the same address) activates the account; the memberships are
 * already there. Resending replaces the token; revoking removes the pending membership.
 *
 * The invitation e-mail goes through the outbound registry ("eposta", connection "smtp"): never when
 * SMTP is not configured or switched off in the Privacy Centre; the inviter then gets the link.
 */
import { and, asc, desc, eq, gt, inArray, isNull } from "drizzle-orm";
import {
  INVITATION_DAYS,
  INVITATION_SETTINGS_DEFAULTS,
  type InvitationDeliveryDto,
  type InvitationDto,
  type InvitationSettings,
  type InvitationStatus,
} from "@sitekeep/shared";
import type { Db } from "../db/index.js";
import { companies, invitations, memberRoles, projectMembers, projects, users } from "../db/schema.js";
import { linkProjectCompanies } from "../projects/companies.js";
import { getSetting, putSetting } from "../ai/settings.js";
import { audit, type AuditEvent } from "../core/platform/audit.js";
import { HttpError } from "../core/platform/http.js";
import { hashPassword, hashToken, newToken } from "../core/security/auth.js";
import { ensureDefaultProjectRoles } from "../core/security/default-roles.js";
import { joinCompanyTeam } from "../cde/teams.js";
import { refreshSeats } from "../license/state.js";
import { outboundCall, outboundRefusalMsg } from "../privacy/outbound.js";
import { refreshPrivacyState } from "../privacy/settings.js";
import type { LetterMailer } from "../works/letter.js";
import { DEFAULT_LANGUAGE, intlLocale, msg, tFor } from "../i18n/index.js";

export const INVITATION_SETTINGS_KEY = "auth.invitations";

export async function getInvitationSettings(db: Db): Promise<InvitationSettings> {
  const stored = await getSetting<Partial<InvitationSettings>>(db, INVITATION_SETTINGS_KEY, {});
  return { projectAdminsMayInvite: stored.projectAdminsMayInvite === true || INVITATION_SETTINGS_DEFAULTS.projectAdminsMayInvite };
}

export async function putInvitationSettings(db: Db, next: InvitationSettings, userId: string): Promise<InvitationSettings> {
  const value: InvitationSettings = { projectAdminsMayInvite: !!next.projectAdminsMayInvite };
  await putSetting(db, INVITATION_SETTINGS_KEY, value, userId);
  return value;
}

/** System administrators always; project administrators of the project when the system setting allows it. */
export async function mayInvite(db: Db, user: { isAdmin: boolean }, isProjectAdmin: boolean): Promise<boolean> {
  if (user.isAdmin) return true;
  return isProjectAdmin && (await getInvitationSettings(db)).projectAdminsMayInvite;
}

/** Writes an audit row, or keeps it for after the transaction. */
async function record(db: Db, deferred: AuditEvent[] | undefined, e: AuditEvent): Promise<void> {
  if (deferred) deferred.push(e);
  else await audit(db, e);
}

type InvitationRow = typeof invitations.$inferSelect;
type UserRow = typeof users.$inferSelect;

export function invitationStatus(row: Pick<InvitationRow, "acceptedAt" | "revokedAt" | "expiresAt">, now = new Date()): InvitationStatus {
  if (row.acceptedAt) return "accepted";
  if (row.revokedAt) return "revoked";
  return row.expiresAt.getTime() <= now.getTime() ? "expired" : "open";
}

/** The name until the person sets their own: the given one, else the part before @. */
export function invitedName(email: string, name?: string | null): string {
  const given = name?.trim();
  if (given) return given.slice(0, 200);
  return (email.split("@")[0] || email).slice(0, 200);
}

/** What the address is today: an active account, a pending (invited) one, an account an administrator disabled, or none. */
export async function accountFor(
  db: Db,
  email: string,
): Promise<{ kind: "active" | "pending" | "disabled"; user: UserRow } | { kind: "none"; user: null }> {
  const [user] = await db.select().from(users).where(eq(users.email, email));
  if (!user) return { kind: "none", user: null };
  if (user.pending) return { kind: "pending", user };
  return { kind: user.disabled ? "disabled" : "active", user };
}

/** The pending user of an invitation (an existing pending user is reused). */
export async function ensurePendingUser(
  db: Db,
  input: { email: string; name?: string | null; companyId?: string | null; invitedBy: string },
  /** Collects the audit rows instead of writing them (inside a long transaction, see AUDIT_LOG.md). */
  deferred?: AuditEvent[],
): Promise<UserRow> {
  const [existing] = await db.select().from(users).where(eq(users.email, input.email));
  if (existing) return existing;
  const [created] = await db
    .insert(users)
    .values({
      email: input.email,
      name: invitedName(input.email, input.name),
      // Never usable: the person sets a password when accepting (or signs in with Google).
      passwordHash: await hashPassword(newToken("secret")),
      companyId: input.companyId ?? null,
      disabled: true,
      pending: true,
    })
    .returning();
  await record(db, deferred, { userId: input.invitedBy, action: "user.created", targetType: "user", targetId: created!.id, details: { pending: true } });
  return created!;
}

/** Project membership with company, roles (task teams included) and the administrator flag. */
export async function addProjectMember(
  db: Db,
  project: { id: string; rootFolderId: string | null },
  input: { userId: string; companyId: string | null; roleIds: string[]; isProjectAdmin: boolean },
): Promise<void> {
  const values = { companyId: input.companyId, isProjectAdmin: input.isProjectAdmin };
  await db
    .insert(projectMembers)
    .values({ projectId: project.id, userId: input.userId, ...values })
    .onConflictDoUpdate({ target: [projectMembers.projectId, projectMembers.userId], set: values });
  if (input.roleIds.length)
    await db
      .insert(memberRoles)
      .values(input.roleIds.map((roleId) => ({ projectId: project.id, userId: input.userId, roleId })))
      .onConflictDoNothing();
  await linkProjectCompanies(db, project.id, [input.companyId]);
  await joinCompanyTeam(db, project.id, input.userId, input.companyId);
  if (input.isProjectAdmin) {
    const roleIds = await ensureDefaultProjectRoles(db, project.id, project.rootFolderId);
    const adminRoleId = roleIds["Yönetici"]; // i18n-ok: data (default role name)
    if (adminRoleId) await db.insert(memberRoles).values({ projectId: project.id, userId: input.userId, roleId: adminRoleId }).onConflictDoNothing();
  }
}

/**
 * A new invitation of a pending user to a project: the user's earlier open invitations to the same
 * project are replaced. Returns the plain token once (never stored).
 */
export async function issueInvitation(
  db: Db,
  input: {
    userId: string;
    email: string;
    projectId: string;
    companyId: string | null;
    roleIds: string[];
    isProjectAdmin: boolean;
    language: string;
    invitedBy: string;
    viaWizard?: boolean;
  },
  deferred?: AuditEvent[],
): Promise<{ id: string; token: string; expiresAt: Date }> {
  await db
    .delete(invitations)
    .where(and(eq(invitations.userId, input.userId), eq(invitations.projectId, input.projectId), isNull(invitations.acceptedAt), isNull(invitations.revokedAt)));
  const token = newToken("invite");
  const expiresAt = new Date(Date.now() + INVITATION_DAYS * 86400_000);
  const [row] = await db
    .insert(invitations)
    .values({
      userId: input.userId,
      email: input.email,
      projectId: input.projectId,
      tokenHash: hashToken(token),
      language: input.language,
      companyId: input.companyId,
      roleIds: input.roleIds,
      isProjectAdmin: input.isProjectAdmin,
      invitedBy: input.invitedBy,
      expiresAt,
    })
    .returning({ id: invitations.id });
  await record(db, deferred, {
    projectId: input.projectId,
    userId: input.invitedBy,
    action: "invitation.created",
    targetType: "user",
    targetId: input.userId,
    details: {
      email: input.email,
      language: input.language,
      expiresAt: expiresAt.toISOString(),
      companyId: input.companyId,
      roleIds: input.roleIds,
      isProjectAdmin: input.isProjectAdmin,
      ...(input.viaWizard ? { wizard: true } : {}),
    },
  });
  return { id: row!.id, token, expiresAt };
}

/** A new token and expiry for an invitation (resend); the old link stops working. */
export async function renewInvitation(db: Db, row: InvitationRow, by: string, language?: string): Promise<{ token: string; expiresAt: Date; language: string }> {
  const token = newToken("invite");
  const expiresAt = new Date(Date.now() + INVITATION_DAYS * 86400_000);
  const lang = language ?? row.language;
  await db
    .update(invitations)
    .set({ tokenHash: hashToken(token), expiresAt, language: lang, sendCount: row.sendCount + 1, mailedAt: null })
    .where(eq(invitations.id, row.id));
  await audit(db, {
    projectId: row.projectId,
    userId: by,
    action: "invitation.resent",
    targetType: "user",
    targetId: row.userId,
    details: { email: row.email, language: lang, expiresAt: expiresAt.toISOString() },
  });
  return { token, expiresAt, language: lang };
}

/** The invitation link: the token travels in the fragment, so it never reaches server logs or referrers. */
export function invitationUrl(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/invite#${token}`;
}

/** Why no e-mail can be sent now, or null when the invitation can be mailed. */
export async function mailBlocked(db: Db, mailer: LetterMailer | null | undefined): Promise<InvitationDeliveryDto["mailSkipped"] | null> {
  if (!mailer) return "smtp_not_configured";
  await refreshPrivacyState(db);
  return outboundRefusalMsg(mailer.host ?? "localhost", "smtp", "eposta") ? "smtp_disabled" : null;
}

/**
 * Sends the invitation e-mail when SMTP is configured and allowed; otherwise (or when sending fails)
 * the answer carries the link for the inviter to hand over.
 */
export async function deliverInvitation(
  db: Db,
  mailer: LetterMailer | null | undefined,
  input: { id: string; token: string; email: string; name: string; language: string; expiresAt: Date; inviterName: string; projectName: string; baseUrl: string },
): Promise<InvitationDeliveryDto> {
  const url = invitationUrl(input.baseUrl, input.token);
  const base = { id: input.id, expiresAt: input.expiresAt.toISOString() };
  const blocked = await mailBlocked(db, mailer);
  if (blocked || !mailer) return { ...base, mailed: false, url, mailSkipped: blocked ?? "smtp_not_configured" };
  const t = tFor(input.language);
  const params = {
    name: input.name,
    inviter: input.inviterName,
    project: input.projectName,
    url,
    expires: new Intl.DateTimeFormat(intlLocale(input.language), { dateStyle: "long" }).format(input.expiresAt),
  };
  const subject = t("auth:invitation.mail.subject", params);
  const text = t("auth:invitation.mail.body", params);
  try {
    await outboundCall(
      "eposta",
      mailer.host ?? "localhost",
      { connection: "smtp", method: "SMTP", bytesOut: Buffer.byteLength(text), details: { kind: "invitation" } },
      () =>
        mailer.transport.sendMail({
          from: mailer.from,
          to: input.email,
          subject,
          text,
          textEncoding: "quoted-printable",
          headers: { "X-Mailer": "SiteKeep" },
        }),
    );
  } catch {
    return { ...base, mailed: false, url, mailSkipped: "send_failed" };
  }
  await db.update(invitations).set({ mailedAt: new Date() }).where(eq(invitations.id, input.id));
  return { ...base, mailed: true };
}

// ---- Accepting ----------------------------------------------------------------------------------

export type InvitationProblem = "invitation_invalid" | "invitation_expired" | "invitation_used" | "invitation_revoked";

const PROBLEM_MSG = {
  invitation_invalid: msg("auth:errors.invitationInvalid"),
  invitation_expired: msg("auth:errors.invitationExpired"),
  invitation_used: msg("auth:errors.invitationUsed"),
  invitation_revoked: msg("auth:errors.invitationRevoked"),
} as const;

export function invitationError(problem: InvitationProblem): HttpError {
  return new HttpError(problem === "invitation_invalid" ? 404 : 410, problem, PROBLEM_MSG[problem]);
}

/** The open invitation of a token with its pending user, or the reason it cannot be used. */
export async function findOpenInvitation(
  db: Db,
  token: string,
): Promise<{ ok: true; invitation: InvitationRow; user: UserRow } | { ok: false; problem: InvitationProblem }> {
  if (!token.startsWith("7dcde_invite_") || token.length > 200) return { ok: false, problem: "invitation_invalid" };
  const [row] = await db
    .select({ invitation: invitations, user: users })
    .from(invitations)
    .innerJoin(users, eq(users.id, invitations.userId))
    .where(eq(invitations.tokenHash, hashToken(token)));
  if (!row) return { ok: false, problem: "invitation_invalid" };
  const status = invitationStatus(row.invitation);
  if (status === "accepted" || (status === "open" && !row.user.pending)) return { ok: false, problem: "invitation_used" };
  if (status === "revoked") return { ok: false, problem: "invitation_revoked" };
  if (status === "expired") return { ok: false, problem: "invitation_expired" };
  return { ok: true, invitation: row.invitation, user: row.user };
}

/**
 * Activates the invited account: name, password (none with Google), interface language. The token is spent in
 * the same statement that checks it (single use); the person's other open invitations are closed too,
 * since their memberships already exist. Returns the active user.
 */
export async function acceptInvitation(
  db: Db,
  token: string,
  input: AcceptInput,
): Promise<UserRow> {
  const found = await findOpenInvitation(db, token);
  if (!found.ok) throw invitationError(found.problem);
  return activate(db, found, input);
}

type AcceptInput = { name?: string | null; password?: string | null; provider: string; language?: string | null };

/**
 * Accepts the newest open invitation of a pending user without its token: an OpenID Connect provider
 * confirmed the invited address (docs/features/OIDC_SIGN_IN.md). Null when the user has none open.
 */
export async function acceptInvitationOfUser(db: Db, userId: string, input: AcceptInput): Promise<UserRow | null> {
  const [row] = await db
    .select({ invitation: invitations, user: users })
    .from(invitations)
    .innerJoin(users, eq(users.id, invitations.userId))
    .where(and(eq(invitations.userId, userId), eq(users.pending, true), isNull(invitations.acceptedAt), isNull(invitations.revokedAt), gt(invitations.expiresAt, new Date())))
    .orderBy(desc(invitations.createdAt))
    .limit(1);
  return row ? activate(db, row, input) : null;
}

async function activate(db: Db, found: { invitation: InvitationRow; user: UserRow }, input: AcceptInput): Promise<UserRow> {
  const { invitation } = found;
  const passwordHash = input.password ? await hashPassword(input.password) : null;
  const now = new Date();
  const user = await db.transaction(async (tx) => {
    const spent = await tx
      .update(invitations)
      .set({ acceptedAt: now })
      .where(and(eq(invitations.id, invitation.id), isNull(invitations.acceptedAt), isNull(invitations.revokedAt), gt(invitations.expiresAt, now)))
      .returning({ id: invitations.id });
    if (!spent.length) throw invitationError("invitation_used");
    const [activated] = await tx
      .update(users)
      .set({
        pending: false,
        disabled: false,
        ...(input.name?.trim() ? { name: input.name.trim().slice(0, 200) } : {}),
        ...(passwordHash ? { passwordHash } : {}),
        // The language the person accepted in (the accept page's), else the invitation's.
        prefs: { ...(found.user.prefs ?? {}), language: input.language ?? found.user.prefs?.language ?? invitation.language },
      })
      .where(and(eq(users.id, invitation.userId), eq(users.pending, true)))
      .returning();
    if (!activated) throw invitationError("invitation_used");
    const others = await tx
      .update(invitations)
      .set({ acceptedAt: now })
      .where(and(eq(invitations.userId, invitation.userId), isNull(invitations.acceptedAt), isNull(invitations.revokedAt)))
      .returning({ id: invitations.id, projectId: invitations.projectId });
    const txDb = tx as unknown as Db;
    for (const p of [{ id: invitation.id, projectId: invitation.projectId }, ...others])
      await audit(txDb, {
        projectId: p.projectId,
        userId: activated.id,
        action: "invitation.accepted",
        targetType: "user",
        targetId: activated.id,
        details: { email: activated.email, provider: input.provider },
      });
    return activated;
  });
  await refreshSeats(db);
  return user;
}

/** Closes an invitation; while the person is still pending, the membership it gave is removed. */
export async function revokeInvitation(db: Db, row: InvitationRow, by: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.update(invitations).set({ revokedAt: new Date() }).where(eq(invitations.id, row.id));
    const [user] = await tx.select({ pending: users.pending }).from(users).where(eq(users.id, row.userId));
    if (user?.pending && row.projectId) {
      await tx.delete(memberRoles).where(and(eq(memberRoles.projectId, row.projectId), eq(memberRoles.userId, row.userId)));
      await tx.delete(projectMembers).where(and(eq(projectMembers.projectId, row.projectId), eq(projectMembers.userId, row.userId)));
    }
    await audit(tx as unknown as Db, {
      projectId: row.projectId,
      userId: by,
      action: "invitation.revoked",
      targetType: "user",
      targetId: row.userId,
      details: { email: row.email },
    });
  });
}

// ---- Lists --------------------------------------------------------------------------------------

/** The project's invitations, newest first (accepted and revoked ones of the last 90 days included). */
export async function listInvitations(db: Db, projectId: string): Promise<InvitationDto[]> {
  const rows = await db
    .select({ invitation: invitations, name: users.name, companyName: companies.name })
    .from(invitations)
    .innerJoin(users, eq(users.id, invitations.userId))
    .leftJoin(companies, eq(companies.id, invitations.companyId))
    .where(and(eq(invitations.projectId, projectId), gt(invitations.createdAt, new Date(Date.now() - 90 * 86400_000))))
    .orderBy(desc(invitations.createdAt));
  const inviterIds = [...new Set(rows.map((r) => r.invitation.invitedBy).filter((id): id is string => !!id))];
  const inviters = inviterIds.length ? await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, inviterIds)) : [];
  const inviterName = new Map(inviters.map((u) => [u.id, u.name]));
  return rows.map(({ invitation: i, name, companyName }) => ({
    id: i.id,
    email: i.email,
    name,
    userId: i.userId,
    projectId: i.projectId,
    companyId: i.companyId,
    companyName: companyName ?? null,
    roleIds: i.roleIds,
    isProjectAdmin: i.isProjectAdmin,
    language: i.language,
    invitedByName: i.invitedBy ? (inviterName.get(i.invitedBy) ?? null) : null,
    createdAt: i.createdAt.toISOString(),
    expiresAt: i.expiresAt.toISOString(),
    acceptedAt: i.acceptedAt?.toISOString() ?? null,
    revokedAt: i.revokedAt?.toISOString() ?? null,
    mailedAt: i.mailedAt?.toISOString() ?? null,
    sendCount: i.sendCount,
    status: invitationStatus(i),
  }));
}

/** Projects an invitation token's person was invited to (for the accept page). */
export async function invitedProjects(db: Db, userId: string): Promise<{ code: string; name: string }[]> {
  return db
    .selectDistinct({ code: projects.code, name: projects.name })
    .from(invitations)
    .innerJoin(projects, eq(projects.id, invitations.projectId))
    .where(and(eq(invitations.userId, userId), isNull(invitations.acceptedAt), isNull(invitations.revokedAt)))
    .orderBy(asc(projects.code));
}

/** Language of an invitation: the inviter's choice, else the installation's. */
export function invitationLanguage(choice: string | null | undefined): string {
  return choice ?? DEFAULT_LANGUAGE;
}
