/**
 * Default texts the server writes into projects as data (docs/architecture/i18n.md §8.2), shown
 * in the reader's language while the stored text is still the seeded default: default project
 * roles, built-in folders, the list options of built-in work type fields. Stored rows are never
 * renamed; a text the admin changed is shown as written. Turkish is the stored text itself; other
 * languages come from the "seededText" label table (locales/<lang>/labels.json), keyed by the
 * Turkish text.
 */
import { DEFAULT_PROJECT_ROLES } from "../workflow/roles.js";
import { labelText } from "./i18n.js";
import {
  DISCIPLINE_OPTIONS,
  IMPACT_OPTIONS,
  MEETING_KINDS,
  RFI_CATEGORIES,
  RFI_PRIORITIES,
  SUBMITTAL_KINDS,
  SUBMITTAL_KIND_OPTIONS,
} from "../works/build-works.js";
import { TRANSMITTAL_PURPOSES } from "../works/work-catalog.js";

/** Names of the built-in folders (data; the server finds some of them by name). */
export const SEEDED_FOLDER_NAMES = {
  /** Project root. */
  root: "Proje Dosyaları", // i18n-ok: folder name stored as data
  /** Transmittal cover PDFs, under the root. */
  covers: "Gönderim formları", // i18n-ok: folder name stored as data
  /** Official letter PDFs, under the root. */
  letters: "Yazılar", // i18n-ok: folder name stored as data
  /** Registered incoming documents, under the root. */
  intake: "Gelen belgeler", // i18n-ok: folder name stored as data
} as const;

/** Earlier names of the cover folder, reused when found. */
export const SEEDED_COVER_FOLDER_OLD_NAMES = ["Transmittaller"];

/** ISO 19650 state folders of projects created before their names followed the creator's language. */
const ISO_FOLDER_NAMES_TR = ["01-WIP (Çalışmada)", "02-SHARED (Paylaşılan)", "03-PUBLISHED (Yayınlanan)", "04-ARCHIVED (Arşiv)"];

const ROOT_CHILD_FOLDERS: readonly string[] = [
  SEEDED_FOLDER_NAMES.covers,
  SEEDED_FOLDER_NAMES.letters,
  SEEDED_FOLDER_NAMES.intake,
  ...SEEDED_COVER_FOLDER_OLD_NAMES,
  ...ISO_FOLDER_NAMES_TR,
];

/** Every seeded Turkish text with a translation: label table "seededText" (identity in Turkish). */
export const SEEDED_TEXT_LABELS_TR: Record<string, string> = Object.fromEntries(
  [
    SEEDED_FOLDER_NAMES.root,
    ...ROOT_CHILD_FOLDERS,
    ...DEFAULT_PROJECT_ROLES.flatMap((r) => [r.name, r.description]),
    ...DISCIPLINE_OPTIONS,
    ...RFI_CATEGORIES,
    ...RFI_PRIORITIES,
    ...IMPACT_OPTIONS,
    ...SUBMITTAL_KIND_OPTIONS,
    ...SUBMITTAL_KINDS.map((k) => k.label),
    ...MEETING_KINDS,
    ...TRANSMITTAL_PURPOSES,
  ].map((t) => [t, t]),
);

const isTurkish = (lang: string) => lang.toLowerCase().startsWith("tr");

/** A seeded text in `lang`; anything that is not a seeded text (or has no translation) as given. */
export function seededText(text: string, lang: string): string {
  if (isTurkish(lang) || !Object.prototype.hasOwnProperty.call(SEEDED_TEXT_LABELS_TR, text)) return text;
  const v = labelText(lang, "seededText", text);
  return v && v !== text ? v : text;
}

/** A project role as its reader sees it: the default roles' name and description in `lang`. */
export function shownRole<T extends { name: string; description?: string | null }>(role: T, lang: string): T {
  const def = DEFAULT_PROJECT_ROLES.find((r) => r.name === role.name);
  if (!def || isTurkish(lang)) return role;
  return {
    ...role,
    name: seededText(role.name, lang),
    ...(role.description === def.description && { description: seededText(def.description, lang) }),
  };
}

/** A role name alone (lists of names: members, assignees, permissions). */
export function shownRoleName(name: string, lang: string): string {
  return DEFAULT_PROJECT_ROLES.some((r) => r.name === name) ? seededText(name, lang) : name;
}

/**
 * A folder name as its reader sees it. Only the built-in folders at their place: the root, and
 * the cover / letter / intake / ISO state folders directly under it. A folder with the same name
 * elsewhere is the user's own.
 */
export function shownFolderName(name: string, place: "root" | "rootChild" | "other", lang: string): string {
  if (place === "root" && name === SEEDED_FOLDER_NAMES.root) return seededText(name, lang);
  if (place === "rootChild" && ROOT_CHILD_FOLDERS.includes(name)) return seededText(name, lang);
  return name;
}
