/**
 * New issue without a model: title, description, type, priority, assignee, due date and optional
 * documents (file versions, linked as "version" issue links). For projects that work with documents
 * only; issues with a viewpoint are still created in the model viewer.
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { IssueDto, IssuePriority } from "@sitekeep/shared";
import { api } from "../../../shared/api/api";
import { useLoad, useProject } from "../../../app/context/project";
import { Dialog } from "../../../shared/ui/Dialog";
import { useLabel } from "../../../i18n";
import { FilePickerDialog } from "../../works/components/WorkDialogs";

/** Issue type values as stored on the issue (Turkish, like existing data); labels: `newIssue.types.<key>`. */
export const ISSUE_TYPES: { value: string; key: "coordination" | "design" | "site" | "quality" | "ohs" | "other" }[] = [
  { value: "Koordinasyon", key: "coordination" },
  { value: "Tasarım", key: "design" }, // i18n-ok
  { value: "Saha", key: "site" },
  { value: "Kalite", key: "quality" },
  { value: "İSG", key: "ohs" }, // i18n-ok
  { value: "Diğer", key: "other" }, // i18n-ok
];

/** The project's issue types (from its template), else the built-in ones. */
export function IssueTypeSelect({ value, onChange, id }: { value: string; onChange(v: string): void; id?: string }) {
  const { t } = useTranslation(["coordination"]);
  const project = useProject();
  const projectTypes = project.issueTypes?.filter((g) => g.types.length);
  return (
    <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
      {projectTypes?.length
        ? projectTypes.map((g) => (
            <optgroup key={g.category} label={g.category}>
              {g.types.map((x) => (
                <option key={x} value={x}>
                  {x}
                </option>
              ))}
            </optgroup>
          ))
        : ISSUE_TYPES.map((x) => (
            <option key={x.value} value={x.value}>
              {t(`newIssue.types.${x.key}`)}
            </option>
          ))}
    </select>
  );
}

/** First type of the project's list, else the first built-in one. */
export function useDefaultIssueType(): string {
  const project = useProject();
  return project.issueTypes?.find((g) => g.types.length)?.types[0] ?? ISSUE_TYPES[0]!.value;
}

interface PickedDoc {
  versionId: string;
  name: string;
}

export function NewIssueDialog({ onClose, onCreated }: { onClose(): void; onCreated(issue: IssueDto): void }) {
  const { t } = useTranslation(["coordination", "common"]);
  const label = useLabel();
  const project = useProject();
  const { data: members } = useLoad(() => api.members(project.id), [project.id]);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [type, setType] = useState(useDefaultIssueType());
  const [priority, setPriority] = useState<IssuePriority>("normal");
  const [assignee, setAssignee] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [docs, setDocs] = useState<PickedDoc[]>([]);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function addDocs(versionIds: string[], names: string[]) {
    setPicking(false);
    const fresh = versionIds.map((v, i) => ({ versionId: v, name: names[i] ?? v })).filter((d) => !docs.some((x) => x.versionId === d.versionId));
    setDocs((cur) => [...cur, ...fresh]);
  }

  async function submit() {
    setError(null);
    setBusy(true);
    try {
      const issue = await api.createIssue(project.id, {
        title: title.trim(),
        description: description.trim() || null,
        type,
        priority,
        assigneeUserId: assignee || null,
        dueDate: dueDate || null,
      });
      for (const d of docs) await api.linkIssue(project.id, issue.id, "version", d.versionId);
      onCreated(issue);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <Dialog title={t("newIssue.title")} onClose={onClose} wide>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (title.trim() && !busy) void submit();
        }}
      >
        <label htmlFor="new-issue-title">{t("common:fields.title")}</label>
        <input id="new-issue-title" autoFocus maxLength={300} value={title} onChange={(e) => setTitle(e.target.value)} />
        <label htmlFor="new-issue-description">{t("common:fields.description")}</label>
        <textarea id="new-issue-description" maxLength={10000} value={description} onChange={(e) => setDescription(e.target.value)} />
        <div className="row wrap">
          <div style={{ flex: "1 1 160px", minWidth: 0 }}>
            <label htmlFor="new-issue-type">{t("common:fields.type")}</label>
            <IssueTypeSelect id="new-issue-type" value={type} onChange={setType} />
          </div>
          <div style={{ flex: "1 1 160px", minWidth: 0 }}>
            <label htmlFor="new-issue-priority">{t("common:fields.priority")}</label>
            <select id="new-issue-priority" value={priority} onChange={(e) => setPriority(e.target.value as IssuePriority)}>
              {(["low", "normal", "high", "critical"] as IssuePriority[]).map((p) => (
                <option key={p} value={p}>
                  {label("issuePriority", p)}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="row wrap">
          <div style={{ flex: "1 1 160px", minWidth: 0 }}>
            <label htmlFor="new-issue-assignee">{t("common:fields.assignee")}</label>
            <select id="new-issue-assignee" value={assignee} onChange={(e) => setAssignee(e.target.value)}>
              <option value="">—</option>
              {members?.map((m) => (
                <option key={m.userId} value={m.userId}>
                  {m.name} {m.companyName ? `(${m.companyName})` : ""}
                </option>
              ))}
            </select>
          </div>
          <div style={{ flex: "1 1 160px", minWidth: 0 }}>
            <label htmlFor="new-issue-due">{t("common:fields.dueDate")}</label>
            <input id="new-issue-due" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          </div>
        </div>
        <label>{t("issues.form.documents")}</label>
        <div className="row wrap" style={{ gap: 6 }}>
          {docs.map((d) => (
            <span key={d.versionId} className="badge" data-testid="new-issue-doc">
              📄 {d.name}{" "}
              <button
                type="button"
                className="ghost small"
                aria-label={t("issues.form.removeDocument", { name: d.name })}
                onClick={() => setDocs((cur) => cur.filter((x) => x.versionId !== d.versionId))}
              >
                ✕
              </button>
            </span>
          ))}
          <button type="button" className="small" onClick={() => setPicking(true)}>
            {t("issues.form.addDocument")}
          </button>
        </div>
        <p className="muted small">{t("issues.form.hint")}</p>
        {error && <p className="error">{error}</p>}
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>{t("common:actions.cancel")}</button>
          <button type="submit" className="primary" disabled={!title.trim() || busy}>
            {t("common:actions.create")}
          </button>
        </div>
      </form>
      {picking && <FilePickerDialog exclude={docs.map((d) => d.versionId)} onClose={() => setPicking(false)} onPick={addDocs} />}
    </Dialog>
  );
}
