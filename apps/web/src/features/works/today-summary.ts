/**
 * "Günün Özeti" on the project Bugün page: pure helpers (the card is components/TodaySummary.tsx).
 */
import type { TodaySummaryBullet, TodaySummaryDto } from "@sitekeep/shared";
import { i18n } from "../../i18n";
import { intlLocale } from "../../shared/lib/format";

export type SummarySegment = { text: string; link?: string };

/** Splits a bullet so that every referenced record number becomes a link. */
export function summarySegments(b: TodaySummaryBullet): SummarySegment[] {
  if (!b.refs.length) return [{ text: b.text }];
  const byNumber = new Map(b.refs.map((r) => [r.number, r.link]));
  const escaped = [...byNumber.keys()].sort((x, y) => y.length - x.length).map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const re = new RegExp(`(?<![\\p{L}\\p{N}-])(${escaped.join("|")})(?![\\p{L}\\p{N}-])`, "gu");
  const out: SummarySegment[] = [];
  let last = 0;
  for (const m of b.text.matchAll(re)) {
    if (m.index! > last) out.push({ text: b.text.slice(last, m.index) });
    out.push({ text: m[0], link: byNumber.get(m[0]) });
    last = m.index! + m[0].length;
  }
  if (last < b.text.length) out.push({ text: b.text.slice(last) });
  return out;
}

/** What the card shows: today's AI summary when there is one, else the automatic one. */
export function shownSummary(s: TodaySummaryDto): { bullets: TodaySummaryBullet[]; label: string; ai: boolean } {
  if (s.ai) {
    const t = new Date(s.ai.generatedAt).toLocaleTimeString(intlLocale(), { hour: "2-digit", minute: "2-digit" });
    return { bullets: s.ai.bullets, label: i18n.t("works:summary.badges.ai", { time: t }), ai: true };
  }
  return { bullets: s.auto, label: i18n.t("works:summary.badges.auto"), ai: false };
}

/** The card polls while a model writes the summary or a queued task waits. */
export function summaryPending(s: TodaySummaryDto | null | undefined): boolean {
  return !!s && (s.running || !!s.queueTask);
}
