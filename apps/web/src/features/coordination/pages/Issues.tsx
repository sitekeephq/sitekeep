import { useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { type IssueDto, type IssuePriority, type IssueStatus } from "@sitekeep/shared";
import { api, formatDate } from "../../../shared/api/api";
import { useAuth } from "../../../app/context/auth";
import { IssueLinks } from "../components/IssueLinks";
import { LocationLinkField } from "../../../shared/ui/LocationSelect";
import { useLoad, useProject, useRevealOnNarrow } from "../../../app/context/project";
import { ReportShortcut } from "../../documents/components/ReportShortcut";
import { useEmbedded } from "../../../app/context/embedded";
import { RecordCards, usePhoneWidth } from "../../../shared/ui/RecordCards";
import { MoreMenu } from "../../../shared/ui/MoreMenu";
import { dueOf } from "../../works/record-cards";
import { BcfExportDialog, BcfImportDialog } from "../components/BcfDialogs";
import { LoadingIndicator } from "../../../shared/ui/LoadingIndicator";
import { reportBuilderUrl } from "../../documents/components/ReportShortcut";
import { useLabel } from "../../../i18n";

const PRIORITIES: IssuePriority[] = ["low", "normal", "high", "critical"];
const STATUSES: IssueStatus[] = ["open", "in_progress", "in_review", "closed"];
const STATUS_CLASS: Record<IssueStatus, string> = { open: "danger", in_progress: "warn", in_review: "info", closed: "ok" };

export function IssuesPage() {
  const { t } = useTranslation(["coordination", "common"]);
  const label = useLabel();
  const project = useProject();
  const { iid } = useParams();
  const navigate = useNavigate();
  const embedded = useEmbedded();
  const phone = usePhoneWidth();
  // The status filter lives in the URL (?durum=…), so the İşler hub can save it as a view.
  const [search, setSearch] = useSearchParams();
  const status = search.get("durum") ?? "";
  const setStatus = (v: string) =>
    setSearch(
      (p) => {
        if (v) p.set("durum", v);
        else p.delete("durum");
        p.delete("gorunum");
        return p;
      },
      { replace: true },
    );
  const suffix = search.toString() ? `?${search.toString()}` : "";
  const { data: issues, error, reload } = useLoad(
    () => api.issues(project.id, status || undefined),
    [project.id, status, embedded?.refreshKey],
  );
  const { data: members } = useLoad(() => api.members(project.id), [project.id]);
  const names = new Map(members?.map((m) => [m.userId, m.name]));
  // BCF: selected rows (export), dialogs.
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [bcf, setBcf] = useState<"export" | "import" | null>(null);
  const visible = new Set((issues ?? []).map((i) => i.id));
  const pickedIds = [...picked].filter((id) => visible.has(id));
  const issuesOn = project.modules?.issues !== false;
  const togglePick = (id: string, on: boolean) =>
    setPicked((p) => {
      const n = new Set(p);
      if (on) n.add(id);
      else n.delete(id);
      return n;
    });

  return (
    <div className={`split${iid ? " with-detail" : ""}`}>
      <div className="page" style={{ maxWidth: "none", width: "100%", overflow: "auto" }}>
        <div className="row wrap" style={{ marginBottom: 12 }}>
          {!embedded && <h1 style={{ margin: 0 }}>{t("issues.title")}</h1>}
          <div className="spacer" />
          <select style={{ width: 180 }} value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">{t("issues.options.allStatuses")}</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {label("issueStatus", s)}
              </option>
            ))}
          </select>
          {phone ? (
            <>
              <Link className="btn" to={`/projects/${project.id}/viewer`}>
                {t("issues.actions.newInModel")}
              </Link>
              <MoreMenu
                items={[
                  { key: "report", label: t("issues.actions.report") },
                  ...(issuesOn ? [{ key: "import", label: t("bcfImport.title") }] : []),
                  {
                    key: "export",
                    label: pickedIds.length ? t("issues.actions.exportBcfCount", { n: pickedIds.length }) : t("bcfExport.title"),
                    disabled: !issues?.length,
                  },
                ]}
                onSelect={(key) => {
                  if (key === "report") navigate(reportBuilderUrl(project.id, "issues"));
                  else if (key === "import") setBcf("import");
                  else if (key === "export") setBcf("export");
                }}
              />
            </>
          ) : (
            <>
              <ReportShortcut module="issues" />
              {issuesOn && <button onClick={() => setBcf("import")}>{t("bcfImport.title")}</button>}
              <button disabled={!issues?.length} onClick={() => setBcf("export")}>
                {pickedIds.length ? t("issues.actions.exportBcfCount", { n: pickedIds.length }) : t("bcfExport.title")}
              </button>
              <Link className="btn" to={`/projects/${project.id}/viewer`}>
                {t("issues.actions.newInModel")}
              </Link>
            </>
          )}
        </div>
        {error && <p className="error">{error}</p>}
        {phone ? (
          <RecordCards
            label={t("issues.title")}
            selectedId={iid}
            onOpen={(id) => navigate(`/projects/${project.id}/issues/${id}${suffix}`)}
            emptyText={issues ? t("issues.empty") : null}
            groups={[
              {
                key: "",
                label: "",
                rows: (issues ?? []).map((i) => ({
                  id: i.id,
                  number: `#${i.number}`,
                  title: i.title,
                  meta: [i.type, i.assigneeUserId ? names.get(i.assigneeUserId) : null],
                  status: { label: label("issueStatus", i.status), tone: STATUS_CLASS[i.status] },
                  due: dueOf(i.dueDate, i.status === "closed"),
                  chips: i.priority === "high" || i.priority === "critical" ? [{ label: label("issuePriority", i.priority), tone: "danger" }] : [],
                })),
              },
            ]}
          />
        ) : (
          <div className="card" style={{ padding: 0 }}>
            <table>
              <thead>
                <tr>
                  <th style={{ width: 32 }}>
                    <input
                      type="checkbox"
                      aria-label={t("common:actions.selectAll")}
                      checked={!!issues?.length && pickedIds.length === issues.length}
                      onChange={(e) => setPicked(e.target.checked ? new Set(issues?.map((i) => i.id)) : new Set())}
                    />
                  </th>
                  <th style={{ width: 60 }}>{t("issues.columns.number")}</th>
                  <th>{t("issues.columns.title")}</th>
                  <th style={{ width: 120 }}>{t("issues.columns.status")}</th>
                  <th style={{ width: 90 }}>{t("issues.columns.priority")}</th>
                  <th style={{ width: 150 }}>{t("issues.columns.assignee")}</th>
                  <th style={{ width: 100 }}>{t("issues.columns.due")}</th>
                  <th style={{ width: 120 }}>{t("issues.columns.updated")}</th>
                </tr>
              </thead>
              <tbody>
                {issues?.map((i) => (
                  <tr
                    key={i.id}
                    className={`clickable${i.id === iid ? " selected" : ""}`}
                    onClick={() => navigate(`/projects/${project.id}/issues/${i.id}${suffix}`)}
                  >
                    <td onClick={(e) => e.stopPropagation()}>
                      <input type="checkbox" aria-label={t("issues.selectIssue")} checked={picked.has(i.id)} onChange={(e) => togglePick(i.id, e.target.checked)} />
                    </td>
                    <td className="muted">#{i.number}</td>
                    <td>
                      {i.title}
                      {i.type && <span className="badge" style={{ marginLeft: 6 }}>{i.type}</span>}
                    </td>
                    <td>
                      <span className={`badge ${STATUS_CLASS[i.status]}`}>{label("issueStatus", i.status)}</span>
                    </td>
                    <td>{label("issuePriority", i.priority)}</td>
                    <td className="muted">{i.assigneeUserId ? names.get(i.assigneeUserId) ?? "—" : "—"}</td>
                    <td className="muted">{i.dueDate ?? "—"}</td>
                    <td className="muted small">{formatDate(i.updatedAt)}</td>
                  </tr>
                ))}
                {issues?.length === 0 && (
                  <tr>
                    <td colSpan={8} className="muted" style={{ textAlign: "center", padding: 32 }}>
                      {t("issues.empty")}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {iid && <IssueDetail key={iid} issueId={iid} onChanged={reload} names={names} />}
      {bcf === "export" && (
        <BcfExportDialog
          ids={pickedIds.length ? pickedIds : undefined}
          status={status || undefined}
          count={pickedIds.length || issues?.length || 0}
          onClose={() => setBcf(null)}
        />
      )}
      {bcf === "import" && <BcfImportDialog onClose={() => setBcf(null)} onImported={reload} />}
    </div>
  );
}

function IssueDetail({ issueId, onChanged, names }: { issueId: string; onChanged(): void; names: Map<string, string> }) {
  const { t } = useTranslation(["coordination", "common"]);
  const label = useLabel();
  const project = useProject();
  const { user } = useAuth();
  const { data: issue, error, setData } = useLoad(() => api.issue(project.id, issueId), [project.id, issueId]);
  const { data: comments, reload: reloadComments } = useLoad(() => api.comments(project.id, issueId), [project.id, issueId]);
  const { data: members } = useLoad(() => api.members(project.id), [project.id]);
  const [comment, setComment] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const panelRef = useRevealOnNarrow<HTMLElement>(issue?.id);
  // Further viewpoints (BCF topics may carry several); loaded only when there are any.
  const extra = issue?.extraViewpointCount ?? 0;
  const { data: viewpoints } = useLoad(
    () => (extra ? api.issueViewpoints(project.id, issueId) : Promise.resolve([])),
    [project.id, issueId, extra],
  );

  if (error) return <aside className="panel right"><p className="error">{error}</p></aside>;
  if (!issue) return <aside className="panel right"><LoadingIndicator /></aside>;
  const canEdit = project.isProjectAdmin || issue.createdBy === user?.id || issue.assigneeUserId === user?.id;
  const viewerHref = (vp: { fileVersionIds: string[] }, guid?: string) =>
    `/projects/${project.id}/viewer?v=${vp.fileVersionIds.join(",")}&issue=${issue.id}${guid ? `&vp=${guid}` : ""}`;
  const viewerLink = issue.viewpoint ? viewerHref(issue.viewpoint) : null;

  async function update(patch: Partial<IssueDto>) {
    setMsg(null);
    try {
      setData(await api.updateIssue(project.id, issueId, patch));
      onChanged();
    } catch (e) {
      setMsg((e as Error).message);
    }
  }

  return (
    <aside className="panel right" ref={panelRef}>
      <div className="muted small">
        #{issue.number} · {issue.createdByName} · {formatDate(issue.createdAt)}
      </div>
      <h2 style={{ marginTop: 4 }}>{issue.title}</h2>
      {viewerLink && issue.viewpoint?.snapshot && (
        <Link to={viewerLink}>
          <img src={issue.viewpoint.snapshot} alt={t("issue.viewpoint")} style={{ width: "100%", borderRadius: 6, border: "1px solid var(--border)" }} />
        </Link>
      )}
      {viewerLink && (
        <Link className="btn" style={{ marginTop: 8 }} to={viewerLink}>
          {t("issue.actions.openInModel")}
        </Link>
      )}
      {viewpoints && viewpoints.length > 1 && (
        <div className="bcf-viewpoints">
          {viewpoints.map((v, n) => (
            <Link key={v.guid} to={viewerHref(v.viewpoint, v.guid)} title={t("issue.viewpointN", { n: n + 1 })}>
              {v.viewpoint.snapshot ? <img src={v.viewpoint.snapshot} alt={t("issue.viewpointN", { n: n + 1 })} /> : null}
              {t("issue.viewpointN", { n: n + 1 })}
            </Link>
          ))}
        </div>
      )}
      {issue.description && <p style={{ whiteSpace: "pre-wrap" }}>{issue.description}</p>}
      {(issue.labels?.length || issue.stage) && (
        <div className="row wrap" style={{ gap: 4, marginTop: 6 }}>
          {issue.labels?.map((l) => (
            <span key={l} className="badge">
              {l}
            </span>
          ))}
          {issue.stage && <span className="badge info">{issue.stage}</span>}
        </div>
      )}
      {issue.importedFrom && (
        <p className="muted small" style={{ margin: "6px 0" }}>
          {issue.importedFrom.fileName
            ? t("issue.importedFromFile", { version: issue.importedFrom.version, file: issue.importedFrom.fileName })
            : t("issue.importedFrom", { version: issue.importedFrom.version })}
          {issue.importedFrom.assignedTo ? ` · ${t("issue.assignedInFile", { name: issue.importedFrom.assignedTo })}` : ""}
        </p>
      )}
      <button style={{ marginTop: 8 }} onClick={() => setExporting(true)}>
        {t("bcfExport.title")}
      </button>
      {exporting && <BcfExportDialog ids={[issue.id]} count={1} onClose={() => setExporting(false)} />}
      <IssueLinks projectId={project.id} issueId={issue.id} />
      <LocationLinkField projectId={project.id} kind="issue" targetId={issue.id} disabled={!canEdit} />

      <div className="row" style={{ marginTop: 12 }}>
        <div style={{ flex: 1 }}>
          <label>{t("common:fields.status")}</label>
          <select disabled={!canEdit} value={issue.status} onChange={(e) => void update({ status: e.target.value as IssueStatus })}>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {label("issueStatus", s)}
              </option>
            ))}
          </select>
        </div>
        <div style={{ flex: 1 }}>
          <label>{t("common:fields.priority")}</label>
          <select disabled={!canEdit} value={issue.priority} onChange={(e) => void update({ priority: e.target.value as IssuePriority })}>
            {PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {label("issuePriority", p)}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="row">
        <div style={{ flex: 1 }}>
          <label>{t("common:fields.assignee")}</label>
          <select
            disabled={!canEdit}
            value={issue.assigneeUserId ?? ""}
            onChange={(e) => void update({ assigneeUserId: e.target.value || null })}
          >
            <option value="">—</option>
            {members?.map((m) => (
              <option key={m.userId} value={m.userId}>
                {m.name}
              </option>
            ))}
          </select>
        </div>
        <div style={{ flex: 1 }}>
          <label>{t("common:fields.dueDate")}</label>
          <input
            disabled={!canEdit}
            type="date"
            value={issue.dueDate ?? ""}
            onChange={(e) => void update({ dueDate: e.target.value || null })}
          />
        </div>
      </div>
      {!canEdit && <p className="muted small">{t("issue.editHint")}</p>}
      {msg && <p className="error">{msg}</p>}

      <h3 style={{ marginTop: 20 }}>{t("issue.comments")}</h3>
      {comments?.length === 0 && <p className="muted small">{t("issue.noComments")}</p>}
      {comments?.map((c) => (
        <div key={c.id} style={{ borderBottom: "1px solid var(--border)", padding: "8px 0" }}>
          <div className="small">
            <strong>{c.importedAuthor ?? c.authorName ?? names.get(c.authorId)}</strong> <span className="muted">{formatDate(c.createdAt)}</span>
          </div>
          <div style={{ whiteSpace: "pre-wrap" }}>{c.body}</div>
        </div>
      ))}
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (!comment.trim()) return;
          try {
            await api.addComment(project.id, issueId, comment);
            setComment("");
            reloadComments();
            onChanged();
          } catch (err) {
            setMsg((err as Error).message);
          }
        }}
      >
        <textarea placeholder={t("issue.commentPlaceholder")} value={comment} onChange={(e) => setComment(e.target.value)} style={{ marginTop: 8 }} />
        <div className="dialog-actions" style={{ marginTop: 8 }}>
          <button className="primary" disabled={!comment.trim()}>
            {t("common:actions.send")}
          </button>
        </div>
      </form>
    </aside>
  );
}
