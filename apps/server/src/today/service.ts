/**
 * "Günün Özeti" on the project Bugün page (docs/product/SADELESTIRME.md, 2. aşama):
 *
 *   - the deterministic summary is built on every request (no AI, shown at once);
 *   - the AI summary is written in the background by the configured model and cached per user +
 *     project + stamp (hash of the compact input). It is rewritten when the stamp changed, at most
 *     every 15 minutes (a manual "Yenile" skips the 15 minutes, not the stamp check);
 *   - without a model, "Yapay Zekâya Gönder" (task kind today_summary) runs the same route with the
 *     connected client's answer; the result is stored as the requester's summary;
 *   - with AI off only the deterministic summary exists.
 */
import { and, eq, inArray } from "drizzle-orm";
import { TODAY_SUMMARY_MIN_INTERVAL_MS, type TodaySummaryAi, type TodaySummaryDto } from "@sitekeep/shared";
import type { ProjectAccess } from "../core/security/access.js";
import { todaySummaries } from "../db/schema.js";
import { capability } from "../sdk/capabilities.js";
import type { Db } from "../db/index.js";
import { HttpError } from "../core/platform/http.js";
import { DEFAULT_LANGUAGE, isMsg, msg, render } from "../i18n/index.js";
import { AnswerProvider, overrideProvider } from "../ai/override.js";
import { resolveProvider, resolveProviderSetup, type AiProvider } from "../ai/provider.js";
import { externalClientAllowed, getAiTaskQueueSettings } from "../ai/settings.js";
import { todayIso } from "../works/service.js";
import { TODAY_SUMMARY_SYSTEM, autoSummary, compactInput, inputStamp, parseAiSummary, type CompactInput, type TodayData } from "./text.js";

export interface SummaryDeps {
  db: Db;
  secretKey: Buffer;
}

type Row = typeof todaySummaries.$inferSelect;

/** Background runs per "user:project". */
const inflight = new Map<string, Promise<void>>();

/** Resolves when no background summary is running (tests). */
export async function todaySummaryIdle(): Promise<void> {
  while (inflight.size) await Promise.all([...inflight.values()]);
}

/** How the AI summary can be made in the project (after the system mode and project policy). */
export async function summaryMode(deps: SummaryDeps, projectId: string): Promise<TodaySummaryAi> {
  try {
    await resolveProviderSetup(deps.db, deps.secretKey, projectId);
    return "provider";
  } catch (e) {
    const code = e instanceof HttpError ? e.code : "";
    if (code === "ai_off" || code === "ai_project_off") return "off";
    const q = await getAiTaskQueueSettings(deps.db);
    if (q.enabled && (await externalClientAllowed(deps.db, projectId)).ok) return "queue";
    return "none";
  }
}

async function loadRow(db: Db, userId: string, projectId: string): Promise<Row | undefined> {
  const [row] = await db
    .select()
    .from(todaySummaries)
    .where(and(eq(todaySummaries.userId, userId), eq(todaySummaries.projectId, projectId)));
  return row;
}

async function save(db: Db, userId: string, projectId: string, set: Partial<Omit<Row, "userId" | "projectId">>): Promise<void> {
  await db
    .insert(todaySummaries)
    .values({ userId, projectId, ...set })
    .onConflictDoUpdate({ target: [todaySummaries.userId, todaySummaries.projectId], set });
}

const lastFailed = (row: Row | undefined) => !!row?.error && (!row.generatedAt || (row.errorAt ?? new Date(0)) > row.generatedAt);

/**
 * Whether a new AI summary is due. Automatic: the data changed (or there is none) and the last run
 * started at least 15 minutes ago. Manual ("Yenile"): the data changed or the last run failed.
 */
export function summaryDue(row: Row | undefined, stamp: string, now: Date, manual: boolean): boolean {
  const changed = !row?.bullets?.length || row.stamp !== stamp;
  if (manual) return changed || lastFailed(row);
  if (!changed) return false;
  return !row?.attemptedAt || now.getTime() - row.attemptedAt.getTime() >= TODAY_SUMMARY_MIN_INTERVAL_MS;
}

/** Asks the model; invented numbers are dropped (strict for a connected client: it gets the errors back). */
export async function writeSummary(provider: AiProvider, input: CompactInput, strict = false) {
  const res = await provider.chat(
    [
      { role: "system", content: TODAY_SUMMARY_SYSTEM },
      { role: "user", content: input.text },
    ],
    { maxTokens: 400, timeoutMs: 240_000 },
  );
  const parsed = parseAiSummary(res.text, input);
  // Sent back to the connected AI client (model-facing): Turkish, like the prompt.
  const errors = parsed.dropped.map((d) => `Girdide olmayan numara (${d.numbers.join(", ")}): ${d.text}`);
  if (!parsed.bullets.length || (strict && errors.length)) {
    if (!errors.length) errors.push("Cevapta '- ' ile başlayan özet maddesi yok."); // i18n-ok: model-facing error list
    throw new HttpError(
      422,
      "today_summary_invalid",
      parsed.dropped.length
        ? msg("today:errors.inventedNumbers")
        : msg("today:errors.noValidSummary"),
      { errors },
    );
  }
  return { bullets: parsed.bullets, model: res.model || provider.model, dropped: parsed.dropped };
}

function start(deps: SummaryDeps, a: ProjectAccess, input: CompactInput, stamp: string, key: string): void {
  const { db } = deps;
  const uid = a.user.id;
  const pid = a.project.id;
  const job = (async () => {
    await save(db, uid, pid, { attemptedAt: new Date() });
    try {
      const provider = await resolveProvider(db, deps.secretKey, pid);
      const r = await writeSummary(provider, input);
      await save(db, uid, pid, { stamp, bullets: r.bullets, model: r.model, source: "provider", generatedAt: new Date(), error: null, errorAt: null });
    } catch (e) {
      // Stored with the summary: in the installation language.
      const err = e as Error & { msg?: unknown };
      const text = isMsg(err.msg) ? render(DEFAULT_LANGUAGE, err.msg) : err.message || render(DEFAULT_LANGUAGE, msg("today:errors.summaryFailed"));
      await save(db, uid, pid, { error: text.slice(0, 500), errorAt: new Date() });
    }
  })()
    .catch(() => {
      /* database gone (shutdown): nothing to record */
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, job);
}

/** The user's open "today_summary" task in the AI module's queue, if any. */
async function openQueueTask(db: Db, userId: string, projectId: string): Promise<TodaySummaryDto["queueTask"]> {
  return (await capability("ai.tasks")?.open(db, projectId, userId, "today_summary")) ?? null;
}

function toDto(row: Row | undefined, o: { auto: TodaySummaryDto["auto"]; mode: TodaySummaryAi; stamp: string; today: string; key: string; queueTask: TodaySummaryDto["queueTask"] }): TodaySummaryDto {
  // Only today's AI summary is shown (yesterday's would talk about another day).
  const ai =
    o.mode !== "off" && row?.bullets?.length && row.generatedAt && todayIso(row.generatedAt) === o.today
      ? {
          bullets: row.bullets,
          generatedAt: row.generatedAt.toISOString(),
          model: row.model,
          source: (row.source === "queue" ? "queue" : "provider") as "queue" | "provider",
          fresh: row.stamp === o.stamp,
        }
      : null;
  return {
    auto: o.auto,
    ai,
    mode: o.mode,
    running: inflight.has(o.key),
    error: o.mode !== "off" && lastFailed(row) ? row!.error : null,
    queueTask: o.queueTask,
    stamp: o.stamp,
  };
}

/** The summary for the Bugün response; `kick` starts a due background run (configured model only). */
export async function todaySummary(
  deps: SummaryDeps,
  a: ProjectAccess,
  data: TodayData,
  now: Date,
  o: { kick: boolean; lang?: string },
): Promise<TodaySummaryDto> {
  const today = todayIso(now);
  const input = compactInput(data, today);
  const stamp = inputStamp(input.text);
  const auto = autoSummary(data, today, o.lang);
  const pid = a.project.id;
  const key = `${a.user.id}:${pid}`;
  const mode = await summaryMode(deps, pid);
  const row = await loadRow(deps.db, a.user.id, pid);
  if (o.kick && mode === "provider" && !inflight.has(key) && summaryDue(row, stamp, now, false)) start(deps, a, input, stamp, key);
  const queueTask = mode === "queue" ? await openQueueTask(deps.db, a.user.id, pid) : null;
  return toDto(row, { auto, mode, stamp, today, key, queueTask });
}

/**
 * "Yenile" and the task queue's route. Without `wait` a due run starts in the background. With
 * `wait` the model (or the connected client's answer, ai/override.ts) answers in this request and
 * errors come back as HTTP errors; `force` asks even when the data did not change.
 */
export async function refreshTodaySummary(
  deps: SummaryDeps,
  a: ProjectAccess,
  data: TodayData,
  now: Date,
  o: { wait: boolean; force: boolean; lang?: string },
): Promise<TodaySummaryDto> {
  const { db } = deps;
  const pid = a.project.id;
  const key = `${a.user.id}:${pid}`;
  const input = compactInput(data, todayIso(now));
  const stamp = inputStamp(input.text);
  const row = await loadRow(db, a.user.id, pid);
  const due = o.force || summaryDue(row, stamp, now, true);
  if (o.wait) {
    if (due) {
      // resolveProvider applies the AI policy (also to a connected client's answer).
      const provider = await resolveProvider(db, deps.secretKey, pid);
      const override = overrideProvider();
      const r = await writeSummary(provider, input, override instanceof AnswerProvider);
      const at = new Date();
      await save(db, a.user.id, pid, {
        stamp,
        bullets: r.bullets,
        model: override ? override.name : r.model,
        source: override ? "queue" : "provider",
        generatedAt: at,
        attemptedAt: at,
        error: null,
        errorAt: null,
      });
    }
    return todaySummary(deps, a, data, now, { kick: false, lang: o.lang });
  }
  const mode = await summaryMode(deps, pid);
  if (mode === "off") throw new HttpError(403, "ai_off", msg("today:errors.aiOff"));
  if (mode !== "provider")
    throw new HttpError(409, "ai_no_provider", msg("today:errors.noProvider"));
  if (due && !inflight.has(key)) start(deps, a, input, stamp, key);
  return todaySummary(deps, a, data, now, { kick: false, lang: o.lang });
}
