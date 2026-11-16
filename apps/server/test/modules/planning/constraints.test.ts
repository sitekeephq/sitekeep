import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { decodeText } from "@7dimensions-project/sitekeep-ee-planning/internal/schedule/import.js";
import { parseMspdi } from "@7dimensions-project/sitekeep-ee-planning/internal/schedule/mspdi.js";
import { parseXer } from "@7dimensions-project/sitekeep-ee-planning/internal/schedule/xer.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fx = (n: string) => readFileSync(path.join(here, "../../fixtures", n));

/** Appends cstr_type / cstr_date to the TASK table of the fixture: the first task gets the constraint. */
function withConstraint(xer: string, type: string, date: string): string {
  const lines = xer.split(/\r?\n/);
  let inTask = false, first = true;
  return lines
    .map((l) => {
      if (l.startsWith("%T")) inTask = l.split("\t")[1] === "TASK";
      if (!inTask) return l;
      if (l.startsWith("%F")) return `${l}\tcstr_type\tcstr_date`;
      if (l.startsWith("%R")) {
        const out = first ? `${l}\t${type}\t${date}` : `${l}\t\t`;
        first = false;
        return out;
      }
      return l;
    })
    .join("\r\n");
}

describe("date constraints on import", () => {
  it("reads P6 cstr_type / cstr_date", () => {
    const base = decodeText(fx("schedule.xer"));
    const p = parseXer(withConstraint(base, "CS_MSOA", "2028-07-01 08:00"));
    const tasks = p.activities.filter((a) => !a.summary);
    const constrained = tasks.filter((a) => a.constraintType);
    expect(constrained).toHaveLength(1);
    expect(constrained[0]).toMatchObject({ constraintType: "startOnOrAfter", constraintDate: "2028-07-01" });
    // Unknown or dateless constraints are left out.
    expect(parseXer(withConstraint(base, "CS_ALAP", "")).activities.some((a) => a.constraintType)).toBe(false);
  });

  it("reads MS Project ConstraintType / ConstraintDate", () => {
    const xml = fx("schedule-v1.xml")
      .toString("utf8")
      .replace(/<ConstraintType>\d<\/ConstraintType>/g, "")
      .replace(/<ConstraintDate>[^<]*<\/ConstraintDate>/g, "")
      .replace("<Milestone>1</Milestone>", "<Milestone>1</Milestone><ConstraintType>7</ConstraintType><ConstraintDate>2026-12-31T17:00:00</ConstraintDate>");
    const p = parseMspdi(xml);
    const ms = p.activities.filter((a) => a.constraintType);
    expect(ms).toHaveLength(1);
    expect(ms[0]).toMatchObject({ milestone: true, constraintType: "finishOnOrBefore", constraintDate: "2026-12-31" });
  });
});
