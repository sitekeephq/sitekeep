import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import {
  viewerFor,
  viewerPath,
  type FileDto,
  type SearchHitDto,
  type SearchMatchPlace,
  type SearchResultDto,
  type SearchSort,
} from "@sitekeep/shared";
import { formatDate, formatSize } from "../../shared/api/api";
import { DocsCards, type DocsCardFile } from "./components/DocsCards";
import { CodeChips } from "./components/cde/CodeChips";
import { iconFor } from "./DocsTableParts";
import { Highlight } from "./search/Highlight";

export type ResultScope = "folder" | "all" | "folders" | "trash";

/** Badges for where a hit matched: Name / Attribute / Content. */
function MatchBadges({ places }: { places?: SearchMatchPlace[] }) {
  const { t } = useTranslation("documents");
  if (!places?.length) return null;
  return (
    <>
      {places.map((p) => (
        <span key={p} className={`badge search-match search-match-${p}`} data-testid={`match-${p}`}>
          {t(`search.match.${p}`)}
        </span>
      ))}
    </>
  );
}

function Snippet({ hit, terms }: { hit: SearchHitDto; terms: string[] }) {
  const { t } = useTranslation("documents");
  if (!hit.snippet) return null;
  return (
    <div className="small search-snippet" title={t("search.foundInContent")}>
      {hit.page ? (
        <span className="badge" data-testid="snippet-page">
          {t("search.page", { page: hit.page })}
        </span>
      ) : null}{" "}
      <Highlight text={hit.snippet} terms={terms} />
    </div>
  );
}

/**
 * Search results in Dokümanlar: highlighted names, where each hit matched, a clean excerpt with
 * the PDF page, sorting, the number of hits and paging.
 */
export function DocsSearchResults({
  projectId,
  result,
  error,
  query,
  scope,
  sort,
  dir,
  onSort,
  onPage,
  checked,
  onToggle,
  onToggleAll,
  onOpen,
  onOpenVersion,
  onClose,
  onEdit,
  filterCount,
  phone,
  selecting,
}: {
  projectId: string;
  result: SearchResultDto | null;
  error: string | null;
  query: string;
  scope: ResultScope;
  sort: SearchSort;
  dir: "asc" | "desc";
  onSort(sort: SearchSort, dir: "asc" | "desc"): void;
  onPage(offset: number): void;
  checked: Set<string>;
  onToggle(key: string): void;
  onToggleAll(on: boolean): void;
  onOpen(hit: FileDto): void;
  onOpenVersion(fileId: string): void;
  onClose(): void;
  /** Opens the search panel. */
  onEdit(): void;
  filterCount: number;
  phone?: boolean;
  selecting?: boolean;
}) {
  const { t } = useTranslation(["documents", "common"]);
  const terms = result?.terms ?? [];
  const total = result?.total ?? result?.results.length ?? 0;
  const offset = result?.offset ?? 0;
  const limit = result?.limit ?? (result?.results.length || 1);
  const hits = result?.results ?? [];
  const allChecked = hits.length > 0 && hits.every((h) => checked.has(`file:${h.id}`));
  const title = query
    ? t(`search.title.${scope}`, { query })
    : t(`search.titleNoQuery.${scope}`);

  return (
    <div className="search-results" data-testid="search-results">
      <div className="row wrap search-results-head">
        <strong>{title}</strong>
        {result && (
          <span className="muted small" data-testid="search-count">
            {t("search.count", { count: total })}
          </span>
        )}
        <button type="button" className="small ghost" onClick={onEdit} data-testid="search-edit">
          {filterCount > 0 ? t("search.actions.editFilters", { count: filterCount }) : t("search.actions.edit")}
        </button>
        <div className="spacer" />
        <label className="row small" style={{ gap: 6, margin: 0, fontWeight: 400 }}>
          {t("search.sort.label")}
          <select
            aria-label={t("search.sort.label")}
            data-testid="search-sort"
            value={sort}
            onChange={(e) => {
              const next = e.target.value as SearchSort;
              onSort(next, next === "name" ? "asc" : "desc");
            }}
            style={{ width: "auto" }}
          >
            {(query ? (["relevance", "name", "date", "size"] as const) : (["name", "date", "size"] as const)).map((s) => (
              <option key={s} value={s}>
                {t(`search.sort.${s}`)}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="small ghost"
          aria-label={dir === "asc" ? t("search.sort.asc") : t("search.sort.desc")}
          title={dir === "asc" ? t("search.sort.asc") : t("search.sort.desc")}
          onClick={() => onSort(sort, dir === "asc" ? "desc" : "asc")}
        >
          {dir === "asc" ? "↑" : "↓"}
        </button>
        <button className="small" onClick={onClose}>
          {t("search.actions.close")}
        </button>
      </div>
      {error && (
        <p className="error" style={{ margin: 16 }}>
          {error}
        </p>
      )}
      {phone ? (
        <div className="docs-cards-wrap">
          {!result && !error && <p className="muted">{t("search.searching")}</p>}
          <DocsCards
            files={hits}
            selecting={!!selecting}
            checked={checked}
            iconFor={iconFor}
            badges={(f: DocsCardFile) => {
              const hit = hits.find((h) => h.id === f.id);
              return (
                <>
                  <MatchBadges places={hit?.matchedIn} />
                  {viewerFor(f.name).kind !== "none" && scope !== "trash" && (
                    <Link to={viewerPath(projectId, f.name, f.latest.id)} className="badge info">
                      {t("common:actions.open")}
                    </Link>
                  )}
                  {hit?.page ? <span className="badge">{t("search.page", { page: hit.page })}</span> : null}
                </>
              );
            }}
            emptyText={result ? t("common:empty.noResults") : null}
            onOpenFolder={() => undefined}
            onOpenFile={(id) => {
              const hit = hits.find((x) => x.id === id);
              if (hit) onOpen(hit);
            }}
            onOpenVersion={onOpenVersion}
            onToggle={onToggle}
          />
        </div>
      ) : (
        <div className="search-results-table">
          <table>
            <thead>
              <tr>
                <th style={{ width: 32 }}>
                  <input
                    type="checkbox"
                    style={{ width: "auto" }}
                    aria-label={t("common:actions.selectAll")}
                    checked={allChecked}
                    onChange={(e) => onToggleAll(e.target.checked)}
                  />
                </th>
                <th>{t("common:fields.name")}</th>
                <th>{t("common:fields.folder")}</th>
                <th style={{ width: 110 }}>{t("columns.version")}</th>
                <th style={{ width: 90 }}>{t("common:fields.size")}</th>
                <th style={{ width: 150 }}>{scope === "trash" ? t("search.deletedAt") : t("common:fields.date")}</th>
              </tr>
            </thead>
            <tbody>
              {!result && !error && (
                <tr>
                  <td colSpan={6} className="muted">
                    {t("search.searching")}
                  </td>
                </tr>
              )}
              {hits.map((f) => (
                <tr key={f.id} className="clickable" onClick={() => onOpen(f)} data-testid="search-hit">
                  <td onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      style={{ width: "auto" }}
                      aria-label={t("selectItem", { name: f.name })}
                      checked={checked.has(`file:${f.id}`)}
                      onChange={() => onToggle(`file:${f.id}`)}
                    />
                  </td>
                  <td>
                    <div className="row wrap" style={{ gap: 6 }}>
                      <span>{iconFor(f.extension)}</span>
                      <span className="search-hit-name">
                        <Highlight text={f.name} terms={terms} />
                      </span>
                      <MatchBadges places={f.matchedIn} />
                      {viewerFor(f.name).kind !== "none" && scope !== "trash" && (
                        <Link to={viewerPath(projectId, f.name, f.latest.id)} onClick={(e) => e.stopPropagation()} className="badge info">
                          {t("common:actions.open")}
                        </Link>
                      )}
                    </div>
                    <Snippet hit={f} terms={terms} />
                    {Object.keys(f.attributes).length > 0 && (
                      <div className="muted small">
                        <Highlight
                          text={Object.entries(f.attributes)
                            .map(([k, v]) => `${k}: ${v}`)
                            .join(" · ")}
                          terms={f.matchedIn?.includes("attribute") ? terms : []}
                        />
                      </div>
                    )}
                  </td>
                  <td className="muted small">{f.folderPath}</td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <button type="button" className="version-link" onClick={() => onOpenVersion(f.id)} disabled={scope === "trash"}>
                      V{f.currentVersion}
                    </button>
                    <CodeChips suitability={f.latest.suitabilityCode} revision={f.latest.revisionCode} />
                  </td>
                  <td className="muted">{formatSize(f.latest.size)}</td>
                  <td className="muted small">
                    {formatDate(scope === "trash" && f.deletedAt ? f.deletedAt : f.latest.uploadedAt)}
                    {f.latest.uploadedByName && <div>{f.latest.uploadedByName}</div>}
                  </td>
                </tr>
              ))}
              {result && hits.length === 0 && (
                <tr>
                  <td colSpan={6} className="muted" style={{ padding: 32, textAlign: "center" }}>
                    {t("common:empty.noResults")}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      {result && total > limit && (
        <div className="row search-pager" data-testid="search-pager">
          <button type="button" className="small" disabled={offset === 0} onClick={() => onPage(Math.max(0, offset - limit))}>
            ‹ {t("search.pager.prev")}
          </button>
          <span className="muted small">{t("search.pager.range", { from: offset + 1, to: Math.min(total, offset + hits.length), total })}</span>
          <button type="button" className="small" disabled={offset + hits.length >= total} onClick={() => onPage(offset + limit)}>
            {t("search.pager.next")} ›
          </button>
        </div>
      )}
    </div>
  );
}
