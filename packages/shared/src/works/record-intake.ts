/**
 * "Bırak, kaydet" (docs/product/SIMPLIFICATION.md 2. aşama): a dropped PDF, e-mail (.eml / .msg) or .docx
 * becomes a record draft. The server reads the text with plain rules first (Sayı, Tarih, Konu,
 * İlgi, KEP header, e-mail From/Subject/Date); an optional AI pass only fills gaps. The user sees
 * a prefilled form with the original file attached and confirms with "Kaydet".
 */
import type { NewRecordKind } from "./intent.js";

/** Record types a file can become ("Gelen Yazı" unless the text names another type). */
export const INTAKE_KINDS = ["gelen-yazi", "rfi", "submittal", "transmittal"] as const satisfies readonly NewRecordKind[];

export type IntakeKind = (typeof INTAKE_KINDS)[number];

/** Accepted file extensions (lower case, without the dot). */
export const INTAKE_EXTENSIONS = ["pdf", "eml", "msg", "docx"] as const;

export type IntakeFormat = (typeof INTAKE_EXTENSIONS)[number];

/** Characters of the text that go to the AI pass (with the rule-based result). */
export const INTAKE_AI_CHARS = 2000;

/** "İlgi" line: "a) 02.10.2026 tarihli ve E-123 sayılı yazınız", matched to a work by number or "sayi". */
export interface IntakeReferenceDto {
  /** Number as read ("E-12345678-000-1234"). */
  number: string;
  /** Date as read (ISO), when the line had one. */
  date: string | null;
  /** The visible work whose number or "Gönderenin Sayısı" equals the number. */
  workId: string | null;
  workNumber: string | null;
  workTitle: string | null;
}

export interface RecordDraftDto {
  kind: IntakeKind;
  /** Words that decided the type (hint under the type select). */
  kindReason: string | null;
  title: string;
  /** Project company matched by name or short code (letterhead, KEP address, e-mail sender). */
  fromCompanyId: string | null;
  /** Sender as read (shown when no company matched). */
  fromText: string | null;
  /** "Sayı" of the document. */
  sayi: string | null;
  /** Letter date (ISO). */
  date: string | null;
  /** "Konu". */
  subject: string | null;
  references: IntakeReferenceDto[];
  /** "… gün içinde" or a date in the text (ISO). */
  dueDate: string | null;
  replyRequired: boolean;
  /** Fields the AI pass filled or changed. */
  aiFields: string[];
}

export interface RecordFromFileDto {
  draft: RecordDraftDto;
  file: {
    name: string;
    size: number;
    format: IntakeFormat;
    /** Signed reference of the stored upload; sent back with "Kaydet" (POST /works sourceUploadId). */
    uploadId: string | null;
    /** The file was already in Dokümanlar (fileId / versionId given): attached as this version. */
    versionId: string | null;
  };
  /** The text the rules read; the AI pass gets its first INTAKE_AI_CHARS characters. */
  excerpt: string;
  textLength: number;
  /** PDF without a text layer (scan): fields stay empty, the file is still attached. */
  noTextLayer: boolean;
  notes: string[];
  ai: {
    /** A configured model can run the AI pass now ("Yapay Zekâ ile Tamamla"). */
    available: boolean;
    used: boolean;
    error: string | null;
  };
}

/** Answer of POST /projects/:pid/ai/record-from-file (and of the queue kind record_from_file). */
export interface RecordDraftAiDto {
  draft: RecordDraftDto;
  notes: string[];
}
