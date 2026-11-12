import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  CompanyDto,
  MemberDto,
  WorkDetailDto,
  WorkFieldValues,
  WorkLinkKind,
  WorkTypeDto,
} from "@sitekeep/shared";
import { api, dataLocale, intlLocale } from "../../../shared/api/api";
import { documentsApi } from "../../documents/api";
import { worksApi, type LinkInput } from "../../../shared/api/api-works";
import { useLoad, useProject } from "../../../app/context/project";
import { Dialog } from "../../../shared/ui/Dialog";
import { CompanyChips, FieldInputs, MemberSelect } from "./CreateWorkDialog";

export function SendDialog({
  w,
  onClose,
  onSend,
}: {
  w: WorkDetailDto;
  onClose(): void;
  onSend(s: { channel: string; reference?: string | null; note?: string | null }): void;
}) {
  const { t } = useTranslation(["works", "common"]);
  const { data: channels } = useLoad(() => worksApi.channels(), []);
  const [channel, setChannel] = useState("cde");
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");
  const c = channels?.find((x) => x.id === channel);
  const signed = w.links.some((l) => l.role === "ek" && l.meta.signed);
  return (
    <Dialog title={t("send.title", { number: w.number })} onClose={onClose}>
      <div className="choices">
        {channels?.map((x) => (
          <label key={x.id} className={`choice${channel === x.id ? " selected" : ""}`}>
            <input type="radio" checked={channel === x.id} onChange={() => setChannel(x.id)} />
            <strong>{x.label}</strong>
            <span className="muted">{x.description}</span>
          </label>
        ))}
      </div>
      {c?.manual && (
        <>
          <label>{t("send.fields.reference")}</label>
          <input value={reference} onChange={(e) => setReference(e.target.value)} placeholder={t("send.referencePlaceholder")} />
        </>
      )}
      <label>{t("send.fields.note")}</label>
      <input value={note} onChange={(e) => setNote(e.target.value)} />
      {c?.requiresSignedPdf && !signed && (
        <p className="notice small">{t("send.signedRequired")}</p>
      )}
      {w.category === "transmittal" && (
        <p className="muted small">{t("send.transmittalHint")}</p>
      )}
      {w.letter?.pdf && (
        <p className="muted small">
          {t("send.letterHint")}
        </p>
      )}
      <div className="dialog-actions">
        <button onClick={onClose}>{t("common:actions.cancel")}</button>
        <button className="primary" onClick={() => onSend({ channel, reference: reference || null, note: note || null })}>
          {t("common:actions.send")}
        </button>
      </div>
    </Dialog>
  );
}

/** Picks the current version of files the caller can see (versions are pinned when added). */
export function FilePickerDialog({
  onClose,
  onPick,
  exclude,
}: {
  onClose(): void;
  onPick(versionIds: string[]): void;
  exclude: string[];
}) {
  const { t } = useTranslation(["works", "common"]);
  const project = useProject();
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const { data, error } = useLoad(() => documentsApi.search(project.id, { q: query }), [project.id, query]);
  useEffect(() => {
    const timer = setTimeout(() => setQuery(q.trim()), 300);
    return () => clearTimeout(timer);
  }, [q]);
  return (
    <Dialog title={t("filePicker.title")} onClose={onClose} wide>
      <input autoFocus placeholder={t("filePicker.placeholder")} value={q} onChange={(e) => setQ(e.target.value)} />
      {error && <p className="error">{error}</p>}
      <div style={{ maxHeight: 380, overflow: "auto", marginTop: 8 }}>
        <table className="phone-cards">
          <tbody>
            {data?.results
              .filter((f) => !exclude.includes(f.latest.id))
              .map((f) => {
                const on = picked.includes(f.latest.id);
                return (
                  <tr
                    key={f.id}
                    className={`clickable${on ? " selected" : ""}`}
                    onClick={() => setPicked(on ? picked.filter((x) => x !== f.latest.id) : [...picked, f.latest.id])}
                  >
                    <td className="pc-inline" style={{ width: 30 }}>
                      <input type="checkbox" readOnly checked={on} style={{ width: "auto" }} />
                    </td>
                    <td className="pc-title">
                      {f.name}
                      <div className="muted small">{f.folderPath}</div>
                    </td>
                    <td className="muted small" data-label={t("filePicker.columns.version")} style={{ width: 60 }}>
                      V{f.currentVersion}
                    </td>
                  </tr>
                );
              })}
          </tbody>
        </table>
      </div>
      <div className="dialog-actions">
        <span className="muted small">{t("filePicker.selected", { count: picked.length })}</span>
        <div className="spacer" />
        <button onClick={onClose}>{t("common:actions.cancel")}</button>
        <button className="primary" disabled={!picked.length} onClick={() => onPick(picked)}>
          {t("common:actions.add")}
        </button>
      </div>
    </Dialog>
  );
}

export function LinkPickerDialog({
  workId,
  onClose,
  onPick,
}: {
  workId: string;
  onClose(): void;
  onPick(l: LinkInput): void;
}) {
  const { t } = useTranslation(["works", "common"]);
  const project = useProject();
  const [kind, setKind] = useState<WorkLinkKind>("work");
  const [q, setQ] = useState("");
  const { data: items } = useLoad(async (): Promise<{ id: string; label: string }[]> => {
    if (kind === "work")
      return (await worksApi.list(project.id))
        .filter((w) => w.id !== workId)
        .map((w) => ({ id: w.id, label: `${w.number} · ${w.title}` }));
    if (kind === "issue") return (await api.issues(project.id)).map((i) => ({ id: i.id, label: `#${i.number} ${i.title}` }));
    return (await api.reviews(project.id)).map((r) => ({ id: r.id, label: `#${r.number} ${r.name}` }));
  }, [project.id, kind]);
  const shown = items?.filter((i) => i.label.toLocaleLowerCase(dataLocale()).includes(q.toLocaleLowerCase(dataLocale()))) ?? [];
  return (
    <Dialog title={t("linkPicker.title")} onClose={onClose}>
      <div className="row">
        {(
          [
            ["work", "linkPicker.options.work"],
            ["issue", "linkPicker.options.issue"],
            ["review", "linkPicker.options.review"],
          ] as const
        ).map(([k, label]) => (
          <button key={k} className={kind === k ? "primary small" : "small"} onClick={() => setKind(k)}>
            {t(label)}
          </button>
        ))}
        <input placeholder={t("linkPicker.placeholder")} value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div style={{ maxHeight: 360, overflow: "auto", marginTop: 8 }}>
        {shown.map((i) => (
          <div key={i.id} className="bell-item" onClick={() => onPick({ kind, targetId: i.id, role: "ilgi" })}>
            {i.label}
          </div>
        ))}
        {items && !shown.length && <p className="muted small">{t("linkPicker.empty")}</p>}
      </div>
    </Dialog>
  );
}

export function EditDialog({
  w,
  type,
  companies,
  members,
  onClose,
  onSave,
}: {
  w: WorkDetailDto;
  type: WorkTypeDto;
  companies: CompanyDto[];
  members: MemberDto[];
  onClose(): void;
  onSave(patch: Parameters<typeof worksApi.update>[2]): void;
}) {
  const { t } = useTranslation(["works", "common"]);
  const draft = w.status === "taslak";
  const [title, setTitle] = useState(w.title);
  const [fields, setFields] = useState<WorkFieldValues>(w.fields);
  const [to, setTo] = useState(w.toCompanyIds);
  const [cc, setCc] = useState(w.ccCompanyIds);
  const [assignee, setAssignee] = useState(w.assigneeUserId ?? "");
  const [dueDate, setDueDate] = useState(w.dueDate ?? "");
  const [replyRequired, setReplyRequired] = useState(w.replyRequired);
  return (
    <Dialog title={t("editWork.title", { number: w.number })} onClose={onClose} wide>
      <label>{t("editWork.fields.title")}</label>
      <input value={title} onChange={(e) => setTitle(e.target.value)} />
      <label>{t("editWork.fields.to")}</label>
      <CompanyChips companies={companies} value={to} onChange={setTo} disabled={!draft} />
      <label>{t("editWork.fields.cc")}</label>
      <CompanyChips companies={companies} value={cc} onChange={setCc} exclude={to} disabled={!draft} />
      {!draft && <p className="muted small">{t("editWork.sentRecipientsLocked")}</p>}
      <div className="row">
        <div style={{ flex: 1 }}>
          <label>{t("common:fields.owner")}</label>
          <MemberSelect members={members} value={assignee} onChange={setAssignee} />
        </div>
        <div style={{ flex: 1 }}>
          <label>{t("common:fields.dueDate")}</label>
          <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
        </div>
      </div>
      {type.category === "correspondence" && (
        <label className="check">
          <input type="checkbox" checked={replyRequired} onChange={(e) => setReplyRequired(e.target.checked)} /> {t("createWork.options.replyRequired")}
        </label>
      )}
      <FieldInputs defs={type.fields} values={fields} onChange={setFields} />
      <div className="dialog-actions">
        <button onClick={onClose}>{t("common:actions.cancel")}</button>
        <button
          className="primary"
          onClick={() =>
            onSave({
              title,
              fields: Object.fromEntries(
                type.fields.map((f) => [f.key, fields[f.key] === "" || fields[f.key] === undefined ? null : fields[f.key]!]),
              ),
              ...(draft ? { toCompanyIds: to, ccCompanyIds: cc } : {}),
              assigneeUserId: assignee || null,
              dueDate: dueDate || null,
              replyRequired,
            })
          }
        >
          {t("common:actions.save")}
        </button>
      </div>
    </Dialog>
  );
}
