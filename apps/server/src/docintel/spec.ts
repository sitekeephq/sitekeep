/**
 * Specification → draft submittal register (Şartnameden submittal).
 *
 * Deterministic: the text layer is read in reading order, numbered headings split it into
 * sections ("03 30 00 Yerinde Dökme Beton", "Bölüm 5.2", "MADDE 12", "5.2.1 Beton İşleri"),
 * sentences with submittal triggers ("onaya sunulacaktır", "numune", "teknik föy", "shop
 * drawing" …) become register items, typed by keyword rules and given a discipline from the
 * section. The language model (optional) only classifies items the rules could not type and
 * shortens long excerpts.
 */
import {
  SUBMITTAL_TYPE_CODES,
  type SubmittalDisciplineCode,
  type SubmittalRegisterItem,
  type SubmittalTypeCode,
} from "@sitekeep/shared";
import { DEFAULT_LANGUAGE, tFor, type MsgKey } from "../i18n/index.js";
import { extractJson } from "../reports/llm.js";
import { pdfErrorText } from "./extract.js";
import type { WorkerOutput } from "./pdf-worker.js";
import type { ChatProvider } from "./suggest.js";
import { buildLines, fold, shorten } from "./text.js";

interface Heading {
  code: string;
  title: string;
  /** Body text after the heading on the same line. */
  rest?: string;
}

const UPPER = "A-ZÇĞİÖŞÜ"; // i18n-ok: character class for Turkish headings

/** Recognises a section heading line. */
export function readHeading(line: string): Heading | null {
  const t = line.replace(/\s+/g, " ").trim();
  if (t.length < 3) return null;
  // "MADDE 12 – Malzeme onayı. Yüklenici …": the text after the first full stop is body text.
  let m = /^(BÖLÜM|Bölüm|BOLUM|KISIM|Kısım|MADDE|Madde)\s+(\d+(?:\.\d+)*|[IVXL]+)\s*[-–—:.)]?\s*(.*)$/.exec(t); // i18n-ok: Turkish heading words matched in the document
  if (m) {
    const word = fold(m[1]!).replace("bolum", "Bölüm").replace("kisim", "Kısım").replace("madde", "Madde"); // i18n-ok: Turkish heading words
    let title = m[3]!.trim();
    let rest: string | undefined;
    const stop = title.search(/[.:]\s/);
    if (stop > 0) {
      rest = title.slice(stop + 1).trim();
      title = title.slice(0, stop);
    }
    if (title.length > 90) return null;
    return { code: `${word} ${m[2]}`, title: title.replace(/[.:]$/, "").trim(), rest };
  }
  if (t.length > 140) return null;
  m = /^(\d{2} \d{2} \d{2}(?:\.\d{1,2})?)\s*[-–—:]?\s*(.{3,100})$/.exec(t);
  if (m && !/[.;]$/.test(m[2]!)) return { code: m[1]!, title: m[2]!.trim() };
  m = /^(SECTION|Section)\s+(\d{2} ?\d{2} ?\d{2}(?:\.\d{1,2})?)\s*[-–—:]?\s*(.*)$/.exec(t);
  if (m) return { code: m[2]!, title: m[3]!.trim() };
  m = new RegExp(`^(\\d{1,2}(?:\\.\\d{1,2}){1,3})\\.?\\s+([${UPPER}][^.;:]{2,80})$`).exec(t);
  if (m && words(m[2]!) <= 10) return { code: m[1]!, title: m[2]!.trim() };
  m = new RegExp(`^(\\d{1,2})[.)]\\s+([${UPPER}][${UPPER}0-9 ,/&()-]{2,70})$`).exec(t);
  if (m) return { code: m[1]!, title: m[2]!.trim() };
  return null;
}

function words(s: string): number {
  return s.split(/\s+/).filter(Boolean).length;
}

/** Submission verbs: the sentence asks for something to be submitted for approval. */
const SUBMIT = [
  "onaya sunul",
  "onayina sunul",
  "onaya verilecek",
  "onaylatil",
  "onayi alinacak",
  "onayi alinmadan",
  "onay alinacak",
  "idareye sunul",
  "idareye verilecek",
  "kontrol teskilatina sunul",
  "musavire sunul",
  "teslim edilecek",
  "sunulacaktir",
  "sunulmalidir",
  "ibraz edilecek",
  "sunacak",
  "verecek",
  "submit",
  "for approval",
  "submittal",
];

/** Type rules, most specific first. Each pattern is matched against the folded sentence. */
const TYPE_RULES: { type: SubmittalTypeCode; patterns: string[]; strong: boolean }[] = [
  { type: "UCZ", patterns: ["atolye cizim", "atolye resim", "imalat resim", "imalat cizim", "shop drawing", "uygulama cizim", "uygulama projesi", "detay cizim"], strong: true },
  { type: "NUM", patterns: ["numune", "sample", "mock-up", "mockup", "ornek uygulama", "maket"], strong: true },
  { type: "YB", patterns: ["yontem beyan", "method statement", "metodoloji", "uygulama yontemi", "montaj yontemi", "calisma yontemi"], strong: true },
  { type: "IP", patterns: ["is programi", "termin plani", "work programme", "schedule"], strong: false },
  { type: "ISG", patterns: ["is sagligi", "isg", "risk analizi", "risk degerlendirme", "acil durum plani", "guvenlik plani"], strong: true },
  { type: "PMR", patterns: ["periyodik muayene", "periyodik kontrol"], strong: true },
  { type: "IKOF", patterns: ["imalat kontrol", "imalata baslamadan once", "kontrol onay formu"], strong: false },
  { type: "MKF", patterns: ["malzeme kabul", "sahaya getirilen malzeme", "sahaya gelen malzeme"], strong: false },
  { type: "TR", patterns: ["hesap raporu", "statik hesap", "teknik rapor", "hesaplari", "analiz raporu", "calculation", "tasarim raporu"], strong: true },
  { type: "KS", patterns: ["test raporu", "deney raporu", "test sonuc", "sertifika", "kalite plani", "kalite belge", "uygunluk belgesi", "ce belgesi", "tse belgesi", "muayene raporu", "itp", "test certificate", "certificate"], strong: true },
  { type: "MOS", patterns: ["teknik foy", "katalog", "product data", "data sheet", "datasheet", "urun bilgi", "malzeme onay", "marka", "teknik dokuman", "teknik ozellik belgesi"], strong: true },
  { type: "BAS", patterns: ["bilgi amacli", "bilgi icin", "for information"], strong: false },
];

const DISCIPLINE_RULES: { code: SubmittalDisciplineCode; patterns: string[] }[] = [
  { code: "ELK", patterns: ["elektrik", "kuvvetli akim", "zayif akim", "kablo", "pano", "aydinlatma", "jenerator", "trafo", "ups", "topraklama", "paratoner", "elektronik", "scada", "electrical"] },
  { code: "MEK", patterns: ["mekanik", "hvac", "havalandirma", "klima", "isitma", "sogutma", "mekanik tesisat", "sihhi tesisat", "pompa", "yangin sondurme", "sprinkler", "sihhi", "plumbing", "kanal", "chiller"] },
  { code: "GEO", patterns: ["geoteknik", "zemin", "kazik", "ankraj", "iksa", "kazi", "dolgu", "earthwork"] },
  { code: "INS", patterns: ["beton", "donati", "celik", "kalip", "betonarme", "yapisal", "statik", "concrete", "steel", "structural", "prefabrik"] },
  { code: "MIM", patterns: ["mimari", "cephe", "dograma", "dosmeme", "kaplama", "boya", "alci", "seramik", "tavan", "kapi", "pencere", "cati", "yalitim", "su yalitim", "finishes"] },
  { code: "ALT", patterns: ["altyapi", "yol", "asfalt", "drenaj", "kanalizasyon", "icme suyu", "atik su"] },
  { code: "PEY", patterns: ["peyzaj", "bitki", "sulama", "landscape"] },
];

/** MasterFormat division → discipline. */
function divisionDiscipline(code: string | null): SubmittalDisciplineCode | null {
  const m = code ? /^(\d{2}) \d{2} \d{2}/.exec(code) : null;
  if (!m) return null;
  const d = Number(m[1]);
  if (d === 1) return "GNL";
  if ([3, 5].includes(d)) return "INS";
  if ([4, 6, 7, 8, 9, 10, 11, 12, 13, 14].includes(d)) return "MIM";
  if ([21, 22, 23, 25].includes(d)) return "MEK";
  if ([26, 27, 28].includes(d)) return "ELK";
  if (d === 31) return "GEO";
  if (d === 32) return "PEY";
  if (d === 33) return "ALT";
  return null;
}

function classifyType(text: string): { type: SubmittalTypeCode | null; confidence: number; keywords: string[]; strong: boolean } {
  const hits: { type: SubmittalTypeCode; kw: string; strong: boolean; index: number }[] = [];
  TYPE_RULES.forEach((r, index) => {
    for (const p of r.patterns) if (hasPhrase(text, p)) hits.push({ type: r.type, kw: p, strong: r.strong, index });
  });
  if (!hits.length) return { type: null, confidence: 0, keywords: [], strong: false };
  const types = [...new Set(hits.map((h) => h.type))];
  const first = hits.sort((a, b) => a.index - b.index)[0]!;
  return {
    type: first.type,
    confidence: types.length > 1 ? 0.6 : 0.8,
    keywords: [...new Set(hits.map((h) => h.kw))],
    strong: hits.some((h) => h.strong),
  };
}

function hasPhrase(text: string, phrase: string): boolean {
  if (phrase.length <= 4) return new RegExp(`(^|[^a-z0-9])${phrase}($|[^a-z0-9])`).test(text);
  return text.includes(phrase);
}

function classifyDiscipline(...texts: (string | null)[]): SubmittalDisciplineCode | null {
  for (const t of texts) {
    if (!t) continue;
    const f = fold(t);
    for (const r of DISCIPLINE_RULES) if (r.patterns.some((p) => hasPhrase(f, p))) return r.code;
  }
  return null;
}

const DESC_LABEL: Record<SubmittalTypeCode, MsgKey> = {
  MOS: "docintel:register.types.mos",
  NUM: "docintel:register.types.num",
  UCZ: "docintel:register.types.ucz",
  YB: "docintel:register.types.yb",
  IP: "docintel:register.types.ip",
  ISG: "docintel:register.types.isg",
  TR: "docintel:register.types.tr",
  PMR: "docintel:register.types.pmr",
  KS: "docintel:register.types.ks",
  IKOF: "docintel:register.types.ikof",
  BAS: "docintel:register.types.bas",
  MKF: "docintel:register.types.mkf",
};

type T = ReturnType<typeof tFor>;

interface Sentence {
  text: string;
  page: number;
  section: Heading | null;
}

/** Splits the document into sentences, each with its page and current section. */
export function sentences(out: WorkerOutput): { list: Sentence[]; sections: number } {
  const list: Sentence[] = [];
  let section: Heading | null = null;
  let sections = 0;
  let buf = "";
  let bufPage = 1;
  const add = (text: string) => {
    // Words hyphenated across lines are joined.
    if (buf.endsWith("-") && /^[a-zçğıöşü]/.test(text)) buf = buf.slice(0, -1) + text;
    else buf += (buf ? " " : "") + text;
  };
  const flush = () => {
    const text = buf.replace(/\s+/g, " ").trim();
    buf = "";
    if (!text) return;
    for (const s of text.split(/(?<=[.;!?])\s+(?=[A-ZÇĞİÖŞÜ0-9(•\-–])/)) {
      const t = s.trim();
      if (t.length >= 12) list.push({ text: t, page: bufPage, section });
    }
  };
  for (const page of out.pages) {
    const lines = buildLines(page);
    // Running headers/footers (top and bottom 5 %) are ignored.
    const body = lines.filter((l) => (l.y > page.height * 0.05 && l.y < page.height * 0.95) || lines.length < 5);
    for (const line of body) {
      const text = line.segments.map((s) => s.text).join(" ").trim();
      if (!text || /^(sayfa|page)?\s*\d+\s*(\/|of|-)?\s*\d*$/i.test(text)) continue;
      const h = readHeading(text);
      if (h) {
        flush();
        section = { code: h.code, title: h.title };
        sections++;
        bufPage = page.n;
        if (h.rest) add(h.rest);
        continue;
      }
      // A bullet or lettered item starts a new sentence.
      if (/^([•\-–*]|[a-zçğıöşü]\)|\(\w\))\s/.test(text)) flush();
      if (!buf) bufPage = page.n;
      add(text);
    }
  }
  flush();
  return { list, sections };
}

/** Draft register (deterministic). */
export function buildRegister(out: WorkerOutput, lang: string = DEFAULT_LANGUAGE): { items: SubmittalRegisterItem[]; sectionCount: number } {
  const t = tFor(lang);
  const { list, sections } = sentences(out);
  const items: SubmittalRegisterItem[] = [];
  const seen = new Set<string>();
  for (const s of list) {
    const f = fold(s.text);
    const submit = SUBMIT.filter((p) => hasPhrase(f, p));
    const cls = classifyType(f);
    // A trigger noun alone counts only when it is a strong one; a verb alone gives an untyped item.
    if (!submit.length && !(cls.type && cls.strong)) continue;
    if (!submit.length && !cls.type) continue;
    if (submit.length && !cls.type && !/(onay|submit|sunul)/.test(f)) continue;
    const key = `${s.section?.code ?? ""}|${cls.type ?? ""}|${f.slice(0, 80)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const confidence = cls.type ? (submit.length ? Math.min(0.9, cls.confidence + 0.1) : cls.confidence - 0.15) : 0.3;
    const discipline = divisionDiscipline(s.section?.code ?? null) ?? classifyDiscipline(s.section?.title ?? null, s.text) ?? null;
    items.push({
      id: "",
      sectionCode: s.section?.code ?? null,
      sectionTitle: s.section?.title ?? null,
      page: s.page,
      description: describe(t, cls.type, s.section?.title ?? null),
      excerpt: shorten(s.text, 300),
      type: cls.type,
      typeConfidence: Math.round(confidence * 100) / 100,
      discipline,
      keywords: [...submit, ...cls.keywords].slice(0, 6),
    });
  }
  items.forEach((it, i) => (it.id = `S${String(i + 1).padStart(3, "0")}`));
  return { items, sectionCount: sections };
}

function describe(t: T, type: SubmittalTypeCode | null, sectionTitle: string | null): string {
  const label = type ? t(DESC_LABEL[type]) : t("docintel:register.types.untyped");
  return sectionTitle ? `${label} – ${shorten(sectionTitle, 80)}` : label;
}

/**
 * Classifies untyped items and shortens long excerpts with the language model. Answers outside
 * the type list are ignored item by item; the deterministic register is kept otherwise.
 */
export async function refineRegisterWithAi(
  provider: ChatProvider,
  items: SubmittalRegisterItem[],
  opts: { timeoutMs?: number; maxItems?: number; lang?: string } = {},
): Promise<{ items: SubmittalRegisterItem[]; changed: number; note?: string }> {
  const t = tFor(opts.lang ?? DEFAULT_LANGUAGE);
  const open = items.filter((i) => !i.type || i.typeConfidence < 0.6).slice(0, opts.maxItems ?? 15);
  if (!open.length) return { items, changed: 0, note: t("docintel:register.noAmbiguousItems") };
  const payload = {
    tipler: SUBMITTAL_TYPE_CODES,
    kalemler: open.map((i) => ({ id: i.id, bolum: i.sectionTitle?.slice(0, 60) ?? null, metin: i.excerpt.slice(0, 280) })),
  };
  let answer: Record<string, unknown>;
  try {
    const res = await provider.chat(
      [
        {
          role: "system",
          content:
            "Şartname cümlelerini teknik onay tiplerine ayırıyorsun: MOS malzeme onayı/teknik föy, NUM numune, UCZ atölye çizimi, YB yöntem beyanı, IP iş programı, ISG iş güvenliği, TR teknik rapor/hesap, PMR periyodik muayene, KS test/sertifika/kalite, IKOF imalat kontrol formu, BAS bilgi amaçlı, MKF saha malzeme kabulü. Yalnız JSON döndür: {\"<id>\": {\"tip\": \"<kod>\"|null, \"ozet\": \"<en çok 12 kelime>\"}}.", // i18n-ok: prompt for the language model
        },
        { role: "user", content: JSON.stringify(payload) },
      ],
      { maxTokens: 60 * open.length + 50, timeoutMs: opts.timeoutMs ?? 300_000 },
    );
    answer = extractJson(res.text) as Record<string, unknown>;
  } catch (e) {
    return { items, changed: 0, note: t("docintel:ai.unreadable", { error: pdfErrorText(e, opts.lang) }) };
  }
  let changed = 0;
  const next = items.map((it) => {
    const a = answer[it.id] as { tip?: unknown; ozet?: unknown } | undefined;
    if (!a || !open.includes(it)) return it;
    const tip = typeof a.tip === "string" ? a.tip.trim().toUpperCase() : null;
    const valid = tip && (SUBMITTAL_TYPE_CODES as readonly string[]).includes(tip) ? (tip as SubmittalTypeCode) : null;
    const ozet = typeof a.ozet === "string" ? a.ozet.trim().slice(0, 160) : "";
    if (!valid && !ozet) return it;
    changed++;
    return {
      ...it,
      type: valid ?? it.type,
      typeConfidence: valid ? 0.65 : it.typeConfidence,
      description: ozet || (valid ? describe(t, valid, it.sectionTitle) : it.description),
      aiAssisted: true,
    };
  });
  return { items: next, changed };
}
