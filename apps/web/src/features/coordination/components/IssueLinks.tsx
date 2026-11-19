import { useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { api } from "../../../shared/api/api";
import { useLoad } from "../../../app/context/project";
import { FilePickerDialog } from "../../works/components/WorkDialogs";

/**
 * Documents an issue is linked to (PDF markups, file versions). Editors of the issue link further
 * documents (current versions) and remove version links; markups are unlinked in the PDF viewer.
 */
export function IssueLinks({ projectId, issueId, canEdit = false }: { projectId: string; issueId: string; canEdit?: boolean }) {
  const { t } = useTranslation(["coordination", "common"]);
  const { data: links, reload } = useLoad(() => api.issueLinks(projectId, issueId), [projectId, issueId]);
  const [picking, setPicking] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function run(fn: () => Promise<unknown>) {
    setErr(null);
    try {
      await fn();
    } catch (e) {
      setErr((e as Error).message);
    }
    reload();
  }

  if (!links?.length && !canEdit) return null;
  return (
    <div style={{ marginTop: 12 }}>
      <div className="row">
        <h3 style={{ margin: 0, flex: 1 }}>{t("issueLinks.title")}</h3>
        {canEdit && (
          <button type="button" className="small" onClick={() => setPicking(true)}>
            {t("issues.form.addDocument")}
          </button>
        )}
      </div>
      {links && !links.length && <p className="muted small">{t("issueLinks.empty")}</p>}
      {links?.map((l) =>
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
            <div style={{ flex: 1, minWidth: 0 }}>
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
            {canEdit && l.kind === "version" && (
              <button
                type="button"
                className="ghost small danger"
                aria-label={t("issueLinks.remove", { name: l.target.fileName })}
                title={t("issueLinks.remove", { name: l.target.fileName })}
                onClick={() => void run(() => api.unlinkIssue(projectId, issueId, l.id))}
              >
                ✕
              </button>
            )}
          </div>
        ) : null,
      )}
      {err && <p className="error">{err}</p>}
      {picking && (
        <FilePickerDialog
          exclude={(links ?? []).filter((l) => l.kind === "version").map((l) => l.targetId)}
          onClose={() => setPicking(false)}
          onPick={(ids) => {
            setPicking(false);
            void run(async () => {
              for (const v of ids) await api.linkIssue(projectId, issueId, "version", v);
            });
          }}
        />
      )}
    </div>
  );
}
