import { useEffect, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { type NamingSuggestionDto } from "@sitekeep/shared";
import { useLabel } from "../../../i18n";
import { formatPercent } from "../../../shared/lib/format";
import { documentsApi, type FileDetail } from "../api";
import { useLoad } from "../../../app/context/project";

/** Confidence as a small badge: ≥ 80 % green, ≥ 55 % neutral, else amber. */
export function ConfidenceBadge({ value, ambiguous }: { value: number; ambiguous?: boolean }) {
  const { t } = useTranslation(["documents", "common"]);
  const cls = ambiguous || value < 0.55 ? "warn" : value >= 0.8 ? "ok" : "";
  return (
    <span className={`badge ${cls}`} style={{ whiteSpace: "nowrap" }} title={ambiguous ? t("antet.confidence.ambiguousHint") : t("antet.confidence.label")}>
      {ambiguous ? t("antet.confidence.ambiguous") : formatPercent(value)}
    </span>
  );
}

/**
 * "Antetteki 'Çizim No: X' → Proje ZAVM", "… → Firma CNS" become one line
 * "Antetteki 'Çizim No: X' → Proje ZAVM, Firma CNS".
 */
export function groupExplanations(s: NamingSuggestionDto): string[] {
  const groups = new Map<string, string[]>();
  for (const f of s.fields) {
    if (!f.value && !f.ambiguous) continue;
    const i = f.explanation.lastIndexOf(" → ");
    const [head, tail] = i > 0 ? [f.explanation.slice(0, i), f.explanation.slice(i + 3)] : [f.explanation, ""];
    const list = groups.get(head) ?? [];
    if (tail) list.push(tail);
    groups.set(head, list);
  }
  return [...groups.entries()].map(([head, tails]) => (tails.length ? `${head} → ${tails.join(", ")}` : head));
}

/** Revision candidate sources with a label (antet.sources.*). */
const SOURCES = ["antet", "table", "filename", "attribute"] as const;
type Source = (typeof SOURCES)[number];
const isSource = (s: string): s is Source => (SOURCES as readonly string[]).includes(s);

/** "Antet" section of the file drawer: title block, revision warnings, name suggestion, spec analysis. */
export function AntetPanel({
  projectId,
  file,
  canEdit,
  onChanged,
}: {
  projectId: string;
  file: FileDetail;
  canEdit: boolean;
  onChanged(): void;
}) {
  const { t } = useTranslation(["documents", "common"]);
  const label = useLabel();
  const navigate = useNavigate();
  const vid = file.latest.id;
  const { data, error, reload } = useLoad(() => documentsApi.versionDocIntel(projectId, vid), [projectId, vid]);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [aiSuggestion, setAiSuggestion] = useState<NamingSuggestionDto | null>(null);
  const [showTable, setShowTable] = useState(false);

  // Poll while the background job runs.
  useEffect(() => {
    if (!data || (data.status !== "pending" && data.status !== "processing")) return;
    const timer = setTimeout(reload, 2500);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);
  useEffect(() => setAiSuggestion(null), [vid]);

  async function act(key: string, fn: () => Promise<unknown>) {
    setBusy(key);
    setMsg(null);
    try {
      await fn();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function openSpec() {
    await act("spec", async () => {
      const id = data?.registerId ?? (await documentsApi.buildSpecRegister(projectId, vid)).id;
      navigate(`/projects/${projectId}/spec/${id}`);
    });
  }

  if (error) return <p className="error small">{t("upload.suggestion.error", { error })}</p>;
  if (!data) return null;
  const suggestion = aiSuggestion ?? data.suggestion;
  const antet = data.antet;
  const attrUpdates = Object.fromEntries(
    (suggestion?.attributes ?? []).filter((a) => (file.attributes[a.name] ?? "") !== a.value).map((a) => [a.name, a.value]),
  );

  return (
    <div>
      <div className="row">
        <h3 style={{ margin: 0 }}>{t("antet.heading")}</h3>
        <div className="spacer" />
        {(data.status === "done" || data.status === "failed") && (
          <button className="small ghost" disabled={!!busy} onClick={() => void act("extract", () => documentsApi.reExtract(projectId, vid).then(reload))}>
            {t("antet.actions.reread")}
          </button>
        )}
      </div>
      {msg && <p className="error small">{msg}</p>}
      {(data.status === "pending" || data.status === "processing") && <p className="muted small">{t("antet.reading")}</p>}
      {data.status === "failed" && <p className="error small">{t("antet.errors.readFailed", { error: data.error })}</p>}
      {data.status === "done" && antet && (
        <div className="stack" style={{ gap: 8 }}>
          {antet.note && <p className="muted small" style={{ margin: 0 }}>{antet.note}</p>}
          {data.warnings.length > 0 && (
            <div className="stack" style={{ gap: 4 }}>
              {data.warnings.map((w) => (
                <div key={w.code} className="small">
                  <span className={`badge ${w.severity === "warn" ? "warn" : "info"}`}>{w.severity === "warn" ? t("antet.badges.warning") : t("antet.badges.info")}</span> {w.message}
                </div>
              ))}
            </div>
          )}
          {antet.fields.length > 0 && (
            <table className="props-table">
              <tbody>
                {antet.fields.map((f) => (
                  <tr key={f.key}>
                    <td title={t("antet.fieldLabel", { label: f.label })}>{label("antetField", f.key)}</td>
                    <td style={{ wordBreak: "break-word" }}>{f.value}</td>
                    <td style={{ width: 60 }}>
                      <ConfidenceBadge value={f.confidence} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {data.revision?.value && (
            <div className="small">
              <Trans t={t} i18nKey="antet.revision" values={{ value: data.revision.value }} components={{ b: <strong /> }} />{" "}
              <span className="muted">
                ({data.revision.candidates.map((c) => `${isSource(c.source) ? t(`antet.sources.${c.source}`) : c.source}: ${c.value}`).join(", ")})
              </span>
            </div>
          )}
          {antet.revisionTable.length > 0 && (
            <div className="small">
              <button className="small ghost" onClick={() => setShowTable((x) => !x)}>
                {showTable ? "▾" : "▸"} {t("antet.actions.revisionTable", { count: antet.revisionTable.length })}
              </button>
              {showTable && (
                <table className="props-table">
                  <tbody>
                    {antet.revisionTable.map((r, i) => (
                      <tr key={i}>
                        <td className="mono">{r.rev}</td>
                        <td>{r.date ?? "—"}</td>
                        <td>{r.description ?? ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}
          {suggestion?.standard && (
            <div className="card small" style={{ padding: 8 }}>
              {suggestion.name ? (
                suggestion.unchanged ? (
                  <span className="badge ok">{t("antet.nameMatches")}</span>
                ) : (
                  <>
                    <Trans t={t} i18nKey="antet.suggestion" values={{ name: suggestion.name }} components={{ m: <span className="mono" /> }} />
                  </>
                )
              ) : (
                <span className="muted">{t("antet.noName")} {suggestion.errors.join(" ")}</span>
              )}
              {suggestion.ai?.used && <div className="muted">{suggestion.ai.accepted ? t("antet.aiResolved") : suggestion.ai.note}</div>}
              <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
                {groupExplanations(suggestion).map((line) => (
                  <li key={line} className="muted">
                    {line}
                  </li>
                ))}
              </ul>
              <div className="row wrap" style={{ marginTop: 6 }}>
                {canEdit && suggestion.name && !suggestion.unchanged && (
                  <button
                    className="small primary"
                    disabled={!!busy}
                    onClick={() =>
                      void act("rename", async () => {
                        await documentsApi.updateFile(projectId, file.id, { name: suggestion.name! });
                        onChanged();
                        reload();
                      })
                    }
                  >
                    {t("antet.actions.rename")}
                  </button>
                )}
                {data.aiAvailable && !suggestion.ok && !aiSuggestion && (
                  <button
                    className="small"
                    disabled={!!busy}
                    onClick={() => void act("ai", async () => setAiSuggestion(await documentsApi.versionSuggest(projectId, vid, true)))}
                  >
                    {busy === "ai" ? t("upload.status.aiThinking") : t("antet.actions.refineWithAi")}
                  </button>
                )}
              </div>
            </div>
          )}
          {canEdit && Object.keys(attrUpdates).length > 0 && (
            <div className="small">
              <span className="muted">
                {t("antet.attributesFromTitleBlock", { values: Object.entries(attrUpdates).map(([k, v]) => `${k} = ${v}`).join(", ") })}
              </span>{" "}
              <button
                className="small"
                disabled={!!busy}
                onClick={() =>
                  void act("attrs", async () => {
                    await documentsApi.updateFile(projectId, file.id, { attributes: attrUpdates });
                    onChanged();
                    reload();
                  })
                }
              >
                {t("antet.actions.fillAttributes")}
              </button>
            </div>
          )}
        </div>
      )}
      <div className="row wrap" style={{ marginTop: 8 }}>
        {data.specLike || data.registerId ? (
          <button className="small" disabled={!!busy} onClick={() => void openSpec()}>
            {busy === "spec" ? t("antet.status.readingSpec") : data.registerId ? t("antet.actions.specAnalysis") : t("antet.actions.buildRegister")}
          </button>
        ) : (
          <button className="small ghost" disabled={!!busy} onClick={() => void openSpec()}>
            {busy === "spec" ? t("antet.status.reading") : t("antet.actions.analyseSpec")}
          </button>
        )}
      </div>
    </div>
  );
}
