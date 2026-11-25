/**
 * Workflow e-mail (docs/features/WORKFLOW_EMAIL.md). notify() writes the in-app notification; for the
 * kinds below it then hands the event to this file, which
 *   - e-mails each recipient who wants it (users.prefs.emailNotifications, else the project default
 *     projects.settings.emailNotifications, else on), in the recipient's language, through the
 *     outbound registry (connection "smtp"; nothing is sent while SMTP is off or blocked);
 *   - passes the same event to the notification channels modules registered (SDK
 *     registerNotificationChannel: Teams/Slack/webhook, digests).
 * The actor of the event, disabled and pending users get nothing. Sending runs in the background and
 * a failure is only logged: it never breaks the workflow step that raised the notification.
 */
import { and, eq, inArray } from "drizzle-orm";
import type { EmailNotifyPrefs, EmailNotifyType } from "@sitekeep/shared";
import type { Db } from "../db/index.js";
import { projects, users } from "../db/schema.js";
import { DEFAULT_LANGUAGE, intlLocale, render, tFor, type Msg } from "../i18n/index.js";
import { mailBlocked } from "../auth/invitations.js";
import { outboundCall } from "../privacy/outbound.js";
import type { LetterMailer } from "../works/letter.js";
import { loadingModule } from "../app/module-owner.js";
import { moduleIds } from "../app/module-ids.js";

/** Notification kinds that are e-mailed, and the preference type each one falls under. */
export const MAIL_KINDS: Readonly<Record<string, EmailNotifyType>> = {
  "review.assigned": "assigned",
  "work.assigned": "assigned",
  "work.sent": "assigned",
  "review.due_soon": "due_soon",
  "work.due_soon": "due_soon",
  "review.overdue": "overdue",
  "work.overdue": "overdue",
  "review.completed": "outcome",
  "review.returned": "outcome",
  "cde.returned": "outcome",
  "work.decided": "outcome",
};

export function mailTypeOf(kind: string): EmailNotifyType | null {
  return MAIL_KINDS[kind] ?? null;
}

/** One person a notification event is for. */
export interface NotificationRecipient {
  userId: string;
  name: string;
  email: string;
  /** BCP 47 language of the person (their profile language, else the installation default). */
  language: string;
  /** The person's e-mail choice for this type, project default applied. */
  emailEnabled: boolean;
}

/** What a notification channel receives (SDK, `registerNotificationChannel`). */
export interface NotificationEvent {
  kind: string;
  type: EmailNotifyType;
  projectId: string | null;
  projectCode: string | null;
  /** Page of the record inside the web app ("/projects/<id>/reviews/<id>"), or null. */
  link: string | null;
  /** The same as an absolute address (public address of the installation), or null. */
  url: string | null;
  /** Due date (ISO date or timestamp) of the step or record, or null. */
  dueDate: string | null;
  actorId: string | null;
  /** The recipients (the actor, disabled and pending users already left out). */
  recipients: NotificationRecipient[];
  /** Title and body in a language. */
  text(language: string): { title: string; body: string | null };
}

export interface NotificationChannel {
  /** Unique id, e.g. "teams" or "digest". */
  id: string;
  /**
   * True when the channel takes over delivery for this recipient (e.g. they chose a daily digest):
   * the core then sends no immediate e-mail to them. Optional.
   */
  claims?(recipient: NotificationRecipient, event: NotificationEvent): boolean | Promise<boolean>;
  /** Called once per event with every recipient; deliver now or queue for a digest. A throw is logged. */
  deliver(event: NotificationEvent): Promise<void> | void;
}

interface Registered {
  channel: NotificationChannel;
  /** Module that registered it while loading (off when that module is off), or null for the core. */
  owner: string | null;
}

const channels = new Map<string, Registered>();

/** Adds a notification channel; returns the function that removes it. Ids are unique. */
export function registerNotificationChannel(channel: NotificationChannel): () => void {
  if (channels.has(channel.id)) throw new Error(`Notification channel "${channel.id}" is already registered`);
  const entry = { channel, owner: loadingModule() };
  channels.set(channel.id, entry);
  return () => {
    if (channels.get(channel.id) === entry) channels.delete(channel.id);
  };
}

function activeChannels(): NotificationChannel[] {
  const on = moduleIds();
  return [...channels.values()].filter((r) => !r.owner || on.includes(r.owner)).map((r) => r.channel);
}

// ---- Configuration and background sending ----------------------------------------------------

interface MailConfig {
  db: Db;
  mailer: LetterMailer | null;
  /** Public address of the installation, for links in the mail. */
  baseUrl: string;
  log: (message: string, error?: unknown) => void;
}

let config: MailConfig | null = null;
const pending = new Set<Promise<unknown>>();

/** Called by buildApp: the database, the SMTP sender (null: no e-mail) and the address for links. */
export function configureNotificationMail(c: Partial<MailConfig> & { db: Db }): void {
  config = { mailer: null, baseUrl: "", log: (m, e) => console.error(m, e), ...c };
}

/** Waits for the e-mails and channel calls still running (shutdown, tests). */
export async function settleNotificationMail(): Promise<void> {
  while (pending.size) await Promise.allSettled([...pending]);
}

export interface MailableNotification {
  projectId: string | null;
  kind: string;
  title: Msg | string;
  body?: Msg | string | null;
  link?: string | null;
  due?: Date | string | null;
  actorId?: string | null;
}

/** Starts the delivery of a notification in the background; never throws. */
export function dispatchNotificationMail(userIds: readonly string[], n: MailableNotification): void {
  const cfg = config;
  const type = mailTypeOf(n.kind);
  if (!cfg || !type) return;
  const run = deliver(cfg, type, userIds, n).catch((err) => cfg.log(`workflow e-mail failed (${n.kind})`, err));
  pending.add(run);
  void run.finally(() => pending.delete(run));
}

function isoOf(due: Date | string | null | undefined): string | null {
  if (!due) return null;
  return typeof due === "string" ? due : due.toISOString();
}

/** "12 December 2026": a date-only string is read as that calendar day, a timestamp in the server's zone. */
function dueText(language: string, due: string): string {
  const day = /^\d{4}-\d{2}-\d{2}$/.test(due);
  const d = day ? new Date(`${due}T12:00:00Z`) : new Date(due);
  if (Number.isNaN(d.getTime())) return due;
  return new Intl.DateTimeFormat(intlLocale(language), { dateStyle: "long", ...(day ? { timeZone: "UTC" } : {}) }).format(d);
}

async function deliver(cfg: MailConfig, type: EmailNotifyType, userIds: readonly string[], n: MailableNotification): Promise<void> {
  const on = activeChannels();
  if (!cfg.mailer && !on.length) return;
  const ids = [...new Set(userIds)].filter((u) => u !== n.actorId);
  if (!ids.length) return;
  const { db } = cfg;
  const rows = await db
    .select({ id: users.id, name: users.name, email: users.email, prefs: users.prefs })
    .from(users)
    .where(and(inArray(users.id, ids), eq(users.disabled, false), eq(users.pending, false)));
  if (!rows.length) return;
  let projectCode: string | null = null;
  let projectDefault: EmailNotifyPrefs = {};
  if (n.projectId) {
    const [p] = await db.select({ code: projects.code, settings: projects.settings }).from(projects).where(eq(projects.id, n.projectId));
    projectCode = p?.code ?? null;
    projectDefault = p?.settings?.emailNotifications ?? {};
  }
  const recipients: NotificationRecipient[] = rows.map((u) => ({
    userId: u.id,
    name: u.name,
    email: u.email,
    language: u.prefs?.language ?? DEFAULT_LANGUAGE,
    emailEnabled: u.prefs?.emailNotifications?.[type] ?? projectDefault[type] ?? true,
  }));
  const dueDate = isoOf(n.due);
  const event: NotificationEvent = {
    kind: n.kind,
    type,
    projectId: n.projectId,
    projectCode,
    link: n.link ?? null,
    url: n.link && cfg.baseUrl ? `${cfg.baseUrl.replace(/\/+$/, "")}${n.link}` : null,
    dueDate,
    actorId: n.actorId ?? null,
    recipients,
    text: (language) => ({ title: render(language, n.title), body: n.body == null ? null : render(language, n.body) }),
  };

  // Channels first (a digest claims its people), then the immediate e-mail for the rest.
  const claimed = new Set<string>();
  for (const ch of on) {
    try {
      for (const r of recipients) if (ch.claims && (await ch.claims(r, event))) claimed.add(r.userId);
      await ch.deliver(event);
    } catch (err) {
      cfg.log(`notification channel "${ch.id}" failed (${n.kind})`, err);
    }
  }

  const mailer = cfg.mailer;
  if (!mailer) return;
  const todo = recipients.filter((r) => r.emailEnabled && !claimed.has(r.userId));
  if (!todo.length || (await mailBlocked(db, mailer))) return;
  for (const r of todo) {
    try {
      const { subject, text } = renderMail(r.language, event);
      await outboundCall(
        "eposta",
        mailer.host ?? "localhost",
        { connection: "smtp", method: "SMTP", bytesOut: Buffer.byteLength(text), projectId: n.projectId, details: { kind: "workflow_notification", type } },
        () =>
          mailer.transport.sendMail({
            from: mailer.from,
            to: r.email,
            subject,
            text,
            textEncoding: "quoted-printable",
            headers: { "X-Mailer": "SiteKeep" },
          }),
      );
    } catch (err) {
      // One recipient failing (or the connection being refused) leaves the others and the workflow alone.
      cfg.log(`workflow e-mail to a recipient failed (${n.kind})`, err instanceof Error ? err.message : err);
    }
  }
}

/** Subject and plain-text body of an event in a language (texts: workflow:mail.*). */
export function renderMail(language: string, event: NotificationEvent): { subject: string; text: string } {
  const t = tFor(language);
  const { title, body } = event.text(language);
  const lines = [title];
  // With a due date the body is that date in short form (callers): the line below shows it in full.
  if (body && !event.dueDate) lines.push(body);
  lines.push("");
  if (event.projectCode) lines.push(t("workflow:mail.project", { code: event.projectCode }));
  if (event.dueDate) lines.push(t("workflow:mail.due", { date: dueText(language, event.dueDate) }));
  if (event.url) lines.push(t("workflow:mail.open", { url: event.url }));
  lines.push("", t("workflow:mail.footer"));
  return { subject: event.projectCode ? t("workflow:mail.subject", { code: event.projectCode, title }) : title, text: lines.join("\n") };
}
