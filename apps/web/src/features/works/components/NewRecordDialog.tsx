import { useMemo, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import {
  NEW_RECORD_KINDS,
  NEW_RECORD_WORK_TYPE_KEYS,
  matchByName,
  moduleOfNewRecordKind,
  resolveModules,
  type IssuePriority,
  type NewRecordGuess,
  type NewRecordKind,
  type WorkTypeDto,
} from "@sitekeep/shared";
import { api } from "../../../shared/api/api";
import { worksApi } from "../../../shared/api/api-works";
import { draftFromSentence, quickGuess } from "../new-record";
import { WORK_SECTIONS, type NavIconName } from "../../../app/navigation/nav";
import { useLoad, useProject } from "../../../app/context/project";
import { lastDocsFolder } from "../../../shared/lib/remember";
import { labelEntries, useLabel } from "../../../i18n";
import { CreateWorkDialog, type WorkPrefill } from "./CreateWorkDialog";
import { webCapability } from "../../../sdk";
import { webModules } from "../../../app/modules";
import { Dialog } from "../../../shared/ui/Dialog";
import { NavIcon } from "../../../shared/ui/NavIcon";
import { LoadingIndicator } from "../../../shared/ui/LoadingIndicator";

const KIND_ICONS: Record<NewRecordKind, NavIconName> = {
  "gelen-yazi": "letters",
  "giden-yazi": "letters",
  rfi: "rfi",
  submittal: "submittals",
  meeting: "meetings",
  action: "works",
  transmittal: "transmittals",
  issue: "issues",
  form: "forms",
  review: "reviews",
  "param-change": "model",
  upload: "upload",
};

const KIND_HELP = {
  "gelen-yazi": "newRecord.kindHelp.incomingLetter",
  "giden-yazi": "newRecord.kindHelp.outgoingLetter",
  rfi: "newRecord.kindHelp.rfi",
  submittal: "newRecord.kindHelp.submittal",
  meeting: "newRecord.kindHelp.meeting",
  action: "newRecord.kindHelp.action",
  transmittal: "newRecord.kindHelp.transmittal",
  issue: "newRecord.kindHelp.issue",
  form: "newRecord.kindHelp.form",
  review: "newRecord.kindHelp.review",
  "param-change": "newRecord.kindHelp.paramChange",
  upload: "newRecord.kindHelp.upload",
} as const satisfies Record<NewRecordKind, string>;

type Stage =
  | { kind: "choose" }
  | { kind: "work"; type: WorkTypeDto; prefill: WorkPrefill }
  | { kind: "issue"; title: string }
  | { kind: "form"; hint: string }
  | { kind: "file"; file: File };

/**
 * "+ Yeni" — "Ne yapmak istiyorsunuz?": a free-text box and the record types of the modules that
 * are on. A typed sentence preselects the type and fills the title and the company (keyword rules,
 * no AI; phase 2 plugs an AI draft into new-record.ts `draftFromSentence`).
 */
export function NewRecordDialog({
  onClose,
  onCreated,
  preferred = [],
  initialFile,
}: {
  onClose(): void;
  onCreated?(): void;
  /** Kinds of the current view, shown first; one kind is preselected. */
  preferred?: NewRecordKind[];
  /** A file dropped on a list ("Bırak, kaydet"): opens its prefilled record form. */
  initialFile?: File;
}) {
  const { t } = useTranslation(["works", "common"]);
  const label = useLabel();
  const project = useProject();
  const navigate = useNavigate();
  // "Bırak, kaydet" (a record from a dropped file) is Manage's.
  const manage = webCapability("manage.ui");
  const modules = project.modules ?? resolveModules(null);
  const { data: types } = useLoad(() => worksApi.creatableTypes(project.id), [project.id]);
  const { data: companies } = useLoad(() => api.companies(), []);
  const [text, setText] = useState("");
  const [stage, setStage] = useState<Stage>(initialFile ? { kind: "file", file: initialFile } : { kind: "choose" });
  const [busy, setBusy] = useState(false);

  const ctx = useMemo(() => ({ projectId: project.id, companies: companies ?? [] }), [project.id, companies]);
  const guess = useMemo(() => (text.trim() ? quickGuess(text, ctx) : null), [text, ctx]);
  const typeOf = (k: NewRecordKind) => {
    const key = NEW_RECORD_WORK_TYPE_KEYS[k];
    return key ? types?.find((t) => t.key === key) : undefined;
  };
  const available = (k: NewRecordKind) => {
    const m = moduleOfNewRecordKind(k);
    if (m && !modules[m]) return false;
    if (k === "form" && !webCapability("field.newFormDialog")) return false; // forms are the Field module's
    if (k === "param-change" && !webModules.some((m) => m.id === "coordinate")) return false; // Coordinate's
    return NEW_RECORD_WORK_TYPE_KEYS[k] ? !!typeOf(k) : true;
  };
  const kinds = NEW_RECORD_KINDS.filter(available);
  const ordered = [...kinds.filter((k) => preferred.includes(k)), ...kinds.filter((k) => !preferred.includes(k))];
  const builtInKeys = new Set(Object.values(NEW_RECORD_WORK_TYPE_KEYS));
  const otherTypes = types?.filter((t) => !builtInKeys.has(t.key)) ?? [];
  const preferredOne = preferred.filter(available).length === 1 ? preferred.filter(available)[0]! : null;
  const selected: NewRecordKind | null = (guess?.kind && available(guess.kind) ? guess.kind : null) ?? (text.trim() ? null : preferredOne);
  const company = guess?.companyId ? companies?.find((c) => c.id === guess.companyId) : undefined;

  function docsUrl(param: string) {
    const fid = lastDocsFolder(project.id);
    return `/projects/${project.id}/files${fid ? `/${fid}` : ""}?${param}=1`;
  }

  function go(kind: NewRecordKind, g: NewRecordGuess | null) {
    const title = g?.title ?? "";
    if (NEW_RECORD_WORK_TYPE_KEYS[kind]) {
      const type = typeOf(kind);
      if (!type) return;
      const prefill: WorkPrefill = { title };
      if (g?.companyId) {
        if (type.settings.incoming && g.companyRole !== "to") prefill.fromCompanyId = g.companyId;
        else if (!type.settings.incoming) prefill.toCompanyIds = [g.companyId];
      }
      setStage({ kind: "work", type, prefill });
      return;
    }
    switch (kind) {
      case "issue":
        setStage({ kind: "issue", title });
        return;
      case "form":
        setStage({ kind: "form", hint: text });
        return;
      case "review":
        onClose();
        navigate(docsUrl("inceleme"));
        return;
      case "upload":
        onClose();
        navigate(docsUrl("yukle"));
        return;
      case "param-change":
        onClose();
        navigate(`/projects/${project.id}/param-changes?yeni=1`);
        return;
    }
  }

  /** Enter / "Devam" goes on with the preselected type; a tile goes on with its own type. */
  async function proceed(kind = selected) {
    if (!kind) return;
    setBusy(true);
    try {
      // A type picked by hand keeps the title and company read from the sentence.
      go(kind, text.trim() ? await draftFromSentence(text, ctx) : null);
    } finally {
      setBusy(false);
    }
  }

  if (stage.kind === "work")
    return (
      <CreateWorkDialog
        types={[stage.type]}
        companies={companies ?? []}
        initialType={stage.type}
        prefill={stage.prefill}
        onBack={() => setStage({ kind: "choose" })}
        onClose={onClose}
        onCreated={(w) => {
          onClose();
          onCreated?.();
          const section = WORK_SECTIONS.find((s) => s.categories.includes(w.category));
          navigate(`/projects/${project.id}/works/${w.id}${section ? `?bolum=${section.key}` : ""}`);
        }}
      />
    );
  if (stage.kind === "file" && manage)
    return <manage.FileRecordDialog file={stage.file} onBack={() => setStage({ kind: "choose" })} onClose={onClose} onCreated={onCreated} />;
  if (stage.kind === "issue")
    return (
      <NewIssueDialog
        initialTitle={stage.title}
        onBack={() => setStage({ kind: "choose" })}
        onClose={onClose}
        onCreated={(id) => {
          onClose();
          onCreated?.();
          navigate(`/projects/${project.id}/issues/${id}`);
        }}
      />
    );
  if (stage.kind === "form")
    return (
      <FormStage
        hint={stage.hint}
        onClose={onClose}
        onCreated={(id) => {
          onClose();
          onCreated?.();
          navigate(`/projects/${project.id}/forms/${id}`);
        }}
      />
    );

  return (
    <Dialog title={t("newRecord.title")} onClose={onClose} wide>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void proceed();
        }}
      >
        <input
          autoFocus
          className="new-record-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={t("newRecord.placeholder")}
          aria-label={t("newRecord.inputLabel")}
        />
        <p className="muted small new-record-hint" aria-live="polite">
          {guess?.kind && available(guess.kind) ? (
            <Trans
              t={t}
              i18nKey="newRecord.suggestion"
              values={{
                kind: label("newRecordKind", guess.kind),
                details: [
                  company &&
                    (guess.companyRole === "from"
                      ? t("newRecord.suggestionFrom", { company: company.name })
                      : t("newRecord.suggestionTo", { company: company.name })),
                  guess.title && t("newRecord.suggestionTitle", { title: guess.title }),
                ]
                  .filter(Boolean)
                  .map((d) => ` · ${d}`)
                  .join(""),
              }}
              components={{ b: <strong /> }}
            />
          ) : text.trim() ? (
            t("newRecord.notUnderstood")
          ) : (
            t("newRecord.hint")
          )}
        </p>
        {manage && <manage.FileDropZone onFile={(file) => setStage({ kind: "file", file })} />}
        {!types && <p className="muted small">{t("newRecord.loadingTypes")}</p>}
        <div className="new-record-grid" role="list" hidden={!types}>
          {ordered.map((k) => (
            <button
              type="button"
              role="listitem"
              key={k}
              className={`choice new-record-tile${selected === k ? " selected" : ""}`}
              onClick={() => void proceed(k)}
              aria-pressed={selected === k}
            >
              <strong>
                <NavIcon name={KIND_ICONS[k]} size={16} /> {label("newRecordKind", k)}
              </strong>
              <span className="muted">{t(KIND_HELP[k])}</span>
            </button>
          ))}
          {otherTypes.map((t) => (
            <button
              type="button"
              role="listitem"
              key={t.id}
              className="choice new-record-tile"
              onClick={() => setStage({ kind: "work", type: t, prefill: { title: guess?.title ?? text.trim() } })}
            >
              <strong>
                {t.icon} {t.name}
              </strong>
              <span className="muted mono">{t.numberingPattern}</span>
            </button>
          ))}
        </div>
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>
            {t("common:actions.cancel")}
          </button>
          <button type="submit" className="primary" disabled={!selected || busy}>
            {t("newRecord.actions.continue")}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

/** A new issue without a model view (title, description, priority, assignee, due date). */
export function NewIssueDialog({
  initialTitle = "",
  onClose,
  onCreated,
  onBack,
}: {
  initialTitle?: string;
  onClose(): void;
  onCreated(id: string): void;
  onBack?(): void;
}) {
  const { t } = useTranslation(["works", "common"]);
  const project = useProject();
  const { data: members } = useLoad(() => api.members(project.id), [project.id]);
  const [title, setTitle] = useState(initialTitle);
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<IssuePriority>("normal");
  const [assignee, setAssignee] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      const issue = await api.createIssue(project.id, {
        title: title.trim(),
        description: description.trim() || null,
        priority,
        assigneeUserId: assignee || null,
        dueDate: dueDate || null,
      });
      onCreated(issue.id);
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog title={t("newIssue.title")} onClose={onClose}>
      <label>{t("newIssue.fields.title")}</label>
      <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} />
      <label>{t("common:fields.description")}</label>
      <textarea value={description} onChange={(e) => setDescription(e.target.value)} />
      <div className="row wrap">
        <div style={{ flex: 1, minWidth: 140 }}>
          <label>{t("common:fields.priority")}</label>
          <select value={priority} onChange={(e) => setPriority(e.target.value as IssuePriority)}>
            {labelEntries("issuePriority").map(([p, text]) => (
              <option key={p} value={p}>
                {text}
              </option>
            ))}
          </select>
        </div>
        <div style={{ flex: 1, minWidth: 140 }}>
          <label>{t("common:fields.dueDate")}</label>
          <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
        </div>
      </div>
      <label>{t("common:fields.assignee")}</label>
      <select value={assignee} onChange={(e) => setAssignee(e.target.value)}>
        <option value="">—</option>
        {members?.map((m) => (
          <option key={m.userId} value={m.userId}>
            {m.name}
            {m.companyName ? ` (${m.companyName})` : ""}
          </option>
        ))}
      </select>
      <p className="muted small">{t("newIssue.pinHint")}</p>
      {msg && <p className="error">{msg}</p>}
      <div className="dialog-actions">
        {onBack && <button onClick={onBack}>{t("common:actions.back")}</button>}
        <button className="primary" disabled={!title.trim() || busy} onClick={() => void save()}>
          {t("common:actions.save")}
        </button>
      </div>
    </Dialog>
  );
}

/** "Form (şablon seçin)": the Formlar page's dialog; a template named in the sentence is preselected. */
function FormStage({ hint, onClose, onCreated }: { hint: string; onClose(): void; onCreated(id: string): void }) {
  const { t } = useTranslation(["works", "common"]);
  const project = useProject();
  const { data: templates, error } = useLoad(() => api.formTemplates(project.id), [project.id]);
  const { data: locations } = useLoad(() => api.locations(project.id).catch(() => []), [project.id]);
  if (error)
    return (
      <Dialog title={t("newForm.title")} onClose={onClose}>
        <p className="error">{error}</p>
      </Dialog>
    );
  if (!templates)
    return (
      <Dialog title={t("newForm.title")} onClose={onClose}>
        <LoadingIndicator />
      </Dialog>
    );
  if (!templates.length)
    return (
      <Dialog title={t("newForm.title")} onClose={onClose}>
        <p>{t("newForm.noTemplates")}</p>
      </Dialog>
    );
  const NewFormDialog = webCapability("field.newFormDialog")!;
  return (
    <NewFormDialog
      templates={templates}
      locations={locations ?? []}
      initialTemplateId={matchByName(hint, templates)?.id}
      onClose={onClose}
      onCreated={onCreated}
    />
  );
}
