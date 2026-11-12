import type { ReportData, ReportQueryErrorKind, ReportQueryRef } from "@sitekeep/shared";
import { HttpError } from "../core/platform/http.js";
import { DEFAULT_LANGUAGE, msg, render, tFor } from "../i18n/index.js";
import { reportDatasets, type DatasetRegistry, type ReportContext } from "./datasets.js";
import { checkSpec, executeSpec } from "./engine.js";

export interface RunResult {
  results: ReportData;
  errors: Record<string, string>;
  errorKinds: Record<string, ReportQueryErrorKind>;
}

/**
 * The message a dashboard viewer sees on the widget of a saved query that no longer fits its
 * dataset (a field was renamed or removed): short, without the full field list.
 */
export function invalidQueryMessage(brief: string[], lang: string = DEFAULT_LANGUAGE): string {
  return tFor(lang)("reports:messages.invalidSavedQuery", { problems: [...new Set(brief)].join(" ") });
}

export interface QueryProblem {
  id: string;
  status: number;
  messages: string[];
  /** Short form of `messages` for a dashboard viewer (invalidQueryMessage). */
  brief: string[];
}

/**
 * Validation problems of query refs against the registry and the caller (no data loaded), in
 * `lang`: the requester's for the UI, PROMPT_LANGUAGE when the messages go back to the model.
 */
export function queryProblems(
  queries: ReportQueryRef[],
  ctx: Pick<ReportContext, "access">,
  registry: DatasetRegistry = reportDatasets,
  lang: string = DEFAULT_LANGUAGE,
): QueryProblem[] {
  const t = tFor(lang);
  const out: QueryProblem[] = [];
  const one = (id: string, status: number, message: string) => out.push({ id, status, messages: [message], brief: [message] });
  for (const q of queries) {
    const def = registry.get(q.spec.dataset);
    if (!def) {
      one(q.id, 400, t("reports:validation.unknownDataset", { dataset: q.spec.dataset, datasets: registry.names().join(", ") }));
      continue;
    }
    const msgs = checkSpec(q.spec, def, lang);
    if (msgs.length) {
      out.push({ id: q.id, status: 400, messages: msgs, brief: checkSpec(q.spec, def, lang, { brief: true }) });
      continue;
    }
    if (def.adminOnly && !ctx.access.isProjectAdmin) {
      one(q.id, 403, t("reports:validation.adminOnly", { dataset: q.spec.dataset }));
      continue;
    }
    const denied = def.deny?.(ctx);
    if (denied) one(q.id, 403, render(lang, denied));
  }
  return out;
}

/**
 * Runs queries as the context's user.
 * - `strict`: the first problem throws (400 invalid / 403 not allowed) — the /query endpoint.
 * - otherwise problems are reported per query and the rest still run — dashboards.
 */
export async function runQueries(
  ctx: ReportContext,
  queries: ReportQueryRef[],
  opts: { strict?: boolean; registry?: DatasetRegistry; lang?: string } = {},
): Promise<RunResult> {
  const registry = opts.registry ?? reportDatasets;
  const lang = opts.lang ?? DEFAULT_LANGUAGE;
  const problems = queryProblems(queries, ctx, registry, lang);
  if (opts.strict && problems.length) {
    const p = problems.find((x) => x.status === 403) ?? problems[0]!;
    throw new HttpError(
      p.status,
      p.status === 403 ? "forbidden" : "invalid_query",
      msg("reports:errors.queryProblem", { id: p.id, problems: p.messages.join(" ") }),
      problems,
    );
  }
  const errors: Record<string, string> = {};
  const errorKinds: Record<string, ReportQueryErrorKind> = {};
  for (const p of problems) {
    errors[p.id] = p.status === 400 ? invalidQueryMessage(p.brief, lang) : p.messages.join(" ");
    errorKinds[p.id] = p.status === 400 ? "invalid" : "forbidden";
  }
  const results: ReportData = {};
  for (const q of queries) {
    if (errors[q.id]) {
      results[q.id] = [];
      continue;
    }
    const def = registry.get(q.spec.dataset)!;
    let rows;
    try {
      rows = def.loadFor ? await def.loadFor(ctx, q.spec) : await ctx.rows(q.spec.dataset, def);
    } catch (e) {
      // Scoped datasets fail per query (e.g. a model that is not indexed yet); a dashboard keeps working.
      if (opts.strict || !(e instanceof HttpError)) throw e;
      errors[q.id] = e.msg ? render(lang, e.msg) : e.message;
      errorKinds[q.id] = "failed";
      results[q.id] = [];
      continue;
    }
    results[q.id] = executeSpec(rows, q.spec, def, { now: ctx.now, timeZone: ctx.timeZone });
  }
  return { results, errors, errorKinds };
}
