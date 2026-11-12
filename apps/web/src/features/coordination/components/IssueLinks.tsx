import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { api } from "../../../shared/api/api";
import { useLoad } from "../../../app/context/project";

/** Documents an issue is linked to (PDF markups, file versions). */
export function IssueLinks({ projectId, issueId }: { projectId: string; issueId: string }) {
  const { t } = useTranslation(["coordination", "common"]);
  const { data: links } = useLoad(() => api.issueLinks(projectId, issueId), [projectId, issueId]);
  if (!links?.length) return null;
  return (
    <div style={{ marginTop: 12 }}>
      <h3>{t("issueLinks.title")}</h3>
      {links.map((l) =>
        l.target && l.kind === "clash_group" ? (
          <div key={l.id} className="model-item small">
            <span>⚠</span>
            <div>
              <Link to={`/projects/${projectId}/coordination/tests/${l.target.clashTestId}`}>{l.target.title ?? t("issueLinks.clashGroup")}</Link>
              <div className="muted">
                {t("issueLinks.clashGroupMeta", { file: l.target.fileName, version: l.target.version })}
              </div>
            </div>
          </div>
        ) : l.target ? (
          <div key={l.id} className="model-item small">
            <span>{l.kind === "markup" ? "✏️" : "📄"}</span>
            <div>
              <Link
                to={`/projects/${projectId}/view/${l.target.versionId}${l.kind === "markup" ? `?page=${l.target.page ?? 1}&markup=${l.targetId}` : ""}`}
              >
                {l.target.fileName}
              </Link>
              <div className="muted">
                {l.kind === "markup"
                  ? t("issueLinks.markupMeta", { version: l.target.version, page: l.target.page })
                  : t("issueLinks.versionMeta", { version: l.target.version })}
              </div>
            </div>
          </div>
        ) : null,
      )}
    </div>
  );
}
