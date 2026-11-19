/**
 * Output language of the core's AI features (docs/architecture/i18n.md §8.4): the language
 * instruction reaches every prompt (mock provider), and "ball in court" of RFIs / submittals.
 */
import { describe, expect, it } from "vitest";
import type { CompareGroupDto } from "@sitekeep/shared";
import { aiLanguageName, answerLanguageRule, sourceLanguageRule } from "../../src/ai/language.js";
import type { AiProvider, ChatMessage } from "../../src/ai/provider.js";
import { summarize, type PromptInput } from "../../src/doccompare/ai.js";
import { refineRegisterWithAi } from "../../src/docintel/spec.js";
import { aiCompareSummary } from "../../src/model/ai.js";
import { writeSummary } from "../../src/today/service.js";
import { compactInput, todaySummarySystem, type TodayData } from "../../src/today/text.js";
import { ballInCourt } from "../../src/works/workflow.js";

/** A provider that records the messages and answers `text`. */
function mock(text: string) {
  const calls: ChatMessage[][] = [];
  const provider = {
    id: "mock",
    name: "Mock",
    kind: "anthropic",
    model: "mock",
    external: true,
    chat: async (messages: ChatMessage[]) => {
      calls.push(messages);
      return { text, toolCalls: [], model: "mock", stopReason: "stop" };
    },
    embed: async () => [],
  } as unknown as AiProvider;
  const system = () => String(calls.at(-1)?.find((m) => m.role === "system")?.content ?? "");
  return { provider, calls, system };
}

describe("language rules", () => {
  it("names languages in English", () => {
    expect(aiLanguageName("en")).toBe("English");
    expect(aiLanguageName("tr")).toBe("Turkish");
    expect(aiLanguageName("de")).toBe("German");
    expect(aiLanguageName("xx-invalid-!")).toBe("xx-invalid-!");
  });

  it("answers in the interface language unless the request asks otherwise; Turkish keeps the CDE terms", () => {
    const en = answerLanguageRule("en");
    expect(en).toContain("in English (the user's interface language)");
    expect(en).toContain("unless the user's request explicitly asks for another language");
    expect(en).not.toContain("sıradaki taraf");
    const tr = answerLanguageRule("tr");
    expect(tr).toContain("in Turkish");
    expect(tr).toContain("ball in court → sıradaki taraf");
  });

  it("keeps the source language for extraction, the interface language as the fallback", () => {
    const r = sourceLanguageRule("en", "the minutes");
    expect(r).toContain("in the language of the minutes");
    expect(r).toContain("use English (the user's interface language)");
  });
});

describe("the language instruction reaches the prompts", () => {
  it("Günün Özeti: the reader's language, the localized last bullet", async () => {
    expect(todaySummarySystem("en")).toContain("'Most urgent: <numara> <konu>.'");
    expect(todaySummarySystem("en")).toContain("in English");
    expect(todaySummarySystem("tr")).toContain("'En acil: <numara> <konu>.'");
    expect(todaySummarySystem("tr")).toContain("in Turkish");
    const data = {
      projectId: "p",
      mine: { tasks: [], works: [], actions: [], replies: [], receipts: [], forms: [], issues: [] },
      overdue: [],
      upcoming: [],
      upcomingDays: 7,
      changes: [],
      changeDays: 7,
      counts: { mine: 0, overdue: 0, upcoming: 0, changes: 0 },
    } as unknown as TodayData;
    const m = mock("- Nothing is overdue today.");
    const r = await writeSummary(m.provider, compactInput(data, "2026-11-19"), false, "en");
    expect(r.bullets.map((b) => b.text)).toEqual(["Nothing is overdue today."]);
    expect(m.system()).toContain("in English (the user's interface language)");
  });

  it("Değişiklik özeti (document comparison): the requester's language", async () => {
    const input: PromptInput = {
      fileA: "A.pdf",
      fileB: "A.pdf",
      versionA: 1,
      versionB: 2,
      result: {
        kind: "pdf",
        hasText: true,
        identical: false,
        pageCountA: 1,
        pageCountB: 1,
        pages: [],
        totals: { added: 0, removed: 0, changed: 0, pages: 0 },
        antet: [],
        revisionA: "B",
        revisionB: "C",
        revisionTableA: null,
        revisionTableB: null,
        antetRegion: null,
        contentChanged: true,
      },
      regions: null,
      flags: [],
      lang: "en",
    } as PromptInput;
    const m = mock("- [s.1] Revision B → C.");
    expect((await summarize(m.provider, input))[0]).toMatchObject({ text: "Revision B → C.", page: 1 });
    expect(m.system()).toContain("in English (the user's interface language)");
    expect(m.system()).toContain("[s.N]");
    await summarize(m.provider, { ...input, lang: "tr" });
    expect(m.system()).toContain("in Turkish");
  });

  it("model comparison summary: the requester's language", async () => {
    const groups = [{ id: "g1", text: "Kat 1: 2 kapı eklendi", kind: "added", count: 2 }] as unknown as CompareGroupDto[];
    const m = mock('{"bullets":[{"text":"Floor 1: 2 doors added","refs":["g1"]}]}');
    const r = await aiCompareSummary(m.provider, "Toplam: 2 eklendi.", groups, undefined, "en");
    expect(r.bullets).toEqual([{ text: "Floor 1: 2 doors added", groupIds: ["g1"] }]);
    expect(m.system()).toContain("in English (the user's interface language)");
    expect(m.system()).not.toContain("Türkçe");
  });

  it("spec register (extraction): keeps the specification's language", async () => {
    const items = [{ id: "S001", type: null, typeConfidence: 0, excerpt: "Submit shop drawings for the steel stairs.", sectionTitle: "Steel", description: "" }];
    const m = mock(JSON.stringify({ S001: { tip: "UCZ", ozet: "Shop drawings for steel stairs" } }));
    const r = await refineRegisterWithAi(m.provider, items as never, { lang: "tr" });
    expect(r.items[0]).toMatchObject({ type: "UCZ", description: "Shop drawings for steel stairs" });
    expect(m.system()).toContain("in the language of each item's specification sentence");
    expect(m.system()).toContain("use Turkish (the user's interface language)");
  });
});

describe("ball in court", () => {
  const RMA = "c-rma";
  const RDJ = "c-rdj";
  const statuses = [
    { key: "taslak", label: "Taslak", tone: "" },
    { key: "acik", label: "Açık", tone: "warn" },
    { key: "cevaplandi", label: "Cevaplandı", tone: "info" },
    { key: "kapandi", label: "Kapalı", tone: "ok", closed: true },
  ];
  const rfiType = { category: "rfi", statuses, settings: { submittedStatus: "acik" } } as never;
  const work = (status: string, o: Record<string, unknown> = {}) =>
    ({ status, toCompanyIds: [RMA], fromCompanyId: RDJ, ownerCompanyId: RDJ, assigneeUserId: null, ...o }) as never;
  const members = [{ userId: "u-rma", companyId: RMA }] as never;
  const running = (assignees: unknown[]) =>
    ({ status: "running", stepIndex: 0, startedBy: "u-rdj", template: { steps: [{ name: "Cevap", assignees, rule: "any" }] } }) as never;

  it("an open RFI without a running workflow waits for its addressees", () => {
    expect(ballInCourt(work("acik"), rfiType, undefined, members)).toEqual([RMA]);
    expect(ballInCourt(work("acik", { toCompanyIds: [], assigneeUserId: "u-rma" }), rfiType, undefined, members)).toEqual([RMA]);
  });

  it("a running step names its companies; a step without one falls back to the addressees", () => {
    expect(ballInCourt(work("acik"), rfiType, running([{ type: "company", id: "c-other" }]), members)).toEqual(["c-other"]);
    expect(ballInCourt(work("acik"), rfiType, running([{ type: "user", id: "u-nobody" }]), members)).toEqual([RMA]);
  });

  it("drafts, answered and closed RFIs", () => {
    expect(ballInCourt(work("taslak"), rfiType, undefined, members)).toEqual([]);
    expect(ballInCourt(work("cevaplandi"), rfiType, undefined, members)).toEqual([RDJ]);
    expect(ballInCourt(work("kapandi"), rfiType, undefined, members)).toEqual([]);
  });
});
