import { useState, type ReactNode } from "react";
import { Trans, useTranslation } from "react-i18next";
import type {
  CompanyDto,
  MemberDto,
  WorkDetailDto,
  WorkFieldDef,
  WorkFieldValues,
  WorkTypeDto,
} from "@sitekeep/shared";
import { api } from "../../../shared/api/api";
import { worksApi, type LinkInput } from "../../../shared/api/api-works";
import { useLoad, useProject } from "../../../app/context/project";
import { Dialog } from "../../../shared/ui/Dialog";
import { webCapability } from "../../../sdk/capabilities";

/** Prefill from "+ Yeni": what the typed sentence (or a dropped file, "Bırak, kaydet") suggested. */
export interface WorkPrefill {
  title?: string;
  fromCompanyId?: string | null;
  toCompanyIds?: string[];
  /** Field values by key; keys the type does not have are left out. */
  fields?: WorkFieldValues;
  dueDate?: string | null;
  replyRequired?: boolean;
  /** "ilgi" links read from the file. */
  links?: LinkInput[];
  /** Dropped original, attached as "ek" when saved. */
  sourceUploadId?: string | null;
}

/**
 * New work of one of `types`. From "+ Yeni" the type is chosen already (`initialType`) and the
 * title / company come from the typed sentence; "Geri" then returns to the "+ Yeni" dialog.
 */
export function CreateWorkDialog({
  types,
  companies,
  onClose,
  onCreated,
  initialType,
  prefill,
  onBack,
  extra,
}: {
  types: WorkTypeDto[];
  companies: CompanyDto[];
  onClose(): void;
  onCreated(w: WorkDetailDto): void;
  initialType?: WorkTypeDto;
  prefill?: WorkPrefill;
  onBack?(): void;
  /** Shown above the form (e.g. the dropped file and the type select of "Bırak, kaydet"). */
  extra?: ReactNode;
}) {
  // The RFI draft box (AI) is Manage's.
  const RfiDraftBox = webCapability("manage.ui")?.RfiDraftBox;
  const { t } = useTranslation(["works", "common"]);
  const project = useProject();
  const { data: members } = useLoad(() => api.members(project.id), [project.id]);
  const [type, setType] = useState<WorkTypeDto | null>(initialType ?? null);
  const [title, setTitle] = useState(prefill?.title ?? "");
  const [fields, setFields] = useState<WorkFieldValues>(() => (initialType ? prefillFields(initialType, prefill?.fields) : {}));
  const [from, setFrom] = useState<string>(initialType?.settings.incoming ? (prefill?.fromCompanyId ?? "") : "");
  const [to, setTo] = useState<string[]>(prefill?.toCompanyIds ?? []);
  const [cc, setCc] = useState<string[]>([]);
  const [assignee, setAssignee] = useState("");
  const [dueDate, setDueDate] = useState(prefill?.dueDate ?? "");
  const [replyRequired, setReplyRequired] = useState(prefill?.replyRequired ?? false);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function pick(wt: WorkTypeDto) {
    setType(wt);
    setFields(defaultFields(wt));
  }

  async function submit() {
    if (!type) return;
    setBusy(true);
    setMsg(null);
    try {
      const w = await worksApi.create(project.id, {
        typeId: type.id,
        title,
        fields: cleanFields(fields),
        ...(type.settings.incoming ? { fromCompanyId: from || null } : {}),
        toCompanyIds: to,
        ccCompanyIds: cc,
        assigneeUserId: assignee || null,
        dueDate: dueDate || null,
        replyRequired,
        ...(prefill?.links?.length ? { links: prefill.links } : {}),
        ...(prefill?.sourceUploadId ? { sourceUploadId: prefill.sourceUploadId } : {}),
      });
      onCreated(w);
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog title={type ? t("createWork.titleOfType", { type: type.name }) : t("createWork.title")} onClose={onClose} wide={!!type}>
      {!type ? (
        <div className="choices">
          {types.map((wt) => (
            <button key={wt.id} className="choice" style={{ textAlign: "left" }} onClick={() => pick(wt)}>
              <strong>{wt.icon} {wt.name}</strong>
              <span className="muted">{wt.numberingPattern}</span>
            </button>
          ))}
        </div>
      ) : (
        <div>
          {extra}
          <label>{t("createWork.fields.title")}</label>
          <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} />
          {type.settings.incoming && (
            <>
              <label>{t("createWork.fields.fromCompany")}</label>
              <select value={from} onChange={(e) => setFrom(e.target.value)}>
                <option value="">—</option>
                {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </>
          )}
          <label>{type.settings.incoming ? t("createWork.fields.toIncoming") : t("createWork.fields.to")}</label>
          <CompanyChips companies={companies} value={to} onChange={setTo} />
          <label>{t("createWork.fields.cc")}</label>
          <CompanyChips companies={companies} value={cc} onChange={setCc} exclude={to} />
          <div className="row wrap">
            <div style={{ flex: 1, minWidth: 180 }}>
              <label>{t("common:fields.owner")}</label>
              <MemberSelect members={members ?? []} value={assignee} onChange={setAssignee} />
            </div>
            <div style={{ flex: 1, minWidth: 160 }}>
              <label>{t("common:fields.dueDate")}</label>
              <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
            </div>
          </div>
          {type.category === "correspondence" && (
            <label className="check">
              <input type="checkbox" checked={replyRequired} onChange={(e) => setReplyRequired(e.target.checked)} /> {t("createWork.options.replyRequired")}
            </label>
          )}
          {type.category === "rfi" && RfiDraftBox && (
            <RfiDraftBox onDraft={(d) => {
              if (!title.trim()) setTitle(d.title);
              setFields({ ...fields, ...d.fields });
            }} />
          )}
          <FieldInputs defs={type.fields} values={fields} onChange={setFields} />
          <p className="muted small">
            <Trans t={t} i18nKey="createWork.numberHint" values={{ pattern: type.numberingPattern }} components={{ mono: <span className="mono" /> }} />
            {type.category !== "generic" && !prefill?.sourceUploadId && ` · ${t("createWork.attachmentsHint")}`}
          </p>
          {msg && <p className="error">{msg}</p>}
          <div className="dialog-actions">
            <button onClick={() => (onBack && initialType ? onBack() : setType(null))}>{t("common:actions.back")}</button>
            <button className="primary" disabled={!title.trim() || busy} onClick={() => void submit()}>{t("common:actions.save")}</button>
          </div>
        </div>
      )}
    </Dialog>
  );
}

/** Defaults plus prefilled values of fields the type has. */
function prefillFields(t: WorkTypeDto, values: WorkFieldValues | undefined): WorkFieldValues {
  const out = defaultFields(t);
  for (const [k, v] of Object.entries(values ?? {})) {
    if (t.fields.some((f) => f.key === k) && v !== null && v !== "") out[k] = v;
  }
  return out;
}

/** Required list fields start with their first option. */
function defaultFields(t: WorkTypeDto): WorkFieldValues {
  const init: WorkFieldValues = {};
  for (const f of t.fields) if (f.type === "list" && f.required && f.options?.length) init[f.key] = f.options[0]!;
  return init;
}

function cleanFields(v: WorkFieldValues): WorkFieldValues {
  return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== "" && x !== null && x !== undefined));
}

export function FieldInputs({
  defs,
  values,
  onChange,
  disabled,
}: {
  defs: WorkFieldDef[];
  values: WorkFieldValues;
  onChange(v: WorkFieldValues): void;
  disabled?: boolean;
}) {
  const set = (k: string, v: string | number | boolean | null) => onChange({ ...values, [k]: v });
  return (
    <>
      {defs.map((d) => {
        const v = values[d.key];
        const label = `${d.label}${d.required ? " *" : ""}`;
        if (d.type === "boolean") {
          return (
            <label key={d.key} className="check">
              <input type="checkbox" disabled={disabled} checked={v === true} onChange={(e) => set(d.key, e.target.checked)} /> {label}
            </label>
          );
        }
        return (
          <div key={d.key}>
            <label title={d.help}>{label}</label>
            {d.type === "textarea" ? (
              <textarea disabled={disabled} value={String(v ?? "")} onChange={(e) => set(d.key, e.target.value)} />
            ) : d.type === "list" ? (
              <select disabled={disabled} value={String(v ?? "")} onChange={(e) => set(d.key, e.target.value || null)}>
                <option value="">—</option>
                {d.options?.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            ) : (
              <input
                disabled={disabled}
                type={d.type === "date" ? "date" : d.type === "number" ? "number" : "text"}
                placeholder={d.help}
                value={String(v ?? "")}
                onChange={(e) => set(d.key, d.type === "number" ? (e.target.value === "" ? null : Number(e.target.value)) : e.target.value)}
              />
            )}
          </div>
        );
      })}
    </>
  );
}

export function CompanyChips({
  companies,
  value,
  onChange,
  exclude = [],
  disabled,
}: {
  companies: CompanyDto[];
  value: string[];
  onChange(v: string[]): void;
  exclude?: string[];
  disabled?: boolean;
}) {
  const { t } = useTranslation(["works", "common"]);
  return (
    <div className="row wrap">
      {companies.filter((c) => !exclude.includes(c.id)).map((c) => {
        const on = value.includes(c.id);
        return (
          <button
            key={c.id}
            type="button"
            disabled={disabled}
            className={on ? "primary small" : "small"}
            onClick={() => onChange(on ? value.filter((x) => x !== c.id) : [...value, c.id])}
          >
            {c.name}
          </button>
        );
      })}
      {!companies.length && <span className="muted small">{t("createWork.noCompanies")}</span>}
    </div>
  );
}

export function MemberSelect({
  members,
  value,
  onChange,
  disabled,
}: {
  members: MemberDto[];
  value: string;
  onChange(v: string): void;
  disabled?: boolean;
}) {
  return (
    <select disabled={disabled} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">—</option>
      {members.map((m) => <option key={m.userId} value={m.userId}>{m.name}{m.companyName ? ` (${m.companyName})` : ""}</option>)}
    </select>
  );
}
