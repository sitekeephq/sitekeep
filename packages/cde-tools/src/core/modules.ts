/**
 * Tools whose endpoints belong to a SiteKeep module (ids as in SITEKEEP_MODULES). With
 * `CdeToolsOptions.modules` set, a tool of a module that is not installed is not offered at all,
 * instead of being listed and answering 404. Tools not listed here use core endpoints.
 */
export const TOOL_MODULES: Readonly<Record<string, string>> = {
  // Field: forms and form templates (locations are core)
  cde_form_templates_list: "field", cde_forms_list: "field", cde_form_get: "field",
  cde_form_template_from_description: "field", cde_form_create_draft: "field",
  cde_form_template_save: "field", cde_form_flow_save: "field",
  // Planning: schedules and 4D
  cde_schedule_list: "planning", cde_schedule_activities: "planning", cde_schedule_compare: "planning", cde_4d_state: "planning",
  // Cost: 5D
  cde_cost_summary: "cost",
  // Coordinate: clash tests and parameter change requests
  cde_clash_tests_list: "coordinate", cde_clash_results: "coordinate",
  cde_change_requests_list: "coordinate", cde_change_request_get: "coordinate", cde_change_request_create: "coordinate",
  cde_change_request_verify: "coordinate", cde_change_request_apply: "coordinate",
  // Manage: registers, minutes, record from file, spec registers (the spec switch is Manage's)
  cde_rfi_log: "manage", cde_submittal_register: "manage", cde_meeting_minutes_update: "manage", cde_record_from_file: "manage",
  cde_spec_registers_list: "manage", cde_spec_register_get: "manage", cde_spec_register_build: "manage",
  // AI: task queue and its schemas, AI evaluation
  cde_ai_schemas: "ai", cde_ai_tasks_list: "ai", cde_ai_task_claim: "ai", cde_ai_task_complete: "ai", cde_ai_task_fail: "ai",
  cde_dev_ai_eval: "ai", cde_dev_ai_check: "ai",
};
