/**
 * Official letters on correspondence works (port of the Odoo module sevend_yazismalar): letter data
 * in works.data.letter (validated here), recipient prefill from companies, the "ilgi" thread,
 * İLGİ references for the PDF, the .eml draft and optional SMTP sending. Nothing in this file
 * imports works/service.ts (service.ts uses it when creating, sending and replying).
 */
import { and, eq, inArray, or } from "drizzle-orm";
import nodemailer, { type Transporter } from "nodemailer";
import { hostOf, outboundCall } from "../privacy/outbound.js";
import { z } from "zod";
import {
  LETTER_LANGS,
  LETTER_LAYOUTS,
  emptyLetter,
  letterMailSubject,
  letterMailText,
  readLetter,
  type LetterData,
  type LetterReference,
  type WorkCategory,
  type WorkTypeSettings,
} from "@sitekeep/shared";
import type { Db } from "../db/index.js";
import { companies, workLinks, workTypes, works } from "../db/schema.js";
import { badRequest } from "../core/platform/http.js";
import { DEFAULT_LANGUAGE, msg, render } from "../i18n/index.js";

type TypeLike = { category: WorkCategory; settings: WorkTypeSettings };
type WorkLike = { id: string; data: Record<string, unknown>; fromCompanyId: string | null; ownerCompanyId: string | null; toCompanyIds: string[] };

export function isLetterType(t: TypeLike): boolean {
  return t.category === "correspondence";
}

/** Outgoing correspondence: has an official letter PDF (incoming registrations do not). */
export function isOutgoingLetter(t: TypeLike): boolean {
  return t.category === "correspondence" && !t.settings.incoming;
}

export function letterOf(w: { data: Record<string, unknown> }): LetterData {
  return readLetter(w.data?.letter);
}

// ---- Validation ---------------------------------------------------------------------------------

const text = (max: number) => z.string().max(max);
const translation = z
  .object({
    subject: text(300).optional(),
    body: text(50000).optional(),
    body2: text(50000).optional(),
    signerTitle: text(200).optional(),
    referenceText: text(5000).optional(),
  })
  .strict();

/** Body of PUT /works/:wid/letter: any part of the letter (mailSentAt is set by the server only). */
export const letterPatchSchema = z
  .object({
    language: z.enum(LETTER_LANGS).optional(),
    secondaryLanguage: z.enum(LETTER_LANGS).nullable().optional(),
    layout: z.enum(LETTER_LAYOUTS).optional(),
    recipient: z
      .object({
        name: text(300).optional(),
        address: text(1000).optional(),
        email: z.union([z.literal(""), z.string().trim().max(200).pipe(z.email(render(DEFAULT_LANGUAGE, msg("works:errors.recipientEmailInvalid"))))]).optional(),
      })
      .strict()
      .optional(),
    ccEmails: z.array(z.string().trim().max(200).pipe(z.email(render(DEFAULT_LANGUAGE, msg("works:errors.ccEmailInvalid"))))).max(30).optional(),
    body: text(50000).optional(),
    body2: text(50000).optional(),
    signer: z.object({ name: text(200).optional(), title: text(200).optional() }).strict().optional(),
    referenceText: text(5000).optional(),
    translations: z.partialRecord(z.enum(LETTER_LANGS).exclude(["tr"]), translation.nullable()).optional(),
  })
  .strict();
export type LetterPatch = z.infer<typeof letterPatchSchema>;

/** Applies a validated patch; translations merge per language (null removes a language). */
export function mergeLetter(current: LetterData, patch: LetterPatch): LetterData {
  const next: LetterData = {
    ...current,
    ...(patch.language !== undefined ? { language: patch.language } : {}),
    ...(patch.secondaryLanguage !== undefined ? { secondaryLanguage: patch.secondaryLanguage } : {}),
    ...(patch.layout !== undefined ? { layout: patch.layout } : {}),
    ...(patch.body !== undefined ? { body: patch.body } : {}),
    ...(patch.body2 !== undefined ? { body2: patch.body2 } : {}),
    ...(patch.referenceText !== undefined ? { referenceText: patch.referenceText } : {}),
    ...(patch.ccEmails !== undefined ? { ccEmails: [...new Set(patch.ccEmails.map((e) => e.toLowerCase()))] } : {}),
    recipient: { ...current.recipient, ...stripUndefined(patch.recipient ?? {}) },
    signer: { ...current.signer, ...stripUndefined(patch.signer ?? {}) },
    translations: { ...current.translations },
  };
  for (const [lang, t] of Object.entries(patch.translations ?? {})) {
    const key = lang as keyof LetterData["translations"];
    if (t === null) delete next.translations[key];
    else next.translations[key] = { ...(next.translations[key] ?? {}), ...stripUndefined(t ?? {}) };
  }
  if (next.secondaryLanguage && next.secondaryLanguage === next.language) throw badRequest(msg("works:errors.secondaryLanguageSame"));
  return readLetter(next);
}

function stripUndefined<T extends Record<string, unknown>>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

// ---- Recipient ----------------------------------------------------------------------------------

/** Recipient ("muhatap") from a company: name, address, e-mail. */
export async function recipientFromCompany(db: Db, companyId: string | null | undefined): Promise<LetterData["recipient"] | null> {
  if (!companyId) return null;
  const [c] = await db.select().from(companies).where(eq(companies.id, companyId));
  if (!c) return null;
  return { name: c.name, address: c.address ?? "", email: c.email ?? "" };
}

/** The other side of a letter: the sender of an incoming letter, the first "gereği" of an outgoing one. */
export function counterpartCompany(t: TypeLike, w: Pick<WorkLike, "fromCompanyId" | "toCompanyIds">): string | null {
  return t.settings.incoming ? w.fromCompanyId : (w.toCompanyIds[0] ?? null);
}

/** Letter data for a new correspondence work: defaults, given parts, recipient from the counterpart company. */
export async function initialLetter(
  db: Db,
  t: TypeLike,
  w: Pick<WorkLike, "fromCompanyId" | "toCompanyIds">,
  given: LetterData | null,
): Promise<LetterData> {
  const letter = given ?? emptyLetter();
  if (!letter.recipient.name && !letter.recipient.email && !letter.recipient.address) {
    const r = await recipientFromCompany(db, counterpartCompany(t, w));
    if (r) letter.recipient = r;
  }
  return letter;
}

// ---- Thread -------------------------------------------------------------------------------------

/** Works reachable through "ilgi" work links in both directions (transitive), the start included. */
export async function threadGraph(
  db: Db,
  projectId: string,
  workId: string,
  max = 200,
): Promise<{ ids: Set<string>; edges: { from: string; to: string }[] }> {
  const seen = new Set<string>([workId]);
  let frontier = [workId];
  const edges: { from: string; to: string }[] = [];
  while (frontier.length && seen.size < max) {
    const rows = await db
      .select({ workId: workLinks.workId, targetId: workLinks.targetId })
      .from(workLinks)
      .innerJoin(works, eq(works.id, workLinks.workId))
      .where(
        and(
          eq(works.projectId, projectId),
          eq(workLinks.kind, "work"),
          eq(workLinks.role, "ilgi"),
          or(inArray(workLinks.workId, frontier), inArray(workLinks.targetId, frontier)),
        ),
      );
    const next: string[] = [];
    for (const r of rows) {
      if (!edges.some((e) => e.from === r.workId && e.to === r.targetId)) edges.push({ from: r.workId, to: r.targetId });
      for (const id of [r.workId, r.targetId])
        if (!seen.has(id)) {
          seen.add(id);
          next.push(id);
        }
    }
    frontier = next;
  }
  return { ids: seen, edges };
}

// ---- References ---------------------------------------------------------------------------------

/** Day of a letter for references: its "tarih" field, else the send or creation day. */
export function letterDay(w: { fields: Record<string, unknown>; sentAt: Date | null; createdAt: Date }): string | Date {
  const t = w.fields.tarih;
  if (typeof t === "string" && /^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  return w.sentAt ?? w.createdAt;
}

function sortKey(d: string | Date): string {
  return typeof d === "string" ? d : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * İLGİ lines of a letter: works it refers to with "ilgi", oldest first. Incoming letters are
 * cited with the sender's number (sayı) as "yazınız"; our letters with their number as "yazımız".
 */
export async function letterReferences(db: Db, workId: string): Promise<LetterReference[]> {
  const links = await db
    .select({ targetId: workLinks.targetId })
    .from(workLinks)
    .where(and(eq(workLinks.workId, workId), eq(workLinks.kind, "work"), eq(workLinks.role, "ilgi")));
  if (!links.length) return [];
  const rows = await db
    .select({ w: works, t: workTypes })
    .from(works)
    .innerJoin(workTypes, eq(workTypes.id, works.typeId))
    .where(inArray(works.id, links.map((l) => l.targetId)));
  return rows
    .map(({ w, t }) => {
      const incoming = !!t.settings.incoming;
      const sayi = typeof w.fields.sayi === "string" && w.fields.sayi.trim() ? w.fields.sayi.trim() : null;
      return { date: letterDay(w), number: (incoming && sayi) || w.number, incoming };
    })
    .sort((a, b) => sortKey(a.date).localeCompare(sortKey(b.date)));
}

// ---- E-mail -------------------------------------------------------------------------------------

/** SMTP sender configured by CDE_SMTP_URL / CDE_SMTP_FROM (tests pass a jsonTransport). */
export interface LetterMailer {
  transport: Transporter;
  from: string;
  /** SMTP server host[:port] (no credentials), for the outbound registry; tests' jsonTransport has none. */
  host?: string;
}

export function mailerFromEnv(env: NodeJS.ProcessEnv = process.env): LetterMailer | null {
  const url = env.CDE_SMTP_URL?.trim();
  const from = env.CDE_SMTP_FROM?.trim();
  if (!url || !from) return null;
  return { transport: nodemailer.createTransport(url), from, host: hostOf(url) };
}

export interface LetterMail {
  from: string;
  to: string;
  cc: string[];
  subject: string;
  text: string;
  attachment: { filename: string; content: Buffer };
}

export function letterMail(
  letter: LetterData,
  c: { number: string; title: string; senderName: string; company: string; from: string; pdf: Uint8Array },
): LetterMail {
  if (!letter.recipient.email.trim()) throw badRequest(msg("works:errors.recipientEmailMissing"));
  return {
    from: c.from,
    to: letter.recipient.name.trim() ? `"${letter.recipient.name.trim().replace(/"/g, "'")}" <${letter.recipient.email.trim()}>` : letter.recipient.email.trim(),
    cc: letter.ccEmails,
    subject: letterMailSubject(letter, c.number, c.title),
    text: letterMailText(letter, { number: c.number, title: c.title, senderName: c.senderName, company: c.company }),
    attachment: { filename: pdfFileName(c.number), content: Buffer.from(c.pdf) },
  };
}

function nodemailerMessage(m: LetterMail) {
  return {
    from: m.from,
    to: m.to,
    ...(m.cc.length ? { cc: m.cc.join(", ") } : {}),
    subject: m.subject,
    text: m.text,
    textEncoding: "quoted-printable" as const,
    attachments: [{ filename: m.attachment.filename, content: m.attachment.content, contentType: "application/pdf" }],
    headers: { "X-Mailer": "SiteKeep" },
  };
}

/** RFC 5322 message (multipart/mixed, UTF-8, CRLF) for "E-posta hazırla": opened in the user's mail program. */
export async function buildEml(m: LetterMail): Promise<Buffer> {
  const t = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: "windows" });
  const info = await t.sendMail({ ...nodemailerMessage(m), headers: { "X-Mailer": "SiteKeep", "X-Unsent": "1" } });
  return info.message as Buffer;
}

export async function sendLetterMail(mailer: LetterMailer, m: LetterMail): Promise<string | null> {
  // Through the outbound registry (Gizlilik Merkezi): kill switch, "eposta" log row, never content.
  const info = await outboundCall(
    "eposta",
    mailer.host ?? "localhost",
    { connection: "smtp", method: "SMTP", bytesOut: Buffer.byteLength(m.text) + m.attachment.content.length },
    () => mailer.transport.sendMail({ ...nodemailerMessage(m), from: m.from || mailer.from }),
    (r) => {
      const size = (r as unknown as { messageSize?: unknown }).messageSize;
      return { bytesOut: typeof size === "number" ? size : null };
    },
  );
  return typeof info.messageId === "string" ? info.messageId : null;
}

export function pdfFileName(number: string): string {
  return `${number.replace(/[\\/<>:"|?*\x00-\x1f]/g, "_")}.pdf`;
}
