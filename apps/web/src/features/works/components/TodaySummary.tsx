import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import type { TodaySummaryBullet, TodaySummaryDto, UserPrefs } from "@sitekeep/shared";
import { AI_TASK_POLL_MS } from "../../../shared/ai/ai-tasks";
import { hubApi } from "../../../shared/api/api-hub";
import { useLoad } from "../../../app/context/project";
import { shownSummary, summaryPending, summarySegments } from "../today-summary";
import { AiTaskButton } from "../../../shared/ai/AiTaskButton";

/**
 * "Günün Özeti" at the top of the project Bugün page: the automatic summary at once, replaced by
 * the AI summary when it is ready ("Yapay Zekâ Özeti · hh:mm"). Polls while a model writes it or a
 * "Yapay Zekâya Gönder" task waits. Collapsing is remembered per user (users.prefs).
 */
export function TodaySummary({
  projectId,
  summary,
  onSummary,
}: {
  projectId: string;
  summary: TodaySummaryDto;
  onSummary(s: TodaySummaryDto): void;
}) {
  const { t } = useTranslation(["works", "common"]);
  const { data: prefs, setData: setPrefs } = useLoad((): Promise<UserPrefs> => hubApi.prefs().catch(() => ({})), []);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const collapsed = !!prefs?.todaySummaryCollapsed;
  const pending = summaryPending(summary);

  // Poll while the summary is being written (paused while the tab is hidden).
  useEffect(() => {
    if (!pending) return;
    let live = true;
    const timer = window.setInterval(() => {
      if (document.hidden) return;
      hubApi.todaySummary(projectId).then(
        (s) => live && onSummary(s),
        () => undefined,
      );
    }, AI_TASK_POLL_MS);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [projectId, pending, onSummary]);

  async function toggle() {
    const next = !collapsed;
    setPrefs({ ...(prefs ?? {}), todaySummaryCollapsed: next });
    try {
      setPrefs(await hubApi.setPrefs({ todaySummaryCollapsed: next }));
    } catch {
      /* kept for this visit */
    }
  }

  async function refresh() {
    setBusy(true);
    setError(null);
    try {
      onSummary(await hubApi.refreshTodaySummary(projectId));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const shown = shownSummary(summary);
  return (
    <section className="card today-summary" aria-labelledby="t-summary">
      <div className="today-summary-head">
        <h2 id="t-summary">{t("summary.title")}</h2>
        <span className={`badge${shown.ai ? " info" : ""}`} title={summary.ai?.model ? t("summary.modelTitle", { model: summary.ai.model }) : undefined}>
          {shown.label}
        </span>
        {summary.running && (
          <span className="small muted" role="status">
            {t("summary.messages.writing")}
          </span>
        )}
        {summary.queueTask && (
          <span className="small muted" role="status">
            {t("summary.messages.waitingClient")}
          </span>
        )}
        <div className="spacer" />
        {summary.mode === "provider" && (
          <button type="button" className="small" disabled={busy || summary.running} onClick={() => void refresh()}>
            {t("common:actions.refresh")}
          </button>
        )}
        {summary.mode === "queue" && !summary.queueTask && (
          <AiTaskButton
            projectId={projectId}
            kind="today_summary"
            input={{}}
            small
            onResult={() => void hubApi.todaySummary(projectId).then(onSummary, () => undefined)}
          />
        )}
        <button type="button" className="small ghost" aria-expanded={!collapsed} aria-controls="today-summary-body" onClick={() => void toggle()}>
          {collapsed ? t("common:actions.show") : t("common:actions.hide")}
        </button>
      </div>
      {!collapsed && (
        <div id="today-summary-body">
          <ul className="today-summary-list">
            {shown.bullets.map((b, i) => (
              <li key={i}>
                <BulletText bullet={b} />
              </li>
            ))}
          </ul>
          {summary.ai && !summary.ai.fresh && <p className="muted small today-summary-note">{t("summary.stale")}</p>}
          {(error ?? summary.error) && <p className="small error today-summary-note">{error ?? summary.error}</p>}
        </div>
      )}
    </section>
  );
}

function BulletText({ bullet }: { bullet: TodaySummaryBullet }) {
  return (
    <>
      {summarySegments(bullet).map((s, i) =>
        s.link ? (
          <Link key={i} to={s.link} className="mono">
            {s.text}
          </Link>
        ) : (
          <span key={i}>{s.text}</span>
        ),
      )}
    </>
  );
}
