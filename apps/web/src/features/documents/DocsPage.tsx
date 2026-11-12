import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { Trans, useTranslation } from "react-i18next";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  can,
  foldTr,
  reportModuleEnabled,
  resolveModules,
  type FileDto,
  type SearchResultDto,
} from "@sitekeep/shared";
import { useLabel } from "../../i18n";
import { formatDate, formatSize } from "../../shared/api/api";
import { documentsApi } from "./api";
import { useLoad, useProject } from "../../app/context/project";
import { Dialog } from "../../shared/ui/Dialog";
import { FolderTree } from "./components/FolderTree";
import { UploadDialog } from "./components/UploadDialog";
import { FileDrawer } from "./components/FileDrawer";
import { VersionHistoryDrawer } from "./components/VersionHistoryDrawer";
import { Icon } from "../../shared/ui/Icon";
import { LoadingSpinner } from "../../shared/ui/LoadingIndicator";
import { PermissionsDialog } from "./components/PermissionsDialog";
import { FolderSettingsDialog } from "./components/FolderSettingsDialog";
import { StartReviewDialog } from "./components/StartReviewDialog";
import { ApprovalBadge } from "./components/ApprovalBadge";
import { reportBuilderUrl } from "./components/ReportShortcut";
import { DocsCards } from "./components/DocsCards";
import { MoreMenu } from "../../shared/ui/MoreMenu";
import { useNarrowLayout } from "../../shared/ui/RecordCards";
import { docsMoreItems, type DocsMoreKey } from "./docs-phone";
import { rememberDocsFolder } from "../../shared/lib/remember";
import { AutodeskDocuments } from "./AutodeskDocuments";
import { ColumnHeader, nextSort, sortFiles, sortFolders, useColumnWidths, type DocsSort, type SortKey } from "./DocsGrid";
import { DocsSearchResults } from "./DocsSearchResults";
import { DescriptionCell, DerivativeBadge, FilterRow, FolderRow, PhoneFilters, iconFor } from "./DocsTableParts";
import { NewFolderDialog } from "./NewFolderDialog";

const DOCS_TREE_WIDTH_KEY = "cde.docs.treeWidth";
const DOCS_TREE_COLLAPSED_KEY = "cde.docs.treeCollapsed";
const MIN_TREE_WIDTH = 190;
const MAX_TREE_WIDTH = 520;

export function DocsPage() {
  const { t } = useTranslation(["documents", "common"]);
  const label = useLabel();
  const project = useProject();
  const { fid } = useParams();
  const folderId = fid ?? project.rootFolderId;
  const navigate = useNavigate();
  const [treeVersion, setTreeVersion] = useState(0);
  const { data: folder, error: folderError, reload: reloadFolder } = useLoad(
    () => documentsApi.folder(project.id, folderId),
    [project.id, folderId],
  );
  const { data: contents, error, reload } = useLoad(() => documentsApi.contents(project.id, folderId), [project.id, folderId]);
  const { data: attrDefs } = useLoad(() => documentsApi.folderAttributes(project.id, folderId), [project.id, folderId, treeVersion]);
  const defs = useMemo(() => attrDefs ?? [], [attrDefs]);
  const { data: approvals, reload: reloadApprovals } = useLoad(
    () => documentsApi.folderApprovals(project.id, folderId),
    [project.id, folderId],
  );
  const { data: settings, reload: reloadSettings } = useLoad(
    () => documentsApi.folderSettings(project.id, folderId),
    [project.id, folderId],
  );
  const approvalByVersion = new Map(approvals?.map((x) => [x.versionId, x]));
  const [searchParams, setSearchParams] = useSearchParams();
  const [selected, setSelected] = useState<string | null>(searchParams.get("file"));
  const [versionHistoryFile, setVersionHistoryFile] = useState<string | null>(null);
  const [pending, setPending] = useState<File[] | null>(null);
  const [dialog, setDialog] = useState<"newFolder" | "permissions" | "settings" | "review" | null>(null);
  const [dragging, setDragging] = useState(false);
  const [treeWidth, setTreeWidth] = useState(() => {
    try {
      const saved = Number(localStorage.getItem(DOCS_TREE_WIDTH_KEY));
      return Number.isFinite(saved) && saved >= MIN_TREE_WIDTH && saved <= MAX_TREE_WIDTH ? saved : 280;
    } catch {
      return 280;
    }
  });
  const [treeCollapsed, setTreeCollapsed] = useState(() => {
    try {
      return localStorage.getItem(DOCS_TREE_COLLAPSED_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [showFilters, setShowFilters] = useState(false);
  const [searchText, setSearchText] = useState("");
  const [searchInFolder, setSearchInFolder] = useState(false);
  const [search, setSearch] = useState<{ q: string; folderId?: string } | null>(null);
  const [searchResult, setSearchResult] = useState<SearchResultDto | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [zipError, setZipError] = useState<string | null>(null);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [bulkDeleteBusy, setBulkDeleteBusy] = useState(false);
  const [bulkDeleteError, setBulkDeleteError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);
  // On-demand folders (project templates): created when the first file arrives.
  const virtualInput = useRef<HTMLInputElement>(null);
  const [virtualTarget, setVirtualTarget] = useState<string | null>(null);
  const [pendingFor, setPendingFor] = useState<{ folderId: string; files: File[] } | null>(null);
  const [virtualError, setVirtualError] = useState<string | null>(null);
  const modules = project.modules ?? resolveModules(null);
  // From "+ Yeni": ?yukle=1 opens the file picker, ?inceleme=1 explains how to start a review.
  const [hint, setHint] = useState<"yukle" | "inceleme" | null>(() =>
    searchParams.get("yukle") ? "yukle" : searchParams.get("inceleme") ? "inceleme" : null,
  );
  const askedUpload = useRef(!!searchParams.get("yukle"));
  const phone = useNarrowLayout();
  // Phones: the cards show checkboxes only in "Seç" mode (Diğer menu); "+ Yeni → İnceleme" starts in it.
  const [selecting, setSelecting] = useState(() => !!searchParams.get("inceleme"));

  useEffect(() => {
    try {
      localStorage.setItem(DOCS_TREE_WIDTH_KEY, String(treeWidth));
      localStorage.setItem(DOCS_TREE_COLLAPSED_KEY, treeCollapsed ? "1" : "0");
    } catch {
      // Resizing and collapsing still work when browser storage is unavailable.
    }
  }, [treeWidth, treeCollapsed]);

  // Dokümanlar in the menu opens the last folder next time (per project, this browser).
  useEffect(() => {
    if (folder?.id === folderId) rememberDocsFolder(project.id, fid ?? null);
  }, [folder, folderId, fid, project.id]);
  useEffect(() => {
    if (folderError) rememberDocsFolder(project.id, null);
  }, [folderError, project.id]);

  const refreshAll = useCallback(() => {
    reload();
    reloadFolder();
    reloadSettings();
    setTreeVersion((v) => v + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reload, reloadFolder]);

  // Files picked for an on-demand folder open the upload dialog once that folder is loaded.
  useEffect(() => {
    if (pendingFor && folder?.id === pendingFor.folderId) {
      setPending(pendingFor.files);
      setPendingFor(null);
    }
  }, [folder, pendingFor]);

  async function materialize(name: string, files?: File[]) {
    setVirtualError(null);
    try {
      const r = await documentsApi.materializeFolder(project.id, folderId, [name]);
      setTreeVersion((v) => v + 1);
      if (files?.length) setPendingFor({ folderId: r.folder.id, files });
      navigate(`/projects/${project.id}/files/${r.folder.id}`);
    } catch (e) {
      setVirtualError((e as Error).message);
    }
  }

  // Poll while IFC conversions are running.
  useEffect(() => {
    const busy = contents?.files.some((f) => ["pending", "processing"].includes(f.latest.derivativeStatus));
    if (!busy) return;
    const timer = setTimeout(reload, 3000);
    return () => clearTimeout(timer);
  }, [contents, reload]);

  // Opening a folder resets the selection; "?file=" (from search results) opens that file.
  useEffect(() => {
    setSelected(searchParams.get("file"));
    setChecked(new Set());
    setFilters({});
    setSearch(null);
    setSearchText("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folderId]);

  useEffect(() => {
    if (!search) {
      setSearchResult(null);
      return;
    }
    let alive = true;
    setSearchResult(null);
    setSearchError(null);
    documentsApi.search(project.id, { q: search.q, folderId: search.folderId }).then(
      (r) => alive && setSearchResult(r),
      (e: Error) => alive && setSearchError(e.message),
    );
    return () => {
      alive = false;
    };
  }, [project.id, search]);

  const visibleFiles = useMemo(() => {
    const active = Object.entries(filters).filter(([, v]) => v.trim());
    const all = contents?.files ?? [];
    if (!active.length) return all;
    return all.filter((f) =>
      active.every(([key, value]) => {
        if (key === "__name") return foldTr(f.name).includes(foldTr(value));
        if (key === "__description") return foldTr(f.description ?? "").includes(foldTr(value));
        const def = defs.find((d) => d.name === key);
        const v = f.attributes[key] ?? "";
        return def?.type === "list" ? v === value : foldTr(v).includes(foldTr(value));
      }),
    );
  }, [contents, filters, defs]);
  const [sort, setSort] = useState<DocsSort>({ key: "name", dir: "asc" });
  const sortedFiles = useMemo(() => sortFiles(visibleFiles, sort), [visibleFiles, sort]);
  const sortedFolders = useMemo(() => sortFolders(contents?.folders ?? [], sort), [contents, sort]);
  const { width: colWidth, resize: resizeColumn } = useColumnWidths();
  const columnKeys = [
    "check",
    "name",
    "description",
    "version",
    ...defs.map((d) => `attr:${d.id}`),
    "size",
    "user",
    "date",
    "approval",
    "status",
  ];
  const headerProps = (key: string) => ({
    sort,
    onSort: (k: SortKey) => setSort((s) => nextSort(s, k)),
    width: colWidth(key),
    onResize: (w: number | null) => resizeColumn(key, w),
  });

  const level = folder?.myLevel ?? "none";
  const canManage = can(level, "manage");
  const canEdit = can(level, "edit");
  const gated = !!settings?.gated;
  const canUpload = !!folder?.canUpload && !gated;
  // Phones: everything but search and "Yükle" sits in the "Diğer" menu (folder-admin items need "manage").
  const moreItems = docsMoreItems({
    spec: !!modules.spec,
    report: reportModuleEnabled(modules, "documents"),
    searching: !!search,
    canManage,
    filtersOn: showFilters,
    inFolder: searchInFolder,
    selecting,
    desktop: !phone,
    autodesk: true,
  });
  function onMore(key: DocsMoreKey) {
    if (key === "autodesk") {
      const next = new URLSearchParams(searchParams);
      next.set("source", "autodesk");
      setSearchParams(next);
    } else if (key === "select") {
      if (selecting) setChecked(new Set());
      setSelecting(!selecting);
    } else if (key === "filter") {
      setShowFilters((v) => !v);
      setFilters(searchText.trim() ? { __name: searchText } : {});
    } else if (key === "inFolder") {
      setSearchInFolder(!searchInFolder);
      if (search) setSearch({ q: search.q, folderId: searchInFolder ? undefined : folderId });
    } else if (key === "report") navigate(reportBuilderUrl(project.id, "documents"));
    else if (key === "spec") navigate(`/projects/${project.id}/spec`);
    else setDialog(key);
  }

  // "+ Yeni → Doküman Yükle": open the picker once the folder is known (still inside the click's user activation).
  useEffect(() => {
    if (!askedUpload.current || folder?.id !== folderId || !settings) return;
    askedUpload.current = false;
    if (canUpload) fileInput.current?.click();
    if (searchParams.has("yukle")) setSearchParams({}, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folder, folderId, settings, canUpload]);
  // Reviews take files only (folders are for zip downloads).
  const checkedFiles = (search ? searchResult?.results ?? [] : contents?.files ?? []).filter((f) => checked.has(`file:${f.id}`));

  function hasDraggedFiles(e: DragEvent): boolean {
    return Array.from(e.dataTransfer.types).includes("Files");
  }

  function onDragEnter(e: DragEvent) {
    if (!canUpload || !hasDraggedFiles(e)) return;
    e.preventDefault();
    dragDepth.current += 1;
    setDragging(true);
  }

  function onDragOver(e: DragEvent) {
    if (!canUpload || !hasDraggedFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }

  function onDragLeave(e: DragEvent) {
    if (!hasDraggedFiles(e)) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  }

  function onDrop(e: DragEvent) {
    if (!hasDraggedFiles(e)) return;
    e.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    if (!canUpload) return;
    const files = [...e.dataTransfer.files];
    if (files.length) setPending(files);
  }

  function startTreeResize(e: ReactPointerEvent<HTMLDivElement>) {
    if (treeCollapsed || e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = treeWidth;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.userSelect = "none";
    const move = (event: PointerEvent) =>
      setTreeWidth(Math.min(MAX_TREE_WIDTH, Math.max(MIN_TREE_WIDTH, startWidth + event.clientX - startX)));
    const stop = () => {
      document.body.style.userSelect = previousUserSelect;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
  }

  function closeDrawer() {
    setSelected(null);
    if (searchParams.has("file")) setSearchParams({}, { replace: true });
  }

  function toggle(key: string) {
    setChecked((s) => {
      const n = new Set(s);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });
  }

  async function downloadZip() {
    setZipError(null);
    const keys = [...checked];
    const fileIds = keys.filter((k) => k.startsWith("file:")).map((k) => k.slice(5));
    const folderIds = keys.filter((k) => k.startsWith("folder:")).map((k) => k.slice(7));
    try {
      await documentsApi.downloadZip(project.id, { fileIds, folderIds }, search ? t("page.zipSearchName", { code: project.code }) : folder?.name);
    } catch (e) {
      setZipError((e as Error).message);
    }
  }

  async function deleteChecked() {
    setBulkDeleteBusy(true);
    setBulkDeleteError(null);
    const failed: { id: string; message: string }[] = [];
    for (const f of checkedFiles) {
      try {
        await documentsApi.deleteFile(project.id, f.id);
      } catch (e) {
        failed.push({ id: f.id, message: `${f.name}: ${(e as Error).message}` });
      }
    }
    setBulkDeleteBusy(false);
    setChecked(new Set(failed.map((f) => `file:${f.id}`)));
    if (selected && checkedFiles.some((f) => f.id === selected && !failed.some((x) => x.id === f.id))) setSelected(null);
    reload();
    reloadApprovals();
    if (search) setSearch({ ...search });
    if (failed.length)
      setBulkDeleteError(
        t("page.bulkDelete.partial", {
          deleted: checkedFiles.length - failed.length,
          failed: failed.length,
          errors: failed.map((f) => f.message).join("\n"),
        }),
      );
    else setBulkDeleteOpen(false);
  }

  function closeSearch() {
    setSearch(null);
    setSearchText("");
    setChecked(new Set());
  }

  function openHit(hit: FileDto) {
    closeSearch();
    if (hit.folderId === folderId) setSelected(hit.id);
    else navigate(`/projects/${project.id}/files/${hit.folderId}?file=${hit.id}`);
  }

  const columns = 9 + defs.length; // check, name, description, version, attributes…, size, user, date, approval, status

  if (searchParams.get("source") === "autodesk") {
    return (
      <AutodeskDocuments
        projectId={project.id}
        onShowCde={() => {
          const next = new URLSearchParams(searchParams);
          next.delete("source");
          setSearchParams(next);
        }}
      />
    );
  }

  return (
    <div
      className={`docs resizable-docs${treeCollapsed ? " tree-collapsed" : ""}`}
      style={{ "--docs-tree-width": treeCollapsed ? "0px" : `${treeWidth}px` } as CSSProperties}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <aside className="docs-tree" data-tour="files-tree">
        <FolderTree
          projectId={project.id}
          rootId={project.rootFolderId}
          activeId={folderId}
          version={treeVersion}
          onSelect={(id) => navigate(`/projects/${project.id}/files/${id}`)}
        />
      </aside>
      <div
        className="docs-tree-resizer"
        role="separator"
        aria-label={t("page.treeWidth")}
        aria-orientation="vertical"
        aria-valuemin={MIN_TREE_WIDTH}
        aria-valuemax={MAX_TREE_WIDTH}
        aria-valuenow={treeCollapsed ? 0 : treeWidth}
        onPointerDown={startTreeResize}
      >
        <button
          type="button"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => setTreeCollapsed((value) => !value)}
          title={treeCollapsed ? t("page.showTree") : t("page.hideTree")}
          aria-label={treeCollapsed ? t("page.showTree") : t("page.hideTree")}
        >
          {treeCollapsed ? "›" : "‹"}
        </button>
      </div>
      <section className="docs-main">
        <div className="docs-toolbar" data-tour="files-toolbar">
          <div className="crumbs">
            {folder?.path.map((f, i) => (
              <span key={f.id} className="row" style={{ gap: 4 }}>
                {i > 0 && <span className="sep">/</span>}
                {f.id === folderId ? <strong>{f.name}</strong> : <Link to={`/projects/${project.id}/files/${f.id}`}>{f.name}</Link>}
              </span>
            ))}
          </div>
          {folder?.state && <span className="badge info">{folder.stateLabel ?? label("folderState", folder.state)}</span>}
          {gated && (
            <span
              className="badge warn"
              title={settings?.gatedBy ? t("page.gatedHintBy", { setting: settings.gatedBy }) : t("page.gatedHint")}
            >
              {t("page.badges.gated")}
            </span>
          )}
          <span className="badge" title={t("page.yourLevel")}>
            {label("level", level)}
          </span>
          <div className="spacer" />
          {checkedFiles.length > 0 && modules.reviews && (
            <button className="primary" onClick={() => setDialog("review")}>
              {t("page.actions.startReview", { count: checkedFiles.length })}
            </button>
          )}
          {checked.size > 0 && (
            <button onClick={() => void downloadZip()} title={t("page.zipHint")}>
              <Icon name="download" size={16} />
              ZIP ({checked.size})
            </button>
          )}
          {checkedFiles.length > 0 && (search || canEdit) && (
            <button
              className="danger"
              title={t("page.deleteHint")}
              onClick={() => {
                setBulkDeleteError(null);
                setBulkDeleteOpen(true);
              }}
            >
              <Icon name="trash" size={16} />
              {t("page.actions.deleteCount", { count: checkedFiles.length })}
            </button>
          )}
          <form
            className="docs-search"
            role="search"
            onSubmit={(e) => {
              e.preventDefault();
              const q = searchText.trim();
              setChecked(new Set());
              setSearch(q ? { q, folderId: searchInFolder ? folderId : undefined } : null);
            }}
          >
            <Icon name="search" size={15} />
            <input
              type="search"
              placeholder={searchInFolder ? t("page.search.placeholderInFolder") : t("page.search.placeholder")}
              aria-label={t("page.search.label")}
              title={t("page.search.hint")}
              value={searchText}
              onChange={(e) => {
                const value = e.target.value;
                setSearchText(value);
                setFilters((f) => {
                  const next = { ...f };
                  if (value.trim()) next.__name = value;
                  else delete next.__name;
                  return next;
                });
                if (!value) setSearch(null);
              }}
            />
            {searchText.trim() && search?.q !== searchText.trim() && (
              <button type="submit" className="docs-search-go" title={t("page.search.goHint")}>
                {searchInFolder ? t("page.search.goInFolder") : t("page.search.goInProject")} ↵
              </button>
            )}
          </form>
          {canUpload && (
            <>
              <button className="primary" data-tour="files-upload" onClick={() => fileInput.current?.click()}>
                <Icon name="upload" size={16} />
                {t("common:actions.upload")}
              </button>
              <input
                ref={fileInput}
                type="file"
                multiple
                hidden
                onChange={(e) => {
                  if (e.target.files?.length) setPending([...e.target.files]);
                  e.target.value = "";
                }}
              />
            </>
          )}
          <MoreMenu items={moreItems} onSelect={onMore} />
        </div>
        <div
          className={`docs-list${dragging ? " dragging" : ""}`}
          data-tour="files-list"
        >
          {(error || folderError) && <p className="error" style={{ margin: 16 }}>{error || folderError}</p>}
          {zipError && <p className="error" style={{ margin: 16 }}>{zipError}</p>}
          {hint && (
            <div className="notice small row wrap" style={{ margin: 12 }}>
              <span style={{ flex: 1 }}>
                {hint === "yukle"
                  ? canUpload
                    ? t("page.hints.upload")
                    : t("page.hints.uploadNotAllowed")
                  : t("page.hints.review")}
              </span>
              {hint === "yukle" && canUpload && (
                <button className="small primary" onClick={() => fileInput.current?.click()}>
                  {t("page.actions.chooseFiles")}
                </button>
              )}
              <button className="ghost small" onClick={() => setHint(null)} aria-label={t("common:actions.close")}>
                ✕
              </button>
            </div>
          )}
          {search ? (
            <DocsSearchResults
              projectId={project.id}
              result={searchResult}
              error={searchError}
              query={search.q}
              inFolder={!!search.folderId}
              checked={checked}
              onToggle={toggle}
              onOpen={openHit}
              onOpenVersion={setVersionHistoryFile}
              onClose={closeSearch}
              phone={phone}
              selecting={selecting}
            />
          ) : phone ? (
            <div className="docs-cards-wrap">
              {showFilters && <PhoneFilters defs={defs} filters={filters} onChange={setFilters} />}
              <DocsCards
                folders={contents?.folders}
                virtualFolders={contents?.virtualFolders}
                files={sortedFiles}
                selectedId={selected}
                selecting={selecting}
                checked={checked}
                iconFor={iconFor}
                badges={(f) => (
                  <>
                    <ApprovalBadge projectId={project.id} approval={approvalByVersion.get(f.latest.id)} />
                    <DerivativeBadge file={f} projectId={project.id} />
                  </>
                )}
                emptyText={contents ? (canUpload ? t("page.emptyPhoneCanUpload") : t("page.empty")) : null}
                onOpenFolder={(id) => navigate(`/projects/${project.id}/files/${id}`)}
                onOpenFile={setSelected}
                onOpenVersion={(id) => {
                  setSelected(null);
                  setVersionHistoryFile(id);
                }}
                onToggle={toggle}
                onVirtual={
                  folder?.canUpload
                    ? (name) => {
                        setVirtualTarget(name);
                        virtualInput.current?.click();
                      }
                    : null
                }
              />
              {contents && contents.files.length > 0 && visibleFiles.length === 0 && (
                <p className="muted record-cards-empty">{t("page.noFilterMatch")}</p>
              )}
            </div>
          ) : (
            <table className="docs-grid" style={{ width: columnKeys.reduce((sum, k) => sum + colWidth(k), 0) }}>
              <colgroup>
                {columnKeys.map((k) => (
                  <col key={k} style={{ width: colWidth(k) }} />
                ))}
              </colgroup>
              <thead>
                <tr>
                  <th className="sticky-col sticky-check">
                    <input
                      type="checkbox"
                      style={{ width: "auto" }}
                      aria-label={t("common:actions.selectAll")}
                      checked={!!contents && checked.size > 0 && checked.size === contents.folders.length + visibleFiles.length}
                      onChange={(e) =>
                        setChecked(
                          e.target.checked
                            ? new Set([
                                ...(contents?.folders ?? []).map((f) => `folder:${f.id}`),
                                ...visibleFiles.map((f) => `file:${f.id}`),
                              ])
                            : new Set(),
                        )
                      }
                    />
                  </th>
                  {(
                    [
                      ["name", t("common:fields.name"), "name", "sticky-col sticky-name"],
                      ["description", t("common:fields.description"), "description"],
                      ["version", t("columns.version"), "version"],
                    ] as const
                  ).map(([key, text, sortKey, className]) => (
                    <ColumnHeader
                      key={key}
                      label={text}
                      sortKey={sortKey}
                      className={className}
                      {...headerProps(key)}
                    />
                  ))}
                  {defs.map((d) => (
                    <ColumnHeader
                      key={d.id}
                      label={`${d.name}${d.required ? " *" : ""}`}
                      title={d.inherited ? t("page.attributeInherited") : t("page.attributeOwn")}
                      sortKey={`attr:${d.name}`}
                      {...headerProps(`attr:${d.id}`)}
                    />
                  ))}
                  <ColumnHeader label={t("common:fields.size")} sortKey="size" {...headerProps("size")} />
                  <ColumnHeader label={t("page.columns.lastUploader")} sortKey="user" {...headerProps("user")} />
                  <ColumnHeader label={t("common:fields.date")} sortKey="date" dataTour="docs-date" {...headerProps("date")} />
                  <ColumnHeader label={t("page.columns.approval")} dataTour="docs-approval" {...headerProps("approval")} />
                  <ColumnHeader label={t("common:fields.status")} {...headerProps("status")} />
                </tr>
                {showFilters && <FilterRow defs={defs} filters={filters} onChange={setFilters} />}
              </thead>
              <tbody>
                {sortedFolders.map((f) => (
                  <FolderRow
                    key={f.id}
                    folder={f}
                    extraColumns={defs.length}
                    checked={checked.has(`folder:${f.id}`)}
                    onToggle={() => toggle(`folder:${f.id}`)}
                    onOpen={() => navigate(`/projects/${project.id}/files/${f.id}`)}
                    canEdit={can(f.myLevel ?? "none", "edit")}
                    onSaveDescription={async (description) => {
                      await documentsApi.updateFolder(project.id, f.id, { description });
                      reload();
                    }}
                  />
                ))}
                {contents?.virtualFolders?.map((v) => (
                  <tr
                    key={`virtual:${v.name}`}
                    className={`virtual-row${folder?.canUpload ? " clickable" : ""}`}
                    title={
                      folder?.canUpload
                        ? t("page.virtual.hintCanUpload")
                        : t("page.virtual.hint")
                    }
                    onClick={() => {
                      if (!folder?.canUpload) return;
                      setVirtualTarget(v.name);
                      virtualInput.current?.click();
                    }}
                    onDragOver={(e) => folder?.canUpload && e.preventDefault()}
                    onDrop={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setDragging(false);
                      const dropped = [...e.dataTransfer.files];
                      if (folder?.canUpload && dropped.length) void materialize(v.name, dropped);
                    }}
                  >
                    <td className="sticky-col sticky-check" />
                    <td className="sticky-col sticky-name">
                      <span className="name-cell">
                        <span className="name-icon">
                          <Icon name="folder" size={18} />
                        </span>
                        <span className="name-text" style={{ fontStyle: "italic" }}>
                          {v.name}
                        </span>
                        {folder?.canUpload && (
                          <button
                            className="small ghost"
                            title={v.descendantCount ? t("page.virtual.createdOnFirstFileWithSub", { count: v.descendantCount }) : t("page.virtual.createdOnFirstFile")}
                            onClick={(e) => {
                              e.stopPropagation();
                              void materialize(v.name);
                            }}
                          >
                            {t("page.virtual.actions.createNow")}
                          </button>
                        )}
                      </span>
                    </td>
                    <td className="muted small">
                      {v.descendantCount ? t("page.virtual.noteWithSub", { count: v.descendantCount }) : t("page.virtual.note")}
                    </td>
                    <td colSpan={5 + defs.length} />
                    <td>{v.state && <span className="badge">{v.stateLabel ?? label("folderState", v.state)}</span>}</td>
                  </tr>
                ))}
                {sortedFiles.map((f) => (
                  <tr key={f.id} className={`clickable${selected === f.id ? " selected" : ""}`} onClick={() => setSelected(f.id)}>
                    <td className="sticky-col sticky-check" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        style={{ width: "auto" }}
                        aria-label={t("selectItem", { name: f.name })}
                        checked={checked.has(`file:${f.id}`)}
                        onChange={() => toggle(`file:${f.id}`)}
                      />
                    </td>
                    <td className="sticky-col sticky-name">
                      <span className="name-cell">
                        <span className="name-icon">{iconFor(f.extension)}</span>
                        <span className="name-text" title={f.name}>
                          {f.name}
                        </span>
                        <button
                          className="ghost small name-more"
                          title={t("page.fileActions")}
                          aria-label={t("page.fileActionsFor", { name: f.name })}
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelected(f.id);
                          }}
                        >
                          ⋮
                        </button>
                      </span>
                    </td>
                    <td onClick={(e) => e.stopPropagation()}>
                      <DescriptionCell
                        value={f.description}
                        canEdit={canEdit}
                        onSave={async (description) => {
                          await documentsApi.updateFile(project.id, f.id, { description });
                          reload();
                        }}
                      />
                    </td>
                    <td onClick={(e) => e.stopPropagation()}>
                      <button
                        type="button"
                        className="version-link"
                        title={t("page.openVersionHistory", { name: f.name })}
                        onClick={() => {
                          setSelected(null);
                          setVersionHistoryFile(f.id);
                        }}
                      >
                        V{f.currentVersion}
                      </button>
                    </td>
                    {defs.map((d) => (
                      <td key={d.id} className="small">
                        {f.attributes[d.name] ?? ""}
                      </td>
                    ))}
                    <td className="muted">{formatSize(f.latest.size)}</td>
                    <td className="muted">{f.latest.uploadedByName}</td>
                    <td className="muted">{formatDate(f.latest.uploadedAt)}</td>
                    <td>
                      <ApprovalBadge projectId={project.id} approval={approvalByVersion.get(f.latest.id)} />
                    </td>
                    <td>
                      <DerivativeBadge file={f} projectId={project.id} />
                    </td>
                  </tr>
                ))}
                {contents && !contents.folders.length && !contents.files.length && !contents.virtualFolders?.length && (
                  <tr>
                    <td colSpan={columns} className="muted" style={{ padding: 32, textAlign: "center" }}>
                      {canUpload ? t("page.emptyCanUpload") : t("page.empty")}
                    </td>
                  </tr>
                )}
                {contents && contents.files.length > 0 && visibleFiles.length === 0 && (
                  <tr>
                    <td colSpan={columns} className="muted" style={{ padding: 24, textAlign: "center" }}>
                      {t("page.noFilterMatch")}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          )}
        </div>
      </section>

      <input
        ref={virtualInput}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          const picked = [...(e.target.files ?? [])];
          e.target.value = "";
          if (virtualTarget && picked.length) void materialize(virtualTarget, picked);
          setVirtualTarget(null);
        }}
      />
      {bulkDeleteOpen && (
        <Dialog title={t("page.bulkDelete.dialogTitle")} onClose={() => !bulkDeleteBusy && setBulkDeleteOpen(false)}>
          <p style={{ marginTop: 0 }}>
            <Trans t={t} i18nKey="page.bulkDelete.body" count={checkedFiles.length} components={{ b: <strong /> }} />
          </p>
          <ul className="bulk-delete-list">
            {checkedFiles.slice(0, 8).map((f) => (
              <li key={f.id}>{f.name}</li>
            ))}
            {checkedFiles.length > 8 && <li className="muted">{t("page.bulkDelete.more", { count: checkedFiles.length - 8 })}</li>}
          </ul>
          {checked.size > checkedFiles.length && <p className="muted small">{t("page.bulkDelete.foldersKept")}</p>}
          {bulkDeleteError && <p className="error" style={{ whiteSpace: "pre-line" }}>{bulkDeleteError}</p>}
          <div className="dialog-actions">
            <button disabled={bulkDeleteBusy} onClick={() => setBulkDeleteOpen(false)}>
              {t("common:actions.cancel")}
            </button>
            <button className="danger" disabled={bulkDeleteBusy || !checkedFiles.length} onClick={() => void deleteChecked()}>
              {bulkDeleteBusy ? <LoadingSpinner className="small" /> : t("page.bulkDelete.confirmButton", { count: checkedFiles.length })}
            </button>
          </div>
        </Dialog>
      )}
      {virtualError && (
        <Dialog title={t("page.virtual.errorTitle")} onClose={() => setVirtualError(null)}>
          <p className="error">{virtualError}</p>
        </Dialog>
      )}
      {selected && (
        <FileDrawer projectId={project.id} fileId={selected} level={level} onClose={closeDrawer} onChanged={reload} />
      )}
      {versionHistoryFile && (
        <VersionHistoryDrawer
          projectId={project.id}
          fileId={versionHistoryFile}
          level={level}
          onClose={() => setVersionHistoryFile(null)}
        />
      )}
      {pending && folder && (
        <UploadDialog
          projectId={project.id}
          folder={folder}
          attributes={defs}
          files={pending}
          existing={contents?.files}
          onClose={() => setPending(null)}
          onDone={() => {
            reload();
            reloadApprovals();
          }}
        />
      )}
      {dialog === "review" && (
        <StartReviewDialog
          projectId={project.id}
          rootFolderId={project.rootFolderId}
          files={checkedFiles}
          onClose={() => setDialog(null)}
          onStarted={() => {
            setChecked(new Set());
            reloadApprovals();
          }}
        />
      )}
      {dialog === "newFolder" && (
        <NewFolderDialog
          projectId={project.id}
          parentId={folderId}
          onClose={() => setDialog(null)}
          onCreated={refreshAll}
        />
      )}
      {dialog === "permissions" && folder && (
        <PermissionsDialog projectId={project.id} folder={folder} onClose={() => setDialog(null)} />
      )}
      {dialog === "settings" && folder && (
        <FolderSettingsDialog
          projectId={project.id}
          folder={folder}
          onClose={() => setDialog(null)}
          onChanged={refreshAll}
          onDeleted={() => navigate(`/projects/${project.id}/files/${folder.parentId ?? ""}`)}
        />
      )}
    </div>
  );
}
