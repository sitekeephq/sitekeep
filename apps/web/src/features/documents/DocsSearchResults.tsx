import { Trans, useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { viewerFor, viewerPath, type FileDto, type SearchResultDto } from "@sitekeep/shared";
import { formatDate, formatSize } from "../../shared/api/api";
import { DocsCards, type DocsCardFile } from "./components/DocsCards";
import { iconFor } from "./DocsTableParts";

export function DocsSearchResults({
  projectId,
  result,
  error,
  query,
  inFolder,
  checked,
  onToggle,
  onOpen,
  onOpenVersion,
  onClose,
  phone,
  selecting,
}: {
  projectId: string;
  result: SearchResultDto | null;
  error: string | null;
  query: string;
  inFolder: boolean;
  checked: Set<string>;
  onToggle(key: string): void;
  onOpen(hit: FileDto): void;
  onOpenVersion(fileId: string): void;
  onClose(): void;
  phone?: boolean;
  selecting?: boolean;
}) {
  const { t } = useTranslation(["documents", "common"]);
  return (
    <>
      <div className="row wrap" style={{ padding: "8px 16px" }}>
        <strong>{inFolder ? t("search.titleInFolder", { query }) : t("search.titleInProject", { query })}</strong>
        {result && (
          <span className="muted small">
            {result.truncated ? t("search.countTruncated", { count: result.results.length }) : t("search.count", { count: result.results.length })}
          </span>
        )}
        <div className="spacer" />
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
            files={result?.results ?? []}
            selecting={!!selecting}
            checked={checked}
            iconFor={iconFor}
            badges={(f: DocsCardFile) =>
              viewerFor(f.name).kind !== "none" && (
                <Link to={viewerPath(projectId, f.name, f.latest.id)} className="badge info">
                  {t("common:actions.open")}
                </Link>
              )
            }
            emptyText={result ? t("common:empty.noResults") : null}
            onOpenFolder={() => undefined}
            onOpenFile={(id) => {
              const hit = result?.results.find((x) => x.id === id);
              if (hit) onOpen(hit);
            }}
            onOpenVersion={onOpenVersion}
            onToggle={onToggle}
          />
        </div>
      ) : (
        <table>
          <thead>
            <tr>
              <th style={{ width: 32 }} />
              <th>{t("common:fields.name")}</th>
              <th>{t("common:fields.folder")}</th>
              <th style={{ width: 70 }}>{t("columns.version")}</th>
              <th style={{ width: 90 }}>{t("common:fields.size")}</th>
              <th style={{ width: 130 }}>{t("common:fields.date")}</th>
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
            {result?.results.map((f) => (
              <tr key={f.id} className="clickable" onClick={() => onOpen(f)}>
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
                  <span style={{ marginRight: 6 }}>{iconFor(f.extension)}</span>
                  {f.name}
                  {viewerFor(f.name).kind !== "none" && (
                    <Link
                      to={viewerPath(projectId, f.name, f.latest.id)}
                      onClick={(e) => e.stopPropagation()}
                      className="badge info"
                      style={{ marginLeft: 8 }}
                    >
                      {t("common:actions.open")}
                    </Link>
                  )}
                  {f.snippet && (
                    <div className="small" title={t("search.foundInContent")}>
                      <Trans t={t} i18nKey="search.snippet" values={{ snippet: f.snippet }} components={{ m: <span className="muted" /> }} />
                    </div>
                  )}
                  {Object.keys(f.attributes).length > 0 && (
                    <div className="muted small">
                      {Object.entries(f.attributes)
                        .map(([k, v]) => `${k}: ${v}`)
                        .join(" · ")}
                    </div>
                  )}
                </td>
                <td className="muted small">{f.folderPath}</td>
                <td onClick={(e) => e.stopPropagation()}>
                  <button type="button" className="version-link" onClick={() => onOpenVersion(f.id)}>
                    V{f.currentVersion}
                  </button>
                </td>
                <td className="muted">{formatSize(f.latest.size)}</td>
                <td className="muted">{formatDate(f.latest.uploadedAt)}</td>
              </tr>
            ))}
            {result && result.results.length === 0 && (
              <tr>
                <td colSpan={6} className="muted" style={{ padding: 32, textAlign: "center" }}>
                  {t("common:empty.noResults")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}
    </>
  );
}
