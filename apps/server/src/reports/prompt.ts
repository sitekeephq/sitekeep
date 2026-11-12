// i18n-ok-file: prompt library of the AI report builder (sent to the language model in PROMPT_LANGUAGE)
import {
  REPORT_BUCKETS,
  REPORT_FILTER_OPS,
  REPORT_HTML_MAX_BYTES,
  REPORT_MAX_ROWS,
  REPORT_METRIC_OPS,
  termsInstructionTr,
  type ReportDatasetDto,
  type ReportDraft,
  type ReportModule,
  type ReportTemplateDto,
} from "@sitekeep/shared";
import type { ReportLlmMessage } from "./llm.js";
import { routeDatasets } from "./router.js";
import { PROMPT_LANGUAGE } from "./prompt-language.js";
import { reportTemplates } from "./templates.js";

export { PROMPT_LANGUAGE };

/**
 * Rough token count of a prompt for the local model (Qwen3 tokenizer on Turkish text, field lists
 * and JSON: about 3 characters per token, measured against Ollama's prompt_eval_count).
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

/** Upper bound of the system prompt: the 16K context also holds the current dashboard and the answer. */
export const SYSTEM_PROMPT_TOKEN_CAP = 4500;
/** Values listed per field before "…". */
const MAX_VALUES = 12;

function describeDatasets(datasets: ReportDatasetDto[], detail: "full" | "short"): string {
  return datasets
    .map((d) => {
      const fields = d.fields
        .map((f) => {
          const codes = f.values ? Object.keys(f.values) : [];
          const extra =
            detail === "full"
              ? [f.description, codes.length ? `values: ${codes.slice(0, MAX_VALUES).join("|")}${codes.length > MAX_VALUES ? "|…" : ""}` : ""]
                  .filter(Boolean)
                  .join("; ")
              : "";
          return `- ${f.name} (${f.type}) ${f.label}${extra ? ` [${extra}]` : ""}`;
        })
        .join("\n");
      const dyn = d.dynamicPrefix ? `\n- ${d.dynamicPrefix}<Ad> (string) ör. ${d.dynamicPrefix}Durum` : "";
      return `### ${d.name} — ${d.label}\n${d.description}\n${fields}${dyn}`;
    })
    .join("\n\n");
}

/** The template shown as the example: one of the primary dataset's module, else the first one. */
export function exampleFor(datasets: ReportDatasetDto[]): ReportTemplateDto {
  const names = new Set(datasets.map((d) => d.name));
  const fits = (t: ReportTemplateDto) => t.queries.every((q) => names.has(q.spec.dataset));
  const templates = reportTemplates(PROMPT_LANGUAGE);
  for (const d of datasets) {
    const t = templates.find((x) => x.module === d.module && fits(x)) ?? templates.find((x) => x.module === d.module);
    if (t) return t;
  }
  return templates[0]!;
}

function exampleBlock(example: ReportTemplateDto): string {
  return `## Example
User: "${example.name}"
Answer:
${JSON.stringify({ name: example.name, description: example.description, queries: example.queries, html: example.html.replace(/\n[ \t]+/g, "\n") })}`;
}

/** System prompt for the given (already selected) datasets. */
export function buildSystemPrompt(
  datasets: ReportDatasetDto[],
  project: { code: string; name: string },
  opts: { example?: ReportTemplateDto; detail?: "full" | "short"; others?: string[] } = {},
): string {
  const example = opts.example ?? exampleFor(datasets);
  const others = opts.others?.length ? `\nOther datasets exist (${opts.others.join(", ")}) but are not described here; use only the ones above.` : "";
  return `You build report dashboards for "SiteKeep", a construction common data environment (project ${project.code} – ${project.name}).
The user writes in Turkish. All visible texts (name, description, titles, labels) are Turkish. ${termsInstructionTr()}
Answer with ONE JSON object and nothing else:

{"name": "<short Turkish title>", "description": "<one Turkish sentence>", "queries": [{"id": "<identifier>", "spec": <query spec>}], "html": "<dashboard HTML body fragment>"}

## Data: datasets and fields
Queries run on the server with the viewer's permissions. Use ONLY these datasets and fields (name (type) label [notes]):

${describeDatasets(datasets, opts.detail ?? "full")}${others}

## Query spec
{"dataset": "<name>",
 "filters": [{"field": "<field>", "op": "${REPORT_FILTER_OPS.join("|")}", "value": <value>}],
 "groupBy": ["<field>", {"field": "<date field>", "bucket": "${REPORT_BUCKETS.join("|")}"}],
 "metrics": [{"op": "${REPORT_METRIC_OPS.join("|")}", "field": "<number field; optional for count>", "as": "<output column name>"}],
 "fields": ["<field>", ...],        // only for raw rows (no groupBy/metrics)
 "sort": [{"field": "<output column>", "dir": "asc|desc"}],
 "limit": <1..${REPORT_MAX_ROWS}>}
Rules:
- "in" takes an array, "between" takes [low, high] (inclusive), "isNull" takes true/false, "contains" is case-insensitive text search.
- Date filter values: "YYYY-MM-DD", "today", "yesterday", or relative "-7d", "-4w", "-3m", "-1y", "+7d".
- Output rows of grouped queries have the groupBy fields plus one column per metric. Metric column names: "count" for {"op":"count"}, otherwise "<op>_<field>" unless you give "as".
- groupBy without metrics counts rows ("count"). Date buckets give "YYYY-MM-DD" (day, week = Monday) or "YYYY-MM" (month).
- Grouped results are sorted by the first metric descending, or by date bucket ascending; add "sort" to change it.
- Use the codes listed in values in filters (e.g. "open", "critical"), never Turkish labels. Use boolean true/false for boolean fields.
- Query ids: letters/digits/underscore, start with a letter (e.g. "byCompany"). At most 20 queries; prefer few, aggregated queries.

## HTML
- Write a body fragment (no <html>/<head>/<body>), at most ${Math.round(REPORT_HTML_MAX_BYTES / 1024)} KB. Every visible text in Turkish.
- It runs in a sandboxed iframe with NO network: no fetch/XHR, no CDN, no external images/fonts/scripts, no links that navigate. All data comes from window.CDE. Inline event attributes (onclick=…) are blocked: use addEventListener.
- Render inside CDE.onData(function (d) { ... }); — it runs once at load and again on every refresh. d.<queryId> is the array of result rows.
- Available CSS classes: .grid (responsive card grid), .grid-2, .grid-3, .card, .kpis (row of KPI tiles), .muted, .small, .badge (+ .ok .warn .danger .info). Plain <table> is styled.
- CSS variables (light/dark aware): --bg --surface --surface-2 --border --text --muted --primary --primary-soft --ok --warn --danger --radius and categorical chart colours --c1 … --c8. Do not hard-code colours; do not use vh units.
- Chart helper (renders SVG; target is a CSS selector or element; it clears the target):
  CDE.bar(target, rows, {x, y, series?, stacked?, horizontal?, title?, colors?, format?, seriesLabels?})   // y may be an array of columns
  CDE.line(target, rows, {x, y, series?, area?, title?, seriesLabels?})
  CDE.pie(target, rows, {label, value, donut? (default true), title?, colors?})
  CDE.kpi(target, {label, value, sub?, tone?: "ok"|"warn"|"danger", format?: "number"|"bytes"|"percent"})
  CDE.table(target, rows, {columns?: [{field, label, format?: "number"|"date"|"datetime"|"bytes"}], title?, limit?, empty?})
  CDE.sum(rows, column="count"), CDE.find(rows, column, value), CDE.label(field, code) → Turkish label,
  CDE.fmt.number(n) / .bytes(n) / .date(s) / .datetime(s) / .percent(ratio), CDE.project.name, CDE.generatedAt.
  Charts translate value codes, true/false (Evet/Hayır) and dates automatically. colors maps a category or series value to a CSS colour, e.g. {"critical": "var(--danger)"}.
- Keep it simple: a title (<h1>), a .kpis row if useful, then .card elements in a .grid, each holding one chart or table.

${exampleBlock(example)}
`;
}

export interface PromptPlan {
  messages: ReportLlmMessage[];
  /** Datasets described in the system prompt. */
  datasets: string[];
  /** Keyword groups that matched the request. */
  matched: string[];
  /** Estimated tokens of the system prompt. */
  systemTokens: number;
  example: string;
}

/**
 * Messages for a new dashboard or an iterative edit, with only the datasets the request needs:
 * routed by keywords, the module the builder was opened from and the edited dashboard's queries.
 * The system prompt stays under SYSTEM_PROMPT_TOKEN_CAP (descriptions are dropped first, then
 * trailing datasets).
 */
export function planMessages(
  catalog: ReportDatasetDto[],
  project: { code: string; name: string },
  prompt: string,
  current?: ReportDraft,
  opts: { module?: ReportModule; datasets?: string[] } = {},
): PromptPlan {
  const route = routeDatasets({
    prompt,
    module: opts.module,
    moduleDatasets: opts.module ? catalog.filter((d) => d.module === opts.module).map((d) => d.name) : undefined,
    current: current?.queries,
    datasets: opts.datasets,
    available: catalog.map((d) => d.name),
  });
  let chosen = route.datasets.map((n) => catalog.find((d) => d.name === n)!).filter(Boolean);
  const others = catalog.filter((d) => !chosen.includes(d)).map((d) => d.name);
  let system = buildSystemPrompt(chosen, project, { others });
  let detail: "full" | "short" = "full";
  while (estimateTokens(system) > SYSTEM_PROMPT_TOKEN_CAP) {
    if (detail === "full") detail = "short";
    else if (chosen.length > 1) chosen = chosen.slice(0, -1);
    else break;
    system = buildSystemPrompt(chosen, project, { others: catalog.filter((d) => !chosen.includes(d)).map((d) => d.name), detail });
  }
  const msgs: ReportLlmMessage[] = [{ role: "system", content: system }];
  const request = current
    ? `${currentBlock(current)}\n\nChange request (Turkish): ${prompt}\n\nReturn the complete updated JSON object.`
    : `Request (Turkish): ${prompt}\n\nReturn the JSON object.`;
  msgs.push({ role: "user", content: request });
  return {
    messages: msgs,
    datasets: chosen.map((d) => d.name),
    matched: route.matched,
    systemTokens: estimateTokens(system),
    example: exampleFor(chosen).id,
  };
}

function currentBlock(current: ReportDraft): string {
  return `Current dashboard (modify it; keep what the user does not ask to change):
${JSON.stringify({ name: current.name, description: current.description ?? "", queries: current.queries, html: current.html })}`;
}

/** Messages for a new dashboard or an iterative edit of an existing one (routed datasets). */
export function buildMessages(
  datasets: ReportDatasetDto[],
  project: { code: string; name: string },
  prompt: string,
  current?: ReportDraft,
  opts: { module?: ReportModule; datasets?: string[] } = {},
): ReportLlmMessage[] {
  return planMessages(datasets, project, prompt, current, opts).messages;
}

export function repairMessage(errors: string[]): ReportLlmMessage {
  return {
    role: "user",
    content: `Your answer could not be used. Fix these problems and return the complete corrected JSON object only:\n- ${errors
      .slice(0, 30)
      .join("\n- ")}`,
  };
}

/**
 * "Yapay zekâ ile onar": only the broken query, the error and the dataset's fields go to the model
 * (no dashboard HTML, no other datasets), so the call stays small.
 */
export function repairQueryMessages(
  dataset: ReportDatasetDto,
  queryId: string,
  spec: unknown,
  error: string,
  missing: string[] = [],
): ReportLlmMessage[] {
  const example = missing.length ? `{"replace": {${missing.map((m) => `"${m}": "<field name from the list or null>"`).join(", ")}}, "note": "<one short Turkish sentence>"}` : "";
  return [
    {
      role: "system",
      content: `You fix one saved report query of "SiteKeep". The dataset's fields changed: some fields the query uses no longer exist.
For every missing field pick the field below with the same meaning (or null when there is none). Answer with ONE JSON object and nothing else:
{"replace": {"<missing field>": "<existing field or null>"}, "note": "<one short Turkish sentence: what you changed>"}
The rest of the query (filters, grouping, metrics, output names, sort, limit) is kept as saved.
If renaming cannot fix it, answer {"spec": <complete corrected query spec>, "note": "..."} instead (same spec format; filter ops ${REPORT_FILTER_OPS.join("|")}, metric ops ${REPORT_METRIC_OPS.join("|")}, date buckets ${REPORT_BUCKETS.join("|")}).

${describeDatasets([dataset], "full")}`,
    },
    {
      role: "user",
      content: `Query "${queryId}":\n${JSON.stringify(spec)}\n\nError (Turkish): ${error}${missing.length ? `\nMissing fields: ${missing.join(", ")}\nAnswer like: ${example}` : ""}\n\nReturn the JSON object.`,
    },
  ];
}
