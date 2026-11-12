// i18n-ok-file: prompt for the language model (difference description, Turkish summary rules)
/**
 * "Değişiklik özeti": the language model gets ONLY a compact description of the differences
 * (text changes, title-block changes, change-region counts per page, checks), never the documents.
 * The answer is a short Turkish bullet list; bullets name their page as [s.N] so the UI can link.
 */
import type { DocCompareFlag, DocCompareResult, NBox, PageRegions, SummaryBullet, TextChange } from "@sitekeep/shared";
import { stripThinking, type AiProvider } from "../ai/provider.js";
import { DEFAULT_LANGUAGE, msg, render, tFor } from "../i18n/index.js";
import { changeText } from "./text-diff.js";

/**
 * Language of the texts given to the model (checks, change descriptions): the prompt is written in
 * Turkish and asks for a Turkish summary, so its inputs stay Turkish whatever the reader's language.
 */
export const PROMPT_LANGUAGE = "tr";

/** Upper bound of the prompt's difference part (characters). */
const MAX_INPUT = 7000;
const MAX_BULLETS = 10;

export const SYSTEM_PROMPT =
  "Sen bir inşaat projesinde doküman kontrol uzmanısın. Bir paftanın/dokümanın iki versiyonu arasındaki farkların " +
  "özetini alacaksın (tam doküman değil). Türkçe, kısa madde işaretli bir değişiklik özeti yaz: en önemli değişiklikler önce, " +
  "her madde tek cümle, en fazla 8 madde. Sayfayı biliyorsan maddenin başına [s.N] yaz. Ölçü, kot, malzeme, adet, not ve " +
  "revizyon değişikliklerini somut değerlerle yaz (örn. \"kolon S12 40x60 → 50x60\"). Gerekirse etkisini kısaca ekle " +
  "(örn. \"statik kontrol gerekir\"); her maddeye \"önemli\" yazma. Uyarı yoksa uyarı maddesi yazma. " +
  "Girdide \"Uyarı:\" ile başlayan bir kontrol satırı varsa onu [!] ile başlayan ayrı bir madde olarak yaz; " +
  "\"Uyarı:\" satırı yoksa [!] kullanma ve revizyonun ya da tablonun güncellenmediğini söyleme. " +
  "Satırların başındaki [s.N] sayfa bilgisini aynen kullan, sayfa uydurma. Antet satırları (antet) ile işaretlidir. " +
  "Verilmeyen bilgiyi uydurma. Yalnızca maddeleri yaz, giriş veya kapanış cümlesi yazma.";

export interface PromptInput {
  fileA: string;
  fileB: string;
  versionA: number;
  versionB: number;
  result: DocCompareResult;
  regions: PageRegions[] | null;
  flags: DocCompareFlag[];
}

/** The difference description sent to the model. */
export function buildPrompt(p: PromptInput): string {
  const r = p.result;
  const lines: string[] = [];
  const same = p.fileA === p.fileB;
  lines.push(
    same
      ? `Dosya: ${p.fileB}, V${p.versionA} → V${p.versionB}`
      : `Eski: ${p.fileA} (V${p.versionA}); yeni: ${p.fileB} (V${p.versionB})`,
  );
  if (r.revisionA || r.revisionB) lines.push(`Revizyon: ${r.revisionA ?? "?"} → ${r.revisionB ?? "?"}`);
  if (r.pageCountA !== r.pageCountB) lines.push(`Sayfa sayısı: ${r.pageCountA} → ${r.pageCountB}`);
  if (r.note) lines.push(`Not: ${r.note}`);
  if (r.antet.length) {
    lines.push("Antet değişiklikleri (sayfa 1):");
    for (const c of r.antet.slice(0, 15))
      lines.push(c.label.startsWith("Revizyon tablosu") ? `[s.1] Revizyon tablosunun son satırı: ${c.new ?? "—"} (önce ${c.old ?? "—"})` : `[s.1] ${c.label}: ${c.old ?? "—"} → ${c.new ?? "—"}`);
  }
  if (p.flags.length) {
    lines.push("Kontroller:");
    for (const f of p.flags) lines.push(`${f.severity === "warn" ? "Uyarı" : "Bilgi"}: ${f.message}`);
  }
  if (r.kind === "pdf" && r.revisionA && r.revisionB && r.revisionA !== r.revisionB && !p.flags.some((f) => f.severity === "warn" && f.code.startsWith("revision")))
    lines.push("Revizyon kontrolü: revizyon yükselmiş, tablo ve içerik tutarlı; sorun yok.");
  const regionCount = new Map((p.regions ?? []).map((x) => [x.page, x]));
  if (r.sheets) {
    for (const s of r.sheets.filter((x) => x.status !== "same")) {
      lines.push(`Çalışma sayfası "${s.name}" (${s.status === "changed" ? `${s.changed} değişen, ${s.added} eklenen, ${s.removed} silinen satır` : s.status === "added" ? "yeni" : "silinmiş"}):`);
      for (const row of s.rows.slice(0, 25)) {
        if (row.kind === "changed")
          lines.push(`~ satır ${row.rowB}: ${(row.cells ?? []).map((c) => `${c.col}: "${c.old}" → "${c.new}"`).join(", ")}`);
        else lines.push(`${row.kind === "added" ? "+" : "-"} satır ${row.rowB ?? row.rowA}: ${row.text}`);
      }
    }
  }
  const pages = new Set<number>([...r.pages.map((x) => x.page), ...regionCount.keys()]);
  for (const n of [...pages].sort((a, b) => a - b)) {
    const pg = r.pages.find((x) => x.page === n);
    const reg = regionCount.get(n);
    const head: string[] = [];
    if (pg) head.push(`${pg.changed} değişen, ${pg.added} eklenen, ${pg.removed} silinen metin`);
    if (reg?.only) head.push(reg.only === "B" ? "yeni sayfa" : "silinmiş sayfa");
    else if (reg) head.push(`${reg.regions.length} görsel değişiklik bölgesi`);
    lines.push(`Sayfa ${n} (${head.join("; ")}):`);
    const tag = r.kind === "pdf" ? `[s.${n}] ` : "";
    for (const c of (pg?.changes ?? []).slice(0, 30)) lines.push(`${tag}${c.kind === "changed" ? "~" : c.kind === "added" ? "+" : "-"} ${changeText(c, tFor(PROMPT_LANGUAGE))}${c.antet ? " (antet)" : ""}`);
  }
  if (!r.pages.length && !r.sheets?.length && !(p.regions ?? []).length) lines.push("Metinde fark yok.");
  let text = lines.join("\n");
  if (text.length > MAX_INPUT) text = `${text.slice(0, MAX_INPUT)}\n… (kısaltıldı)`;
  return text;
}

/** Parses "- [s.2] …" bullets (or a JSON {bullets:[…]} answer) into summary bullets. */
export function parseBullets(raw: string, pageCount: number): SummaryBullet[] {
  const text = stripThinking(raw).trim();
  const fromJson = tryJson(text);
  const items = fromJson ?? text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const out: SummaryBullet[] = [];
  for (const item of items) {
    let t = item.replace(/^(?:[-*•–]|\d+[.)])\s*/, "").replace(/\*\*/g, "").trim();
    if (!t || /^(özet|değişiklik özeti)\s*:?$/i.test(t)) continue;
    let severity: SummaryBullet["severity"];
    if (/^\[!\]\s*/.test(t)) {
      severity = "warn";
      t = t.replace(/^\[!\]\s*/, "");
    }
    let page: number | undefined;
    const m = /^\[(?:s\.?|sayfa|sf\.?|p\.?)\s*(\d+)\]\s*/i.exec(t) ?? /\((?:s\.|sayfa)\s*(\d+)\)/i.exec(t);
    if (m) {
      const n = Number(m[1]);
      if (n >= 1 && n <= Math.max(1, pageCount)) page = n;
      t = t.replace(m[0], m.index === 0 ? "" : " ").replace(/\s+/g, " ").trim();
    }
    if (/^\[!\]\s*/.test(t)) {
      severity = "warn";
      t = t.replace(/^\[!\]\s*/, "");
    }
    if (!t) continue;
    out.push({ text: t.slice(0, 400), ...(page !== undefined && { page }), ...(severity && { severity }) });
    if (out.length >= MAX_BULLETS) break;
  }
  return out;
}

function tryJson(text: string): string[] | null {
  const start = text.indexOf("{");
  if (start < 0 || !/"(bullets|maddeler|items)"/.test(text)) return null;
  try {
    const data = JSON.parse(text.slice(start, text.lastIndexOf("}") + 1)) as Record<string, unknown>;
    const list = (data.bullets ?? data.maddeler ?? data.items) as unknown;
    if (!Array.isArray(list)) return null;
    return list.map((x) =>
      typeof x === "string" ? x : typeof x === "object" && x ? `${(x as { page?: number }).page ? `[s.${(x as { page: number }).page}] ` : ""}${String((x as { text?: string }).text ?? "")}` : "",
    );
  } catch {
    return null;
  }
}

/** Runs the model; `onText` receives the answer so far (for progress). */
export async function summarize(
  provider: AiProvider,
  input: PromptInput,
  opts: { onText?: (t: string) => void; signal?: AbortSignal } = {},
): Promise<SummaryBullet[]> {
  const res = await provider.chat(
    [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: `Farklar:\n${buildPrompt(input)}\n\nDeğişiklik özetini yaz.` },
    ],
    { maxTokens: 900, timeoutMs: 300_000, onText: opts.onText, signal: opts.signal },
  );
  const bullets = parseBullets(res.text, Math.max(input.result.pageCountA, input.result.pageCountB));
  if (!bullets.length) throw new Error(render(DEFAULT_LANGUAGE, msg("doccompare:ai.emptySummary")));
  return bullets;
}

/**
 * Links bullets to the page / change region they talk about: a bullet that quotes a changed text
 * gets that text's page, and the region overlapping its box.
 */
export function linkBullets(bullets: SummaryBullet[], result: DocCompareResult, regions: PageRegions[] | null): SummaryBullet[] {
  const fold = (s: string) => s.toLocaleLowerCase("tr-TR").replace(/\s+/g, " ").trim();
  const overlaps = (a: NBox, b: NBox, pad = 0.01) => a.x0 - pad < b.x1 && b.x0 - pad < a.x1 && a.y0 - pad < b.y1 && b.y0 - pad < a.y1;
  return bullets.map((b) => {
    const text = fold(b.text);
    let page = b.page;
    let box: NBox | undefined;
    const quoted = (c: TextChange) =>
      [c.new, c.old].some((t) => {
        const f = t ? fold(t) : "";
        return f.length >= 3 && text.includes(f);
      });
    // The bullet's own page first; a quote found only on another page corrects the page.
    for (const restrict of page !== undefined ? [true, false] : [false]) {
      for (const pg of result.pages) {
        if (restrict && pg.page !== page) continue;
        const hit = pg.changes.find(quoted);
        if (hit) {
          page = hit.pageB ?? hit.pageA ?? pg.page;
          box = hit.boxB ?? hit.boxA;
          break;
        }
      }
      if (box) break;
    }
    if (page === undefined) return b;
    const list = regions?.find((r) => r.page === page)?.regions ?? [];
    const idx = box ? list.findIndex((r) => overlaps(r.box, box!)) : -1;
    return { ...b, page, ...(idx >= 0 ? { region: idx } : {}) };
  });
}
