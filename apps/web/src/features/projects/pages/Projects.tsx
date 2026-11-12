import { useMemo, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { foldTr, type ProjectDto } from "@sitekeep/shared";
import { api, formatDate } from "../../../shared/api/api";
import { useAuth } from "../../../app/context/auth";
import { useLoad } from "../../../app/context/project";
import { Dialog } from "../../../shared/ui/Dialog";
import { Icon } from "../../../shared/ui/Icon";
import { NewProjectWizard } from "../components/NewProjectWizard";
import { LoadingIndicator } from "../../../shared/ui/LoadingIndicator";

export function ProjectsPage() {
  const { t } = useTranslation(["projects", "common"]);
  const { user } = useAuth();
  const navigate = useNavigate();
  const { data: projects, error, reload } = useLoad(() => api.projects(), []);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<ProjectDto | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [copiedProjectId, setCopiedProjectId] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const visible = useMemo(() => {
    const q = foldTr(query.trim());
    if (!q) return projects ?? [];
    return (projects ?? []).filter((p) => foldTr(`${p.code} ${p.name} ${p.description ?? ""}`).includes(q));
  }, [projects, query]);

  async function removeProject() {
    if (!deleting) return;
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      await api.deleteProject(deleting.id);
      setDeleting(null);
      reload();
    } catch (e) {
      setDeleteError((e as Error).message);
    } finally {
      setDeleteBusy(false);
    }
  }

  async function copyProjectName(project: ProjectDto) {
    try {
      await navigator.clipboard.writeText(project.name);
    } catch {
      const input = document.createElement("textarea");
      input.value = project.name;
      input.style.position = "fixed";
      input.style.opacity = "0";
      document.body.appendChild(input);
      input.select();
      document.execCommand("copy");
      input.remove();
    }
    setCopiedProjectId(project.id);
    window.setTimeout(() => setCopiedProjectId((current) => (current === project.id ? null : current)), 1600);
  }

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>{t("list.title")}</h1>
          <p>{t("list.description")}</p>
        </div>
        {user?.isAdmin && (
          <button className="primary" onClick={() => setCreating(true)}>
            <Icon name="plus" size={16} />
            {t("list.actions.new")}
          </button>
        )}
      </header>

      {error && <p className="error">{error}</p>}

      <section className="panel-box">
        <div className="projects-toolbar">
          <input
            type="search"
            className="search-input"
            placeholder={t("list.searchPlaceholder")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label={t("list.filterLabel")}
          />
          <span className="muted small">
            {query
              ? t("list.filteredCount", { count: projects?.length ?? 0, shown: visible.length })
              : t("list.count", { count: projects?.length ?? 0 })}
          </span>
          <div className="spacer" />
          <button className="ghost icon-button" onClick={reload} title={t("list.actions.refresh")} aria-label={t("list.actions.refresh")}>
            <Icon name="refresh" size={16} />
          </button>
        </div>
        <table className="data-table projects-table phone-cards">
          <thead>
            <tr>
              <th>{t("list.columns.project")}</th>
              <th>{t("list.columns.description")}</th>
              <th style={{ width: 170 }}>{t("list.columns.myRole")}</th>
              <th style={{ width: 130 }}>{t("list.columns.created")}</th>
              {user?.isAdmin && <th style={{ width: 56 }} aria-label={t("list.columns.actions")} />}
            </tr>
          </thead>
          <tbody>
            {visible.map((p) => (
              <tr
                key={p.id}
                className="clickable"
                onClick={() => {
                  if (!window.getSelection()?.toString()) navigate(`/projects/${p.id}/files`);
                }}
              >
                <td className="pc-title">
                  <div className="project-cell">
                    <span className="project-avatar" aria-hidden="true">
                      {p.code.slice(0, 2)}
                    </span>
                    <div className="project-cell-text">
                      <div className="project-name-line">
                        <a
                          href={`/projects/${p.id}/files`}
                          className="strong-link"
                          onClick={(e) => {
                            e.preventDefault();
                            if (window.getSelection()?.toString()) return;
                            navigate(`/projects/${p.id}/files`);
                          }}
                        >
                          {p.name}
                        </a>
                        <button
                          className={`ghost icon-button project-copy${copiedProjectId === p.id ? " copied" : ""}`}
                          title={copiedProjectId === p.id ? t("common:status.copied") : t("list.actions.copyName")}
                          aria-label={t("list.copyNameLabel", { name: p.name })}
                          onClick={(e) => {
                            e.stopPropagation();
                            void copyProjectName(p);
                          }}
                        >
                          <Icon name={copiedProjectId === p.id ? "tick" : "copy"} size={14} />
                        </button>
                      </div>
                      <span className="project-code">{p.code}</span>
                    </div>
                  </div>
                </td>
                <td className="muted truncate" data-label={t("list.columns.description")}>{p.description || "—"}</td>
                <td data-label={t("list.columns.myRole")}>
                  {p.isProjectAdmin ? <span className="status ok">{t("list.status.projectAdmin")}</span> : <span className="status">{t("list.status.member")}</span>}
                </td>
                <td className="muted" data-label={t("list.columns.created")}>{formatDate(p.createdAt).split(" ")[0]}</td>
                {user?.isAdmin && (
                  <td className="pc-actions" onClick={(e) => e.stopPropagation()}>
                    <button
                      className="ghost icon-button project-delete"
                      title={t("delete.title")}
                      aria-label={t("delete.label", { name: p.name })}
                      onClick={() => {
                        setDeleteError(null);
                        setDeleting(p);
                      }}
                    >
                      <Icon name="trash" size={16} />
                    </button>
                  </td>
                )}
              </tr>
            ))}
            {projects && visible.length === 0 && (
              <tr>
                <td colSpan={user?.isAdmin ? 5 : 4} className="empty-cell">
                  {query ? (
                    t("list.emptyFiltered")
                  ) : (
                    <>
                      <strong>{t("list.empty")}</strong>
                      <span>
                        {user?.isAdmin ? t("list.emptyAdminHint") : t("list.emptyMemberHint")}
                      </span>
                    </>
                  )}
                </td>
              </tr>
            )}
            {!projects && !error && (
              <tr>
                <td colSpan={user?.isAdmin ? 5 : 4} className="empty-cell">
                  <LoadingIndicator compact />
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
      {creating && <NewProjectWizard onClose={() => setCreating(false)} onCreated={reload} />}
      {deleting && (
        <Dialog title={t("delete.title")} onClose={() => !deleteBusy && setDeleting(null)}>
          <p>
            <Trans t={t} i18nKey="delete.confirm" values={{ name: deleting.name }} components={{ b: <strong /> }} />
          </p>
          <p className="muted small">{t("delete.hint")}</p>
          {deleteError && <p className="error">{deleteError}</p>}
          <div className="dialog-actions">
            <button disabled={deleteBusy} onClick={() => setDeleting(null)}>
              {t("common:actions.cancel")}
            </button>
            <button className="danger" disabled={deleteBusy} onClick={() => void removeProject()}>
              {deleteBusy ? t("delete.deleting") : t("delete.actions.confirm")}
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
