// Administration → Companies: the project filter (docs/features/COMPANIES.md).
import { describe, expect, it } from "vitest";
import type { CompanyDto } from "@sitekeep/shared";
import { NO_PROJECT, companyProjectOptions, filterCompaniesByProject } from "../../src/features/admin/company-projects";

const P1 = { id: "p1", code: "P1", name: "Metro" };
const P2 = { id: "p2", code: "DEMO", name: "Demo" };
const list: CompanyDto[] = [
  { id: "a", name: "Alfa", code: null, projects: [P1] },
  { id: "b", name: "Riverside", code: null, projects: [P2] },
  { id: "c", name: "Shared", code: null, projects: [P1, P2] },
  { id: "d", name: "Unused", code: null, projects: [] },
];

describe("company project filter", () => {
  it("offers each linked project once, by code", () => {
    expect(companyProjectOptions(list).map((p) => p.code)).toEqual(["DEMO", "P1"]);
  });
  it("filters by project, by none, or not at all", () => {
    expect(filterCompaniesByProject(list, "").map((c) => c.id)).toEqual(["a", "b", "c", "d"]);
    expect(filterCompaniesByProject(list, "p1").map((c) => c.id)).toEqual(["a", "c"]);
    expect(filterCompaniesByProject(list, NO_PROJECT).map((c) => c.id)).toEqual(["d"]);
  });
});
