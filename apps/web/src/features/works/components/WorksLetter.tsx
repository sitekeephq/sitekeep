/**
 * "Yazı" section of correspondence works: official letter data (languages, recipient, texts,
 * translations), PDF preview, e-mail (.eml / SMTP), archive / cancel / reopen / delete.
 * Ported from the Odoo module sevend_yazismalar (docs/features/YAZISMALAR.md).
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  LETTER_LANGS,
  LETTER_LANGUAGE_LABELS,
  LETTER_LAYOUTS,
  letterLanguages,
  type CompanyDto,
  type LetterData,
  type LetterLang,
  type LetterTranslation,
  type WorkDetailDto,
} from "@sitekeep/shared";
import { formatDate } from "../../../shared/api/api";
import { worksApi } from "../../../shared/api/api-works";
import { useLabel } from "../../../i18n";
import { useAsk } from "../../../shared/ui/Ask";
import { Dialog } from "../../../shared/ui/Dialog";
import { useProject } from "../../../app/context/project";
import { AiTaskButton } from "../../../shared/ai/AiTaskButton";

export function LetterPanel({
  w,
  incoming,
  companies,
  act,
  onDeleted,
}: {
  w: WorkDetailDto;
  /** Incoming registration (no PDF, no e-mail). */
  incoming: boolean;
  companies: CompanyDto[];
  act(fn: () => Promise<WorkDetailDto>): Promise<WorkDetailDto | null>;
  onDeleted(): void;
}) {
  const { t } = useTranslation(["works", "common"]);
  const label = useLabel();
  const { confirm } = useAsk();
  const project = useProject();
  const [editing, setEditing] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const info = w.letter;
  if (!info) return null;
  const l = info.data;
  const langs = letterLanguages(l);
  const sent = w.status !== "taslak" && !!w.sentAt;
  const pid = project.id;

  async function run(fn: () => Promise<unknown>) {
    setMsg(null);
    try {
      await fn();
    } catch (e) {
      setMsg((e as Error).message);
    }
  }

  return (
    <div className="card" style={{ marginTop: 12, padding: 10 }}>
      <div className="row">
        <h3 style={{ margin: 0 }}>{t("letter.title")}</h3>
        <div className="spacer" />
        {info.canEditLetter && (
          <button className="small" onClick={() => setEditing(true)}>
            {t("letter.actions.edit")}
          </button>
        )}
      </div>
      <table className="props-table" style={{ marginTop: 6 }}>
        <tbody>
          <tr>
            <td>{t("letter.fields.language")}</td>
            <td>
              {langs.map((x) => LETTER_LANGUAGE_LABELS[x]).join(" + ")}
              {langs.length > 1 && ` · ${label("letterLayout", l.layout)}`}
            </td>
          </tr>
          <tr>
            <td>{t("letter.fields.recipient")}</td>
            <td style={{ whiteSpace: "pre-wrap" }}>
              {l.recipient.name || "—"}
              {l.recipient.address && `\n${l.recipient.address}`}
              {l.recipient.email && <div className="muted">{l.recipient.email}</div>}
            </td>
          </tr>
          {l.ccEmails.length > 0 && (
            <tr>
              <td>CC</td>
              <td>{l.ccEmails.join(", ")}</td>
            </tr>
          )}
          {(l.signer.name || l.signer.title) && (
            <tr>
              <td>{t("letter.fields.signature")}</td>
              <td>{[l.signer.name, l.signer.title].filter(Boolean).join(" · ")}</td>
            </tr>
          )}
          {!incoming && (
            <tr>
              <td>{t("common:fields.email")}</td>
              <td>
                {l.mailSentAt ? (
                  <span className="badge ok">{t("letter.badges.mailSent", { date: formatDate(l.mailSentAt) })}</span>
                ) : sent ? (
                  <span className="badge warn">{t("letter.badges.mailNotSent")}</span>
                ) : (
                  <span className="muted">{t("letter.mailPreparedOnSend")}</span>
                )}
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {l.body.trim() && (
        <div className="small" style={{ whiteSpace: "pre-wrap", marginTop: 6, maxHeight: 120, overflow: "auto" }}>
          {l.body}
        </div>
      )}

      <div className="row wrap" style={{ marginTop: 8 }}>
        {info.pdf && (
          <a className="btn small" href={worksApi.letterPdfUrl(pid, w.id)} target="_blank" rel="noreferrer">
            {t("letter.actions.previewPdf")}
          </a>
        )}
        {info.pdf && w.canEdit && (
          <a
            className="btn small"
            href={worksApi.letterEmlUrl(pid, w.id)}
            title={l.recipient.email ? t("letter.emlHint") : t("letter.emlNeedsEmail")}
            onClick={(e) => {
              if (!l.recipient.email) {
                e.preventDefault();
                setMsg(t("letter.errors.noRecipientEmail"));
              }
            }}
          >
            {t("letter.actions.prepareEml")}
          </a>
        )}
        {info.pdf && w.canEdit && sent && !l.mailSentAt && info.smtp && (
          <button className="small" onClick={() => void act(() => worksApi.mailLetter(pid, w.id))}>
            {t("letter.actions.sendMail")}
          </button>
        )}
        {info.pdf && w.canEdit && sent && !l.mailSentAt && (
          <button className="small" onClick={() => void act(() => worksApi.markMailed(pid, w.id))}>
            {t("letter.actions.markMailed")}
          </button>
        )}
        {info.canArchive && (
          <button className="small" onClick={() => void act(() => worksApi.archive(pid, w.id))}>
            {t("letter.actions.archive")}
          </button>
        )}
        {info.canCancel && (
          <button
            className="small danger"
            onClick={() =>
              void confirm({
                title: t("letter.cancel.title"),
                message: t("letter.cancel.confirm", { number: w.number }),
                confirmLabel: t("letter.actions.cancel"),
                danger: true,
              }).then((ok) => {
                if (ok)
                  return act(async () => {
                    await worksApi.cancel(pid, w.id);
                    return worksApi.get(pid, w.id);
                  });
              })
            }
          >
            {t("letter.actions.cancel")}
          </button>
        )}
        {info.canReopen && (
          <button className="small" onClick={() => void act(() => worksApi.reopen(pid, w.id))}>
            {t("letter.actions.reopen")}
          </button>
        )}
        {info.canDelete && (
          <button
            className="small danger"
            onClick={() =>
              void confirm({
                title: t("letter.delete.title"),
                message: t("letter.delete.confirm", { number: w.number }),
                confirmLabel: t("common:actions.delete"),
                danger: true,
              }).then((ok) => {
                if (ok)
                  return run(async () => {
                    await worksApi.remove(pid, w.id);
                    onDeleted();
                  });
              })
            }
          >
            {t("common:actions.delete")}
          </button>
        )}
      </div>
      {msg && <p className="error small">{msg}</p>}
      {editing && (
        <LetterDialog
          w={w}
          incoming={incoming}
          companies={companies}
          onClose={() => setEditing(false)}
          onSave={async (patch) => {
            const d = await act(() => worksApi.saveLetter(pid, w.id, patch));
            if (d) setEditing(false);
          }}
        />
      )}
    </div>
  );
}

type Tab = "genel" | "metin" | "ceviri";

function LetterDialog({
  w,
  incoming,
  companies,
  onClose,
  onSave,
}: {
  w: WorkDetailDto;
  incoming: boolean;
  companies: CompanyDto[];
  onClose(): void;
  onSave(l: Omit<LetterData, "mailSentAt">): Promise<void>;
}) {
  const { t } = useTranslation(["works", "common"]);
  const label = useLabel();
  const project = useProject();
  const [l, setL] = useState<LetterData>(w.letter!.data);
  const [tab, setTab] = useState<Tab>("genel");
  const [cc, setCc] = useState(l.ccEmails.join(", "));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const foreign = letterLanguages(l).filter((x): x is Exclude<LetterLang, "tr"> => x !== "tr");
  const [lang, setLang] = useState<LetterLang | null>(foreign[0] ?? null);
  const activeLang = lang && foreign.includes(lang as Exclude<LetterLang, "tr">) ? lang : (foreign[0] ?? null);
  const counterpart = incoming ? w.fromCompanyId : w.toCompanyIds[0];
  const company = companies.find((c) => c.id === counterpart);

  const set = (p: Partial<LetterData>) => setL({ ...l, ...p });
  const setT = (lg: LetterLang, p: Partial<LetterTranslation>) =>
    setL({ ...l, translations: { ...l.translations, [lg]: { ...(l.translations[lg] ?? {}), ...p } } });

  /** Suggested translation (local model or a connected AI client) goes into the form; the user saves. */
  function applyTranslation(lg: LetterLang, s: Partial<LetterTranslation>) {
    const cur = l.translations[lg] ?? {};
    setT(lg, {
      subject: s.subject || cur.subject,
      body: s.body || cur.body,
      body2: s.body2 || cur.body2,
      signerTitle: s.signerTitle || cur.signerTitle,
    });
    setMsg(t("letter.messages.suggestionApplied"));
  }

  async function translate(lg: LetterLang) {
    setBusy(true);
    setMsg(null);
    try {
      applyTranslation(lg, await worksApi.translateLetter(project.id, w.id, lg));
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      const { mailSentAt: _m, ...rest } = l;
      await onSave({
        ...rest,
        ccEmails: cc
          .split(/[,;\s]+/)
          .map((x) => x.trim())
          .filter(Boolean),
      });
    } finally {
      setBusy(false);
    }
  }

  const tabs: [Tab, string][] = [
    ["genel", t("letter.tabs.general")],
    ["metin", t("letter.tabs.text")],
    ["ceviri", foreign.length ? t("letter.tabs.translationsCount", { count: foreign.length }) : t("letter.tabs.translations")],
  ];

  return (
    <Dialog title={t("letter.dialogTitle", { number: w.number })} onClose={onClose} wide>
      <div className="row wrap" style={{ marginBottom: 8 }}>
        {tabs.map(([k, text]) => (
          <button key={k} className={tab === k ? "primary small" : "small"} onClick={() => setTab(k)}>
            {text}
          </button>
        ))}
      </div>

      {tab === "genel" && (
        <div>
          <div className="row">
            <div style={{ flex: 1 }}>
              <label>{t("letter.fields.letterLanguage")}</label>
              <select
                value={l.language}
                onChange={(e) => {
                  const language = e.target.value as LetterLang;
                  set({ language, secondaryLanguage: l.secondaryLanguage === language ? null : l.secondaryLanguage });
                }}
              >
                {LETTER_LANGS.map((x) => (
                  <option key={x} value={x}>
                    {LETTER_LANGUAGE_LABELS[x]}
                  </option>
                ))}
              </select>
            </div>
            <div style={{ flex: 1 }}>
              <label>{t("letter.fields.secondLanguage")}</label>
              <select
                value={l.secondaryLanguage ?? ""}
                onChange={(e) => set({ secondaryLanguage: (e.target.value || null) as LetterLang | null })}
              >
                <option value="">{t("letter.options.singleLanguage")}</option>
                {LETTER_LANGS.filter((x) => x !== l.language).map((x) => (
                  <option key={x} value={x}>
                    {LETTER_LANGUAGE_LABELS[x]}
                  </option>
                ))}
              </select>
            </div>
            <div style={{ flex: 1 }}>
              <label>{t("letter.fields.layout")}</label>
              <select value={l.layout} disabled={!l.secondaryLanguage} onChange={(e) => set({ layout: e.target.value as LetterData["layout"] })}>
                {LETTER_LAYOUTS.map((x) => (
                  <option key={x} value={x}>
                    {label("letterLayout", x)}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <p className="muted small" style={{ margin: "6px 0 0" }}>
            {t("letter.languageHint")}
          </p>

          <div className="row" style={{ marginTop: 6 }}>
            <h3 style={{ margin: "8px 0 0" }}>{t("letter.fields.recipient")}</h3>
            <div className="spacer" />
            <button
              type="button"
              className="small"
              disabled={!company}
              title={company ? t("letter.fillFromCompanyHint", { company: company.name }) : t("letter.noCounterpart")}
              onClick={() =>
                company && set({ recipient: { name: company.name, address: company.address ?? "", email: company.email ?? "" } })
              }
            >
              {t("letter.actions.fillFromCompany")}
            </button>
          </div>
          <label>{t("letter.fields.recipientName")}</label>
          <input value={l.recipient.name} onChange={(e) => set({ recipient: { ...l.recipient, name: e.target.value } })} />
          <label>{t("letter.fields.address")}</label>
          <textarea rows={3} value={l.recipient.address} onChange={(e) => set({ recipient: { ...l.recipient, address: e.target.value } })} />
          <div className="row">
            <div style={{ flex: 1 }}>
              <label>{t("common:fields.email")}</label>
              <input type="email" value={l.recipient.email} onChange={(e) => set({ recipient: { ...l.recipient, email: e.target.value } })} />
            </div>
            <div style={{ flex: 1 }}>
              <label>{t("letter.fields.ccEmails")}</label>
              <input value={cc} onChange={(e) => setCc(e.target.value)} placeholder={t("letter.ccPlaceholder")} />
            </div>
          </div>

          <h3 style={{ margin: "12px 0 0" }}>{t("letter.fields.signature")}</h3>
          <div className="row">
            <div style={{ flex: 1 }}>
              <label>{t("letter.fields.signerName")}</label>
              <input value={l.signer.name} onChange={(e) => set({ signer: { ...l.signer, name: e.target.value } })} />
            </div>
            <div style={{ flex: 1 }}>
              <label>{t("letter.fields.signerTitleTr")}</label>
              <input value={l.signer.title} onChange={(e) => set({ signer: { ...l.signer, title: e.target.value } })} />
            </div>
          </div>
        </div>
      )}

      {tab === "metin" && (
        <div>
          <label>{t("letter.fields.referenceTextLong")}</label>
          <textarea rows={2} value={l.referenceText} onChange={(e) => set({ referenceText: e.target.value })} />
          <label>{t("letter.fields.body")}</label>
          <textarea rows={10} value={l.body} onChange={(e) => set({ body: e.target.value })} />
          <label>{t("letter.fields.body2Long")}</label>
          <textarea rows={4} value={l.body2} onChange={(e) => set({ body2: e.target.value })} />
          <p className="muted small">{t("letter.formattingHint")}</p>
        </div>
      )}

      {tab === "ceviri" && (
        <div>
          {!foreign.length ? (
            <p className="muted">{t("letter.turkishOnly")}</p>
          ) : (
            <>
              <div className="row wrap">
                {foreign.map((x) => (
                  <button key={x} className={activeLang === x ? "primary small" : "small"} onClick={() => setLang(x)}>
                    {LETTER_LANGUAGE_LABELS[x]}
                  </button>
                ))}
                <div className="spacer" />
                {activeLang && (
                  <button className="small" disabled={busy} onClick={() => void translate(activeLang)}>
                    {busy ? t("letter.status.translating") : t("letter.actions.translateWithAi")}
                  </button>
                )}
                {activeLang && (
                  <AiTaskButton
                    projectId={project.id}
                    kind="letter_translate"
                    input={{ workId: w.id, language: activeLang }}
                    small
                    disabled={busy}
                    onResult={(r) => applyTranslation(activeLang, r as Partial<LetterTranslation>)}
                  />
                )}
              </div>
              {activeLang && (
                <TranslationForm
                  key={activeLang}
                  value={l.translations[activeLang] ?? {}}
                  title={w.title}
                  base={l}
                  onChange={(p) => setT(activeLang, p)}
                />
              )}
            </>
          )}
        </div>
      )}

      {msg && <p className="small muted">{msg}</p>}
      <div className="dialog-actions">
        <button onClick={onClose}>{t("common:actions.cancel")}</button>
        <button className="primary" disabled={busy} onClick={() => void save()}>
          {t("common:actions.save")}
        </button>
      </div>
    </Dialog>
  );
}

function TranslationForm({
  value,
  title,
  base,
  onChange,
}: {
  value: LetterTranslation;
  title: string;
  base: LetterData;
  onChange(p: Partial<LetterTranslation>): void;
}) {
  const { t } = useTranslation(["works", "common"]);
  return (
    <div>
      <label>{t("letter.fields.subjectRequired")}</label>
      <input value={value.subject ?? ""} placeholder={title} onChange={(e) => onChange({ subject: e.target.value })} />
      <label>{base.body.trim() ? t("letter.fields.bodyRequired") : t("letter.fields.body")}</label>
      <textarea rows={8} value={value.body ?? ""} placeholder={base.body} onChange={(e) => onChange({ body: e.target.value })} />
      <label>{t("letter.fields.body2")}</label>
      <textarea rows={3} value={value.body2 ?? ""} placeholder={base.body2} onChange={(e) => onChange({ body2: e.target.value })} />
      <div className="row">
        <div style={{ flex: 1 }}>
          <label>{t("letter.fields.signerTitle")}</label>
          <input value={value.signerTitle ?? ""} placeholder={base.signer.title} onChange={(e) => onChange({ signerTitle: e.target.value })} />
        </div>
        <div style={{ flex: 1 }}>
          <label>{t("letter.fields.referenceText")}</label>
          <input value={value.referenceText ?? ""} placeholder={base.referenceText} onChange={(e) => onChange({ referenceText: e.target.value })} />
        </div>
      </div>
      <p className="muted small">{t("letter.translationHint")}</p>
    </div>
  );
}
