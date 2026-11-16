/**
 * Sheets ("Paftalar", FP-2, docs/features/SHEETS.md): the drawing sheets of the project as a grid
 * or a list with filters, the sheet sets beside them (publish an issue, export the sheet list,
 * download the PDFs), and a sheet's details with its history across versions.
 */
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { CDE_STATES, type CdeState, type DrawingSheetDto, type SheetSetDto } from "@sitekeep/shared";
import { useLoad, useProject } from "../../app/context/project";
import { formatDate } from "../../shared/lib/format";
import { useAsk } from "../../shared/ui/Ask";
import { Dialog } from "../../shared/ui/Dialog";
import { Icon } from "../../shared/ui/Icon";
import { LoadingIndicator } from "../../shared/ui/LoadingIndicator";
import { sheetsApi, type SheetFilters } from "./api";
import { SheetThumb, releaseThumbnails } from "./SheetThumb";
import { OcrBadge } from "./OcrBadge";
import { TitleBlockEditor } from "./TitleBlockEditor";
import "./sheets.css";

type View = "grid" | "list";

/** Where a sheet opens: the PDF viewer at its page, other formats in their viewer. */
export function sheetViewerPath(pid: string, s: Pick<DrawingSheetDto, "format" | "versionId" | "page">): string {
  return s.format === "pdf" ? `/projects/${pid}/view/${s.versionId}?page=${s.page}` : `/projects/${pid}/open/${s.versionId}`;
}

export function SheetsPage() {
  const { t } = useTranslation(["sheets", "common", "cde"]);
  const project = useProject();
  const navigate = useNavigate();
  const { sheetId } = useParams();
  const [params, setParams] = useSearchParams();
  const { confirm, prompt } = useAsk();
  const setId = params.get("set") ?? "";
  const [view, setView] = useState<View>(() => (localStorageGet("sitekeep.sheets.view") === "list" ? "list" : "grid"));
  const [filters, setFilters] = useState<SheetFilters>({});
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [publishing, setPublishing] = useState(false);

  useEffect(() => () => releaseThumbnails(), []);
  useEffect(() => localStorageSet("sitekeep.sheets.view", view), [view]);
  // Search as you type, one request after a short pause.
  useEffect(() => {
    const timer = setTimeout(() => setFilters((f) => (f.q === search ? f : { ...f, q: search })), 250);
    return () => clearTimeout(timer);
  }, [search]);

  const query = { ...filters, setId: setId || undefined };
  const list = useLoad(() => sheetsApi.list(project.id, query), [project.id, JSON.stringify(query)]);
  const sets = useLoad(() => sheetsApi.sets(project.id), [project.id]);
  const set = useLoad(() => (setId ? sheetsApi.set(project.id, setId) : Promise.resolve(null)), [project.id, setId]);

  const sheets = list.data?.sheets ?? [];
  const chosen = sheets.filter((s) => selected.has(s.id));
  const pickSet = (id: string) =>
    setParams(
      (p) => {
        if (id) p.set("set", id);
        else p.delete("set");
        return p;
      },
      { replace: true },
    );
  const reloadAll = () => {
    list.reload();
    sets.reload();
    set.reload();
  };
  const fail = (e: unknown) => setMsg({ ok: false, text: (e as Error).message });

  async function newSet(fromSelection: boolean) {
    const name = await prompt({ title: t("sets.new"), message: t("sets.namePrompt"), confirmLabel: t("sets.create") });
    if (!name?.trim()) return;
    try {
      const created = await sheetsApi.createSet(project.id, { name: name.trim(), sheetIds: fromSelection ? chosen.map((s) => s.id) : [] });
      setSelected(new Set());
      setMsg({ ok: true, text: t("sets.created", { name: created.name }) });
      sets.reload();
      pickSet(created.id);
    } catch (e) {
      fail(e);
    }
  }

  async function addTo(target: string) {
    if (!target || !chosen.length) return;
    try {
      const r = await sheetsApi.addItems(project.id, target, chosen.map((s) => s.id));
      const name = sets.data?.sets.find((s) => s.id === target)?.name ?? "";
      setMsg({ ok: true, text: t("sets.added", { count: r.added, name }) });
      setSelected(new Set());
      reloadAll();
    } catch (e) {
      fail(e);
    }
  }

  async function removeFromSet(current: SheetSetDto) {
    const keys = [...new Set(chosen.map((s) => sheetKeyOf(current, s)).filter((k): k is string => !!k))];
    if (!keys.length) return;
    try {
      const r = await sheetsApi.removeItems(project.id, current.id, keys);
      setMsg({ ok: true, text: t("sets.removed", { count: r.removed }) });
      setSelected(new Set());
      reloadAll();
    } catch (e) {
      fail(e);
    }
  }

  async function renameSet(current: SheetSetDto) {
    const name = await prompt({ title: t("sets.rename"), defaultValue: current.name, confirmLabel: t("common:actions.save") });
    if (!name?.trim() || name.trim() === current.name) return;
    try {
      await sheetsApi.updateSet(project.id, current.id, { name: name.trim() });
      reloadAll();
    } catch (e) {
      fail(e);
    }
  }

  async function deleteSet(current: SheetSetDto) {
    const ok = await confirm({ title: t("sets.delete"), message: t("sets.deleteConfirm", { name: current.name }), danger: true, confirmLabel: t("sets.delete") });
    if (!ok) return;
    try {
      await sheetsApi.deleteSet(project.id, current.id);
      pickSet("");
      sets.reload();
    } catch (e) {
      fail(e);
    }
  }

  async function rescan() {
    try {
      const r = await sheetsApi.rescan(project.id);
      setMsg({ ok: true, text: t("rescanQueued", { count: r.queued }) });
    } catch (e) {
      fail(e);
    }
  }

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const allChecked = sheets.length > 0 && chosen.length === sheets.length;
  const current = setId ? set.data : null;
  const exportBase = query;

  return (
    <div className="page sheets-page">
      <div className="page-header">
        <div>
          <h1>{t("title")}</h1>
          <p>{t("description")}</p>
        </div>
        <div className="row sheets-head-actions">
          <a className="btn" href={sheetsApi.exportUrl(project.id, exportBase, "xlsx")} download data-testid="sheets-export-xlsx">
            <Icon name="download" size={14} /> {t("export.xlsx")}
          </a>
          <a className="btn" href={sheetsApi.exportUrl(project.id, exportBase, "csv")} download data-testid="sheets-export-csv">
            {t("export.csv")}
          </a>
          {project.isProjectAdmin && (
            <button type="button" onClick={rescan} title={t("rescanHint")}>
              <Icon name="refresh" size={14} /> {t("rescan")}
            </button>
          )}
        </div>
      </div>

      {msg && (
        <div className={msg.ok ? "success" : "error"} role="status">
          {msg.text}
        </div>
      )}

      <div className="sheets-layout">
        <aside className="sheets-sets card" aria-label={t("sets.title")}>
          <div className="row">
            <h2>{t("sets.title")}</h2>
            <span className="spacer" />
            <button type="button" className="ghost" onClick={() => newSet(false)} data-testid="sheets-new-set">
              <Icon name="plus" size={14} /> {t("sets.new")}
            </button>
          </div>
          <ul className="sheets-set-list">
            <li>
              <button type="button" className={!setId ? "active" : ""} onClick={() => pickSet("")}>
                {t("sets.all")}
              </button>
            </li>
            {sets.data?.sets.map((s) => (
              <li key={s.id}>
                <button type="button" className={setId === s.id ? "active" : ""} onClick={() => pickSet(s.id)}>
                  <span>{s.name}</span>
                  <span className="muted">
                    {s.issue ? t("sets.issueShort", { no: pad(s.issue) }) : t("sets.notPublished")} · {t("sets.count", { count: s.itemCount })}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {sets.data && !sets.data.sets.length && <p className="muted">{t("sets.none")}</p>}
        </aside>

        <section className="sheets-main">
          {current && (
            <SetHeader
              set={current}
              pid={project.id}
              onPublish={() => setPublishing(true)}
              onRename={() => renameSet(current)}
              onDelete={() => deleteSet(current)}
            />
          )}

          <div className="sheets-toolbar">
            <label className="docs-search">
              <Icon name="search" size={16} />
              <input
                placeholder={t("filters.search")}
                aria-label={t("filters.search")}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </label>
            <select aria-label={t("filters.discipline")} value={filters.discipline ?? ""} onChange={(e) => setFilters((f) => ({ ...f, discipline: e.target.value || undefined }))}>
              <option value="">{t("filters.allDisciplines")}</option>
              {list.data?.disciplines.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
            <select aria-label={t("filters.revision")} value={filters.revision ?? ""} onChange={(e) => setFilters((f) => ({ ...f, revision: e.target.value || undefined }))}>
              <option value="">{t("filters.allRevisions")}</option>
              {list.data?.revisions.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
            <select aria-label={t("filters.state")} value={filters.state ?? ""} onChange={(e) => setFilters((f) => ({ ...f, state: e.target.value as CdeState | "" }))}>
              <option value="">{t("filters.allStates")}</option>
              {CDE_STATES.map((s) => (
                <option key={s} value={s}>
                  {t(`cde:states.${s}`)}
                </option>
              ))}
            </select>
            <span className="spacer" />
            <div className="segmented" role="tablist" aria-label={t("view.label")}>
              {(["grid", "list"] as const).map((v) => (
                <button key={v} role="tab" aria-selected={view === v} className={view === v ? "active" : ""} onClick={() => setView(v)}>
                  {t(`view.${v}`)}
                </button>
              ))}
            </div>
          </div>

          {chosen.length > 0 && (
            <div className="sheets-selection row" data-testid="sheets-selection">
              <strong>{t("selection.count", { count: chosen.length })}</strong>
              <button type="button" onClick={() => newSet(true)}>
                {t("selection.newSet")}
              </button>
              {!!sets.data?.sets.filter((s) => s.canManage && s.id !== setId).length && (
                <select aria-label={t("selection.addTo")} value="" onChange={(e) => void addTo(e.target.value)}>
                  <option value="">{t("selection.addTo")}</option>
                  {sets.data.sets
                    .filter((s) => s.canManage && s.id !== setId)
                    .map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                </select>
              )}
              {current?.canManage && (
                <button type="button" onClick={() => removeFromSet(current)}>
                  {t("selection.remove")}
                </button>
              )}
              <button type="button" className="ghost" onClick={() => setSelected(new Set())}>
                {t("selection.clear")}
              </button>
            </div>
          )}

          {list.error && <div className="error">{list.error}</div>}
          {!list.data && !list.error && <LoadingIndicator />}
          {list.data && !sheets.length && (
            <div className="card sheets-empty">
              <strong>{t(setId ? "empty.set" : "empty.title")}</strong>
              <p className="muted">{t("empty.hint")}</p>
            </div>
          )}
          {list.data && !!sheets.length && (
            <>
              <div className="row muted sheets-count">
                <label className="check">
                  <input type="checkbox" checked={allChecked} onChange={() => setSelected(allChecked ? new Set() : new Set(sheets.map((s) => s.id)))} />{" "}
                  {t("selection.all")}
                </label>
                <span>{t("count", { count: list.data.total })}</span>
              </div>
              {view === "grid" ? (
                <div className="sheets-grid" data-testid="sheets-grid">
                  {sheets.map((s) => (
                    <article key={s.id} className={`sheet-card card${selected.has(s.id) ? " selected" : ""}`} data-testid="sheet-card">
                      <input type="checkbox" className="sheet-card-check" aria-label={s.number} checked={selected.has(s.id)} onChange={() => toggle(s.id)} />
                      <Link to={`/projects/${project.id}/sheets/${s.id}${setId ? `?set=${setId}` : ""}`} className="sheet-card-link">
                        <SheetThumb pid={project.id} sheet={s} />
                        <strong className="sheet-number">{s.number}</strong>
                        <span className="sheet-title">{s.title ?? <span className="muted">{t("noTitle")}</span>}</span>
                      </Link>
                      <SheetChips sheet={s} />
                    </article>
                  ))}
                </div>
              ) : (
                <div className="table-scroll card">
                  <table className="sheets-table" data-testid="sheets-table">
                    <thead>
                      <tr>
                        <th />
                        <th>{t("columns.number")}</th>
                        <th>{t("columns.title")}</th>
                        <th>{t("columns.discipline")}</th>
                        <th>{t("columns.revision")}</th>
                        <th>{t("columns.suitability")}</th>
                        <th>{t("columns.date")}</th>
                        <th>{t("columns.state")}</th>
                        <th>{t("columns.file")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sheets.map((s) => (
                        <tr key={s.id} className={selected.has(s.id) ? "selected" : ""}>
                          <td>
                            <input type="checkbox" aria-label={s.number} checked={selected.has(s.id)} onChange={() => toggle(s.id)} />
                          </td>
                          <td>
                            <Link to={`/projects/${project.id}/sheets/${s.id}${setId ? `?set=${setId}` : ""}`}>{s.number}</Link> <OcrBadge sheet={s} />
                          </td>
                          <td>{s.title}</td>
                          <td>{s.discipline}</td>
                          <td>{s.revision}</td>
                          <td>{s.suitability}</td>
                          <td>{s.date ? formatDate(s.date) : ""}</td>
                          <td>{s.state ? t(`cde:states.${s.state}`) : ""}</td>
                          <td className="muted">
                            {s.fileName}
                            {s.pageCount > 1 ? ` · ${t("pageOf", { page: s.page, count: s.pageCount })}` : ""}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </section>
      </div>

      {sheetId && (
        <SheetDrawer
          pid={project.id}
          sheetId={sheetId}
          onClose={() => navigate(`/projects/${project.id}/sheets${setId ? `?set=${setId}` : ""}`)}
          onChanged={reloadAll}
          onMessage={(text) => setMsg({ ok: true, text })}
        />
      )}
      {publishing && current && (
        <PublishDialog
          pid={project.id}
          set={current}
          onClose={() => setPublishing(false)}
          onDone={(issue) => {
            setPublishing(false);
            setMsg({ ok: true, text: t("publish.done", { name: current.name, no: pad(issue) }) });
            reloadAll();
          }}
        />
      )}
    </div>
  );
}

function sheetKeyOf(set: SheetSetDto, s: DrawingSheetDto): string | null {
  return set.items.find((i) => i.sheet?.id === s.id || i.number === s.number)?.key ?? null;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function localStorageGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function localStorageSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage blocked */
  }
}

function SheetChips({ sheet }: { sheet: DrawingSheetDto }) {
  const { t } = useTranslation(["sheets", "cde"]);
  return (
    <div className="sheet-chips">
      <OcrBadge sheet={sheet} />
      {sheet.revision && <span className="badge info">{sheet.revision}</span>}
      {sheet.suitability && <span className="badge">{sheet.suitability}</span>}
      {sheet.state && <span className="badge">{t(`cde:states.${sheet.state}`)}</span>}
      {sheet.cdeStatus && <span className="badge warn">{t(`cde:statuses.${sheet.cdeStatus as "returned"}`)}</span>}
      {sheet.discipline && <span className="muted">{sheet.discipline}</span>}
    </div>
  );
}

function SetHeader({ set, pid, onPublish, onRename, onDelete }: { set: SheetSetDto; pid: string; onPublish(): void; onRename(): void; onDelete(): void }) {
  const { t } = useTranslation(["sheets", "common"]);
  return (
    <div className="card sheets-set-head" data-testid="sheet-set-head">
      <div className="row">
        <div>
          <h2>{set.name}</h2>
          <p className="muted">
            {set.issue ? t("sets.lastIssue", { no: pad(set.issue), date: formatDate(set.publishedAt!) }) : t("sets.notPublished")} ·{" "}
            {t("sets.count", { count: set.itemCount })}
            {set.hidden ? ` · ${t("sets.hidden", { count: set.hidden })}` : ""}
          </p>
        </div>
        <span className="spacer" />
        <a className="btn" href={sheetsApi.setExportUrl(pid, set.id, "xlsx")} download>
          {t("export.xlsx")}
        </a>
        <a className="btn" href={sheetsApi.setZipUrl(pid, set.id)} download>
          <Icon name="download" size={14} /> {t("export.zip")}
        </a>
        {set.canManage && (
          <>
            <button type="button" onClick={onRename}>
              {t("sets.rename")}
            </button>
            <button type="button" className="ghost" onClick={onDelete}>
              {t("sets.delete")}
            </button>
            <button type="button" className="primary" onClick={onPublish} disabled={!set.items.length} data-testid="sheet-set-publish">
              {t("publish.action")}
            </button>
          </>
        )}
      </div>
      {!!set.publications.length && (
        <details className="sheets-issues">
          <summary>{t("publish.issues", { count: set.publications.length })}</summary>
          <table>
            <thead>
              <tr>
                <th>{t("publish.issue")}</th>
                <th>{t("publish.date")}</th>
                <th>{t("publish.by")}</th>
                <th>{t("publish.note")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {set.publications.map((p) => (
                <tr key={p.id}>
                  <td>{pad(p.issue)}</td>
                  <td>{formatDate(p.publishedAt)}</td>
                  <td>{p.publishedByName ?? ""}</td>
                  <td>{p.note ?? ""}</td>
                  <td className="row">
                    <a href={sheetsApi.setExportUrl(pid, set.id, "xlsx", p.issue)} download>
                      {t("export.xlsx")}
                    </a>
                    <a href={sheetsApi.setExportUrl(pid, set.id, "csv", p.issue)} download>
                      {t("export.csv")}
                    </a>
                    <a href={sheetsApi.setZipUrl(pid, set.id, p.issue)} download>
                      {t("export.zip")}
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </div>
  );
}

function PublishDialog({ pid, set, onClose, onDone }: { pid: string; set: SheetSetDto; onClose(): void; onDone(issue: number): void }) {
  const { t } = useTranslation(["sheets", "common"]);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const visible = set.items.filter((i) => i.sheet);
  async function publish() {
    setBusy(true);
    setError(null);
    try {
      const r = await sheetsApi.publish(pid, set.id, note.trim() || null);
      onDone(r.issue);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  return (
    <Dialog title={t("publish.title", { name: set.name })} onClose={onClose}>
      <div className="stack">
        <p className="muted">{t("publish.explain", { no: pad((set.issue ?? 0) + 1), count: visible.length })}</p>
        <ul className="sheets-publish-list">
          {visible.map((i) => (
            <li key={i.key}>
              <strong>{i.sheet!.number}</strong> {i.sheet!.title} {i.sheet!.revision && <span className="badge info">{i.sheet!.revision}</span>}
            </li>
          ))}
        </ul>
        <label>
          {t("publish.note")}
          <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={1000} />
        </label>
        {error && <div className="error">{error}</div>}
        <div className="row">
          <span className="spacer" />
          <button type="button" onClick={onClose}>
            {t("common:actions.cancel")}
          </button>
          <button type="button" className="primary" onClick={publish} disabled={busy || !visible.length} data-testid="sheet-set-publish-confirm">
            {t("publish.confirm")}
          </button>
        </div>
      </div>
    </Dialog>
  );
}

function SheetDrawer({
  pid,
  sheetId,
  onClose,
  onChanged,
  onMessage,
}: {
  pid: string;
  sheetId: string;
  onClose(): void;
  onChanged(): void;
  onMessage(text: string): void;
}) {
  const { t } = useTranslation(["sheets", "common", "cde"]);
  const { data, error, reload } = useLoad(() => sheetsApi.detail(pid, sheetId), [pid, sheetId]);
  const [edit, setEdit] = useState<{ number: string; title: string; discipline: string } | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [templating, setTemplating] = useState(false);
  const sheet = data?.sheet;
  const history = useMemo(() => data?.history ?? [], [data]);

  if (templating && sheet)
    return (
      <TitleBlockEditor
        pid={pid}
        sheet={sheet}
        onClose={() => setTemplating(false)}
        onSaved={(text) => {
          setTemplating(false);
          onMessage(text);
          onClose();
        }}
      />
    );

  async function save() {
    if (!edit || !sheet) return;
    setSaveError(null);
    try {
      await sheetsApi.update(pid, sheet.id, { number: edit.number.trim(), title: edit.title.trim() || null, discipline: edit.discipline.trim() || null });
      setEdit(null);
      reload();
      onChanged();
    } catch (e) {
      setSaveError((e as Error).message);
    }
  }

  return (
    <Dialog title={sheet ? `${sheet.number}${sheet.title ? ` · ${sheet.title}` : ""}` : t("detail.title")} onClose={onClose} wide>
      {error && <div className="error">{error}</div>}
      {!data && !error && <LoadingIndicator />}
      {sheet && (
        <div className="sheet-detail">
          <div className="sheet-detail-preview">
            <SheetThumb pid={pid} sheet={sheet} width={420} />
            <Link className="btn primary" to={sheetViewerPath(pid, sheet)} data-testid="sheet-open-viewer">
              <Icon name="eye" size={14} /> {t("detail.open")}
            </Link>
          </div>
          <div className="stack">
            {edit ? (
              <div className="stack sheet-edit">
                <label>
                  {t("columns.number")}
                  <input value={edit.number} onChange={(e) => setEdit({ ...edit, number: e.target.value })} maxLength={120} />
                </label>
                <label>
                  {t("columns.title")}
                  <input value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} maxLength={300} />
                </label>
                <label>
                  {t("columns.discipline")}
                  <input value={edit.discipline} onChange={(e) => setEdit({ ...edit, discipline: e.target.value })} maxLength={100} />
                </label>
                {saveError && <div className="error">{saveError}</div>}
                <div className="row">
                  <button type="button" className="primary" onClick={save} disabled={!edit.number.trim()}>
                    {t("common:actions.save")}
                  </button>
                  <button type="button" onClick={() => setEdit(null)}>
                    {t("common:actions.cancel")}
                  </button>
                </div>
              </div>
            ) : (
              <dl className="sheet-meta">
                <dt>{t("columns.number")}</dt>
                <dd>
                  {sheet.number} <span className="muted">({t(`numberSource.${sheet.numberSource}`)})</span>
                </dd>
                {(sheet.readBy || sheet.fromTemplate) && (
                  <>
                    <dt>{t("ocr.readBy")}</dt>
                    <dd data-testid="sheet-read-by">
                      {t(`ocr.readByValues.${sheet.readBy ?? "none"}`)}
                      {sheet.fromTemplate ? ` · ${t("ocr.fromTemplate")}` : ""} <OcrBadge sheet={sheet} />
                    </dd>
                  </>
                )}
                <dt>{t("columns.title")}</dt>
                <dd>{sheet.title ?? "—"}</dd>
                <dt>{t("columns.discipline")}</dt>
                <dd>{sheet.discipline ?? "—"}</dd>
                <dt>{t("columns.revision")}</dt>
                <dd>{sheet.revision ?? "—"}</dd>
                <dt>{t("columns.suitability")}</dt>
                <dd>{sheet.suitability ?? "—"}</dd>
                <dt>{t("columns.date")}</dt>
                <dd>{sheet.date ? formatDate(sheet.date) : "—"}</dd>
                <dt>{t("columns.state")}</dt>
                <dd>{sheet.state ? t(`cde:states.${sheet.state}`) : "—"}</dd>
                <dt>{t("columns.file")}</dt>
                <dd>
                  {sheet.folderPath} / {sheet.fileName} · V{sheet.version}
                  {sheet.pageCount > 1 ? ` · ${t("pageOf", { page: sheet.page, count: sheet.pageCount })}` : ""}
                </dd>
                {!!data.sets.length && (
                  <>
                    <dt>{t("sets.title")}</dt>
                    <dd>{data.sets.map((s) => s.name).join(", ")}</dd>
                  </>
                )}
              </dl>
            )}
            {sheet.edited && !edit && <p className="muted">{t("detail.edited")}</p>}
            {data.canEdit && !edit && (
              <button type="button" onClick={() => setEdit({ number: sheet.number, title: sheet.title ?? "", discipline: sheet.discipline ?? "" })} data-testid="sheet-edit">
                {t("detail.edit")}
              </button>
            )}
            {data.canManage && sheet.format === "pdf" && !edit && (
              <button type="button" onClick={() => setTemplating(true)} data-testid="sheet-template">
                {t("template.open")}
              </button>
            )}
            <h3>{t("detail.history")}</h3>
            <table className="sheets-history">
              <thead>
                <tr>
                  <th>{t("columns.revision")}</th>
                  <th>{t("columns.version")}</th>
                  <th>{t("columns.state")}</th>
                  <th>{t("columns.date")}</th>
                  <th>{t("columns.file")}</th>
                </tr>
              </thead>
              <tbody>
                {history.map((h) => (
                  <tr key={h.id} className={h.id === sheet.id ? "selected" : ""}>
                    <td>{h.revision ?? "—"}</td>
                    <td>V{h.version}</td>
                    <td>{h.state ? t(`cde:states.${h.state}`) : ""}</td>
                    <td>{formatDate(h.uploadedAt)}</td>
                    <td>
                      <Link to={sheetViewerPath(pid, h)}>{h.fileName}</Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Dialog>
  );
}
