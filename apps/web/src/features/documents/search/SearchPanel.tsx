import { useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  OUTCOME_CODES,
  SEARCH_STATES,
  formatSearchQuery,
  parseSearchQuery,
  searchFilterCount,
  type AttributeDefinitionDto,
  type CompanyDto,
  type DocSearchParams,
  type MemberDto,
  type SavedSearchDto,
  type SearchReviewFilter,
} from "@sitekeep/shared";
import { useLabel } from "../../../i18n";
import { Icon } from "../../../shared/ui/Icon";
import { documentsApi } from "../api";
import { FolderMultiPicker } from "./FolderMultiPicker";
import { SavedSearchShareDialog } from "./SavedSearchShareDialog";

export type SearchScope = "folder" | "all" | "folders";

export function scopeOf(p: DocSearchParams): SearchScope {
  return p.folderId ? "folder" : p.folderIds?.length ? "folders" : "all";
}

const COMMON_EXTS = ["pdf", "dwg", "dxf", "ifc", "rvt", "docx", "xlsx", "jpg"];
const REVIEW_FILTERS: SearchReviewFilter[] = [...OUTCOME_CODES, "pending", "none"];

/** "S2, A1" → ["S2", "A1"]. */
const splitList = (v: string) =>
  v
    .split(/[,;\s]+/)
    .map((x) => x.trim())
    .filter(Boolean);

/**
 * "Ara ve Süz": the search panel on the right of Dokümanlar (full width on phones). The Search tab
 * holds the text, the scope, "content too", the last five searches and the filters; the Saved
 * Searches tab lists the caller's and shared searches.
 */
export function SearchPanel({
  projectId,
  rootFolderId,
  folderId,
  folderName,
  params,
  onChange,
  onSearch,
  onClose,
  recent,
  saved,
  onSavedChanged,
  onRunSaved,
  isProjectAdmin,
  attributeDefs,
  members,
  companies,
  tab,
  onTab,
}: {
  projectId: string;
  rootFolderId: string;
  /** The folder open in Dokümanlar ("this folder"). */
  folderId: string;
  folderName: string;
  params: DocSearchParams;
  onChange(next: DocSearchParams): void;
  onSearch(params: DocSearchParams): void;
  onClose(): void;
  recent: DocSearchParams[];
  saved: SavedSearchDto[] | null;
  onSavedChanged(): void;
  onRunSaved(s: SavedSearchDto): void;
  isProjectAdmin: boolean;
  attributeDefs: AttributeDefinitionDto[];
  members: MemberDto[];
  companies: CompanyDto[];
  tab: "search" | "saved";
  onTab(tab: "search" | "saved"): void;
}) {
  const { t } = useTranslation(["documents", "common", "cde"]);
  const label = useLabel();
  const [picking, setPicking] = useState(false);
  // Names of the selected folders (known when picked here; a saved search shows a count).
  const [folderNames, setFolderNames] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [sharing, setSharing] = useState<SavedSearchDto | null>(null);
  const [savedError, setSavedError] = useState<string | null>(null);
  const [extText, setExtText] = useState("");
  const scope = scopeOf(params);
  const filterCount = searchFilterCount(params);
  const set = (patch: Partial<DocSearchParams>) => onChange({ ...params, ...patch });
  const attrs = params.attrs ?? {};
  const unusedDefs = attributeDefs.filter((d) => !(d.name in attrs));
  const parsed = useMemo(() => formatSearchQuery(parseSearchQuery(params.q ?? "")), [params.q]);
  const showParsed = !!params.q?.trim() && /\b(AND|OR|NOT|VE|VEYA|DEĞİL)\b|[()*"]/.test(params.q);

  function setScope(next: SearchScope) {
    if (next === "folder") set({ folderId, folderIds: undefined });
    else if (next === "all") set({ folderId: undefined, folderIds: undefined });
    else if (!params.folderIds?.length) setPicking(true);
    else set({ folderId: undefined });
  }

  function toggleIn<T extends string>(list: T[] | undefined, v: T): T[] | undefined {
    const next = list?.includes(v) ? list.filter((x) => x !== v) : [...(list ?? []), v];
    return next.length ? next : undefined;
  }

  async function save() {
    const name = saving?.trim();
    if (!name) return;
    setSaveError(null);
    try {
      await documentsApi.createSavedSearch(projectId, { name, params: { ...params, offset: undefined, limit: undefined } });
      setSaving(null);
      onSavedChanged();
      onTab("saved");
    } catch (e) {
      setSaveError((e as Error).message);
    }
  }

  async function remove(s: SavedSearchDto) {
    if (!window.confirm(t("searchPanel.saved.confirmDelete", { name: s.name }))) return;
    setSavedError(null);
    try {
      await documentsApi.deleteSavedSearch(projectId, s.id);
      onSavedChanged();
    } catch (e) {
      setSavedError((e as Error).message);
    }
  }

  const field = (title: string, children: ReactNode, testId?: string) => (
    <div className="search-panel-field" data-testid={testId}>
      <label>{title}</label>
      {children}
    </div>
  );

  return (
    <aside className="drawer search-panel" aria-label={t("searchPanel.title")} data-testid="search-panel">
      <div className="row">
        <h2 style={{ margin: 0 }}>{t("searchPanel.title")}</h2>
        <div className="spacer" />
        <button className="ghost" onClick={onClose} aria-label={t("common:actions.close")}>
          ✕
        </button>
      </div>
      <nav className="tabs search-panel-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === "search"} className={tab === "search" ? "active" : ""} onClick={() => onTab("search")}>
          {t("searchPanel.tabs.search")}
        </button>
        <button type="button" role="tab" aria-selected={tab === "saved"} className={tab === "saved" ? "active" : ""} onClick={() => onTab("saved")}>
          {t("searchPanel.tabs.saved")}
          {saved?.length ? <span className="segmented-count">{saved.length}</span> : null}
        </button>
      </nav>

      {tab === "search" ? (
        <form
          className="search-panel-body"
          onSubmit={(e) => {
            e.preventDefault();
            onSearch(params);
          }}
        >
          <div className="docs-search search-panel-input">
            <Icon name="search" size={15} />
            <input
              type="search"
              autoFocus
              aria-label={t("searchPanel.query")}
              placeholder={t("searchPanel.queryPlaceholder")}
              value={params.q ?? ""}
              onChange={(e) => set({ q: e.target.value })}
            />
          </div>
          {showParsed && (
            <p className="muted small" style={{ margin: "4px 0 0" }} data-testid="search-parsed">
              {t("searchPanel.parsed", { query: parsed || "—" })}
            </p>
          )}
          <details className="search-panel-help">
            <summary className="small">{t("searchPanel.syntax.title")}</summary>
            <ul className="small muted">
              <li>{t("searchPanel.syntax.and")}</li>
              <li>{t("searchPanel.syntax.or")}</li>
              <li>{t("searchPanel.syntax.not")}</li>
              <li>{t("searchPanel.syntax.phrase")}</li>
              <li>{t("searchPanel.syntax.wildcard")}</li>
              <li>{t("searchPanel.syntax.codes")}</li>
            </ul>
          </details>

          <fieldset className="search-panel-section">
            <legend>{t("searchPanel.scope.title")}</legend>
            <div className="row wrap" style={{ gap: 12 }}>
              {(["folder", "all", "folders"] as const).map((s) => (
                <label key={s} className="row" style={{ gap: 6, margin: 0, fontWeight: 400 }}>
                  <input type="radio" name="search-scope" style={{ width: "auto" }} checked={scope === s} onChange={() => setScope(s)} />
                  {s === "folder" ? t("searchPanel.scope.folder", { name: folderName }) : t(`searchPanel.scope.${s}`)}
                </label>
              ))}
            </div>
            {scope === "folders" && (
              <div className="row wrap small" style={{ gap: 6, marginTop: 6 }}>
                <span className="muted">
                  {params.folderIds!.every((id) => folderNames[id])
                    ? params.folderIds!.map((id) => folderNames[id]).join(", ")
                    : t("searchPanel.scope.selectedCount", { count: params.folderIds!.length })}
                </span>
                <button type="button" className="small ghost" onClick={() => setPicking(true)}>
                  {t("searchPanel.scope.change")}
                </button>
              </div>
            )}
            <div className="row wrap" style={{ gap: 12, marginTop: 6 }}>
              {scope !== "all" && (
                <label className="row" style={{ gap: 6, margin: 0, fontWeight: 400 }}>
                  <input type="checkbox" style={{ width: "auto" }} checked={params.subfolders !== false} onChange={(e) => set({ subfolders: e.target.checked ? undefined : false })} />
                  {t("searchPanel.scope.subfolders")}
                </label>
              )}
              <label className="row" style={{ gap: 6, margin: 0, fontWeight: 400 }} title={t("searchPanel.contentHint")}>
                <input type="checkbox" style={{ width: "auto" }} checked={params.content !== false} onChange={(e) => set({ content: e.target.checked ? undefined : false })} />
                {t("searchPanel.content")}
              </label>
              {isProjectAdmin && (
                <label className="row" style={{ gap: 6, margin: 0, fontWeight: 400 }} title={t("searchPanel.trashHint")}>
                  <input type="checkbox" style={{ width: "auto" }} checked={!!params.trash} onChange={(e) => set({ trash: e.target.checked || undefined })} />
                  {t("searchPanel.trash")}
                </label>
              )}
            </div>
          </fieldset>

          {recent.length > 0 && (
            <div className="search-panel-section">
              <strong className="small">{t("searchPanel.recent")}</strong>
              <div className="stack" style={{ gap: 2, marginTop: 4 }}>
                {recent.map((r, i) => (
                  <button
                    key={i}
                    type="button"
                    className="ghost small search-panel-recent"
                    onClick={() => {
                      onChange(r);
                      onSearch(r);
                    }}
                  >
                    <Icon name="refresh" size={13} />
                    <span>{r.q?.trim() || t("searchPanel.filtersOnly")}</span>
                    {searchFilterCount(r) > 0 && <span className="muted">{t("searchPanel.filterCount", { count: searchFilterCount(r) })}</span>}
                  </button>
                ))}
              </div>
            </div>
          )}

          <fieldset className="search-panel-section">
            <legend>
              {t("searchPanel.filters.title")}
              {filterCount > 0 && <span className="badge info" style={{ marginLeft: 6 }}>{filterCount}</span>}
              {filterCount > 0 && (
                <button
                  type="button"
                  className="ghost small"
                  style={{ marginLeft: 6 }}
                  onClick={() =>
                    onChange({
                      q: params.q,
                      content: params.content,
                      folderId: params.folderId,
                      folderIds: params.folderIds,
                      subfolders: params.subfolders,
                      trash: params.trash,
                    })
                  }
                >
                  {t("common:actions.clear")}
                </button>
              )}
            </legend>

            {field(
              t("searchPanel.filters.fileTypes"),
              <>
                <div className="seg wrap">
                  {COMMON_EXTS.map((e) => (
                    <button key={e} type="button" className={params.ext?.includes(e) ? "active small" : "small"} aria-pressed={!!params.ext?.includes(e)} onClick={() => set({ ext: toggleIn(params.ext, e) })}>
                      .{e}
                    </button>
                  ))}
                  {(params.ext ?? [])
                    .filter((e) => !COMMON_EXTS.includes(e))
                    .map((e) => (
                      <button key={e} type="button" className="active small" aria-pressed onClick={() => set({ ext: toggleIn(params.ext, e) })}>
                        .{e} ✕
                      </button>
                    ))}
                </div>
                <input
                  className="small"
                  style={{ marginTop: 6 }}
                  placeholder={t("searchPanel.filters.otherTypes")}
                  value={extText}
                  onChange={(e) => setExtText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key !== "Enter") return;
                    e.preventDefault();
                    const more = splitList(extText.toLowerCase()).map((x) => x.replace(/^\*?\./, ""));
                    if (more.length) set({ ext: [...new Set([...(params.ext ?? []), ...more])] });
                    setExtText("");
                  }}
                />
              </>,
              "filter-ext",
            )}

            {field(
              t("searchPanel.filters.state"),
              <div className="seg wrap">
                {SEARCH_STATES.map((s) => (
                  <button key={s} type="button" className={params.states?.includes(s) ? "active small" : "small"} aria-pressed={!!params.states?.includes(s)} onClick={() => set({ states: toggleIn(params.states, s) })}>
                    {label("folderState", s)}
                  </button>
                ))}
              </div>,
              "filter-state",
            )}

            <div className="row wrap" style={{ gap: 8 }}>
              {field(
                t("searchPanel.filters.suitability"),
                <input placeholder="S2, A1" value={(params.suitability ?? []).join(", ")} onChange={(e) => set({ suitability: splitList(e.target.value).length ? splitList(e.target.value) : undefined })} />,
                "filter-suitability",
              )}
              {field(
                t("searchPanel.filters.revision"),
                <input placeholder="P01*" value={params.revision ?? ""} onChange={(e) => set({ revision: e.target.value || undefined })} />,
                "filter-revision",
              )}
            </div>

            <div className="row wrap" style={{ gap: 8 }}>
              {field(
                t("searchPanel.filters.uploadedBy"),
                <select value={params.uploadedBy?.[0] ?? ""} onChange={(e) => set({ uploadedBy: e.target.value ? [e.target.value] : undefined })}>
                  <option value="">{t("searchPanel.filters.anyone")}</option>
                  {members.filter((m) => !m.pending).map((m) => (
                    <option key={m.userId} value={m.userId}>
                      {m.name}
                    </option>
                  ))}
                </select>,
                "filter-uploader",
              )}
              {field(
                t("searchPanel.filters.company"),
                <select value={params.companies?.[0] ?? ""} onChange={(e) => set({ companies: e.target.value ? [e.target.value] : undefined })}>
                  <option value="">{t("searchPanel.filters.anyCompany")}</option>
                  {companies.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>,
                "filter-company",
              )}
            </div>

            {field(
              t("searchPanel.filters.updated"),
              <div className="row search-panel-dates">
                <input type="date" aria-label={t("searchPanel.filters.from")} value={params.updatedFrom ?? ""} onChange={(e) => set({ updatedFrom: e.target.value || undefined })} />
                <span aria-hidden>→</span>
                <input type="date" aria-label={t("searchPanel.filters.to")} value={params.updatedTo ?? ""} onChange={(e) => set({ updatedTo: e.target.value || undefined })} />
              </div>,
              "filter-updated",
            )}
            {field(
              t("searchPanel.filters.added"),
              <div className="row search-panel-dates">
                <input type="date" aria-label={t("searchPanel.filters.from")} value={params.addedFrom ?? ""} onChange={(e) => set({ addedFrom: e.target.value || undefined })} />
                <span aria-hidden>→</span>
                <input type="date" aria-label={t("searchPanel.filters.to")} value={params.addedTo ?? ""} onChange={(e) => set({ addedTo: e.target.value || undefined })} />
              </div>,
              "filter-added",
            )}

            <div className="row wrap" style={{ gap: 8 }}>
              {field(
                t("searchPanel.filters.version"),
                <input placeholder={t("searchPanel.filters.versionPlaceholder")} value={params.version ?? ""} onChange={(e) => set({ version: e.target.value || undefined })} />,
                "filter-version",
              )}
              <label className="row" style={{ gap: 6, margin: "22px 0 0", fontWeight: 400 }}>
                <input type="checkbox" style={{ width: "auto" }} checked={!!params.locked} onChange={(e) => set({ locked: e.target.checked || undefined })} />
                <Icon name="lock" size={14} />
                {t("searchPanel.filters.locked")}
              </label>
            </div>

            {field(
              t("searchPanel.filters.review"),
              <div className="seg wrap">
                {REVIEW_FILTERS.map((r) => (
                  <button key={r} type="button" className={params.review?.includes(r) ? "active small" : "small"} aria-pressed={!!params.review?.includes(r)} onClick={() => set({ review: toggleIn(params.review, r) })}>
                    {r === "pending" || r === "none" ? t(`searchPanel.filters.review_${r}`) : label("outcome", r)}
                  </button>
                ))}
              </div>,
              "filter-review",
            )}

            <div className="search-panel-field">
              <label>{t("searchPanel.filters.attributes")}</label>
              {Object.entries(attrs).map(([name, value]) => {
                const def = attributeDefs.find((d) => d.name === name);
                return (
                  <div key={name} className="row" style={{ gap: 6, marginBottom: 6 }}>
                    <span className="small" style={{ minWidth: 90 }}>
                      {name}
                    </span>
                    {def?.type === "list" ? (
                      <select value={value} onChange={(e) => set({ attrs: { ...attrs, [name]: e.target.value } })}>
                        <option value="">—</option>
                        {def.options.map((o) => (
                          <option key={o} value={o}>
                            {o}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        type={def?.type === "date" ? "date" : "text"}
                        aria-label={name}
                        value={value}
                        onChange={(e) => set({ attrs: { ...attrs, [name]: e.target.value } })}
                      />
                    )}
                    <button
                      type="button"
                      className="ghost small"
                      aria-label={t("common:actions.remove")}
                      onClick={() => {
                        const next = { ...attrs };
                        delete next[name];
                        set({ attrs: Object.keys(next).length ? next : undefined });
                      }}
                    >
                      ✕
                    </button>
                  </div>
                );
              })}
              {unusedDefs.length > 0 && (
                <select
                  aria-label={t("searchPanel.filters.addAttribute")}
                  data-testid="filter-add-attribute"
                  value=""
                  onChange={(e) => e.target.value && set({ attrs: { ...attrs, [e.target.value]: "" } })}
                >
                  <option value="">+ {t("searchPanel.filters.addAttribute")}</option>
                  {unusedDefs.map((d) => (
                    <option key={d.id} value={d.name}>
                      {d.name}
                    </option>
                  ))}
                </select>
              )}
              {attributeDefs.length === 0 && <span className="muted small">{t("searchPanel.filters.noAttributes")}</span>}
            </div>
          </fieldset>

          <div className="search-panel-footer">
            {saving === null ? (
              <button type="button" onClick={() => setSaving(params.q?.trim() || "")} disabled={!params.q?.trim() && !filterCount}>
                {t("searchPanel.save")}
              </button>
            ) : (
              <div className="row" style={{ gap: 6, flex: 1 }}>
                <input
                  autoFocus
                  aria-label={t("searchPanel.saveName")}
                  placeholder={t("searchPanel.saveName")}
                  value={saving}
                  onChange={(e) => setSaving(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void save();
                    }
                    if (e.key === "Escape") setSaving(null);
                  }}
                />
                <button type="button" className="primary" disabled={!saving.trim()} onClick={() => void save()}>
                  {t("common:actions.save")}
                </button>
                <button type="button" className="ghost" onClick={() => setSaving(null)} aria-label={t("common:actions.cancel")}>
                  ✕
                </button>
              </div>
            )}
            {saving === null && <div className="spacer" />}
            {saving === null && (
              <button type="submit" className="primary">
                <Icon name="search" size={15} />
                {t("searchPanel.run")}
              </button>
            )}
          </div>
          {saveError && <p className="error">{saveError}</p>}
        </form>
      ) : (
        <div className="search-panel-body">
          {savedError && <p className="error">{savedError}</p>}
          {!saved && <p className="muted">{t("search.searching")}</p>}
          {saved?.length === 0 && <p className="muted">{t("searchPanel.saved.empty")}</p>}
          <ul className="search-panel-saved">
            {saved?.map((s) => (
              <li key={s.id}>
                <button type="button" className="ghost search-panel-saved-run" onClick={() => onRunSaved(s)}>
                  <Icon name="search" size={14} />
                  <span className="search-panel-saved-name">{s.name}</span>
                </button>
                <div className="muted small search-panel-saved-meta">
                  {s.params.q ? <span>“{s.params.q}”</span> : null}
                  {searchFilterCount(s.params) > 0 && <span>{t("searchPanel.filterCount", { count: searchFilterCount(s.params) })}</span>}
                  {!s.mine && <span>{t("searchPanel.saved.sharedBy", { name: s.ownerName ?? "—" })}</span>}
                  {s.shares.length > 0 && (
                    <span className="badge info" title={s.shares.map((x) => x.subjectName ?? x.subjectId).join(", ")}>
                      {t("searchPanel.saved.shared")}
                    </span>
                  )}
                </div>
                <div className="row" style={{ gap: 4 }}>
                  {isProjectAdmin && (
                    <button type="button" className="small" onClick={() => setSharing(s)}>
                      {t("searchPanel.saved.share")}
                    </button>
                  )}
                  {(s.mine || isProjectAdmin) && (
                    <button type="button" className="small ghost" onClick={() => void remove(s)} aria-label={t("searchPanel.saved.delete", { name: s.name })}>
                      <Icon name="trash" size={14} />
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
          {!isProjectAdmin && <p className="muted small">{t("searchPanel.saved.shareHint")}</p>}
        </div>
      )}

      {picking && (
        <FolderMultiPicker
          projectId={projectId}
          rootId={rootFolderId}
          value={Object.fromEntries((params.folderIds ?? []).map((id) => [id, folderNames[id] ?? id]))}
          onClose={() => setPicking(false)}
          onPick={(next) => {
            setPicking(false);
            setFolderNames((n) => ({ ...n, ...next }));
            const ids = Object.keys(next);
            set({ folderIds: ids.length ? ids : undefined, folderId: undefined });
          }}
        />
      )}
      {sharing && (
        <SavedSearchShareDialog
          projectId={projectId}
          search={sharing}
          onClose={() => setSharing(null)}
          onSaved={() => {
            setSharing(null);
            onSavedChanged();
          }}
        />
      )}
    </aside>
  );
}
