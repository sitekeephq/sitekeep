/**
 * IFC version comparison (Collaboration Pro "change visualization"): GlobalId-based
 * added / removed / changed elements between two IFC versions, with property-level changes and
 * change groups (storey, class, property) when both indexes are in format 2. The change summary
 * is deterministic; the AI only words it ("Değişiklik özeti").
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  ifcClassLabel,
  type CompareSummaryDto,
  type VersionCompareDto,
} from "@sitekeep/shared";
import type { AppDeps, ResolvedDeps } from "../../app/deps.js";
import { audit } from "../../core/platform/audit.js";
import { AiError, resolveProvider } from "../../ai/provider.js";
import { aiCompareSummary, summaryCache } from "../../model/ai.js";
import { summaryBullets } from "../../model/diff.js";
import { ensureIndexJob } from "../../model/service.js";
import { DEFAULT_LANGUAGE, intlLocale, labelFor, requestLanguage, tFor } from "../../i18n/index.js";
import { abortOnClose, compareOf, loadComparePair } from "../../model/compare.js";
import { errorText } from "../service.js";

export { ensureIndexJob };
export { diffIndexes } from "../../model/compare.js";

export async function compareRoutes(api: FastifyInstance, deps: AppDeps) {
  const { db } = deps;

  api.get<{ Params: { pid: string }; Querystring: { from?: string; to?: string; rebuild?: string } }>(
    "/projects/:pid/compare",
    async (req): Promise<VersionCompareDto> => {
      const p = await loadComparePair(deps, req.params.pid, req.query.from, req.query.to, req.user!, req.query.rebuild === "1");
      return compareOf(p);
    },
  );

  /** Grouped change summary; with ai (default) the project's model words it, else deterministic only. */
  api.post<{ Params: { pid: string } }>("/projects/:pid/compare/summary", async (req, reply): Promise<CompareSummaryDto> => {
    const body = z.object({ from: z.string(), to: z.string(), ai: z.boolean().default(true), refresh: z.boolean().optional() }).parse(req.body);
    const p = await loadComparePair(deps, req.params.pid, body.from, body.to, req.user!);
    const c = compareOf(p);
    const groups = c.groups ?? [];
    const out: CompareSummaryDto = {
      from: { versionId: c.from.versionId, fileName: c.from.fileName, version: c.from.version },
      to: { versionId: c.to.versionId, fileName: c.to.fileName, version: c.to.version },
      counts: { added: c.added.length, changed: c.changed.length, removed: c.removed.length, unchanged: c.unchanged },
      detailed: !!c.detailed,
      groups,
      bullets: summaryBullets(groups),
      ai: null,
      source: "deterministic",
    };
    if (!body.ai || !groups.length) return out;
    const key = `${c.from.versionId}|${c.to.versionId}`;
    const cached = body.refresh ? undefined : summaryCache.get(key);
    if (cached) return { ...out, ai: cached, source: "ai", cached: true };
    let provider;
    try {
      provider = await resolveProvider(db, (deps as ResolvedDeps).secretKey, p.b.a.project.id);
    } catch (e) {
      if (e instanceof AiError) return { ...out, aiError: errorText(e, requestLanguage(req)) };
      throw e;
    }
    const ac = abortOnClose(reply);
    try {
      const head =
        `Dosya: ${c.to.fileName}, V${c.from.version} → V${c.to.version}. ` + // i18n-ok: sent to the language model
        `Toplam: ${c.added.length} eklendi, ${c.removed.length} silindi, ${c.changed.length} değişti, ${c.unchanged} aynı.`; // i18n-ok: sent to the language model
      const ai = await aiCompareSummary(provider, head, groups, ac.signal);
      if (c.detailed) summaryCache.set(key, ai);
      await audit(db, {
        projectId: p.b.a.project.id,
        userId: p.b.a.user.id,
        action: "ai.compare_summary",
        targetType: "file_version",
        targetId: c.to.versionId,
        details: { from: c.from.versionId, provider: provider.name, model: ai.model },
      });
      return { ...out, ai, source: "ai" };
    } catch (e) {
      return { ...out, aiError: errorText(e, requestLanguage(req)) };
    } finally {
      ac.done();
    }
  });

  /** Printable comparison report (summary + tables); the browser saves it as PDF. */
  api.get<{ Params: { pid: string }; Querystring: { from?: string; to?: string } }>("/projects/:pid/compare/report", async (req, reply) => {
    const p = await loadComparePair(deps, req.params.pid, req.query.from, req.query.to, req.user!);
    const c = compareOf(p);
    const ai = summaryCache.get(`${c.from.versionId}|${c.to.versionId}`) ?? null;
    reply.header("content-type", "text/html; charset=utf-8");
    reply.header("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:");
    return compareReportHtml(c, ai, p.b.a.project.name, requestLanguage(req));
  });
}

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

/** Self-contained HTML report of a comparison (print → PDF). */
export function compareReportHtml(
  c: VersionCompareDto,
  ai: { bullets: { text: string }[]; model: string } | null,
  projectName: string,
  lang: string = DEFAULT_LANGUAGE,
): string {
  const t = tFor(lang);
  const groups = c.groups ?? [];
  const title = t("doccompare:modelReport.title", { file: c.to.fileName, from: c.from.version, to: c.to.version });
  const bullets = (ai?.bullets ?? groups.slice(0, 12).map((g) => ({ text: g.text })))
    .map((b) => `<li>${esc(b.text)}</li>`)
    .join("");
  const classRows = Object.entries(c.byClass)
    .filter(([, n]) => n.added + n.changed + n.removed > 0)
    .sort((x, y) => y[1].added + y[1].changed + y[1].removed - (x[1].added + x[1].changed + x[1].removed))
    .map(
      ([cls, n]) =>
        `<tr><td>${esc(ifcClassLabel(cls, lang))} <span class="m">${esc(cls)}</span></td><td>${n.added}</td><td>${n.changed}</td><td>${n.removed}</td><td>${n.unchanged}</td></tr>`,
    )
    .join("");
  const groupRows = groups
    .map((g) => {
      const names = g.guids
        .slice(0, 8)
        .map((guid) => esc(c.elements[guid]?.[1] ?? guid))
        .join(", ");
      const values =
        g.prop && !g.mixed && g.kind === "changed" && g.prop !== "Konum" && g.prop !== "Diğer" // i18n-ok: group names written by model/diff
          ? `<div class="m">${esc(g.from ?? "—")} → ${esc(g.to ?? "—")}</div>`
          : "";
      return `<tr><td>${esc(labelFor(lang, "modelChange", g.kind))}</td><td>${esc(g.storey ?? "—")}</td><td>${esc(ifcClassLabel(g.class, lang))}</td><td>${esc(g.prop ?? "")}${values}</td><td>${g.count}</td><td class="s">${names}${g.count > 8 ? " …" : ""}</td></tr>`;
    })
    .join("");
  const stamp = new Date().toLocaleString(intlLocale(lang), { timeZone: process.env.REPORT_TZ || "Europe/Istanbul" });
  const noChanges = esc(t("doccompare:modelReport.noChanges"));
  return `<!doctype html><html lang="${esc(lang)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
:root{--text:#111827;--muted:#5b6472;--border:#e5e7eb;--surface:#fff;--soft:#f6f7f9;--primary:#3b6fb5;--ok:#15803d;--warn:#92400e;--danger:#b91c1c}
@media (prefers-color-scheme: dark){:root{--text:#f6f7f9;--muted:#b8c4d6;--border:#22395c;--surface:#0a1f3d;--soft:#0f2748;--primary:#5b9bf0;--ok:#4ade80;--warn:#fbbf24;--danger:#f87171}}
@media print{:root{--text:#111827;--muted:#5b6472;--border:#d0d5dd;--surface:#fff;--soft:#f6f7f9;--primary:#3b6fb5;--ok:#15803d;--warn:#92400e;--danger:#b91c1c}.noprint{display:none}}
body{font-family:"Segoe UI",Arial,sans-serif;color:var(--text);background:var(--surface);margin:0 auto;padding:16px;max-width:1100px}
h1{font-size:20px;margin:0 0 4px}h2{font-size:15px;margin:24px 0 8px;color:var(--primary)}
.m{color:var(--muted);font-size:12px}.s{font-size:12px;word-break:break-word}
.kpis{display:flex;gap:12px;flex-wrap:wrap;margin:16px 0}.kpi{border:1px solid var(--border);border-radius:8px;padding:8px 14px;background:var(--soft)}
.kpi b{display:block;font-size:20px}.add b{color:var(--ok)}.chg b{color:var(--warn)}.rem b{color:var(--danger)}
.wrap{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:13px}th,td{border-bottom:1px solid var(--border);padding:5px 6px;text-align:left;vertical-align:top}
th{background:var(--soft)}ul{padding-left:20px}li{margin:4px 0}
button{font:inherit;padding:6px 14px;border:1px solid var(--border);border-radius:8px;background:var(--soft);color:var(--text);cursor:pointer}
</style></head><body>
<div class="noprint" style="float:right"><button onclick="window.print()">${esc(t("doccompare:modelReport.print"))}</button></div>
<h1>${esc(title)}</h1>
<div class="m">${esc(projectName)} · ${esc(stamp)}${c.from.fileName !== c.to.fileName ? ` · ${esc(c.from.fileName)} → ${esc(c.to.fileName)}` : ""}</div>
<div class="kpis"><div class="kpi add"><b>${c.added.length}</b>${esc(t("doccompare:modelReport.added"))}</div><div class="kpi chg"><b>${c.changed.length}</b>${esc(t("doccompare:modelReport.changed"))}</div><div class="kpi rem"><b>${c.removed.length}</b>${esc(t("doccompare:modelReport.removed"))}</div><div class="kpi"><b>${c.unchanged}</b>${esc(t("doccompare:modelReport.unchanged"))}</div></div>
<h2>${esc(t("doccompare:modelReport.summary"))}${ai ? ` <span class="m">${esc(t("doccompare:modelReport.aiModel", { model: ai.model }))}</span>` : ""}</h2>
${bullets ? `<ul>${bullets}</ul>` : `<p class="m">${noChanges}</p>`}
${c.detailed ? "" : `<p class="m">${esc(t("doccompare:modelReport.oldIndex"))}</p>`}
<h2>${esc(t("doccompare:modelReport.byClass"))}</h2>
<div class="wrap"><table><thead><tr><th>${esc(t("doccompare:modelReport.columns.class"))}</th><th>${esc(t("doccompare:modelReport.added"))}</th><th>${esc(t("doccompare:modelReport.changed"))}</th><th>${esc(t("doccompare:modelReport.removed"))}</th><th>${esc(t("doccompare:modelReport.unchanged"))}</th></tr></thead><tbody>${classRows || `<tr><td colspan="5" class="m">${noChanges}</td></tr>`}</tbody></table></div>
${groups.length ? `<h2>${esc(t("doccompare:modelReport.groups"))}</h2><div class="wrap"><table><thead><tr><th>${esc(t("doccompare:modelReport.columns.kind"))}</th><th>${esc(t("doccompare:modelReport.columns.storey"))}</th><th>${esc(t("doccompare:modelReport.columns.class"))}</th><th>${esc(t("doccompare:modelReport.columns.property"))}</th><th>${esc(t("doccompare:modelReport.columns.count"))}</th><th>${esc(t("doccompare:modelReport.columns.elements"))}</th></tr></thead><tbody>${groupRows}</tbody></table></div>` : ""}
</body></html>`;
}
