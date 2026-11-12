/**
 * Kapasite raporu: a self-contained HTML page (print → PDF) and the JSON the administrator sends to
 * 7D by hand. Numbers only: no project, file or person names (docs/onprem/kapasite.md §6.4).
 */
import {
  CAPACITY_CONCURRENCY,
  CAPACITY_LIMITS,
  CAPACITY_MEASURED_AT,
  CAPACITY_TIERS,
  capacityTierLabel,
  type AdminCapacityDto,
  type CapacityRunDto,
  type StatusLevel,
} from "@sitekeep/shared";

import { intlLocale, tFor } from "../../i18n/index.js";
import { editionName } from "../../app/module-ids.js";

const GiB = 1024 ** 3;

const esc = (v: unknown) =>
  String(v ?? "—").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Same wording as Kapasite Rehberi: "500 GB", "1–2 TB". */
function diskRange(gb: [number, number] | null): string {
  if (!gb) return "—";
  return gb[0] === gb[1] ? `${gb[0]} GB` : `${gb[0] / 1000}–${gb[1] / 1000} TB`;
}

/** The report in `lang` (the requester's): texts, numbers and dates. */
export function capacityReportHtml(run: CapacityRunDto, capacity: AdminCapacityDto, lang: string): string {
  const t = tFor(lang);
  const locale = intlLocale(lang);
  const num = (v: number, digits = 0) => v.toLocaleString(locale, { maximumFractionDigits: digits, minimumFractionDigits: digits });
  const pct = (v: number, digits = 0) => t("admin:capacity.report.percent", { value: num(v * 100, digits) });
  const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString(locale, { timeZone: "Europe/Istanbul" }) : "—");
  const level = (l: StatusLevel) => t(`admin:capacity.report.level.${l}`);
  const status = (s: CapacityRunDto["status"]) => t(`admin:capacity.report.status.${s}`);

  /** Bar chart of p95 per step with the limit line; inline SVG so the file needs nothing else. */
  const stepsChart = (): string => {
    if (!run.steps.length) return "";
    const w = 640;
    const h = 200;
    const pad = 32;
    const max = Math.max(CAPACITY_LIMITS.p95Ms * 1.3, ...run.steps.map((s) => s.p95Ms));
    const bw = (w - pad * 2) / run.steps.length;
    const y = (ms: number) => h - pad - (ms / max) * (h - pad * 2);
    const bars = run.steps
      .map((s, i) => {
        const x = pad + i * bw + bw * 0.15;
        return `<rect x="${x}" y="${y(s.p95Ms)}" width="${bw * 0.7}" height="${h - pad - y(s.p95Ms)}" fill="${s.passed ? "#0f7b63" : "#c2410c"}"/>
<text x="${x + bw * 0.35}" y="${h - pad + 14}" text-anchor="middle">${s.users}</text>
<text x="${x + bw * 0.35}" y="${y(s.p95Ms) - 4}" text-anchor="middle">${num(s.p95Ms)}</text>`;
      })
      .join("");
    const limit = y(CAPACITY_LIMITS.p95Ms);
    return `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(t("admin:capacity.report.chartLabel"))}">
<line x1="${pad}" x2="${w - pad}" y1="${limit}" y2="${limit}" stroke="#c2410c" stroke-dasharray="4 4"/>
<text x="${pad}" y="${limit - 4}" text-anchor="start">${esc(t("admin:capacity.report.chartLimit", { ms: CAPACITY_LIMITS.p95Ms }))}</text>
${bars}
<text x="${w / 2}" y="${h - 4}" text-anchor="middle">${esc(t("admin:capacity.report.chartUsers"))}</text>
</svg>`;
  };

  const hw = run.hardware;
  const findings = run.findings.length ? run.findings : capacity.findings;
  const title = run.mode === "quick" ? t("admin:capacity.report.modeQuick") : t("admin:capacity.report.modeLoad");
  const ratio = { ratio: num(capacity.concurrency, 2), pct: pct(capacity.concurrency) };
  return `<!doctype html>
<html lang="${esc(lang)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(t("admin:capacity.report.pageTitle"))}</title>
<style>
body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color:#172033;margin:0;background:#fff}
main{max-width:760px;margin:0 auto;padding:32px 16px}
h1{font-size:24px;margin:0 0 4px}h2{font-size:16px;margin:28px 0 8px}
.muted{color:#5d6b80;font-size:13px}
.demo{background:#fff4e5;border:1px solid #f5c27a;padding:10px 12px;border-radius:8px;margin:16px 0;font-size:14px}
table{border-collapse:collapse;width:100%;font-size:13px}th,td{border-bottom:1px solid #dde3ea;padding:6px 8px;text-align:left;vertical-align:top}
th{color:#5d6b80;font-weight:600}.ok{color:#0f7b63}.warn{color:#b45309}.danger{color:#c2410c}
.big{font-size:28px;font-weight:700}svg{width:100%;height:auto;font-size:11px;fill:#5d6b80}
@media print{main{padding:0}}
</style></head><body><main>
<h1>${esc(t("admin:capacity.report.heading", { mode: title }))}</h1>
<div class="muted">${esc(editionName())} ${esc(run.appVersion)} · ${esc(when(run.startedAt))} · ${esc(status(run.status))}</div>
${run.demo ? `<div class="demo"><b>${esc(t("admin:capacity.report.demoTitle"))}</b> ${esc(t("admin:capacity.report.demoText"))}</div>` : ""}
${
  run.result?.concurrent != null
    ? `<h2>${esc(t("admin:capacity.report.result"))}</h2><div class="big">${esc(t("admin:capacity.report.resultBig", { concurrent: run.result.concurrent, registered: run.result.registered ?? "—" }))}</div>
<div class="muted">${esc(
        run.result.stopReason
          ? t("admin:capacity.report.resultNoteStopped", { ...ratio, reason: run.result.stopReason })
          : t("admin:capacity.report.resultNoteNoLimit", ratio),
      )}</div>`
    : ""
}
<h2>${esc(t("admin:capacity.report.server"))}</h2>
<table><tbody>
<tr><th>${esc(t("admin:capacity.report.cpu"))}</th><td>${esc(hw.cpuCount)} vCPU · ${esc(hw.cpuModel)}</td></tr>
<tr><th>${esc(t("admin:capacity.report.memory"))}</th><td>${num(hw.memoryBytes / GiB, 1)} GB</td></tr>
<tr><th>${esc(t("admin:capacity.report.dataDisk"))}</th><td>${esc(
    hw.disk
      ? t("admin:capacity.report.diskValue", { total: num(hw.disk.totalBytes / GiB), free: num(hw.disk.freeBytes / GiB) })
      : t("admin:capacity.report.diskUnreadable"),
  )}</td></tr>
<tr><th>${esc(t("admin:capacity.report.os"))}</th><td>${esc(hw.os)}</td></tr>
<tr><th>${esc(t("admin:capacity.report.users"))}</th><td>${esc(t("admin:capacity.report.usersValue", { registered: capacity.counts.registered, active: capacity.counts.active }))}</td></tr>
</tbody></table>
<h2>${esc(t("admin:capacity.report.findings"))}</h2>
<table><thead><tr><th>${esc(t("admin:capacity.report.colStatus"))}</th><th>${esc(t("admin:capacity.report.colTopic"))}</th><th>${esc(t("admin:capacity.report.colAction"))}</th></tr></thead><tbody>
${findings.map((f) => `<tr><td class="${f.level}">${esc(level(f.level))}</td><td>${esc(f.title)}</td><td>${esc(f.action)}</td></tr>`).join("")}
</tbody></table>
${
  run.checks.length
    ? `<h2>${esc(t("admin:capacity.report.measurements"))}</h2><table><tbody>${run.checks
        .map((c) => `<tr><th>${esc(c.label)}</th><td class="${c.level ?? ""}">${esc(c.value)}</td></tr>`)
        .join("")}</tbody></table>`
    : ""
}
${
  run.steps.length
    ? `<h2>${esc(t("admin:capacity.report.steps"))}</h2>${stepsChart()}
<table><thead><tr><th>${esc(t("admin:capacity.report.colUsers"))}</th><th>p50</th><th>p95</th><th>p99</th><th>${esc(t("admin:capacity.report.colRps"))}</th><th>${esc(t("admin:capacity.report.colError"))}</th><th>${esc(t("admin:capacity.report.colCpu"))}</th><th>${esc(t("admin:capacity.report.colRam"))}</th><th></th></tr></thead><tbody>
${run.steps
  .map(
    (s) =>
      `<tr><td>${s.users}</td><td>${num(s.p50Ms)} ms</td><td>${num(s.p95Ms)} ms</td><td>${num(s.p99Ms)} ms</td><td>${num(s.rps, 1)}</td><td>${pct(s.errorRate, 2)}</td><td>${pct(s.cpu)}</td><td>${pct(s.memory)}</td><td class="${s.passed ? "ok" : "danger"}">${esc(s.passed ? t("admin:capacity.report.stepPassed") : t("admin:capacity.report.stepLimit"))}</td></tr>`,
  )
  .join("")}
</tbody></table>
<div class="muted">${esc(
        t("admin:capacity.report.limits", {
          p95: CAPACITY_LIMITS.p95Ms,
          p99: CAPACITY_LIMITS.p99Ms,
          error: pct(CAPACITY_LIMITS.errorRate, 1),
          cpu: pct(CAPACITY_LIMITS.cpu),
          ram: pct(CAPACITY_LIMITS.freeMemory),
        }),
      )}</div>`
    : ""
}
<h2>${esc(t("admin:capacity.report.tiers"))}</h2>
<table><thead><tr><th>${esc(t("admin:capacity.report.colTier"))}</th><th>${esc(t("admin:capacity.report.colRegistered"))}</th><th>${esc(t("admin:capacity.report.colConcurrent"))}</th><th>vCPU</th><th>RAM</th><th>${esc(t("admin:capacity.report.colDisk"))}</th></tr></thead><tbody>
${CAPACITY_TIERS.map(
  (tier) =>
    `<tr${tier.id === capacity.hardwareTier ? ' style="background:#d8f2ea"' : ""}><td>${esc(capacityTierLabel(tier.id, lang))}</td><td>${tier.maxUsers ? `≤ ${tier.maxUsers}` : "500+"}</td><td>${tier.concurrent}</td><td>${tier.vcpu ?? "—"}</td><td>${tier.ramGb ? `${tier.ramGb} GB` : "—"}</td><td>${diskRange(tier.diskGb)}</td></tr>`,
).join("")}
</tbody></table>
<div class="muted">${esc(CAPACITY_MEASURED_AT ? t("admin:capacity.report.measuredAt", { date: CAPACITY_MEASURED_AT }) : t("admin:capacity.report.estimated"))} ${esc(
    t("admin:capacity.report.concurrencyRatio", { pct: pct(CAPACITY_CONCURRENCY) }),
  )}</div>
</main></body></html>`;
}

/** The package for 7D: the run and the card, numbers only (no disk path, no names). */
export function capacityReportJson(run: CapacityRunDto, capacity: AdminCapacityDto) {
  const strip = <T extends { disk: { path: string } | null }>(hw: T) => ({ ...hw, disk: hw.disk ? { ...hw.disk, path: undefined } : null });
  return {
    kind: "7d-cde-capacity-report", // file format id from the former product name; saved reports carry it
    version: 1,
    generatedAt: new Date().toISOString(),
    run: { ...run, startedBy: undefined, hardware: strip(run.hardware) },
    capacity: { ...capacity, hardware: strip(capacity.hardware), lastRun: undefined, running: undefined },
  };
}
