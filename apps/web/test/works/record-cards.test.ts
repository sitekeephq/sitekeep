import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { WorkSummaryDto } from "@sitekeep/shared";
import { RecordCards } from "../../src/shared/ui/RecordCards";
import { dueOf, localToday, NARROW_QUERY, PHONE_QUERY, workCard, workCounterpart } from "../../src/features/works/record-cards";

const names = new Map([
  ["c-cns", "CNS İnşaat"],
  ["c-hll", "HLL Müşavirlik"],
  ["c-zrt", "Zirve"],
]);

function work(over: Partial<WorkSummaryDto> = {}): WorkSummaryDto {
  return {
    id: "w1",
    projectId: "p1",
    typeId: "t-giden",
    typeKey: "giden-yazi",
    typeName: "Giden Yazı",
    category: "correspondence",
    number: "PAS-CNS-HLL-0001",
    title: "Kalıp çizimleri hakkında",
    status: "gonderildi",
    statusLabel: "Gönderildi",
    statusTone: "info",
    closed: false,
    fromCompanyId: "c-cns",
    toCompanyIds: ["c-hll", "c-zrt"],
    ccCompanyIds: [],
    assigneeUserId: null,
    dueDate: "2026-10-01",
    replyRequired: true,
    overdue: true,
    createdBy: "u1",
    createdAt: "2026-09-20T10:00:00.000Z",
    updatedAt: "2026-09-20T10:00:00.000Z",
    sentAt: "2026-09-20T10:00:00.000Z",
    ...over,
  };
}

describe("İşler phone cards (record-cards.ts)", () => {
  it("shows number, title, type, status, counterpart, due date and the reply chip of a work", () => {
    const c = workCard(work(), { incoming: false, companyNames: names });
    expect(c).toEqual({
      id: "w1",
      number: "PAS-CNS-HLL-0001",
      title: "Kalıp çizimleri hakkında",
      meta: ["Giden Yazı", "HLL Müşavirlik, Zirve"],
      status: { label: "Gönderildi", tone: "info" },
      due: { text: "01.10.2026", overdue: true },
      chips: [{ label: "Cevap Bekleniyor", tone: "warn" }],
    });
  });

  it("uses the sender as counterpart of incoming works; closed or answered works lose the chip", () => {
    expect(workCounterpart(work(), true, names)).toBe("CNS İnşaat");
    expect(workCounterpart(work({ fromCompanyId: null }), true, names)).toBeNull();
    expect(workCounterpart(work({ toCompanyIds: [] }), false, names)).toBeNull();
    expect(workCard(work({ closed: true }), { incoming: false, companyNames: names }).chips).toEqual([]);
    expect(workCard(work({ replyRequired: false }), { incoming: false, companyNames: names }).chips).toEqual([]);
    const noDue = workCard(work({ dueDate: null, overdue: false }), { incoming: true, companyNames: names });
    expect(noDue.due).toBeNull();
    expect(noDue.meta).toEqual(["Giden Yazı", "CNS İnşaat"]);
  });

  it("marks open records overdue when the due day is before today", () => {
    expect(localToday(new Date(2026, 9, 11, 23, 30))).toBe("2026-10-11");
    expect(dueOf("2026-10-10", false, "2026-10-11")).toEqual({ text: "10.10.2026", overdue: true });
    expect(dueOf("2026-10-11", false, "2026-10-11")).toEqual({ text: "11.10.2026", overdue: false });
    expect(dueOf("2026-10-10T08:00:00.000Z", true, "2026-10-11")).toEqual({ text: "10.10.2026", overdue: false });
    expect(dueOf(null, false)).toBeNull();
  });
});

describe("RecordCards component", () => {
  const card = workCard(work(), { incoming: false, companyNames: names });
  const render = (props: Partial<Parameters<typeof RecordCards>[0]>) =>
    renderToStaticMarkup(createElement(RecordCards, { label: "İşler", onOpen: () => undefined, groups: [], ...props }));

  it("renders group headers collapsed by default and opens the group of the selected record", () => {
    const html = render({
      selectedId: "w2",
      groups: [
        { key: "Giden Yazı", label: "Giden Yazı", rows: [card] },
        { key: "Bilgi Talebi", label: "Bilgi Talebi", rows: [{ ...card, id: "w2", number: "BT-001", title: "Şaft ölçüsü", due: { text: "20.10.2026", overdue: false }, chips: [] }] },
      ],
    });
    expect(html).toContain('<ul class="record-cards" aria-label="İşler">');
    expect(html.match(/<button type="button" class="record-card/g)).toHaveLength(1);
    expect(html).toContain('<span class="work-group-name">Giden Yazı</span><span class="work-group-count">1</span>');
    expect(html).toContain('<span class="work-group-name">Bilgi Talebi</span><span class="work-group-count">1</span>');
    expect(html).toContain('<span class="mono record-card-no">BT-001</span>');
    expect(html).toContain('<span class="badge info">Gönderildi</span>');
    expect(html).toContain("Giden Yazı · HLL Müşavirlik, Zirve");
    expect(html).toContain('<span class="record-card-due">Termin 20.10.2026</span>');
    expect(html).toContain('class="record-card selected" aria-current="true"');

    const ungrouped = render({ groups: [{ key: "", label: "", rows: [card] }] });
    expect(ungrouped).toContain('<span class="mono record-card-no">PAS-CNS-HLL-0001</span>');
    expect(ungrouped).toContain('<span class="record-card-due overdue">Termin 01.10.2026</span>');
    expect(ungrouped).toContain('<span class="badge warn">Cevap Bekleniyor</span>');
  });

  it("switches lists to cards at the same 900px breakpoint as the hamburger project nav", () => {
    expect(PHONE_QUERY).toBe("(max-width: 900px)");
    expect(NARROW_QUERY).toBe("(max-width: 900px)");
  });

  it("shows the empty text only when there are no records", () => {
    expect(render({ groups: [{ key: "", label: "", rows: [] }], emptyText: "Henüz iş yok." })).toContain("Henüz iş yok.");
    expect(render({ groups: [{ key: "", label: "", rows: [] }], emptyText: null })).toBe("");
    expect(render({ groups: [{ key: "", label: "", rows: [card] }] })).not.toContain("record-cards-group");
  });
});
