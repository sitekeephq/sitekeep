/**
 * "Koordinasyon": model sets (federations and saved views), IDS checks (information requirements)
 * and, with the Coordinate module, clash tests with grouped results.
 */
import { Fragment, useEffect, useMemo, useState } from "react";
import { Link, NavLink, useNavigate, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  type IdsReportDto,
  type ModelSetDto,
  type ModelSetItem,
} from "@sitekeep/shared";
import { api, formatDate, dataLocale, intlLocale, type ModelVersion } from "../../../shared/api/api";
import { documentsApi } from "../../documents/api";
import { useAsk } from "../../../shared/ui/Ask";
import { Dialog } from "../../../shared/ui/Dialog";
import { useLoad, useProject } from "../../../app/context/project";
import { ReportShortcut } from "../../documents/components/ReportShortcut";
import { useEmbedded } from "../../../app/context/embedded";
import { webCapability } from "../../../sdk";
import { LoadingIndicator } from "../../../shared/ui/LoadingIndicator";

/** Run / check status badge classes (IDS checks here; clash runs in the Coordinate module). */
const RUN_CLASS: Record<string, string> = { queued: "info", running: "info", done: "ok", failed: "danger" };

export function CoordinationPage() {
  const { t } = useTranslation(["coordination", "common"]);
  const project = useProject();
  const { section = "sets", id } = useParams();
  // Inside the Model tabs the tab bar names the page: no second header.
  const embedded = useEmbedded();
  const clash = webCapability("coordinate.clashTests"); // clash tests are the Coordinate module's
  return (
    <div className="page" style={{ maxWidth: "none" }}>
      {!embedded && <h1 style={{ margin: "0 0 8px" }}>{t("page.title")}</h1>}
      <div className="row wrap" style={{ borderBottom: "1px solid var(--border)", marginBottom: 14 }}>
        <nav className="tabs">
          <NavLink to={`/projects/${project.id}/coordination/sets`}>{t("page.tabs.sets")}</NavLink>
          {clash && <NavLink to={`/projects/${project.id}/coordination/tests`}>{t("page.tabs.tests")}</NavLink>}
          <NavLink to={`/projects/${project.id}/coordination/ids`}>{t("page.tabs.ids")}</NavLink>
        </nav>
        <div className="spacer" />
        <ReportShortcut module="coordination" small />
      </div>
      {section === "sets" && <ModelSets />}
      {section === "tests" && clash && !id && <clash.ClashTests />}
      {section === "tests" && clash && id && <clash.ClashResults testId={id} />}
      {section === "ids" && !id && <IdsChecks />}
      {section === "ids" && id && <IdsReport reportId={id} />}
    </div>
  );
}

function ModelSets() {
  const { t } = useTranslation(["coordination", "common"]);
  const { confirm } = useAsk();
  const project = useProject();
  const { data: sets, error, reload } = useLoad(() => api.modelSets(project.id), [project.id]);
  const [editing, setEditing] = useState<ModelSetDto | "new" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  return (
    <>
      <div className="row wrap coord-intro" style={{ marginBottom: 10, alignItems: "flex-start" }}>
        <p className="muted small" style={{ margin: 0 }}>
          {t("sets.description")}
        </p>
        <button className="primary" onClick={() => setEditing("new")}>{t("sets.actions.new")}</button>
      </div>
      {(error || err) && <p className="error">{error ?? err}</p>}
      <div className="card" style={{ padding: 0 }}>
        <table className="phone-cards">
          <thead>
            <tr>
              <th>{t("sets.columns.name")}</th>
              <th>{t("sets.columns.models")}</th>
              <th style={{ width: 160 }}>{t("sets.columns.views")}</th>
              <th style={{ width: 130 }}>{t("sets.columns.createdBy")}</th>
              <th style={{ width: 230 }} />
            </tr>
          </thead>
          <tbody>
            {sets?.map((s) => (
              <tr key={s.id}>
                <td className="pc-title">
                  <strong>{s.name}</strong>
                  {s.description && <div className="muted small">{s.description}</div>}
                </td>
                <td className="small" data-label={t("sets.columns.models")}>
                  {s.items.map((i) => (
                    <div key={i.fileId}>
                      {i.hidden ? (
                        <span className="muted">{t("sets.hiddenModel")}</span>
                      ) : i.missing ? (
                        <span className="error">{t("sets.missingFile")}</span>
                      ) : (
                        <>
                          {i.fileName} <span className="muted">· {i.versionId ? t("sets.pinnedVersion", { version: i.resolvedVersion }) : t("sets.latestVersion", { version: i.resolvedVersion })}</span>
                        </>
                      )}
                    </div>
                  ))}
                </td>
                <td className="small" data-label={t("sets.columns.views")}>
                  {s.views.map((v) => (
                    <div key={v.id}>
                      <Link to={`/projects/${project.id}/viewer?set=${s.id}&view=${v.id}`}>{v.name}</Link>
                    </div>
                  ))}
                  {!s.views.length && <span className="muted">—</span>}
                </td>
                <td className="muted small" data-label={t("sets.columns.createdBy")}>{s.createdByName ?? "—"}</td>
                <td className="pc-actions">
                  <Link className="btn small" to={`/projects/${project.id}/viewer?set=${s.id}`}>{t("sets.actions.openInViewer")}</Link>{" "}
                  {s.canEdit && (
                    <>
                      <button className="small" onClick={() => setEditing(s)}>{t("common:actions.edit")}</button>{" "}
                      <button
                        className="small ghost"
                        onClick={() =>
                          void confirm({
                            title: t("sets.deleteTitle"),
                            message: t("sets.deleteConfirm", { name: s.name }),
                            confirmLabel: t("common:actions.delete"),
                            danger: true,
                          }).then((ok) => {
                            if (!ok) return;
                            api.deleteModelSet(project.id, s.id).then(reload, (e: Error) => setErr(e.message));
                          })
                        }
                      >
                        {t("common:actions.delete")}
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
            {sets?.length === 0 && (
              <tr>
                <td colSpan={5} className="muted" style={{ textAlign: "center", padding: 28 }}>
                  {t("sets.empty")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {editing && (
        <ModelSetDialog
          set={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            reload();
          }}
        />
      )}
    </>
  );
}

function ModelSetDialog({ set, onClose, onSaved }: { set: ModelSetDto | null; onClose(): void; onSaved(): void }) {
  const { t } = useTranslation(["coordination", "common"]);
  const project = useProject();
  const { data: versions } = useLoad(() => api.modelVersions(project.id), [project.id]);
  const [name, setName] = useState(set?.name ?? "");
  const [description, setDescription] = useState(set?.description ?? "");
  const [items, setItems] = useState<ModelSetItem[]>(set?.items.filter((i) => !i.hidden).map((i) => ({ fileId: i.fileId, versionId: i.versionId })) ?? []);
  const [error, setError] = useState<string | null>(null);
  const byFile = useMemo(() => {
    const m = new Map<string, ModelVersion[]>();
    for (const v of versions ?? []) m.set(v.fileId, [...(m.get(v.fileId) ?? []), v].sort((a, b) => b.version - a.version));
    return [...m.values()].sort((a, b) => a[0]!.folderPath.localeCompare(b[0]!.folderPath, dataLocale()) || a[0]!.fileName.localeCompare(b[0]!.fileName, dataLocale()));
  }, [versions]);
  const toggle = (fileId: string, on: boolean) =>
    setItems((list) => (on ? [...list, { fileId, versionId: null }] : list.filter((i) => i.fileId !== fileId)));

  async function save() {
    setError(null);
    try {
      const body = { name: name.trim(), description: description.trim() || null, items };
      if (set) await api.updateModelSet(project.id, set.id, body);
      else await api.createModelSet(project.id, body);
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <Dialog title={set ? t("setDialog.editTitle") : t("setDialog.newTitle")} onClose={onClose} wide>
      <label>{t("common:fields.name")}</label>
      <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={t("setDialog.namePlaceholder")} />
      <label>{t("common:fields.description")}</label>
      <input value={description} onChange={(e) => setDescription(e.target.value)} />
      <label>{t("setDialog.fields.ifcFiles")}</label>
      <div style={{ maxHeight: 320, overflow: "auto", border: "1px solid var(--border)", borderRadius: 6, padding: 6 }}>
        {byFile.length === 0 && <div className="muted small">{t("setDialog.noIfc")}</div>}
        {byFile.map((list) => {
          const f = list[0]!;
          const item = items.find((i) => i.fileId === f.fileId);
          return (
            <div key={f.fileId} className="row small" style={{ padding: "3px 0" }}>
              <input type="checkbox" style={{ width: "auto" }} checked={!!item} onChange={(e) => toggle(f.fileId, e.target.checked)} />
              <div style={{ flex: 1, wordBreak: "break-all" }}>
                {f.fileName} <span className="muted">· {f.folderPath}</span>
              </div>
              {item && (
                <select
                  style={{ width: 170 }}
                  value={item.versionId ?? ""}
                  onChange={(e) => setItems((l) => l.map((i) => (i.fileId === f.fileId ? { ...i, versionId: e.target.value || null } : i)))}
                >
                  <option value="">{t("setDialog.options.latest", { version: f.version })}</option>
                  {list.map((v) => (
                    <option key={v.id} value={v.id}>
                      {t("setDialog.options.pinned", { version: v.version, date: new Date(v.uploadedAt).toLocaleDateString(intlLocale()) })}
                    </option>
                  ))}
                </select>
              )}
            </div>
          );
        })}
      </div>
      {error && <p className="error">{error}</p>}
      <div className="dialog-actions">
        <button onClick={onClose}>{t("common:actions.cancel")}</button>
        <button className="primary" disabled={!name.trim() || !items.length} onClick={() => void save()}>
          {t("common:actions.save")}
        </button>
      </div>
    </Dialog>
  );
}

// ------------------------------------------------------------------------------- clash tests

function IdsChecks() {
  const { t } = useTranslation(["coordination", "common"]);
  const project = useProject();
  const navigate = useNavigate();
  const { data: reports, error, reload } = useLoad(() => api.idsReports(project.id), [project.id]);
  const { data: idsFiles } = useLoad(() => documentsApi.search(project.id, { ext: "ids" }), [project.id]);
  const { data: models } = useLoad(() => api.modelVersions(project.id), [project.id]);
  const [idsVersion, setIdsVersion] = useState("");
  const [ifcVersion, setIfcVersion] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const busy = reports?.some((r) => r.status === "queued" || r.status === "running");

  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(reload, 3000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy]);

  return (
    <>
      <p className="muted small" style={{ marginTop: 0 }}>
        {t("ids.description")}
      </p>
      <div className="card row wrap" style={{ marginBottom: 12, alignItems: "flex-end" }}>
        <div style={{ flex: 1, minWidth: 220 }}>
          <label>{t("ids.fields.idsFile")}</label>
          <select value={idsVersion} onChange={(e) => setIdsVersion(e.target.value)}>
            <option value="">{t("results.choose")}</option>
            {idsFiles?.results.map((f) => (
              <option key={f.id} value={f.latest.id}>
                {f.name} (V{f.currentVersion}) · {f.folderPath}
              </option>
            ))}
          </select>
        </div>
        <div style={{ flex: 1, minWidth: 220 }}>
          <label>{t("ids.fields.ifcVersion")}</label>
          <select value={ifcVersion} onChange={(e) => setIfcVersion(e.target.value)}>
            <option value="">{t("results.choose")}</option>
            {models?.map((m) => (
              <option key={m.id} value={m.id}>
                {m.isLatest ? t("ids.versionLatest", { file: m.fileName, version: m.version }) : `${m.fileName} V${m.version}`}
              </option>
            ))}
          </select>
        </div>
        <button
          className="primary"
          disabled={!idsVersion || !ifcVersion}
          onClick={() => api.runIds(project.id, idsVersion, ifcVersion).then(reload, (e: Error) => setErr(e.message))}
        >
          {t("ids.actions.check")}
        </button>
      </div>
      {(error || err) && <p className="error">{error ?? err}</p>}
      <div className="card" style={{ padding: 0 }}>
        <table className="phone-cards">
          <thead>
            <tr>
              <th>IFC</th>
              <th>IDS</th>
              <th style={{ width: 120 }}>{t("ids.columns.status")}</th>
              <th style={{ width: 220 }}>{t("ids.columns.result")}</th>
              <th style={{ width: 150 }}>{t("ids.columns.date")}</th>
            </tr>
          </thead>
          <tbody>
            {reports?.map((r) => (
              <tr key={r.id} className="clickable" onClick={() => navigate(`/projects/${project.id}/coordination/ids/${r.id}`)}>
                <td className="pc-title">{r.ifcFileName} V{r.ifcVersion}</td>
                <td className="small" data-label="IDS">{r.title ?? r.idsFileName}</td>
                <td data-label={t("ids.columns.status")}><span className={`badge ${RUN_CLASS[r.status]}`}>{t(`run.${r.status}`)}</span></td>
                <td className="small" data-label={t("ids.columns.result")}>
                  {r.totals ? (
                    <>
                      <span className="badge ok">{t("ids.passedN", { n: r.totals.passed })}</span> <span className="badge danger">{t("ids.failedN", { n: r.totals.failed })}</span>
                      {r.totals.skipped > 0 && <span className="badge"> {t("ids.skippedN", { n: r.totals.skipped })}</span>}
                    </>
                  ) : (
                    <span className="error">{r.error}</span>
                  )}
                </td>
                <td className="muted small" data-label={t("ids.columns.date")}>{formatDate(r.createdAt)}</td>
              </tr>
            ))}
            {reports?.length === 0 && (
              <tr>
                <td colSpan={5} className="muted" style={{ textAlign: "center", padding: 28 }}>{t("ids.empty")}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

function IdsReport({ reportId }: { reportId: string }) {
  const { t } = useTranslation(["coordination", "common"]);
  const project = useProject();
  const { data: r, error, reload } = useLoad<IdsReportDto>(() => api.idsReport(project.id, reportId), [project.id, reportId]);
  const [open, setOpen] = useState<number | null>(null);
  const running = r && (r.status === "queued" || r.status === "running");
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(reload, 3000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running]);
  if (error) return <p className="error">{error}</p>;
  if (!r) return <LoadingIndicator />;
  const STATUS = { pass: ["ok", t("ids.status.pass")], fail: ["danger", t("ids.status.fail")], skipped: ["", t("ids.status.skipped")] } as const;
  return (
    <>
      <div className="row" style={{ marginBottom: 10 }}>
        <Link to={`/projects/${project.id}/coordination/ids`}>{t("ids.back")}</Link>
        <h2 style={{ margin: 0 }}>{r.title ?? r.idsFileName}</h2>
        <span className="muted small">{r.ifcFileName} V{r.ifcVersion} · {formatDate(r.createdAt)}</span>
        <div className="spacer" />
        {r.status === "done" && <a className="btn small" href={api.idsCsvUrl(project.id, r.id)}>{t("ids.actions.downloadCsv")}</a>}
      </div>
      {r.status !== "done" && <p className={r.status === "failed" ? "error" : "notice"}>{r.error ?? t(`run.${r.status}`)}</p>}
      {r.totals && (
        <p className="small">
          {t("ids.specCount", { n: r.totals.specs })} · <span className="badge ok">{t("ids.passedN", { n: r.totals.passed })}</span>{" "}
          <span className="badge danger">{t("ids.failedN", { n: r.totals.failed })}</span> <span className="badge">{t("ids.skippedN", { n: r.totals.skipped })}</span> ·{" "}
          {t("ids.elementsChecked", { n: r.totals.elementsChecked })}
        </p>
      )}
      <div className="card" style={{ padding: 0 }}>
        <table className="phone-cards">
          <thead>
            <tr>
              <th>{t("ids.columns.spec")}</th>
              <th style={{ width: 100 }}>{t("ids.columns.status")}</th>
              <th style={{ width: 120 }}>{t("ids.columns.applicable")}</th>
              <th style={{ width: 90 }}>{t("ids.columns.passed")}</th>
              <th style={{ width: 90 }}>{t("ids.columns.failed")}</th>
            </tr>
          </thead>
          <tbody>
            {r.specs.map((s, i) => (
              <Fragment key={i}>
                <tr className="clickable" onClick={() => setOpen(open === i ? null : i)}>
                  <td className="pc-title">
                    {open === i ? "▾" : "▸"} <strong>{s.name}</strong>
                    {s.description && <div className="muted small">{s.description}</div>}
                  </td>
                  <td data-label={t("ids.columns.status")}><span className={`badge ${STATUS[s.status][0]}`}>{STATUS[s.status][1]}</span></td>
                  <td data-label={t("ids.columns.applicable")}>{s.applicable}</td>
                  <td data-label={t("ids.columns.passed")}>{s.passed}</td>
                  <td data-label={t("ids.columns.failed")}>{s.failed}</td>
                </tr>
                {open === i && (
                  <tr className="pc-detail">
                    <td colSpan={5} style={{ background: "var(--surface-2)" }}>
                      {s.requirements.length > 0 && (
                        <ul className="small" style={{ margin: "4px 0" }}>
                          {s.requirements.map((q, k) => <li key={k}>{q}</li>)}
                        </ul>
                      )}
                      {s.note && <p className="notice small">{s.note}</p>}
                      {s.failures.length > 0 && (
                        <table className="props-table phone-cards">
                          <thead>
                            <tr><th>GlobalId{/* i18n-ok: IFC attribute name */}</th><th>{t("ids.columns.class")}</th><th>{t("ids.columns.name")}</th><th>{t("ids.columns.reason")}</th></tr>
                          </thead>
                          <tbody>
                            {s.failures.map((f) => (
                              <tr key={f.globalId}>
                                <td className="pc-title mono">{f.globalId}</td>
                                <td data-label={t("ids.columns.class")}>{f.ifcClass}</td>
                                <td data-label={t("ids.columns.name")}>{f.name ?? "—"}</td>
                                <td data-label={t("ids.columns.reason")}>{f.reasons.join("; ")}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                      {s.truncated && <p className="muted small">{t("ids.truncated", { n: s.failures.length })}</p>}
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
