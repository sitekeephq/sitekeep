import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  CdeError,
  activityRow,
  capList,
  cdeParseArgs,
  cdeResult,
  cdeToolDefinitions,
  cdeToolJsonSchema,
  TOOL_MODULES,
  chainText,
  schedulePair,
  workRow,
  type CdeCall,
} from "../src/index.js";

const BASE_NAMES = `
cde_projects_list cde_members_list cde_member_add cde_companies_list cde_activity
cde_folder_contents cde_folder_tree cde_folder_create cde_folder_update
cde_folder_permissions_get cde_folder_permissions_set cde_naming_standards_list
cde_naming_validate cde_file_get cde_file_update cde_models_list cde_issues_list
cde_issue_get cde_issue_create cde_issue_update cde_issue_comments_list
cde_issue_comment_add cde_bcf_export cde_bcf_import cde_work_types_list
cde_works_list cde_work_get cde_work_thread cde_rfi_log cde_submittal_register
cde_today cde_project_today cde_reviews_list cde_review_get
cde_form_templates_list cde_forms_list cde_form_get cde_locations_tree
cde_schedule_list cde_schedule_activities cde_schedule_compare cde_4d_state
cde_cost_summary cde_clash_tests_list cde_clash_results cde_spec_registers_list
cde_spec_register_get cde_spec_register_build cde_file_antet cde_document_compare cde_work_create cde_record_from_file
cde_work_comment cde_work_submit cde_work_respond cde_meeting_minutes_update
cde_form_template_from_description cde_form_create_draft cde_model_query
cde_quantity_inventory cde_model_compare_summary cde_change_requests_list cde_change_request_get
cde_change_request_create cde_change_request_verify cde_change_request_apply
cde_report_datasets cde_reports_list cde_report_run cde_ai_schemas cde_report_save
cde_form_template_save cde_form_flow_save cde_work_draft
cde_workflow_template_save cde_ai_tasks_list cde_ai_task_claim
cde_ai_task_complete cde_ai_task_fail
`.trim().split(/\s+/);

const DEV_NAMES = `
cde_dev_health cde_dev_seed cde_dev_project cde_dev_upload cde_dev_scenario
cde_dev_ai_eval cde_dev_ai_check cde_dev_time
`.trim().split(/\s+/);

const call: CdeCall = async () => [];

describe("tool inventory and gating", () => {
  it("keeps the complete base inventory in stable order", () => {
    expect(cdeToolDefinitions(call).map((tool) => tool.name)).toEqual(BASE_NAMES);
  });

  it("adds local tools at their stable positions", () => {
    const names = cdeToolDefinitions(call, { localFiles: true, download: async () => new Response() }).map((tool) => tool.name);
    expect(names.filter((name) => name === "cde_file_upload" || name === "cde_file_download")).toEqual([
      "cde_file_upload",
      "cde_file_download",
    ]);
    expect(names.filter((name) => !["cde_file_upload", "cde_file_download"].includes(name))).toEqual(BASE_NAMES);
  });

  it("gates developer tools and preserves their order", () => {
    const names = cdeToolDefinitions(call, { devTools: true }).map((tool) => tool.name);
    expect(names).toEqual([...BASE_NAMES, ...DEV_NAMES]);
  });

  it("removes every write tool in read-only mode", () => {
    const all = cdeToolDefinitions(call, { localFiles: true, download: async () => new Response(), devTools: true });
    const readOnly = cdeToolDefinitions(call, {
      readOnly: true,
      localFiles: true,
      download: async () => new Response(),
      devTools: true,
    });
    expect(readOnly.every((tool) => !tool.write)).toBe(true);
    expect(readOnly.map((tool) => tool.name)).toEqual(all.filter((tool) => !tool.write).map((tool) => tool.name));
  });
});

describe("argument and result helpers", () => {
  const def = {
    shape: {
      count: z.number().int().default(3),
      mode: z.enum(["a", "b"]).optional(),
    },
  };

  it("parses arguments and fills defaults", () => {
    expect(cdeParseArgs(def, undefined)).toEqual({ count: 3 });
    expect(() => cdeParseArgs(def, { count: 1.5 })).toThrow();
  });

  it("generates input JSON Schema and supports omission", () => {
    expect(cdeToolJsonSchema(def)).toMatchObject({
      type: "object",
      properties: { count: { type: "integer", default: 3 }, mode: { enum: ["a", "b"] } },
    });
    expect(cdeToolJsonSchema(def, ["mode"])).not.toHaveProperty("properties.mode");
  });

  it("parses successful responses and reports HTTP errors", () => {
    expect(cdeResult(200, '{"ok":true}', false)).toEqual({ ok: true });
    expect(() => cdeResult(403, '{"message":"yasak"}', false)).toThrowError(
      expect.objectContaining<CdeError>({ message: "HTTP 403: yasak", status: 403 }),
    );
    expect(cdeResult(400, '{"files":[{"ok":false}]}', true)).toEqual({ files: [{ ok: false }] });
  });
});

describe("formatting compatibility", () => {
  it("caps lists and formats work rows", () => {
    expect(capList([1, 2, 3], 2)).toEqual({ items: [1, 2], more: 1 });
    expect(workRow({ id: "w", number: "RFI-1", title: "Soru", typeName: "RFI", statusLabel: "Açık", dueDate: "2026-10-17T12:00:00Z" }))
      .toEqual({ id: "w", number: "RFI-1", title: "Soru", type: "RFI", status: "Açık", due: "2026-10-17" });
  });

  it("formats workflow, schedule, and activity data", () => {
    expect(chainText([{ name: "Müşavir", state: "done", label: "Onaylandı" }, { name: "İdare", state: "current" }]))
      .toBe("Müşavir ✓ (Onaylandı) → İdare ⧗");
    const pair = schedulePair([
      { id: "old", seriesId: "s", version: 1, isBaseline: true, createdAt: "2026-01-01" },
      { id: "new", seriesId: "s", version: 2, createdAt: "2026-02-01" },
    ]);
    expect(pair).toMatchObject({ latest: { id: "new" }, previous: { id: "old" } });
    expect(activityRow({ code: "A1", name: "Kazı", finishVarianceDays: 0, critical: false, milestone: false }))
      .toEqual({ code: "A1", name: "Kazı" });
  });

  it("uses shared form labels without changing lowercase tool output", async () => {
    const formsCall: CdeCall = async () => [{ id: "f", number: 1, status: "in_review" }];
    const tool = cdeToolDefinitions(formsCall).find((item) => item.name === "cde_forms_list")!;
    await expect(tool.run({ projectId: "00000000-0000-4000-8000-000000000000", limit: 50 })).resolves.toMatchObject({
      forms: [{ status: "incelemede" }],
    });
  });
});

describe("specification register build", () => {
  const PID = "6f1c2a9e-3b4d-4e5f-8a7b-9c0d1e2f3a4b";
  const searchOnly = (results: { id: string; name: string }[]) => {
    const calls: string[] = [];
    const fake: CdeCall = async (method, url) => {
      calls.push(`${method} ${url}`);
      if (url.includes("/search")) return { results } as never;
      throw new Error(`unexpected ${method} ${url}`);
    };
    return { fake, calls };
  };
  const build = (fake: CdeCall) => cdeToolDefinitions(fake).find((d) => d.name === "cde_spec_register_build")!;

  it("never analyses a search hit whose name does not match", async () => {
    const { fake, calls } = searchOnly([{ id: "f-1", name: "Mimari Rapor.pdf" }]);
    const d = build(fake);
    await expect(d.run(cdeParseArgs(d, { projectId: PID, file: "Elektrik Şartnamesi" }))).rejects.toThrow(
      /bulunamadı.*Mimari Rapor\.pdf/,
    );
    expect(calls.some((c) => c.startsWith("POST"))).toBe(false);
  });
});

describe("tools by module", () => {
  const call = (async () => ({})) as CdeCall;
  const all = cdeToolDefinitions(call, { devTools: true }).map((d) => d.name);
  it("maps only tools that exist", () => {
    expect(Object.keys(TOOL_MODULES).filter((name) => !all.includes(name))).toEqual([]);
  });
  it("leaves out the tools of modules that are not installed; core tools stay", () => {
    const community = cdeToolDefinitions(call, { devTools: true, modules: [] }).map((d) => d.name);
    expect(community).not.toContain("cde_rfi_log");
    expect(community).not.toContain("cde_forms_list");
    expect(community).not.toContain("cde_dev_ai_eval");
    expect(community).toContain("cde_works_list");
    expect(community).toContain("cde_locations_tree");
    expect(community.length).toBe(all.length - Object.keys(TOOL_MODULES).length);
    const field = cdeToolDefinitions(call, { modules: ["field"] }).map((d) => d.name);
    expect(field).toContain("cde_forms_list");
    expect(field).not.toContain("cde_schedule_list");
  });
});
