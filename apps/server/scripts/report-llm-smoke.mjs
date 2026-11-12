#!/usr/bin/env node
/**
 * Opt-in smoke test of the AI report builder against a real local model (NOT part of npm test).
 *
 *   npm run build
 *   AI_ENABLED=1 AI_MODEL=qwen3-8b-16k node apps/server/scripts/report-llm-smoke.mjs "Cevap bekleyen yazılar firma bazında"
 *   … --module correspondence     (as if opened from the module page's "Rapor" shortcut)
 *   … --out preview.html          (standalone preview with empty data)
 *
 * Uses AI_BASE_URL / AI_MODEL / AI_API_KEY like the server (default: local Ollama, qwen3:8b; Qwen3 runs
 * with reasoning_effort "none"). Builds the same routed system prompt as POST /reports/generate (only
 * the datasets the request needs, as for a project admin), validates the answer with the server's checks
 * and, like the server, sends one repair round when it is invalid. No database is needed.
 */
import { writeFileSync } from "node:fs";
import { buildReportSrcdoc } from "@sitekeep/shared";
import { reportDatasets } from "../dist/reports/all.js";
import { extractJson, reportLlmFromEnv, stripThinking } from "../dist/reports/llm.js";
import { planMessages, repairMessage } from "../dist/reports/prompt.js";
import { checkSpec } from "../dist/reports/engine.js";
import { normalizeQueryRefs, queryRefsSchema, zodMessages } from "../dist/reports/spec.js";

const args = process.argv.slice(2);
const take = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args.splice(i, 2)[1] : null;
};
const out = take("--out");
const module = take("--module") ?? undefined;
const prompt = args.join(" ") || "Firmalara göre açık sorun sayısı ve öncelik dağılımı";

const llm = reportLlmFromEnv({ AI_ENABLED: "1", ...process.env });
if (!llm) {
  console.error("AI is disabled (AI_ENABLED=0).");
  process.exit(1);
}
const plan = planMessages(reportDatasets.describe(), { code: "DEMO", name: "Smoke test" }, prompt, undefined, { module });
const messages = plan.messages;
console.error(
  `model: ${process.env.AI_MODEL || "qwen3:8b"} · datasets: ${plan.datasets.join(", ")} · example: ${plan.example} · ` +
    `system prompt ${messages[0].content.length} chars (~${plan.systemTokens} tokens) · prompt: ${prompt}`,
);

function validate(text) {
  let draft;
  try {
    draft = extractJson(text);
  } catch (e) {
    return { draft: null, problems: [`${e.message} Yalnızca tek bir JSON nesnesi döndür.`] };
  }
  const problems = [];
  const q = queryRefsSchema.safeParse(normalizeQueryRefs(draft.queries));
  if (!q.success) problems.push(...zodMessages(q.error, "queries."));
  else
    for (const ref of q.data) {
      const def = reportDatasets.get(ref.spec.dataset);
      if (!def) problems.push(`query '${ref.id}': '${ref.spec.dataset}' diye bir veri kümesi yok.`);
      else problems.push(...checkSpec(ref.spec, def).map((m) => `query '${ref.id}': ${m}`));
      if (typeof draft.html === "string" && !new RegExp(`[.\\[]\\s*["']?${ref.id}\\b`).test(draft.html))
        problems.push(`html does not use query '${ref.id}': read its rows as d.${ref.id} inside CDE.onData.`);
    }
  if (typeof draft.html !== "string" || !draft.html) problems.push("html missing");
  return { draft, problems, queries: q.success ? q.data : [] };
}

const started = Date.now();
let result;
for (let attempt = 1; attempt <= 2; attempt++) {
  const t0 = Date.now();
  const text = await llm.complete(messages);
  console.error(`attempt ${attempt}: answer in ${((Date.now() - t0) / 1000).toFixed(1)} s, ${text.length} chars`);
  result = validate(text);
  result.attempt = attempt;
  if (!result.problems.length) break;
  console.error(`  problems: ${result.problems.slice(0, 6).join(" | ")}`);
  messages.push({ role: "assistant", content: stripThinking(text).slice(0, 60_000) }, repairMessage(result.problems));
}
const total = ((Date.now() - started) / 1000).toFixed(1);
if (result.draft) {
  console.log(JSON.stringify({ name: result.draft.name, description: result.draft.description, queries: result.draft.queries }, null, 2));
  console.log(`html: ${result.draft.html?.length ?? 0} chars`);
}
console.log(
  result.problems.length
    ? `INVALID after ${result.attempt} attempt(s), ${total} s:\n- ${result.problems.join("\n- ")}`
    : `OK: valid draft after ${result.attempt} attempt(s), ${total} s`,
);

if (out && result.draft && typeof result.draft.html === "string") {
  const data = Object.fromEntries((result.queries ?? []).map((r) => [r.id, []]));
  writeFileSync(
    out,
    buildReportSrcdoc({ html: result.draft.html, data, project: { id: "demo", code: "DEMO", name: "Smoke test" }, generatedAt: new Date().toISOString() }),
  );
  console.error(`preview written to ${out}`);
}
process.exit(result.problems.length ? 3 : 0);
