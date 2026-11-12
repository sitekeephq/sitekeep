/**
 * "Günün Özeti" without side effects (docs/product/SIMPLIFICATION.md, 2. aşama):
 *
 *   compactInput   the ONLY thing a model sees: counts plus at most 15 short lines (number, title,
 *                  type, due, why it is here, who waits) taken from the Bugün data. Never documents.
 *   autoSummary    the deterministic summary: templated sentences (today.json) in the reader's language
 *   parseAiSummary the model's bullets after the invented-number guard (as in model/ai.ts): a bullet
 *                  naming a record number or a count that is not in the input is dropped
 */
import { createHash } from "node:crypto";
import {
  TODAY_MINE_GROUPS,
  TODAY_SUMMARY_MAX_BULLETS,
  TODAY_SUMMARY_MAX_LINES,
  type ProjectTodayDto,
  type TodayMineGroup,
  type TodayRowDto,
  type TodaySummaryBullet,
} from "@sitekeep/shared";
import { stripThinking } from "../ai/provider.js";
import { DEFAULT_LANGUAGE, intlLocale, msg, tFor, type MsgKey } from "../i18n/index.js";

/** The Bugün data a summary is made from (the endpoint's DTO without the summary itself). */
export type TodayData = Omit<ProjectTodayDto, "summary">;

/** Lines of recent changes in the input (inside TODAY_SUMMARY_MAX_LINES). */
const CHANGE_LINES = 3;

/** Group names inside the model's input ("onay adımı 2"); model-facing, Turkish. */
const GROUP_WORDS: Record<TodayMineGroup, string> = {
  tasks: "onay adımı", // i18n-ok: model input
  works: "bana atanan iş", // i18n-ok: model input
  actions: "eylem",
  replies: "cevap beklenen yazı", // i18n-ok: model input
  receipts: "alındı onayı bekleyen yazı", // i18n-ok: model input
  forms: "doldurulacak form",
  issues: "bana atanan sorun",
};

/** Group counts inside the deterministic summary's sentences ("2 onay adımı"). */
const GROUP_KEYS: Record<TodayMineGroup, MsgKey> = {
  tasks: "today:groups.tasks",
  works: "today:groups.works",
  actions: "today:groups.actions",
  replies: "today:groups.replies",
  receipts: "today:groups.receipts",
  forms: "today:groups.forms",
  issues: "today:groups.issues",
};

/**
 * Record numbers in a text: "ZAVM-RFI-0003", "TPL-014", "#12" (upper-case code with at least one
 * hyphen, or # and digits). Dates ("2026-10-11") are not record numbers.
 */
export function recordNumbers(text: string): string[] {
  return [...text.matchAll(/(?<![\p{L}\p{N}#-])(?:#\d+|\p{Lu}[\p{Lu}\p{N}]*(?:-[\p{Lu}\p{N}]+)+)(?![\p{L}\p{N}-])/gu)].map((m) => m[0]);
}

export function trDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
}

function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(`${toIso}T12:00:00Z`) - Date.parse(`${fromIso}T12:00:00Z`)) / 86_400_000);
}

/** "09" and "9" are the same number ("09.10.2026" → "9 Ekim"). */
const intKey = (n: string) => n.replace(/^0+(?=\d)/, "");

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export interface CompactInput {
  /** The prompt's user message; its hash is the summary stamp. */
  text: string;
  /** Record numbers in the input (the guard accepts only these). */
  known: Set<string>;
  /** Integers in the input (counts, days, dates). */
  integers: Set<string>;
  /** Record number → link. */
  links: Map<string, string>;
}

function allRows(d: TodayData): TodayRowDto[] {
  return [...TODAY_MINE_GROUPS.flatMap((g) => d.mine[g]), ...d.overdue, ...d.upcoming];
}

/** Model input (Turkish on purpose). */
function dueText(r: TodayRowDto, today: string): string {
  if (!r.dueDate) return "termin yok";
  const diff = daysBetween(today, r.dueDate);
  if (diff < 0) return `${trDate(r.dueDate)}, ${-diff} gün gecikti`; // i18n-ok: model input
  if (diff === 0) return "termini bugün"; // i18n-ok: model input
  return `${trDate(r.dueDate)}, ${diff} gün kaldı`; // i18n-ok: model input
}

/** Model input (Turkish on purpose). */
function dayWord(day: string, today: string): string {
  const diff = daysBetween(day, today);
  return diff === 0 ? "bugün" : diff === 1 ? "dün" : trDate(day); // i18n-ok: model input
}

/** A date of the deterministic summary in the reader's language ("13.10.2026", "13/10/2026"). */
function localDate(iso: string, lang: string): string {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString(intlLocale(lang), { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "UTC" });
}

/** The model's whole input: counts, then at most 15 lines. */
export function compactInput(d: TodayData, today: string): CompactInput {
  const groupCounts = TODAY_MINE_GROUPS.filter((g) => d.mine[g].length).map((g) => `${GROUP_WORDS[g]} ${d.mine[g].length}`);
  const dueToday = d.upcoming.filter((r) => r.dueDate === today).length;
  const head = [
    `Bugün: ${trDate(today)}`, // i18n-ok: model input
    `Sayılar: bana düşen ${d.counts.mine}${groupCounts.length ? ` (${groupCounts.join(", ")})` : ""}; geciken ${d.counts.overdue}; ` + // i18n-ok: model input
      `termini bugün olan ${dueToday}; ${d.upcomingDays} gün içinde termin ${d.counts.upcoming}; son ${d.changeDays} günde değişiklik ${d.counts.changes}`, // i18n-ok: model input
  ];

  // Most pressing first: my steps, letters waiting for me, overdue, due today, the rest of mine, upcoming.
  const order: { rows: TodayRowDto[]; why?: string }[] = [
    { rows: d.mine.tasks, why: "onayımı bekliyor" }, // i18n-ok: model input
    { rows: d.mine.replies },
    { rows: d.overdue },
    { rows: d.upcoming.filter((r) => r.dueDate === today) },
    { rows: d.mine.actions, why: "eylemim" },
    { rows: d.mine.works, why: "bana atandı" }, // i18n-ok: model input
    { rows: d.mine.issues, why: "bana atandı" }, // i18n-ok: model input
    { rows: d.mine.receipts },
    { rows: d.mine.forms, why: "doldurulacak" },
    { rows: d.upcoming },
  ];
  const changeLines: string[] = [];
  for (const day of d.changes) {
    for (const c of day.changes) {
      if (changeLines.length >= CHANGE_LINES) break;
      const items = c.items.slice(0, 2).map((i) => cut(i.label, 50));
      changeLines.push(`${dayWord(day.day, today)}: ${c.userName ?? "Sistem"} ${c.text}${items.length ? ` (${items.join(", ")})` : ""}`);
    }
  }
  const maxRecords = TODAY_SUMMARY_MAX_LINES - changeLines.length;
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const { rows, why } of order) {
    for (const r of rows) {
      if (lines.length >= maxRecords) break;
      if (seen.has(r.number)) continue;
      seen.add(r.number);
      const notes = [why, r.note, r.party ? `bekleyen: ${r.party}` : undefined].filter(Boolean);
      lines.push(`${r.number} | ${cut(r.title, 60)} | ${r.typeLabel} | ${dueText(r, today)}${notes.length ? ` | ${notes.join("; ")}` : ""}`);
    }
  }
  const text = [
    ...head,
    ...(lines.length ? ["Kayıtlar (numara | başlık | tip | termin | not):", ...lines] : ["Kayıt yok."]), // i18n-ok: model input
    ...(changeLines.length ? ["Son değişiklikler:", ...changeLines] : []), // i18n-ok: model input
  ].join("\n");

  const links = new Map<string, string>();
  for (const r of allRows(d)) if (!links.has(r.number)) links.set(r.number, r.link);
  for (const day of d.changes)
    for (const c of day.changes)
      for (const i of c.items) {
        const n = recordNumbers(i.label)[0];
        if (n && i.link && i.label.startsWith(n) && !links.has(n)) links.set(n, i.link);
      }
  return { text, known: new Set(recordNumbers(text)), integers: new Set((text.match(/\d+/g) ?? []).map(intKey)), links };
}

/** Stamp of the input: the AI summary is fresh while it is unchanged. */
export function inputStamp(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 20);
}

export function refsOf(text: string, links: Map<string, string>): TodaySummaryBullet["refs"] {
  const out: TodaySummaryBullet["refs"] = [];
  for (const n of recordNumbers(text)) {
    const link = links.get(n);
    if (link && !out.some((r) => r.number === n)) out.push({ number: n, link });
  }
  return out;
}

/** "A, B and 3 more". */
function numberList(rows: TodayRowDto[], t: ReturnType<typeof tFor>, n = 2): string {
  const shown = rows.slice(0, n).map((r) => r.number).join(", ");
  return rows.length > n ? t("today:summary.numberListMore", { shown, count: rows.length - n }) : shown;
}

/** The deterministic summary (3–6 bullets): always available, no AI; in the reader's language. */
export function autoSummary(d: TodayData, today: string, lang: string = DEFAULT_LANGUAGE): TodaySummaryBullet[] {
  const t = tFor(lang);
  const input = compactInput(d, today);
  const out: string[] = [];

  const groups = TODAY_MINE_GROUPS.filter((g) => d.mine[g].length).map((g) => t(GROUP_KEYS[g], { count: d.mine[g].length }));
  out.push(d.counts.mine ? t("today:summary.mine", { count: d.counts.mine, groups: groups.join(", ") }) : t("today:summary.mineNone"));

  const dueToday = d.upcoming.filter((r) => r.dueDate === today);
  if (dueToday.length) out.push(t("today:summary.dueToday", { count: dueToday.length, list: numberList(dueToday, t) }));

  if (d.overdue.length) {
    const oldest = d.overdue.find((r) => r.dueDate) ?? d.overdue[0]!;
    const days = oldest.dueDate ? daysBetween(oldest.dueDate, today) : 0;
    out.push(
      days > 0
        ? t("today:summary.overdueDays", { count: d.overdue.length, number: oldest.number, days: msg("today:summary.days", { count: days }) })
        : t("today:summary.overdue", { count: d.overdue.length, number: oldest.number }),
    );
  } else out.push(t("today:summary.noOverdue"));

  if (d.mine.replies.length) {
    const by = new Map<string, number>();
    for (const r of d.mine.replies) if (r.party) by.set(r.party, (by.get(r.party) ?? 0) + 1);
    const parts = [...by.entries()].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0], "tr")).map(([p, n]) => `${p} ${n}`);
    const list = numberList(d.mine.replies, t);
    out.push(
      parts.length
        ? t("today:summary.repliesBy", { count: d.mine.replies.length, parties: parts.join(", "), list })
        : t("today:summary.replies", { count: d.mine.replies.length, list }),
    );
  }

  const lastDay = d.changes[0];
  const last = lastDay?.changes[0];
  if (lastDay && last) {
    const diff = daysBetween(lastDay.day, today);
    const day = diff === 0 ? t("today:summary.today") : diff === 1 ? t("today:summary.yesterday") : localDate(lastDay.day, lang);
    const items = last.items.slice(0, 2).map((i) => i.label);
    const more = d.counts.changes > last.count ? ` ${t("today:summary.moreChanges", { days: d.changeDays, count: d.counts.changes })}` : "";
    const user = last.userName ?? t("today:summary.system");
    out.push(
      items.length
        ? t("today:summary.lastChangeItems", { day, user, action: last.text, items: items.join(", "), more })
        : t("today:summary.lastChange", { day, user, action: last.text, more }),
    );
  } else out.push(t("today:summary.noChanges", { days: d.changeDays }));

  // Later due dates come last: the first sentence dropped when there are too many.
  const later = d.upcoming.filter((r) => r.dueDate && r.dueDate > today);
  if (later.length)
    out.push(
      t("today:summary.later", { days: d.upcomingDays, count: later.length, number: later[0]!.number, date: localDate(later[0]!.dueDate!, lang) }),
    );

  // The most urgent: my oldest overdue line, else the oldest overdue, else due today, else my first step.
  const mineRows = TODAY_MINE_GROUPS.flatMap((g) => d.mine[g]);
  const urgent =
    mineRows.filter((r) => r.overdue && r.dueDate).sort((x, y) => x.dueDate!.localeCompare(y.dueDate!))[0] ??
    d.overdue[0] ??
    dueToday[0] ??
    d.mine.tasks[0];
  const bullets = out.slice(0, urgent ? TODAY_SUMMARY_MAX_BULLETS - 1 : TODAY_SUMMARY_MAX_BULLETS);
  if (urgent) bullets.push(t("today:summary.urgent", { number: urgent.number, title: urgent.title }));
  return bullets.map((text) => ({ text, refs: refsOf(text, input.links) }));
}

/** System prompt: tiny on purpose (the local model runs on CPU). Model-facing: Turkish. */
export const TODAY_SUMMARY_SYSTEM =
  "Bir inşaat projesinin doküman yönetim sisteminde kullanıcının bugünkü durumunu özetliyorsun. " + // i18n-ok: AI prompt
  "Verilen sayılar ve kayıt satırlarından 3-6 kısa Türkçe madde yaz; her madde '- ' ile başlasın ve tek cümle olsun. " + // i18n-ok: AI prompt
  "Önce bugün termini dolanları ve geciken işleri, sonra bekleyenleri ve son değişiklikleri yaz; son madde 'En acil: <numara> <konu>.' olsun. " + // i18n-ok: AI prompt
  "Kayıt numaralarını aynen yaz. Girdide olmayan numara, sayı, kişi veya firma uydurma. Giriş veya kapanış cümlesi yazma."; // i18n-ok: AI prompt

export interface ParsedSummary {
  bullets: TodaySummaryBullet[];
  /** Bullets dropped by the guard, with the numbers that were not in the input. */
  dropped: { text: string; numbers: string[] }[];
}

/** The model's bullets after the invented-number guard. */
export function parseAiSummary(raw: string, input: CompactInput): ParsedSummary {
  const lines = stripThinking(raw)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const marker = /^(?:[-*•–]|\d+[.)])\s+/;
  const picked = lines.some((l) => marker.test(l)) ? lines.filter((l) => marker.test(l)) : lines;
  const bullets: TodaySummaryBullet[] = [];
  const dropped: ParsedSummary["dropped"] = [];
  for (const line of picked) {
    const text = cut(line.replace(marker, "").replace(/\*\*|__|`/g, "").trim(), 300);
    if (!text) continue;
    const numbers = recordNumbers(text);
    const invented = [
      ...numbers.filter((n) => !input.known.has(n)),
      // Counts, days and dates too (the guard of model/ai.ts): every integer must occur in the input.
      ...(text.replace(/(?<![\p{L}\p{N}#-])(?:#\d+|\p{Lu}[\p{Lu}\p{N}]*(?:-[\p{Lu}\p{N}]+)+)/gu, " ").match(/\d+/g) ?? []).filter((n) => !input.integers.has(intKey(n))),
    ];
    if (invented.length) dropped.push({ text, numbers: [...new Set(invented)] });
    else bullets.push({ text, refs: refsOf(text, input.links) });
  }
  return { bullets: bullets.slice(0, TODAY_SUMMARY_MAX_BULLETS), dropped };
}
