/**
 * Developer tools (cde_dev_*): health, synthetic seed data, test projects, sample uploads, end-to-end
 * scenarios, AI evaluation and date shifting. Registered only when the MCP server is told so
 * (devTools option); the CDE server serves /api/v1/dev/* only with CDE_DEV_TOOLS=1 (never in
 * production) and only to a system administrator's write token. Every call is audited there.
 *
 * The argument shapes live here and the server validates /dev/tools/:name with the same shapes.
 */
import { z } from "zod";
import type { CdeCall } from "../core/types.js";

export const DEV_SCENARIOS = [
  "yazisma-dongusu",
  "bilgi-talebi",
  "teknik-onay",
  "toplanti",
  "inceleme",
  "form-pdf",
  "rapor",
  "karsilastirma",
  "gorunum",
] as const;

/** In-app AI features (same names as the AI task queue kinds). */
export const AI_EVAL_FEATURES = [
  "report_generate",
  "report_repair",
  "form_flow",
  "form_fields_naming",
  "form_template_from_text",
  "letter_translate",
  "doc_compare_summary",
  "model_ask",
  "ask",
  "minutes_actions",
  "rfi_draft",
] as const;

export const SAMPLE_KINDS = ["pdf_drawing", "pdf_form", "docx", "xlsx", "pptx", "dxf", "ifc", "ifc_v2"] as const;

export const PROJECT_TEMPLATES = ["empty", "iso19650", "iso19650-temel", "bina-veri-merkezi", "metro-ibb"] as const;

const projectRef = z.string().min(1).max(64).describe("Project id or code, e.g. PKF-DEMO.");
const confirm = z.boolean().optional().describe("Must be true for destructive actions (test/demo projects only).");

/** Argument shapes of the developer tools, shared with the server's /dev/tools/:name validation. */
export const devToolShapes = {
  cde_dev_health: {
    errors: z.number().int().min(0).max(100).default(20).describe("How many recent server errors to include."),
  },
  cde_dev_seed: {
    project: projectRef,
    action: z.enum(["create", "status", "remove"]).default("create"),
    tag: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/).default("demo").describe("Seed tag: the same tag is created once (idempotent)."),
    seed: z.number().int().min(0).max(2 ** 31).optional().describe("Random seed (default: derived from the tag)."),
    counts: z
      .object({
        incomingLetters: z.number().int().min(0).max(500).optional(),
        outgoingLetters: z.number().int().min(0).max(500).optional(),
        rfis: z.number().int().min(0).max(300).optional(),
        submittals: z.number().int().min(0).max(300).optional(),
        meetings: z.number().int().min(0).max(100).optional(),
        transmittals: z.number().int().min(0).max(100).optional(),
        issues: z.number().int().min(0).max(500).optional(),
        reviews: z.number().int().min(0).max(100).optional(),
        forms: z.number().int().min(0).max(300).optional(),
        schedule: z.boolean().optional(),
        clashes: z.boolean().optional(),
      })
      .partial()
      .default({})
      .describe("Records per kind; omitted kinds use small defaults. 'Yazışma' = incoming + outgoing letters."),
    overdueRatio: z.number().min(0).max(1).default(0.3).describe("Share of open records whose due date is in the past."),
    backdateDays: z.number().int().min(0).max(730).default(90).describe("Creation dates spread over this many past days."),
    companies: z.array(z.string().min(1)).max(10).optional().describe("Company codes or names to use; default the project's member companies, else demo companies."),
    confirm,
  },
  cde_dev_project: {
    action: z.enum(["create", "add_members", "set_modules", "reset", "archive", "list"]),
    project: projectRef.optional(),
    code: z.string().trim().min(1).max(40).optional().describe("New project code; '-TEST' is appended unless it ends with -DEMO / -TEST."),
    name: z.string().trim().min(1).max(200).optional(),
    template: z.enum(PROJECT_TEMPLATES).default("iso19650"),
    members: z.boolean().default(true).describe("create: also add demo companies (short codes) and demo members."),
    modules: z
      .record(z.string(), z.boolean())
      .optional()
      .describe(
        "set_modules (also create): module switches of a test/demo project, e.g. {\"schedule\": false}. Keys: correspondence, rfi, submittals, " +
          "meetings, transmittals, issues, reviews, forms, coordination, schedule, spec, reports. Unknown keys are refused.",
      ),
    keepFiles: z.boolean().default(true).describe("reset: keep folders and files, remove records."),
    confirm,
  },
  cde_dev_upload: {
    project: projectRef,
    folderId: z.string().uuid().optional().describe("Target folder (default: the first WIP folder, else the root)."),
    sample: z.enum(SAMPLE_KINDS).optional().describe("Generated sample: PDF drawing with a title block, PDF form, DOCX, XLSX, PPTX, DXF or a small IFC."),
    fixture: z.string().max(200).optional().describe("A file name from the server's test fixtures (apps/server/test/fixtures)."),
    path: z.string().max(1000).optional().describe("Explicit local file path on the server machine (read only when given)."),
    name: z.string().max(200).optional().describe("File name in the CDE (default: generated)."),
    newVersionOf: z.string().uuid().optional().describe("Upload as a new version of this file (same folder and name)."),
    revision: z.string().max(10).optional().describe("Revision written into a generated title block, e.g. P02."),
    count: z.number().int().min(1).max(20).default(1),
    comment: z.string().max(500).optional(),
  },
  cde_dev_scenario: {
    scenarios: z.array(z.enum(DEV_SCENARIOS)).optional().describe("Default: all."),
    project: projectRef.optional().describe("Test project to run in (default: a new SCN-…-TEST project)."),
    list: z.boolean().default(false).describe("Only list the scenarios."),
  },
  cde_dev_ai_eval: {
    features: z.array(z.enum(AI_EVAL_FEATURES)).optional().describe("Default: all except report_repair."),
    mode: z.enum(["run", "dry"]).default("run").describe("run: call the configured provider; dry: return the exact prompts only."),
    model: z.string().max(100).optional().describe("Model name override for the provider, e.g. qwen3-8b-16k (single provider only)."),
    providers: z
      .array(z.string().min(1).max(100))
      .max(10)
      .optional()
      .describe("Compare these configured providers (ids or names; 'all' = every provider the policy allows). Default: the project provider."),
    prices: z
      .record(z.string(), z.object({ input: z.number().min(0), output: z.number().min(0) }))
      .optional()
      .describe("Optional prices per 1M tokens by provider name or id (your own numbers; nothing is hard-coded) for the cost estimate."),
    project: projectRef.optional().describe("Project for context (default: a test project created for the evaluation)."),
    promptsPerFeature: z.number().int().min(1).max(3).default(1),
    timeoutSeconds: z.number().int().min(10).max(1800).default(600).describe("Per model call."),
  },
  cde_dev_ai_check: {
    feature: z.enum(AI_EVAL_FEATURES),
    output: z.union([z.string(), z.record(z.string(), z.unknown()), z.array(z.unknown())]).describe("Candidate model output (raw text or JSON)."),
    project: projectRef.optional().describe("Report specs are checked against this project's datasets; flows against its roles."),
  },
  cde_dev_time: {
    project: projectRef,
    tag: z.string().max(40).optional().describe("Only records of this seed tag (default: every seeded record of the project)."),
    overdueRatio: z.number().min(0).max(1).optional().describe("Make this share of open records overdue (others get future due dates)."),
    shiftDays: z.number().int().min(-730).max(730).optional().describe("Move all dates of the records by this many days (negative = into the past)."),
    kinds: z.array(z.enum(["works", "issues", "reviews", "forms"])).optional(),
    confirm,
  },
} satisfies Record<string, Record<string, z.ZodType>>;

export type DevToolName = keyof typeof devToolShapes;

/** Validates developer tool arguments with the shared shapes (server side). */
export function parseDevArgs(name: string, args: unknown): Record<string, unknown> {
  const shape = (devToolShapes as Record<string, Record<string, z.ZodType>>)[name];
  if (!shape) throw new Error(`Bilinmeyen geliştirici aracı: ${name}`);
  return z.object(shape).parse(args ?? {}) as Record<string, unknown>;
}

type DevToolAdder = (
  name: string,
  description: string,
  shape: Record<string, z.ZodType>,
  run: (args: Record<string, unknown>) => Promise<unknown>,
  o: { write?: boolean; dev?: boolean; destructive?: boolean },
) => void;

const DESCRIPTIONS: Record<DevToolName, string> = {
  cde_dev_health:
    "Developer health check of the local CDE server: version, git commit, migrations, database kind, converters (office/DWG), AI provider and policy, " +
    "MCP settings, job queue, test projects, recent server errors and row counts per table.",
  cde_dev_seed:
    "Generates realistic synthetic data in a test/demo project (code ending -DEMO/-TEST or created by cde_dev_project): incoming/outgoing letters with " +
    "ilgi chains and replies, bilgi talepleri (RFIs) with the next party, teknik onay items/packages with revisions, meetings with minutes and actions, " +
    "gönderim formları, issues, reviews (incl. overdue), forms with failed items, a schedule with baseline variance and clash results when models exist. " +
    "Dates are backdated (dev only). Idempotent per tag; action remove deletes a tag's records (confirm: true).",
  cde_dev_project:
    "Test projects: create from a template with demo companies (short codes) and members, add members, set module switches, " +
    "reset a test project's records or archive it (both need confirm: true and a test/demo project), list projects with their test flag.",
  cde_dev_upload:
    "Uploads a generated sample (PDF drawing with title block, PDF form, DOCX, XLSX, PPTX, DXF, small IFC), a test fixture or an explicitly given " +
    "local path into a folder; newVersionOf uploads a new version of an existing file.",
  cde_dev_scenario:
    "Runs end-to-end scenarios through the real API and services and returns pass/fail per step with timings and web links: " +
    DEV_SCENARIOS.join(", ") +
    ". Runs in a new test project unless one is given.",
  cde_dev_ai_eval:
    "Evaluates the app's own AI features (report generate/repair, form template from description, form flow, field naming, Sor, doc compare summary, " +
    "Modele sor, letter translation, minutes actions, RFI draft) with fixed Turkish prompts through the configured provider (optionally another model) and returns valid JSON yes/no, " +
    "schema errors, seconds and tokens; with `providers` it compares several configured providers (validity, seconds, tokens, cost estimate from `prices`). " +
    "mode dry returns the exact prompts so you can answer them yourself and check with cde_dev_ai_check.",
  cde_dev_ai_check:
    "Validates a candidate output for one AI feature against the same zod schema and checks the app uses (report spec against datasets, " +
    "form fields, flow, model query, translation, doc compare bullets).",
  cde_dev_time:
    "Shifts dates of seeded records in a test project so date-dependent screens can be tested: overdueRatio makes that share of open records overdue, " +
    "shiftDays moves all their dates. Needs confirm: true.",
};

export function registerDevTools(tool: DevToolAdder, call: CdeCall): void {
  for (const [name, shape] of Object.entries(devToolShapes) as [DevToolName, Record<string, z.ZodType>][]) {
    const destructive = name === "cde_dev_project" || name === "cde_dev_time" || name === "cde_dev_seed";
    tool(name, DESCRIPTIONS[name], shape, (a) => call("POST", `/dev/tools/${name}`, a), {
      write: name !== "cde_dev_health" && name !== "cde_dev_ai_check",
      dev: true,
      destructive,
    });
  }
}
