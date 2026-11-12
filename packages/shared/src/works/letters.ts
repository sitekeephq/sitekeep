/**
 * Official letters ("Resmi yazı") on correspondence works: languages, bilingual layout, recipient,
 * body texts with translations, labels for the PDF and e-mail templates. Stored in
 * works.data.letter (validated by the server). Base texts are Turkish (the work title is the
 * Turkish subject); an empty translated field falls back to the Turkish text.
 * Ported from the Odoo module sevend_yazismalar (see docs/features/YAZISMALAR.md).
 */
import { SHARED_DEFAULT_LANGUAGE, sharedText } from "../platform/i18n.js";

export const LETTER_LANGS = ["tr", "en", "fr", "it", "es", "de"] as const;
export type LetterLang = (typeof LETTER_LANGS)[number];

/** Each language in its own name (endonyms, the same in every interface language). */
export const LETTER_LANGUAGE_LABELS: Record<LetterLang, string> = {
  tr: "Türkçe", // i18n-ok: endonym
  en: "English",
  fr: "Français", // i18n-ok: endonym
  it: "Italiano",
  es: "Español",
  de: "Deutsch",
};

export const LETTER_LAYOUTS = ["columns", "stacked"] as const;
export type LetterLayout = (typeof LETTER_LAYOUTS)[number];
export const LETTER_LAYOUT_LABELS_TR: Record<LetterLayout, string> = {
  columns: "Yan Yana (iki sütun)",
  stacked: "Alt Alta",
};

/** Translatable texts of a letter in one language (empty = Turkish text is used). */
export interface LetterTranslation {
  subject?: string;
  body?: string;
  body2?: string;
  signerTitle?: string;
  referenceText?: string;
}
export const LETTER_TRANSLATION_KEYS = ["subject", "body", "body2", "signerTitle", "referenceText"] as const;

export interface LetterRecipient {
  /** "Muhatap": office or person the letter is addressed to. */
  name: string;
  address: string;
  email: string;
}

export interface LetterData {
  language: LetterLang;
  /** Second language of a bilingual letter (must differ from `language`). */
  secondaryLanguage: LetterLang | null;
  layout: LetterLayout;
  recipient: LetterRecipient;
  ccEmails: string[];
  /** Plain text with light markup: blank line = paragraph, "- " = bullet, **bold**. */
  body: string;
  /** Extra page ("İçerik 2"), printed on a new page. */
  body2: string;
  signer: { name: string; title: string };
  /** Free "ilgi" text printed under the reference list. */
  referenceText: string;
  translations: Partial<Record<LetterLang, LetterTranslation>>;
  /** Set when the letter was e-mailed (SMTP) or marked as e-mailed by hand. */
  mailSentAt: string | null;
}

export interface LetterLabels {
  ref: string;
  date: string;
  subject: string;
  project: string;
  doc: string;
  references: string;
  ours: string;
  theirs: string;
  /** {date}, {number}, {whose}. */
  reference_line: string;
}

export const LETTER_LABELS: Record<LetterLang, LetterLabels> = {
  tr: {
    ref: "Sayı", // i18n-ok: printed in the letter's language
    date: "Tarih",
    subject: "Konu",
    project: "Proje",
    doc: "Belge No",
    references: "İLGİ", // i18n-ok: printed in the letter's language
    ours: "yazımız", // i18n-ok: printed in the letter's language
    theirs: "yazınız", // i18n-ok: printed in the letter's language
    reference_line: "{date} tarihli ve {number} sayılı {whose}.", // i18n-ok: printed in the letter's language
  },
  en: {
    ref: "Ref",
    date: "Date",
    subject: "Subject",
    project: "Project",
    doc: "Doc. No",
    references: "REFERENCES",
    ours: "Our",
    theirs: "Your",
    reference_line: "{whose} letter No. {number} dated {date}.",
  },
  fr: {
    ref: "Réf.",
    date: "Date",
    subject: "Objet",
    project: "Projet",
    doc: "Document n°",
    references: "RÉFÉRENCES",
    ours: "Notre",
    theirs: "Votre",
    reference_line: "{whose} lettre n° {number} du {date}.",
  },
  it: {
    ref: "Prot.",
    date: "Data",
    subject: "Oggetto",
    project: "Progetto",
    doc: "Documento n.",
    references: "RIFERIMENTI",
    ours: "Nostra",
    theirs: "Vostra",
    reference_line: "{whose} lettera n. {number} del {date}.",
  },
  es: {
    ref: "Ref.",
    date: "Fecha",
    subject: "Asunto",
    project: "Proyecto",
    doc: "Documento n.º",
    references: "REFERENCIAS",
    ours: "Nuestra",
    theirs: "Su",
    reference_line: "{whose} carta n.º {number} de fecha {date}.",
  },
  de: {
    ref: "Unser Zeichen",
    date: "Datum",
    subject: "Betreff",
    project: "Projekt",
    doc: "Dokument-Nr.",
    references: "BEZUG",
    ours: "Unser",
    theirs: "Ihr",
    reference_line: "{whose} Schreiben Nr. {number} vom {date}.",
  },
};

const LOCALES: Record<Exclude<LetterLang, "tr">, string> = {
  en: "en-GB",
  fr: "fr-FR",
  it: "it-IT",
  es: "es-ES",
  de: "de-DE",
};

export function isLetterLang(v: unknown): v is LetterLang {
  return typeof v === "string" && (LETTER_LANGS as readonly string[]).includes(v);
}

export function emptyLetter(): LetterData {
  return {
    language: "tr",
    secondaryLanguage: null,
    layout: "columns",
    recipient: { name: "", address: "", email: "" },
    ccEmails: [],
    body: "",
    body2: "",
    signer: { name: "", title: "" },
    referenceText: "",
    translations: {},
    mailSentAt: null,
  };
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** Letter data of a work (works.data.letter) with defaults for missing parts; never throws. */
export function readLetter(raw: unknown): LetterData {
  const base = emptyLetter();
  if (!raw || typeof raw !== "object") return base;
  const r = raw as Record<string, unknown>;
  const rec = (r.recipient ?? {}) as Record<string, unknown>;
  const signer = (r.signer ?? {}) as Record<string, unknown>;
  const language = isLetterLang(r.language) ? r.language : "tr";
  const secondary = isLetterLang(r.secondaryLanguage) && r.secondaryLanguage !== language ? r.secondaryLanguage : null;
  const translations: LetterData["translations"] = {};
  if (r.translations && typeof r.translations === "object")
    for (const [lang, t] of Object.entries(r.translations as Record<string, unknown>)) {
      if (!isLetterLang(lang) || lang === "tr" || !t || typeof t !== "object") continue;
      const tt = t as Record<string, unknown>;
      const out: LetterTranslation = {};
      for (const k of LETTER_TRANSLATION_KEYS) if (str(tt[k])) out[k] = str(tt[k]);
      translations[lang] = out;
    }
  return {
    language,
    secondaryLanguage: secondary,
    layout: r.layout === "stacked" ? "stacked" : "columns",
    recipient: { name: str(rec.name), address: str(rec.address), email: str(rec.email) },
    ccEmails: Array.isArray(r.ccEmails) ? r.ccEmails.filter((x): x is string => typeof x === "string" && !!x.trim()) : [],
    body: str(r.body),
    body2: str(r.body2),
    signer: { name: str(signer.name), title: str(signer.title) },
    referenceText: str(r.referenceText),
    translations,
    mailSentAt: typeof r.mailSentAt === "string" ? r.mailSentAt : null,
  };
}

/** Languages the letter is printed in: the main language, then the second one. */
export function letterLanguages(l: Pick<LetterData, "language" | "secondaryLanguage">): LetterLang[] {
  return l.secondaryLanguage && l.secondaryLanguage !== l.language ? [l.language, l.secondaryLanguage] : [l.language];
}

export interface LetterValues {
  subject: string;
  body: string;
  body2: string;
  signerTitle: string;
  referenceText: string;
}

/** Texts of the letter in a language; an empty translation falls back to the Turkish text. */
export function letterValues(l: LetterData, title: string, lang: LetterLang = l.language): LetterValues {
  const base: LetterValues = {
    subject: title,
    body: l.body,
    body2: l.body2,
    signerTitle: l.signer.title,
    referenceText: l.referenceText,
  };
  if (lang === "tr") return base;
  const t = l.translations[lang] ?? {};
  const pick = (k: keyof LetterValues) => (t[k]?.trim() ? t[k]! : base[k]);
  return {
    subject: pick("subject"),
    body: pick("body"),
    body2: pick("body2"),
    signerTitle: pick("signerTitle"),
    referenceText: pick("referenceText"),
  };
}

/** Unique values joined with " / " ("İhale / Tender"); repeated values appear once. */
export function joinUnique(values: string[]): string {
  return [...new Set(values.filter((v) => v !== ""))].join(" / ");
}

/** Subject in every letter language: "İhale / Tender". */
export function letterSubject(l: LetterData, title: string): string {
  return joinUnique(letterLanguages(l).map((lang) => letterValues(l, title, lang).subject));
}

/** Heading in every letter language: "Sayı / Ref". */
export function combinedLabel(l: Pick<LetterData, "language" | "secondaryLanguage">, key: keyof LetterLabels): string {
  return joinUnique(letterLanguages(l).map((lang) => LETTER_LABELS[lang][key]));
}

function toDate(d: string | Date): Date | null {
  if (d instanceof Date) return Number.isNaN(d.getTime()) ? null : d;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
  const date = m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : new Date(d);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Letter date: Turkish letters use dd.MM.yyyy, other languages the long local form
 * ("5 March 2026", "5. März 2026"). ISO day strings are read as calendar days (no time zone shift).
 */
export function formatLetterDate(d: string | Date | null | undefined, lang: LetterLang): string {
  if (!d) return "";
  const date = toDate(d);
  if (!date) return "";
  const dayOnly = typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d);
  if (lang === "tr") {
    const p = (n: number) => String(n).padStart(2, "0");
    return dayOnly
      ? `${p(date.getUTCDate())}.${p(date.getUTCMonth() + 1)}.${date.getUTCFullYear()}`
      : `${p(date.getDate())}.${p(date.getMonth() + 1)}.${date.getFullYear()}`;
  }
  return new Intl.DateTimeFormat(LOCALES[lang], { dateStyle: "long", ...(dayOnly ? { timeZone: "UTC" } : {}) }).format(date);
}

/** The date in every letter language: "05.03.2026 / 5 March 2026". */
export function combinedDate(l: Pick<LetterData, "language" | "secondaryLanguage">, d: string | Date | null | undefined): string {
  return joinUnique(letterLanguages(l).map((lang) => formatLetterDate(d, lang)));
}

export interface LetterReference {
  /** Letter date (ISO day or timestamp). */
  date: string | Date | null;
  /** Incoming letters: the sender's number (sayı); outgoing: our number. */
  number: string;
  /** The referenced letter came from the other side ("yazınız" / "Your letter"). */
  incoming: boolean;
}

/** One "İLGİ" line: "05.03.2026 tarihli ve E-12345 sayılı yazınız." / "Your letter No. E-12345 dated 5 March 2026." */
export function referenceLine(lang: LetterLang, ref: LetterReference): string {
  const labels = LETTER_LABELS[lang];
  return labels.reference_line
    .replace("{date}", formatLetterDate(ref.date, lang))
    .replace("{number}", ref.number)
    .replace("{whose}", ref.incoming ? labels.theirs : labels.ours);
}

/** List marks for reference lines: a), b), c)… */
export function referenceMark(i: number): string {
  let n = i;
  let s = "";
  do {
    s = String.fromCharCode(97 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return `${s})`;
}

/**
 * Problems that block sending, in `lang`: every non-Turkish letter language needs a translated
 * subject, and a translated body when the Turkish body is not empty.
 */
export function letterSendProblems(l: LetterData, number: string, lang: string = SHARED_DEFAULT_LANGUAGE): string[] {
  const out: string[] = [];
  for (const letterLang of letterLanguages(l)) {
    if (letterLang === "tr") continue;
    const t = l.translations[letterLang] ?? {};
    if (!t.subject?.trim() || (l.body.trim() && !t.body?.trim()))
      out.push(sharedText(lang, "letters.translationMissing", { number, language: LETTER_LANGUAGE_LABELS[letterLang] }));
  }
  return out;
}

// ---- Light markup -------------------------------------------------------------------------------

export interface LetterRun {
  text: string;
  bold: boolean;
}

export interface LetterBlock {
  kind: "p" | "li";
  /** Runs of one block; "\n" inside a run is a line break. */
  runs: LetterRun[];
}

/** **bold** runs of a line. An unclosed "**" stays as text. */
export function parseRuns(text: string): LetterRun[] {
  const out: LetterRun[] = [];
  const re = /\*\*(.+?)\*\*/gs;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index! > last) out.push({ text: text.slice(last, m.index), bold: false });
    out.push({ text: m[1]!, bold: true });
    last = m.index! + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), bold: false });
  return out.filter((r) => r.text !== "");
}

/** Blocks of a body text: blank lines separate paragraphs, lines starting with "- " are bullets. */
export function parseLetterText(text: string): LetterBlock[] {
  const blocks: LetterBlock[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push({ kind: "p", runs: parseRuns(para.join("\n")) });
    para = [];
  };
  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) {
      flush();
      continue;
    }
    const bullet = /^\s*[-•*]\s+(.*)$/.exec(line);
    if (bullet && !/^\s*\*\*/.test(line)) {
      flush();
      blocks.push({ kind: "li", runs: parseRuns(bullet[1]!) });
      continue;
    }
    para.push(line);
  }
  flush();
  return blocks;
}

// ---- E-mail ---------------------------------------------------------------------------------------

export interface LetterMailContext {
  number: string;
  title: string;
  /** Signer, else the user preparing the mail. */
  senderName: string;
  company: string;
}

function mailBlock(lang: LetterLang, recipient: string, number: string, subject: string): string {
  switch (lang) {
    case "en":
      return `Dear ${recipient || "Sir/Madam"},\n\nPlease find attached our letter No. ${number} regarding "${subject}".\n\nKind regards,`;
    case "fr":
      return `Madame, Monsieur,\n\nVeuillez trouver ci-joint notre lettre n° ${number} concernant « ${subject} ».\n\nVeuillez agréer nos salutations distinguées,`;
    case "it":
      return `Spett.le ${recipient},\n\nin allegato trasmettiamo la nostra lettera n. ${number} relativa a "${subject}".\n\nDistinti saluti,`;
    case "es":
      return `Estimado/a ${recipient}:\n\nAdjuntamos nuestra carta n.º ${number} relativa a «${subject}».\n\nAtentamente,`;
    case "de":
      return `Sehr geehrte Damen und Herren,\n\nanbei erhalten Sie unser Schreiben Nr. ${number} zum Betreff „${subject}“.\n\nMit freundlichen Grüßen`; // i18n-ok: e-mail in the letter's language
    default:
      return `Sayın ${recipient || "Yetkili"},\n\n"${subject}" konulu ${number} sayılı yazımız ekte bilgilerinize sunulmuştur.\n\nSaygılarımızla,`; // i18n-ok: e-mail in the letter's language
  }
}

export const LETTER_MAIL_RULE = "----------------------------------------";

/** E-mail subject: "<number> - İhale / Tender". */
export function letterMailSubject(l: LetterData, number: string, title: string): string {
  return `${number} - ${letterSubject(l, title)}`;
}

/** Plain-text e-mail body: one block per letter language separated by a rule, then signer and company. */
export function letterMailText(l: LetterData, c: LetterMailContext): string {
  const blocks = letterLanguages(l).map((lang) =>
    mailBlock(lang, l.recipient.name.trim(), c.number, letterValues(l, c.title, lang).subject),
  );
  const sign = [c.senderName, c.company].filter((x) => x.trim()).join("\n");
  return `${blocks.join(`\n\n${LETTER_MAIL_RULE}\n\n`)}\n\n${sign}\n`;
}

/** Letter facts shown in lists and tools. */
export interface LetterSummary {
  languages: LetterLang[];
  recipient: string | null;
  recipientEmail: string | null;
  mailSent: boolean;
  mailSentAt: string | null;
}

export function letterSummary(l: LetterData): LetterSummary {
  return {
    languages: letterLanguages(l),
    recipient: l.recipient.name.trim() || null,
    recipientEmail: l.recipient.email.trim() || null,
    mailSent: !!l.mailSentAt,
    mailSentAt: l.mailSentAt,
  };
}
