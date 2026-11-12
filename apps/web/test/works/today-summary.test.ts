import { describe, expect, it } from "vitest";
import { isTitleCaseTr, type TodaySummaryDto } from "@sitekeep/shared";
import { shownSummary, summaryPending, summarySegments } from "../../src/features/works/today-summary";

const base: TodaySummaryDto = {
  auto: [{ text: "Size bekleyen bir iş yok.", refs: [] }],
  ai: null,
  mode: "provider",
  running: false,
  error: null,
  queueTask: null,
  stamp: "s",
};

describe("Günün Özeti card helpers", () => {
  it("links every referenced record number in a bullet", () => {
    const segs = summarySegments({
      text: "En acil: ZAVM-RFI-0003 (ZAVM-RFI-00031 değil) ve TPL-014'ün eylemleri.",
      refs: [
        { number: "ZAVM-RFI-0003", link: "/projects/1/works/a" },
        { number: "TPL-014", link: "/projects/1/works/b" },
      ],
    });
    expect(segs).toEqual([
      { text: "En acil: " },
      { text: "ZAVM-RFI-0003", link: "/projects/1/works/a" },
      { text: " (ZAVM-RFI-00031 değil) ve " },
      { text: "TPL-014", link: "/projects/1/works/b" },
      { text: "'ün eylemleri." },
    ]);
    expect(summarySegments({ text: "Düz metin.", refs: [] })).toEqual([{ text: "Düz metin." }]);
  });

  it("shows the AI summary with its time when there is one, else the automatic one (Title Case labels)", () => {
    const auto = shownSummary(base);
    expect(auto).toMatchObject({ label: "Otomatik Özet", ai: false });
    const at = new Date(2026, 9, 11, 14, 5).toISOString();
    const ai = shownSummary({ ...base, ai: { bullets: [{ text: "x", refs: [] }], generatedAt: at, model: "m", source: "provider", fresh: true } });
    expect(ai.label).toBe("Yapay Zekâ Özeti · 14:05");
    expect(ai.bullets[0]!.text).toBe("x");
    expect(isTitleCaseTr(auto.label)).toBe(true);
    expect(isTitleCaseTr("Yapay Zekâ Özeti")).toBe(true);
  });

  it("polls only while a model writes or a queued task waits", () => {
    expect(summaryPending(base)).toBe(false);
    expect(summaryPending({ ...base, running: true })).toBe(true);
    expect(summaryPending({ ...base, queueTask: { id: "t", status: "pending" } })).toBe(true);
    expect(summaryPending(null)).toBe(false);
  });
});
