/**
 * "+ Yeni" — "Ne yapmak istiyorsunuz?": a typed sentence preselects the record type and suggests
 * a title and a company, with plain keyword rules (no AI, docs/product/SADELESTIRME.md 1. aşama).
 *
 *   "Prota'ya B3 kazısı için bilgi talebi aç" → Bilgi Talebi · alıcı Prota · "B3 kazısı"
 *   "CNS'den gelen yazıyı kaydet"             → Gelen Yazı · gönderen CNS
 *
 * Phase 2 adds an AI draft from the same sentence (see apps/web/src/components/NewRecordDialog.tsx,
 * `draftFromSentence`); its result has the same shape, so the dialog does not change.
 */
import { foldTr } from "../kernel/attributes.js";
import type { ProjectModule } from "../core/modules.js";

export const NEW_RECORD_KINDS = [
  "gelen-yazi",
  "giden-yazi",
  "rfi",
  "submittal",
  "meeting",
  "action",
  "transmittal",
  "issue",
  "form",
  "review",
  "param-change",
  "upload",
] as const;
export type NewRecordKind = (typeof NEW_RECORD_KINDS)[number];

/** Tiles of the "+ Yeni" dialog (Title Case). */
export const NEW_RECORD_KIND_LABELS_TR: Record<NewRecordKind, string> = {
  "gelen-yazi": "Gelen Yazı",
  "giden-yazi": "Giden Yazı",
  rfi: "Bilgi Talebi",
  submittal: "Teknik Onay",
  meeting: "Toplantı",
  action: "Eylem",
  transmittal: "Gönderim Formu",
  issue: "Sorun",
  form: "Form",
  review: "İnceleme Başlat",
  "param-change": "Parametre Değişikliği",
  upload: "Doküman Yükle",
};

/** Built-in work type behind a kind (apps: the project's type with this key). */
export const NEW_RECORD_WORK_TYPE_KEYS: Partial<Record<NewRecordKind, string>> = {
  "gelen-yazi": "gelen-yazi",
  "giden-yazi": "giden-yazi",
  rfi: "rfi",
  submittal: "submittal-kalemi",
  meeting: "toplanti",
  action: "aksiyon",
  transmittal: "transmittal",
};

/** Module a kind needs; "upload" (documents) is always available. */
export function moduleOfNewRecordKind(kind: NewRecordKind): ProjectModule | null {
  switch (kind) {
    case "gelen-yazi":
    case "giden-yazi":
      return "correspondence";
    case "rfi":
      return "rfi";
    case "submittal":
      return "submittals";
    case "meeting":
    case "action":
      return "meetings";
    case "transmittal":
      return "transmittals";
    case "issue":
      return "issues";
    case "form":
      return "forms";
    case "review":
      return "reviews";
    case "param-change":
      return "coordination";
    case "upload":
      return null;
  }
}

export interface IntentCompany {
  id: string;
  name: string;
  code?: string | null;
}

export interface NewRecordGuess {
  /** Preselected type; null when no rule matched. */
  kind: NewRecordKind | null;
  /** Suggested title: the sentence without the type words, the company and verbs like "aç". */
  title: string;
  /** Company named in the sentence ("Prota'ya", "CNS'den"). */
  companyId: string | null;
  /** "from" for the sender of an incoming letter, "to" for a recipient. */
  companyRole: "from" | "to" | null;
  /** Words that decided the type, for the hint under the box. */
  matched: string[];
}

/** Lower case, Turkish i folded, diacritics removed: "Toplantı" → "toplanti". Same length as NFC input. */
export function foldIntent(text: string): string {
  return foldTr(text)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

interface Rule {
  kind: NewRecordKind;
  /** Words that decide the type. */
  re: RegExp;
  /**
   * Words dropped from the title; default: the words `re` matched. Issue and form words that
   * describe the matter ("çatlak", "denetim") stay in the title, only "sorun" / "form" go.
   */
  strip?: RegExp;
}

/**
 * Checked in this order; the first matching rule wins. Specific phrases come before general
 * words ("gönderim formu" before "form", "gelen yazı" before "yazı").
 */
const RULES: Rule[] = [
  { kind: "gelen-yazi", re: /\bgelen (yazi|evrak|mektup)\w*/ },
  { kind: "gelen-yazi", re: /\byazi\w* (geldi|gelmis|alindi)\b/ },
  { kind: "transmittal", re: /\b(gonderim formu\w*|transmittal\w*)/ },
  { kind: "submittal", re: /\b(teknik onay\w*|submittal\w*|malzeme onay\w*|numune onay\w*)/ },
  { kind: "rfi", re: /\b(bilgi tale[pb]\w*|rfi\b|bt\b)/ },
  { kind: "meeting", re: /\b(toplanti\w*|tutanag\w*|tutanak\w*)/ },
  { kind: "action", re: /\b(eylem\w*|aksiyon\w*|yapilacak\w*)/ },
  { kind: "review", re: /\b(inceleme\w*|onaya (gonder|sun)\w*|review\w*)/ },
  { kind: "param-change", re: /\b(parametre degis\w*|parametre\w* degistir\w*|degisiklik talebi\w*)/ },
  { kind: "issue", re: /\b(sorun\w*|uygunsuzluk\w*|kusur\w*|ariza\w*|hasar\w*|catlak\w*|problem\w*|hata\w*)/, strip: /\bsorun\w*/g },
  { kind: "form", re: /\b(form\w*|kontrol listesi\w*|denetim\w*|santiye raporu\w*|gunluk rapor\w*)/, strip: /\bform\w*/g },
  // "yüklenici" (contractor) is not an upload.
  { kind: "upload", re: /\b(yukle(?!nici)\w*|dosya ekle\w*|dokuman ekle\w*)/ },
  { kind: "giden-yazi", re: /\b(giden yazi\w*|resmi yazi\w*|yazi\w*|ust yazi\w*)/ },
];

/** Verbs and fillers dropped from the title (folded). */
const FILLERS = new Set([
  "ac",
  "acalim",
  "acin",
  "olustur",
  "olusturalim",
  "kaydet",
  "kaydedelim",
  "al",
  "kayda",
  "yaz",
  "yazalim",
  "gonder",
  "gonderelim",
  "baslat",
  "ekle",
  "doldur",
  "hazirla",
  "yap",
  "lutfen",
  "yeni",
  "bir",
]);

/** Words that may not open or close a title (folded). */
const CONNECTORS = new Set(["icin", "hakkinda", "ile", "ve", "olarak", "uzerine", "konusunda", "ilgili", "-", ":", ","]);

/** Company name words that do not identify a company (folded). */
const GENERIC_NAME_WORDS = new Set([
  "insaat",
  "muhendislik",
  "teknoloji",
  "teknolojileri",
  "ve",
  "ltd",
  "sti",
  "as",
  "a.s.",
  "san",
  "tic",
  "sanayi",
  "ticaret",
  "international",
  "group",
  "grup",
  "yapi",
  "proje",
  "musavirlik",
  "danismanlik",
  "holding",
  "mimarlik",
  "taahhut",
  "limited",
  "sirketi",
  "anonim",
]);

/** Case suffixes after a proper noun ("Prota'ya", "CNS'den"). */
const FROM_SUFFIXES = ["dan", "den", "tan", "ten"];
const TO_SUFFIXES = ["ya", "ye", "a", "e", "na", "ne"];
const OTHER_SUFFIXES = ["nin", "nun", "in", "un", "yi", "yu", "i", "u", "la", "le", "yla", "yle", "da", "de", "ta", "te"];

interface Token {
  start: number;
  end: number;
  raw: string;
  /** Folded, without surrounding punctuation. */
  word: string;
}

function tokenize(text: string, folded: string): Token[] {
  const out: Token[] = [];
  for (const m of text.matchAll(/\S+/g)) {
    const start = m.index!;
    const end = start + m[0].length;
    const word = folded.slice(start, end).replace(/^[^\p{L}\p{N}'’]+|[^\p{L}\p{N}]+$/gu, "");
    out.push({ start, end, raw: m[0], word });
  }
  return out;
}

/** Company keys: the short code and the identifying words of the name. */
function companyKeys(c: IntentCompany): string[] {
  const keys = foldIntent(c.name)
    .split(/[\s.,()/&-]+/)
    .filter((w) => w.length >= 3 && !GENERIC_NAME_WORDS.has(w));
  const code = c.code ? foldIntent(c.code) : "";
  if (code.length >= 2) keys.unshift(code);
  return [...new Set(keys)];
}

/** "prota'ya" / "protaya" against the key "prota": the suffix, or null when the word is another word. */
function suffixOf(word: string, key: string): string | null {
  const [base, ...rest] = word.split(/['’]/);
  if (rest.length) return base === key ? rest.join("") : null;
  if (word === key) return "";
  if (!word.startsWith(key) || key.length < 4) return null;
  const suffix = word.slice(key.length);
  return [...FROM_SUFFIXES, ...TO_SUFFIXES, ...OTHER_SUFFIXES].includes(suffix) ? suffix : null;
}

function upperFirstTr(s: string): string {
  return s ? s.charAt(0).toLocaleUpperCase("tr-TR") + s.slice(1) : s;
}

export function guessNewRecord(text: string, companies: readonly IntentCompany[] = []): NewRecordGuess {
  const src = text.normalize("NFC").replace(/\s+/g, " ").trim();
  const folded = foldIntent(src);
  const tokens = tokenize(src, folded);
  const drop = new Set<number>();
  const matched: string[] = [];

  let kind: NewRecordKind | null = null;
  for (const r of RULES) {
    const m = r.re.exec(folded);
    if (!m) continue;
    kind = r.kind;
    const from = m.index;
    const to = from + m[0].length;
    const strip = r.strip ? [...folded.matchAll(r.strip)].map((x): [number, number] => [x.index, x.index + x[0].length]) : [[from, to] as [number, number]];
    tokens.forEach((t, i) => {
      if (t.start < to && t.end > from) matched.push(t.raw.replace(/[^\p{L}\p{N}'’ ]+$/gu, ""));
      if (strip.some(([a, b]) => t.start < b && t.end > a)) drop.add(i);
    });
    break;
  }

  // Company: the first word in the sentence that names a known company.
  let companyId: string | null = null;
  let suffix: string | null = null;
  const keyed = companies.map((c) => ({ c, keys: companyKeys(c) }));
  for (let i = 0; i < tokens.length && !companyId; i++) {
    for (const { c, keys } of keyed) {
      const s = keys.map((k) => suffixOf(tokens[i]!.word, k)).find((x) => x !== null);
      if (s === undefined) continue;
      companyId = c.id;
      suffix = s;
      drop.add(i);
      break;
    }
  }
  let companyRole: NewRecordGuess["companyRole"] = null;
  if (companyId) {
    if (suffix && FROM_SUFFIXES.includes(suffix)) companyRole = "from";
    else if (suffix && TO_SUFFIXES.includes(suffix)) companyRole = "to";
    else companyRole = kind === "gelen-yazi" ? "from" : "to";
  }

  tokens.forEach((t, i) => {
    if (FILLERS.has(t.word)) drop.add(i);
  });
  let rest = tokens.filter((_, i) => !drop.has(i));
  while (rest.length && (CONNECTORS.has(rest[0]!.word) || !rest[0]!.word)) rest = rest.slice(1);
  while (rest.length && (CONNECTORS.has(rest[rest.length - 1]!.word) || !rest[rest.length - 1]!.word)) rest = rest.slice(0, -1);
  const title = upperFirstTr(
    rest
      .map((t) => t.raw)
      .join(" ")
      .replace(/^[\s:;,.–-]+|[\s:;,–-]+$/g, ""),
  );

  return { kind, title, companyId, companyRole, matched };
}

/** Name words that do not tell one template from another (folded). */
const GENERIC_TEMPLATE_WORDS = new Set(["form", "formu", "formlari", "onay", "kontrol", "listesi", "raporu", "rapor", "tutanagi", "tutanak", "kayit", "kaydi"]);

/**
 * The item whose name the sentence mentions best ("beton döküm formu doldur" → "Beton Döküm Onay
 * Formu"), by its short code or by the distinctive words of its name. Null when nothing or more
 * than one item matches equally well.
 */
export function matchByName<T extends { id: string; name: string; code?: string | null }>(text: string, items: readonly T[]): T | null {
  const tokens = foldIntent(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  if (!tokens.length) return null;
  let best: T | null = null;
  let bestScore = 0;
  let tie = false;
  for (const item of items) {
    const code = item.code ? foldIntent(item.code) : "";
    let score = code.length >= 2 && tokens.includes(code) ? 10 : 0;
    for (const w of foldIntent(item.name).split(/[^\p{L}\p{N}]+/u)) {
      if (w.length < 3 || GENERIC_TEMPLATE_WORDS.has(w)) continue;
      if (tokens.some((t) => t.startsWith(w) || (w.length >= 5 && t.length >= 5 && w.startsWith(t)))) score++;
    }
    if (score > bestScore) {
      best = item;
      bestScore = score;
      tie = false;
    } else if (score && score === bestScore) tie = true;
  }
  return bestScore > 0 && !tie ? best : null;
}
