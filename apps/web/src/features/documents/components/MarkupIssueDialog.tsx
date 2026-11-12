import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import type { IssuePriority, MarkupDto, MarkupShape } from "@sitekeep/shared";
import { useAuth } from "../../../app/context/auth";
import { useLoad, useProject } from "../../../app/context/project";
import { labelEntries } from "../../../i18n";
import { api } from "../../../shared/api/api";
import { Dialog } from "../../../shared/ui/Dialog";

/** Issue types as stored on the issue (Turkish values, shown translated). */
const ISSUE_TYPES = [
  ["Tasarım", "design"], // i18n-ok
  ["Koordinasyon", "coordination"],
  ["Saha", "site"],
  ["Kalite", "quality"],
  ["İSG", "safety"], // i18n-ok
  ["Diğer", "other"], // i18n-ok
] as const;

/** Creates an issue with the existing issues API and links it to the markup (or the version). */
export function MarkupIssueDialog({
  markup,
  fileName,
  version,
  versionId,
  page,
  initialTitle,
  initialDescription,
  onClose,
  onCreated,
}: {
  markup: MarkupDto | null;
  fileName: string;
  version: number;
  versionId: string;
  page: number;
  /** Pre-filled title / description (e.g. from a revision comparison). */
  initialTitle?: string;
  initialDescription?: string;
  onClose(): void;
  onCreated(published: MarkupDto | null): void;
}) {
  const { t } = useTranslation(["documents", "common"]);
  const project = useProject();
  const { user } = useAuth();
  const { data: members } = useLoad(() => api.members(project.id), [project.id]);
  const firstText = markup?.shapes.find((s): s is Extract<MarkupShape, { type: "text" }> => s.type === "text")?.text;
  const [title, setTitle] = useState(initialTitle?.slice(0, 300) ?? firstText?.split("\n")[0]?.slice(0, 200) ?? "");
  const [description, setDescription] = useState(initialDescription ?? t("markupIssue.defaultDescription", { file: fileName, version, page }));
  const [priority, setPriority] = useState<IssuePriority>("normal");
  const [type, setType] = useState<string>(ISSUE_TYPES[0][0]);
  const [assignee, setAssignee] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ id: string; number: number } | null>(null);
  const willPublish = !!markup && !markup.published && markup.authorId === user?.id;

  async function submit() {
    setError(null);
    try {
      const published = willPublish ? await api.publishMarkup(project.id, markup!.id) : null;
      const issue = await api.createIssue(project.id, {
        title,
        description: description || null,
        priority,
        type,
        assigneeUserId: assignee || null,
        dueDate: dueDate || null,
      });
      await api.linkIssue(project.id, issue.id, markup ? "markup" : "version", markup ? markup.id : versionId);
      setCreated(issue);
      onCreated(published);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <Dialog title={markup ? t("markupIssue.titleMarkup") : t("markupIssue.titleVersion")} onClose={onClose}>
      {created ? (
        <>
          <p className="success">
            {t(markup ? "markupIssue.createdMarkup" : "markupIssue.createdVersion", { number: created.number })}{" "}
            <Link to={`/projects/${project.id}/issues/${created.id}`}>{t("common:actions.open")}</Link>
          </p>
          <div className="dialog-actions"><button className="primary" onClick={onClose}>{t("common:actions.close")}</button></div>
        </>
      ) : (
        <>
          <label>{t("common:fields.title")}</label>
          <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} />
          <label>{t("common:fields.description")}</label>
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} />
          <div className="row">
            <div style={{ flex: 1 }}>
              <label>{t("common:fields.type")}</label>
              <select value={type} onChange={(e) => setType(e.target.value)}>
                {ISSUE_TYPES.map(([value, key]) => <option key={value} value={value}>{t(`markupIssue.types.${key}`)}</option>)}
              </select>
            </div>
            <div style={{ flex: 1 }}>
              <label>{t("common:fields.priority")}</label>
              <select value={priority} onChange={(e) => setPriority(e.target.value as IssuePriority)}>
                {labelEntries("issuePriority").map(([value, text]) => <option key={value} value={value}>{text}</option>)}
              </select>
            </div>
          </div>
          <div className="row">
            <div style={{ flex: 1 }}>
              <label>{t("common:fields.assignee")}</label>
              <select value={assignee} onChange={(e) => setAssignee(e.target.value)}>
                <option value="">—</option>
                {members?.map((m) => <option key={m.userId} value={m.userId}>{m.name} {m.companyName ? `(${m.companyName})` : ""}</option>)}
              </select>
            </div>
            <div style={{ flex: 1 }}>
              <label>{t("common:fields.dueDate")}</label>
              <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
            </div>
          </div>
          {willPublish && <p className="notice small">{t("markupIssue.willPublish")}</p>}
          {error && <p className="error">{error}</p>}
          <div className="dialog-actions">
            <button onClick={onClose}>{t("common:actions.cancel")}</button>
            <button className="primary" disabled={!title.trim()} onClick={() => void submit()}>{t("common:actions.create")}</button>
          </div>
        </>
      )}
    </Dialog>
  );
}
