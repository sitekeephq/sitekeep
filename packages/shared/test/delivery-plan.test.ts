/** ISO-7 delivery plan rules shared by the server and the web app (docs/features/DELIVERY_PLAN.md). */
import { describe, expect, it } from "vitest";
import {
  checkProjectTemplate,
  deliverableLate,
  deliverableStatus,
  formatPlanTarget,
  milestoneHeader,
  milestoneOfHeader,
  parsePlanDate,
  parsePlanTarget,
  planHeaderKey,
  type ProjectTemplate,
} from "../src/index.js";

describe("ISO19650-2 5.4.4 deliverable status and late rule", () => {
  it("takes the most advanced file of the document: WIP, Shared, Published", () => {
    expect(deliverableStatus([])).toBe("not_started");
    expect(deliverableStatus([{ state: "wip" }])).toBe("wip");
    expect(deliverableStatus([{ state: null }])).toBe("wip");
    expect(deliverableStatus([{ state: "wip" }, { state: "shared" }])).toBe("shared");
    // A withdrawn Shared copy went back to its team; an archived publication was published.
    expect(deliverableStatus([{ state: "shared", flag: "withdrawn" }])).toBe("wip");
    expect(deliverableStatus([{ state: "archived", flag: "superseded" }, { state: "shared" }])).toBe("published");
  });

  it("is late when a due date passed below the state it asks for", () => {
    const due = { dueShared: "2027-03-01", duePublished: "2027-04-01" };
    expect(deliverableLate("wip", due, "2027-03-01")).toBeNull();
    expect(deliverableLate("wip", due, "2027-03-02")).toBe("shared");
    expect(deliverableLate("shared", due, "2027-03-02")).toBeNull();
    expect(deliverableLate("shared", due, "2027-04-02")).toBe("published");
    expect(deliverableLate("not_started", due, "2027-04-02")).toBe("published");
    expect(deliverableLate("published", due, "2030-01-01")).toBeNull();
    expect(deliverableLate("not_started", { dueShared: null, duePublished: null }, "2030-01-01")).toBeNull();
  });
});

describe("ISO19650-2 5.4.5 delivery plan import and export cells", () => {
  it("reads dates as ISO, Turkish and Excel serial days", () => {
    expect(parsePlanDate("2027-03-31")).toBe("2027-03-31");
    expect(parsePlanDate("31.03.2027")).toBe("2027-03-31");
    expect(parsePlanDate("1/3/2027")).toBe("2027-03-01");
    expect(parsePlanDate("46600")).toBe("2027-08-01");
    expect(parsePlanDate("")).toBeNull();
    expect(parsePlanDate("2027-02-30")).toBeUndefined();
    expect(parsePlanDate("next week")).toBeUndefined();
  });

  it("writes and reads milestone targets", () => {
    expect(formatPlanTarget({ suitabilityCode: "S2", revisionCode: "P01" })).toBe("S2 / P01");
    expect(formatPlanTarget({ suitabilityCode: "S2", revisionCode: null })).toBe("S2");
    expect(formatPlanTarget(null)).toBe("");
    expect(parsePlanTarget("S2 / P01")).toEqual({ suitabilityCode: "S2", revisionCode: "P01" });
    expect(parsePlanTarget("A1 C01")).toEqual({ suitabilityCode: "A1", revisionCode: "C01" });
    expect(parsePlanTarget("/ P02")).toEqual({ suitabilityCode: null, revisionCode: "P02" });
    expect(parsePlanTarget(" ")).toBeNull();
  });

  it("matches headers in either language and milestones by header, code or name", () => {
    expect(planHeaderKey(" DOKÜMAN  KODU ")).toBe(planHeaderKey("doküman kodu"));
    expect(planHeaderKey("BAŞLIK")).toBe(planHeaderKey("Başlık"));
    const ms = [
      { code: "M1", name: "Concept Design" },
      { code: null, name: "Handover" },
    ];
    expect(milestoneHeader(ms[0]!)).toBe("M1 · Concept Design");
    expect(milestoneOfHeader("m1 · concept design", ms)).toBe(ms[0]);
    expect(milestoneOfHeader("M1", ms)).toBe(ms[0]);
    expect(milestoneOfHeader("handover", ms)).toBe(ms[1]);
    expect(milestoneOfHeader("Status", ms)).toBeUndefined();
  });

  it("refuses a template that lists a milestone twice", () => {
    const template = { name: "T", slots: [], folders: ["A"], deliveryPlan: { milestones: [{ name: "Stage 2" }, { name: "stage 2" }] } } as ProjectTemplate;
    expect(checkProjectTemplate(template, {}, "en")).toEqual([expect.stringContaining('milestone "stage 2" is listed more than once')]);
  });
});
