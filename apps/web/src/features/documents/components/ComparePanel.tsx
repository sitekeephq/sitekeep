import { useEffect, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { modelFieldLabel, type CompareGroupDto, type CompareSummaryDto, type VersionCompareDto } from "@sitekeep/shared";
import { api, type ModelVersion } from "../../../shared/api/api";
import { fileDay } from "../docs-phone";
import { Dialog } from "../../../shared/ui/Dialog";
import { ModelAskPanel } from "../../coordination/components/ModelAsk";
import { COMPARE_COLORS, type ViewerEngine } from "@7dimensions-project/bim-viewer";

type Kind = "added" | "changed" | "removed";

/** Side panel of the viewer's "Karşılaştır" mode. */
export function ComparePanel({
  projectId,
  engine,
  result,
  status,
  ghost,
  fade,
  onGhost,
  onFade,
  onFocus,
  onIssue,
  onClose,
}: {
  projectId: string;
  engine: ViewerEngine | null;
  result: VersionCompareDto | null;
  status: string | null;
  ghost: boolean;
  fade: boolean;
  onGhost(on: boolean): void;
  onFade(on: boolean): void;
  onFocus(guid: string, kind: Kind): void;
  /** Issue for elements of the new version (selected first). */
  onIssue(guids: string[], title: string, description: string): void;
  onClose(): void;
}) {
  const { t, i18n } = useTranslation(["documents", "common"]);
  const [open, setOpen] = useState<Kind | null>(null);
  return (
    <div style={{ marginBottom: 16 }}>
      <div className="row">
        <h3 style={{ margin: 0 }}>{t("modelCompare.heading")}</h3>
        <div className="spacer" />
        <button className="ghost small" onClick={onClose} title={t("modelCompare.close")}>
          ✕
        </button>
      </div>
      {result && (
        <div className="muted small" style={{ margin: "4px 0 8px", wordBreak: "break-all" }}>
          {result.from.fileName === result.to.fileName ? (
            <>
              {result.to.fileName}: <strong>V{result.from.version} → V{result.to.version}</strong>
            </>
          ) : (
            <>
              {result.from.fileName} V{result.from.version} → {result.to.fileName} V{result.to.version}
            </>
          )}
        </div>
      )}
      {status && <p className="notice small">{status}</p>}
      {result && (
        <>
          <div className="row wrap small">
            {(["added", "changed", "removed"] as Kind[]).map((k) => (
              <span key={k} className="badge" style={{ borderColor: COMPARE_COLORS[k], color: COMPARE_COLORS[k] }}>
                {t(`modelCompare.kinds.${k}`)} {result[k].length}
              </span>
            ))}
            <span className="badge">{t("modelCompare.kinds.unchanged")} {result.unchanged}</span>
          </div>
          <label className="row small" style={{ color: "inherit" }}>
            <input type="checkbox" style={{ width: "auto" }} checked={fade} onChange={(e) => onFade(e.target.checked)} />
            {t("modelCompare.options.fade")}
          </label>
          <label className="row small" style={{ color: "inherit", marginTop: 0 }}>
            <input type="checkbox" style={{ width: "auto" }} checked={ghost} onChange={(e) => onGhost(e.target.checked)} />
            {t("modelCompare.options.ghost")}
          </label>
          {result.upgrading && <p className="notice small">{t("modelCompare.upgrading")}</p>}

          <CompareSummary projectId={projectId} result={result} engine={engine} onIssue={onIssue} />

          {Object.keys(result.byClass).length > 0 && (
            <table className="props-table" style={{ marginTop: 8 }}>
              <thead>
                <tr>
                  <th>{t("modelCompare.columns.class")}</th>
                  <th title={t("modelCompare.kinds.added")} style={{ color: COMPARE_COLORS.added }}>+</th>
                  <th title={t("modelCompare.kinds.changed")} style={{ color: COMPARE_COLORS.changed }}>~</th>
                  <th title={t("modelCompare.kinds.removed")} style={{ color: COMPARE_COLORS.removed }}>−</th>
                  <th title={t("modelCompare.kinds.unchanged")}>=</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(result.byClass)
                  .sort((a, b) => b[1].added + b[1].changed + b[1].removed - (a[1].added + a[1].changed + a[1].removed))
                  .map(([cls, c]) => (
                    <tr key={cls}>
                      <td>{cls.replace(/^Ifc/i, "")}</td>
                      <td>{c.added || ""}</td>
                      <td>{c.changed || ""}</td>
                      <td>{c.removed || ""}</td>
                      <td className="muted">{c.unchanged || ""}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          )}

          {(["changed", "added", "removed"] as Kind[]).map((k) => (
            <div key={k} style={{ marginTop: 8 }}>
              <button className="ghost small" style={{ paddingLeft: 0 }} onClick={() => setOpen(open === k ? null : k)}>
                <span className="cmp-legend" style={{ background: COMPARE_COLORS[k] }} />
                {open === k ? "▾" : "▸"} {t(`modelCompare.kinds.${k}`)} ({result[k].length})
              </button>
              {open === k && (
                <div className="cmp-list">
                  {k === "removed" && !ghost && result.removed.length > 0 && (
                    <p className="muted small">{t("modelCompare.removedHint")}</p>
                  )}
                  {result[k].slice(0, 500).map((guid) => {
                    const [cls, name] = result.elements[guid] ?? ["", null];
                    const changes = result.changes?.[guid] ?? [];
                    const storey = result.storeys?.[guid];
                    return (
                      <div
                        key={guid}
                        className="model-item small"
                        style={{ cursor: k !== "removed" || ghost ? "pointer" : undefined }}
                        onClick={() => (k !== "removed" || ghost) && onFocus(guid, k)}
                      >
                        <div>
                          <div>{name ?? <span className="muted">{t("modelCompare.unnamed")}</span>}</div>
                          <div className="muted mono">
                            {cls.replace(/^Ifc/i, "")}
                            {storey ? ` · ${storey}` : ""} · {guid}
                          </div>
                          {changes.slice(0, 3).map((c) => (
                            <div key={c.prop} className="small">
                              {modelFieldLabel(c.prop, i18n.language)}
                              {c.from !== null || c.to !== null ? `: ${c.from ?? "—"} → ${c.to ?? "—"}` : ""}
                            </div>
                          ))}
                          {changes.length > 3 && <div className="muted small">{t("modelCompare.moreProps", { count: changes.length - 3 })}</div>}
                        </div>
                      </div>
                    );
                  })}
                  {result[k].length > 500 && <p className="muted small">{t("modelCompare.moreElements", { count: result[k].length - 500 })}</p>}
                </div>
              )}
            </div>
          ))}

          {result.detailed && result.added.length + result.changed.length + result.removed.length > 0 && (
            <ModelAskPanel projectId={projectId} engine={engine} versionId={result.to.versionId} compareFrom={result.from.versionId} onIssue={onIssue} embedded />
          )}
        </>
      )}
    </div>
  );
}

/**
 * "Değişiklik özeti": deterministic change groups at once, the AI narrative when it arrives.
 * Each line highlights its elements; a group can become an issue.
 */
function CompareSummary({
  projectId,
  result,
  engine,
  onIssue,
}: {
  projectId: string;
  result: VersionCompareDto;
  engine: ViewerEngine | null;
  onIssue(guids: string[], title: string, description: string): void;
}) {
  const { t } = useTranslation(["documents", "common"]);
  const [sum, setSum] = useState<CompareSummaryDto | null>(null);
  const [aiStarted, setAiStarted] = useState<number | null>(null);
  const [, setTick] = useState(0);
  const [active, setActive] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const shown = useRef(false);
  const from = result.from.versionId;
  const to = result.to.versionId;
  const detailed = !!result.detailed;

  useEffect(() => {
    const ac = new AbortController();
    setError(null);
    api.compareSummary(projectId, from, to, false, ac.signal).then(
      (s) => {
        if (ac.signal.aborted) return;
        setSum((cur) => (cur?.ai ? cur : s));
        if (!s.groups.length) return;
        setAiStarted(Date.now());
        api.compareSummary(projectId, from, to, true, ac.signal).then(
          (r) => !ac.signal.aborted && (setSum(r), setAiStarted(null)),
          (e: Error) => !ac.signal.aborted && (setAiStarted(null), e.name !== "AbortError" && setError(e.message)),
        );
      },
      (e: Error) => !ac.signal.aborted && e.name !== "AbortError" && setError(e.message),
    );
    return () => ac.abort();
  }, [projectId, from, to, detailed]);

  useEffect(() => {
    if (!aiStarted) return;
    const timer = setInterval(() => setTick((x) => x + 1), 1000);
    return () => clearInterval(timer);
  }, [aiStarted]);

  useEffect(
    () => () => {
      if (shown.current) void engine?.clearMatches();
    },
    [engine],
  );

  const byId = new Map((sum?.groups ?? []).map((g) => [g.id, g]));
  const guidsOf = (ids: string[]) => {
    const list = ids.map((id) => byId.get(id)).filter((g): g is CompareGroupDto => !!g);
    return {
      fresh: [...new Set(list.filter((g) => g.kind !== "removed").flatMap((g) => g.guids))],
      removed: [...new Set(list.filter((g) => g.kind === "removed").flatMap((g) => g.guids))],
    };
  };

  function highlight(key: string, ids: string[]) {
    if (!engine) return;
    if (active === key) {
      setActive(null);
      shown.current = false;
      void engine.clearMatches();
      return;
    }
    const { fresh, removed } = guidsOf(ids);
    setActive(key);
    shown.current = true;
    void engine.showMatches(
      [
        { modelId: to, guids: fresh },
        { modelId: from, guids: removed },
      ],
      { zoom: true },
    );
  }

  if (!sum) return error ? <p className="error small">{error}</p> : <p className="muted small">{t("modelCompare.summary.preparing")}</p>;
  const bullets = sum.ai?.bullets ?? sum.bullets;
  return (
    <div className="cmp-summary">
      <div className="row wrap">
        <h4 style={{ margin: 0 }}>{t("modelCompare.summary.heading")}</h4>
        {sum.ai ? (
          <span className="badge info small">{t("modelCompare.summary.aiModel", { model: sum.ai.model })}</span>
        ) : aiStarted ? (
          <span className="muted small">
            <span className="mq-spinner" aria-hidden /> {t("modelCompare.summary.aiWriting", { seconds: Math.round((Date.now() - aiStarted) / 1000) })}
          </span>
        ) : null}
        <div className="spacer" />
        <a className="small" href={api.compareReportUrl(projectId, from, to)} target="_blank" rel="noopener noreferrer">
          {t("modelCompare.summary.report")}
        </a>
      </div>
      {sum.aiError && <p className="muted small">{t("modelCompare.summary.aiError", { error: sum.aiError })}</p>}
      {!bullets.length && <p className="muted small">{t("modelCompare.summary.noChanges")}</p>}
      <ul className="cmp-bullets">
        {bullets.map((b, i) => {
          const key = `b${i}`;
          const g = b.groupIds.length === 1 ? byId.get(b.groupIds[0]!) : undefined;
          return (
            <li key={key} className={active === key ? "active" : undefined}>
              <button type="button" className="link" disabled={!b.groupIds.length} onClick={() => highlight(key, b.groupIds)} title={t("modelCompare.summary.showInModel")}>
                {g && <span className="cmp-legend" style={{ background: COMPARE_COLORS[g.kind] }} />}
                {b.text}
              </button>
              {b.groupIds.length > 0 && (
                <button
                  type="button"
                  className="ghost small"
                  title={t("modelCompare.summary.createIssue")}
                  onClick={() => {
                    const { fresh } = guidsOf(b.groupIds);
                    onIssue(fresh.slice(0, 5000), b.text.slice(0, 300), `${result.to.fileName} V${result.from.version} → V${result.to.version}: ${b.text}`);
                  }}
                >
                  {t("modelCompare.summary.actions.issue")}
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {sum.ai && sum.groups.length > 0 && (
        <details>
          <summary className="small">{t("modelCompare.summary.allGroups", { count: sum.groups.length })}</summary>
          <ul className="cmp-bullets">
            {sum.groups.map((g) => (
              <li key={g.id} className={active === g.id ? "active" : undefined}>
                <button type="button" className="link" onClick={() => highlight(g.id, [g.id])}>
                  <span className="cmp-legend" style={{ background: COMPARE_COLORS[g.kind] }} />
                  {g.text}
                </button>
                {g.kind !== "removed" && (
                  <button
                    type="button"
                    className="ghost small"
                    onClick={() => onIssue(g.guids.slice(0, 5000), g.text.slice(0, 300), `${result.to.fileName} V${result.from.version} → V${result.to.version}: ${g.text}`)}
                  >
                    {t("modelCompare.summary.actions.issue")}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

/** Picks two versions of an IFC file to compare (default: previous → latest). */
export function CompareDialog({
  versions,
  onClose,
  onStart,
}: {
  versions: ModelVersion[];
  onClose(): void;
  onStart(from: string, to: string): void;
}) {
  const { t } = useTranslation(["documents", "common"]);
  const sorted = [...versions].sort((a, b) => b.version - a.version);
  const [to, setTo] = useState(sorted[0]?.id ?? "");
  const [from, setFrom] = useState(sorted[1]?.id ?? "");
  const option = (v: ModelVersion) => (
    <option key={v.id} value={v.id} disabled={v.derivativeStatus !== "ready"}>
      V{v.version} · {fileDay(v.uploadedAt)}
      {v.uploadedByName ? ` · ${v.uploadedByName}` : ""}
      {v.derivativeStatus !== "ready" ? ` (${v.derivativeStatus})` : ""}
    </option>
  );
  return (
    <Dialog title={t("modelCompare.dialog.title")} onClose={onClose}>
      <p className="muted small" style={{ wordBreak: "break-all" }}>
        {sorted[0]?.fileName}
      </p>
      <div className="row">
        <div style={{ flex: 1 }}>
          <label>{t("modelCompare.dialog.fields.from")}</label>
          <select value={from} onChange={(e) => setFrom(e.target.value)}>
            {sorted.map(option)}
          </select>
        </div>
        <div style={{ flex: 1 }}>
          <label>{t("modelCompare.dialog.fields.to")}</label>
          <select value={to} onChange={(e) => setTo(e.target.value)}>
            {sorted.map(option)}
          </select>
        </div>
      </div>
      <p className="muted small">
        <Trans
          t={t}
          i18nKey="modelCompare.dialog.help"
          components={{
            added: <span style={{ color: COMPARE_COLORS.added }} />,
            changed: <span style={{ color: COMPARE_COLORS.changed }} />,
            removed: <span style={{ color: COMPARE_COLORS.removed }} />,
          }}
        />
      </p>
      <div className="dialog-actions">
        <button onClick={onClose}>{t("common:actions.cancel")}</button>
        <button className="primary" disabled={!from || !to || from === to} onClick={() => onStart(from, to)}>
          {t("modelCompare.dialog.actions.compare")}
        </button>
      </div>
    </Dialog>
  );
}
