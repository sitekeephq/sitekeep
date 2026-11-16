/**
 * Yönetim → Kullanıcılar → "Kişisel Veriler" (docs/features/DATA_SUBJECT_RIGHTS.md): correct the
 * e-mail address, export the person's data (ZIP of JSON and CSV), anonymise the account. Also the
 * "My data" card of My account (the person's own export).
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { PersonalDataExportDto, UserDto } from "@sitekeep/shared";
import { formatDate, formatSize } from "../../../shared/api/api";
import { subjectApi } from "../../../shared/api/api-privacy";
import { useAsk } from "../../../shared/ui/Ask";
import { Dialog } from "../../../shared/ui/Dialog";

/** Address an anonymised account gets (server: privacy/subject/anonymise.ts). */
export const isAnonymisedUser = (u: Pick<UserDto, "email">) => u.email.endsWith("@anonymised.invalid");

export function PersonalDataDialog({ user, isSelf, onClose, onChanged }: { user: UserDto; isSelf: boolean; onClose(): void; onChanged(): void }) {
  const { t } = useTranslation(["admin", "common"]);
  const { confirm, prompt } = useAsk();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [current, setCurrent] = useState(user);

  async function changeEmail() {
    const email = await prompt({ title: t("users.personal.changeEmail"), message: t("users.personal.changeEmailPrompt", { name: current.name }), defaultValue: current.email, confirmLabel: t("common:actions.save") });
    if (!email || email.trim().toLowerCase() === current.email) return;
    setMsg(null);
    try {
      const next = await subjectApi.changeEmail(current.id, email.trim());
      setCurrent({ ...current, email: next.email });
      setMsg({ ok: true, text: t("users.personal.emailChanged") });
      onChanged();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    }
  }

  async function anonymise() {
    // Two steps: a warning, then the account's address typed by hand.
    const ok = await confirm({
      title: t("users.personal.anonymise"),
      message: t("users.personal.anonymiseWarning", { name: current.name }),
      confirmLabel: t("users.personal.anonymiseContinue"),
      danger: true,
    });
    if (!ok) return;
    const typed = await prompt({ title: t("users.personal.anonymise"), message: t("users.personal.anonymiseType", { email: current.email }), confirmLabel: t("users.personal.anonymiseConfirm") });
    if (!typed) return;
    setMsg(null);
    try {
      const r = await subjectApi.anonymise(current.id, typed.trim());
      setMsg({ ok: true, text: t("users.personal.anonymised", { name: r.name }) });
      onChanged();
      onClose();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    }
  }

  return (
    <Dialog title={t("users.personal.title", { name: current.name })} onClose={onClose} wide>
      <div className="stack">
        {msg && <p className={msg.ok ? "success" : "error"}>{msg.text}</p>}
        <div className="card stack">
          <h3 style={{ margin: 0 }}>{t("users.personal.emailTitle")}</h3>
          <div className="row">
            <code>{current.email}</code>
            <div className="spacer" />
            <button className="small" onClick={() => void changeEmail()}>
              {t("users.personal.changeEmail")}
            </button>
          </div>
          <p className="muted small" style={{ margin: 0 }}>
            {t("users.personal.emailHelp")}
          </p>
        </div>
        <ExportCard
          list={() => subjectApi.exports(current.id)}
          request={(files) => subjectApi.requestExport(current.id, files)}
          url={(id) => subjectApi.downloadUrl(id)}
        />
        {!isSelf && (
          <div className="card stack">
            <h3 style={{ margin: 0 }}>{t("users.personal.anonymise")}</h3>
            <p className="muted small" style={{ margin: 0 }}>
              {t("users.personal.anonymiseHelp")}
            </p>
            <div className="row">
              <button className="danger" onClick={() => void anonymise()}>
                {t("users.personal.anonymise")}
              </button>
            </div>
          </div>
        )}
      </div>
    </Dialog>
  );
}

/** Request an export, list the person's exports with their state and download link. */
export function ExportCard({
  list,
  request,
  url,
  title,
}: {
  list(): Promise<PersonalDataExportDto[]>;
  request(includeFiles: boolean): Promise<PersonalDataExportDto>;
  url(id: string): string;
  title?: string;
}) {
  const { t } = useTranslation(["admin", "common"]);
  const [rows, setRows] = useState<PersonalDataExportDto[] | null>(null);
  const [includeFiles, setIncludeFiles] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let live = true;
    list()
      .then((r) => live && setRows(r))
      .catch((e: Error) => live && setErr(e.message));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick]);
  // Poll while an export is being built.
  const pending = rows?.some((r) => r.status === "queued" || r.status === "running");
  useEffect(() => {
    if (!pending) return;
    const id = setTimeout(() => setTick((n) => n + 1), 2000);
    return () => clearTimeout(id);
  }, [pending, rows]);

  async function start() {
    setErr(null);
    try {
      await request(includeFiles);
      setTick((n) => n + 1);
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  return (
    <div className="card stack" data-testid="personal-export">
      <h3 style={{ margin: 0 }}>{title ?? t("users.personal.exportTitle")}</h3>
      <p className="muted small" style={{ margin: 0 }}>
        {t("users.personal.exportHelp")}
      </p>
      <div className="row wrap">
        <label className="check">
          <input type="checkbox" checked={includeFiles} onChange={(e) => setIncludeFiles(e.target.checked)} />
          {t("users.personal.includeFiles")}
        </label>
        <div className="spacer" />
        <button className="primary" disabled={pending} onClick={() => void start()}>
          {t("users.personal.export")}
        </button>
      </div>
      {err && <p className="error">{err}</p>}
      {rows && rows.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>{t("users.personal.columns.requested")}</th>
              <th>{t("users.personal.columns.status")}</th>
              <th>{t("users.personal.columns.size")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>{formatDate(r.requestedAt)}</td>
                <td>{t(`users.personal.status.${r.status}`)}</td>
                <td>{r.size !== null ? formatSize(r.size) : "—"}</td>
                <td>
                  {r.status === "done" && (
                    <a className="btn small" href={url(r.id)} download>
                      {t("users.personal.download")}
                    </a>
                  )}
                  {r.status === "failed" && <span className="error small">{r.error}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
