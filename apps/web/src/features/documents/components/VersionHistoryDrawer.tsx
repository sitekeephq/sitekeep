import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { can, docCompareKind, viewerFor, viewerPath, type FileVersionDto, type PermissionLevel } from "@sitekeep/shared";
import { formatDate, formatSize } from "../../../shared/api/api";
import { documentsApi } from "../api";
import { useLoad } from "../../../app/context/project";
import { ApprovalBadge } from "./ApprovalBadge";
import { Icon } from "../../../shared/ui/Icon";
import { LoadingIndicator } from "../../../shared/ui/LoadingIndicator";

export function VersionHistoryDrawer({
  projectId,
  fileId,
  level,
  onClose,
}: {
  projectId: string;
  fileId: string;
  level: PermissionLevel;
  onClose(): void;
}) {
  const { t } = useTranslation(["documents", "common"]);
  const { data: file, error } = useLoad(() => documentsApi.file(projectId, fileId), [projectId, fileId]);
  const { data: approvals } = useLoad(() => documentsApi.fileApprovals(projectId, fileId), [projectId, fileId]);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const viewer = viewerFor(file?.name ?? "");
  const canDownload = can(level, "download");
  const ordered = useMemo(
    () => [...(file?.versions ?? [])].sort((a, b) => b.version - a.version),
    [file?.versions],
  );
  const chosen = selected
    .map((id) => ordered.find((version) => version.id === id))
    .filter((version): version is FileVersionDto => !!version)
    .sort((a, b) => a.version - b.version);
  const canCompareDocuments = !!file && !!docCompareKind(file.extension);
  const canCompareModels = viewer.kind === "ifc" && chosen.every((version) => version.derivativeStatus === "ready");
  const compareTo =
    chosen.length === 2
      ? canCompareDocuments
        ? `/projects/${projectId}/compare?from=${chosen[0].id}&to=${chosen[1].id}`
        : canCompareModels
          ? `/projects/${projectId}/viewer?v=${chosen[1].id}&cmp=${chosen[0].id},${chosen[1].id}`
          : null
      : null;

  function toggle(id: string) {
    setSelected((current) => {
      if (current.includes(id)) return current.filter((value) => value !== id);
      return current.length < 2 ? [...current, id] : [current[1], id];
    });
  }

  return (
    <aside className="drawer version-history-drawer" aria-label={t("history.label")}>
      <header className="version-history-head">
        <div>
          <h2>{t("history.label")}</h2>
          {file && <p title={file.name}>{file.name}</p>}
        </div>
        <button className="ghost icon-button" onClick={onClose} aria-label={t("common:actions.close")} title={t("common:actions.close")}>
          ✕
        </button>
      </header>

      {error && <p className="error">{error}</p>}
      {!file && !error && <LoadingIndicator className="version-history-loading" />}
      {file && (
        <>
          <div className="version-history-toolbar">
            {file.versions.length > 1 && (canCompareDocuments || viewer.kind === "ifc") && (
              <button
                className={selecting ? "primary" : "ghost"}
                onClick={() => {
                  setSelecting((value) => !value);
                  setSelected([]);
                }}
              >
                <Icon name="layers" size={16} />
                {t("history.compareVersions")}
              </button>
            )}
            <span className="muted small">{t("history.showing", { count: file.versions.length })}</span>
          </div>

          {selecting && (
            <div className="version-compare-bar">
              <span>{t("history.selected", { count: selected.length })}</span>
              {compareTo ? (
                <Link className="btn primary small" to={compareTo}>
                  {t("modelCompare.dialog.actions.compare")}
                </Link>
              ) : (
                <button className="primary small" disabled>
                  {t("modelCompare.dialog.actions.compare")}
                </button>
              )}
            </div>
          )}

          <div className="version-history-list">
            {ordered.map((version) => {
              const versionApprovals = approvals?.filter((approval) => approval.versionId === version.id) ?? [];
              return (
                <article key={version.id} className={`version-history-item${selected.includes(version.id) ? " selected" : ""}`}>
                  <span className="version-select-slot">
                    {selecting && (
                      <input
                        type="checkbox"
                        checked={selected.includes(version.id)}
                        onChange={() => toggle(version.id)}
                        aria-label={t("history.selectVersion", { version: version.version })}
                      />
                    )}
                  </span>
                  <span className="version-number">V{version.version}</span>
                  <div className="version-history-main">
                    <strong title={file.name}>{file.name}</strong>
                    <span className="muted small">
                      {t("history.uploadedBy", { user: version.uploadedByName ?? t("history.unknownUser"), date: formatDate(version.uploadedAt) })}
                    </span>
                    <span className="muted small">{formatSize(version.size)}</span>
                    {version.comment && <span className="version-comment">{version.comment}</span>}
                    {versionApprovals.map((approval) => (
                      <ApprovalBadge
                        key={`${approval.reviewId}:${approval.isCopy ? "copy" : "source"}`}
                        projectId={projectId}
                        approval={approval}
                      />
                    ))}
                  </div>
                  <details className="version-actions">
                    <summary aria-label={t("history.versionActionsFor", { version: version.version })} title={t("history.versionActions")}>
                      ⋮
                    </summary>
                    <div className="version-actions-menu">
                      {viewer.kind !== "none" && viewer.kind !== "ifc" && (
                        <Link to={viewerPath(projectId, file.name, version.id)}>{t("common:actions.open")}</Link>
                      )}
                      {version.derivativeStatus === "ready" && (
                        <Link to={`/projects/${projectId}/viewer?v=${version.id}`}>{t("history.openInModel")}</Link>
                      )}
                      {canDownload && <a href={documentsApi.downloadUrl(projectId, version.id)}>{t("history.downloadSource")}</a>}
                      {docCompareKind(file.extension) && version.version > 1 && (
                        <Link to={`/projects/${projectId}/compare?to=${version.id}`}>{t("history.comparePrevious")}</Link>
                      )}
                    </div>
                  </details>
                </article>
              );
            })}
          </div>
        </>
      )}
    </aside>
  );
}
