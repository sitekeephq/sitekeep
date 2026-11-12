import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { formatDate, formatNumber } from "../../shared/api/api";
import { FileTypeIcon, Icon } from "../../shared/ui/Icon";
import {
  documentsApi,
  type ExternalDocumentEntry,
} from "./api";

export function AutodeskDocuments({ projectId, onShowCde }: { projectId: string; onShowCde(): void }) {
  const { t } = useTranslation(["documents", "common"]);
  const sourcesQuery = useQuery({
    queryKey: ["documents", projectId, "external-sources"],
    queryFn: ({ signal }) => documentsApi.externalSources(projectId, signal),
  });
  const [sourceId, setSourceId] = useState("");
  const [stack, setStack] = useState<ExternalDocumentEntry[]>([]);
  const parentId = stack.at(-1)?.externalId ?? null;

  useEffect(() => {
    const sources = sourcesQuery.data ?? [];
    if (!sources.some((source) => source.id === sourceId)) setSourceId(sources[0]?.id ?? "");
  }, [sourceId, sourcesQuery.data]);

  const contentsQuery = useQuery({
    queryKey: ["documents", projectId, "external-contents", sourceId, parentId],
    queryFn: ({ signal }) => documentsApi.externalContents(projectId, sourceId, parentId, signal),
    enabled: !!sourceId,
  });
  const selectedSource = sourcesQuery.data?.find((source) => source.id === sourceId);
  const entries = contentsQuery.data?.entries ?? [];
  const folders = entries.filter((entry) => entry.kind === "folder");
  const files = entries.filter((entry) => entry.kind === "file");
  const error = sourcesQuery.error?.message ?? contentsQuery.error?.message ?? null;

  return (
    <div className="docs external-docs">
      <aside className="docs-tree">
        <div className="external-source-head">
          <span className="eyebrow">{t("autodesk.externalSource")}</span>
          <strong>Autodesk Docs</strong> {/* i18n-ok: product name */}
        </div>
        {(sourcesQuery.data ?? []).map((source) => (
          <button
            key={source.id}
            className={`external-source-item${source.id === sourceId ? " active" : ""}`}
            onClick={() => {
              setSourceId(source.id);
              setStack([]);
            }}
          >
            <span className="row-icon"><Icon name="folder" /></span>
            <span>
              <strong>{source.name}</strong>
              <small>{t("autodesk.counts", { folders: formatNumber(source.counts.folders), files: formatNumber(source.counts.files) })}</small>
            </span>
          </button>
        ))}
      </aside>
      <section className="docs-main">
        <div className="docs-toolbar">
          <button onClick={onShowCde}>{t("autodesk.cdeDocuments")}</button>
          <button className="primary">Autodesk</button> {/* i18n-ok: product name */}
          <span className="badge info">{t("autodesk.readOnly")}</span>
          <div className="crumbs">
            <button className="ghost small" onClick={() => setStack([])}>{selectedSource?.name ?? "Autodesk"}</button>
            {stack.map((folder, index) => (
              <span key={folder.externalId} className="row" style={{ gap: 4 }}>
                <span className="sep">/</span>
                {index === stack.length - 1 ? (
                  <strong>{folder.name}</strong>
                ) : (
                  <button className="ghost small" onClick={() => setStack((current) => current.slice(0, index + 1))}>
                    {folder.name}
                  </button>
                )}
              </span>
            ))}
          </div>
          <div className="spacer" />
          {selectedSource && (
            <span className="muted small">
              {t("autodesk.lastSync", { date: formatDate(selectedSource.syncedAt) })}
            </span>
          )}
        </div>
        <div className="docs-list">
          {error && <p className="error" style={{ margin: 16 }}>{error}</p>}
          {!sourcesQuery.isLoading && !error && !sourcesQuery.data?.length && (
            <div className="empty-state">
              <strong>{t("autodesk.empty")}</strong>
              <p className="muted">{t("autodesk.emptyHint")}</p>
            </div>
          )}
          {sourceId && (
            <table className="phone-cards">
              <thead>
                <tr>
                  <th style={{ minWidth: 320 }}>{t("common:fields.name")}</th>
                  <th style={{ width: 120 }}>{t("autodesk.columns.typeVersion")}</th>
                  <th style={{ width: 180 }}>{t("autodesk.columns.modified")}</th>
                  <th style={{ width: 150 }}>{t("autodesk.columns.source")}</th>
                </tr>
              </thead>
              <tbody>
                {stack.length > 0 && (
                  <tr className="clickable" onClick={() => setStack((current) => current.slice(0, -1))}>
                    <td><span className="row-icon"><Icon name="folder" /></span>..</td>
                    <td colSpan={3} className="muted">{t("autodesk.parentFolder")}</td>
                  </tr>
                )}
                {folders.map((folder) => (
                  <tr key={folder.id} className="clickable" onClick={() => setStack((current) => [...current, folder])}>
                    <td className="pc-title"><span className="row-icon"><Icon name="folder" /></span>{folder.name}</td>
                    <td data-label={t("autodesk.columns.typeVersion")}><span className="badge">{t("common:fields.folder")}</span></td>
                    <td className="muted" data-label={t("autodesk.columns.modified")}>{folder.sourceModifiedAt ? formatDate(folder.sourceModifiedAt) : "—"}</td>
                    <td data-label={t("autodesk.columns.source")}><span className="badge info">Autodesk</span></td> {/* i18n-ok: product name */}
                  </tr>
                ))}
                {files.map((file) => (
                  <tr key={file.id}>
                    <td className="pc-title"><FileTypeIcon ext={extension(file.name)} />{file.name}</td>
                    <td data-label={t("autodesk.columns.typeVersion")}>{file.versionNumber ? <span className="badge">V{file.versionNumber}</span> : t("common:fields.file")}</td>
                    <td className="muted" data-label={t("autodesk.columns.modified")}>{file.sourceModifiedAt ? formatDate(file.sourceModifiedAt) : "—"}</td>
                    <td data-label={t("autodesk.columns.source")}>
                      {file.webUrl ? (
                        <a className="badge info" href={file.webUrl} target="_blank" rel="noreferrer">{t("autodesk.openInAutodesk")}</a>
                      ) : (
                        <span className="badge info">Autodesk{/* i18n-ok: product name */}</span>
                      )}
                    </td>
                  </tr>
                ))}
                {!contentsQuery.isLoading && entries.length === 0 && (
                  <tr><td colSpan={4} className="muted" style={{ padding: 32, textAlign: "center" }}>{t("autodesk.folderEmpty")}</td></tr>
                )}
              </tbody>
            </table>
          )}
        </div>
      </section>
    </div>
  );
}

function extension(name: string): string {
  const value = name.split(".").at(-1);
  return value && value !== name ? value.toLowerCase() : "";
}
