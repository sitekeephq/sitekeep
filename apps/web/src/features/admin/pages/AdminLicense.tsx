/**
 * Yönetim → Lisans (docs/onprem/lisanslama.md, top section): the edition, the licence status, the
 * installation id to send when asking for a licence, the licence details and installing / removing it.
 * Without a licence the installation is SiteKeep Community and nothing is limited.
 */
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { licenseApi, type AdminLicenseDto } from "../../../shared/api/api-license";
import { useLoad } from "../../../app/context/project";
import { editionName } from "../../../app/brand";
import { formatDate } from "../../../shared/lib/format";
import { useAsk } from "../../../shared/ui/Ask";
import { LoadingIndicator } from "../../../shared/ui/LoadingIndicator";

const TONE: Record<AdminLicenseDto["status"], string> = {
  none: "",
  not_yet: "info",
  active: "ok",
  expiring: "warn",
  grace: "warn",
  read_only: "danger",
  invalid: "danger",
};

export function AdminLicenseSection() {
  const { t } = useTranslation(["admin", "common"]);
  const { confirm } = useAsk();
  const { data, error, setData } = useLoad(() => licenseApi.get(), []);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  if (error) return <p className="error">{error}</p>;
  if (!data) return <LoadingIndicator />;
  const lic = data.license;

  async function upload(file: File) {
    setBusy(true);
    setMsg(null);
    try {
      setData(await licenseApi.install(await file.text()));
      setMsg(t("admin:license.installed"));
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  async function remove() {
    if (!(await confirm({ title: t("admin:license.removeTitle"), message: t("admin:license.removeText"), confirmLabel: t("admin:license.remove"), danger: true }))) return;
    setBusy(true);
    try {
      setData(await licenseApi.remove());
      setMsg(null);
    } finally {
      setBusy(false);
    }
  }

  async function copyId() {
    try {
      await navigator.clipboard.writeText(data!.installationId);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="stack">
      <section className="card stack">
        <h2 style={{ margin: 0 }}>{t("admin:license.title")}</h2>
        <div className="row wrap">
          <strong>{editionName()}</strong>
          <span className={`badge ${TONE[data.status]}`}>{t(`admin:license.status.${data.status}`)}</span>
        </div>
        <p className="muted" style={{ margin: 0 }}>
          {t(`admin:license.statusText.${data.status}`, {
            days: data.daysLeft ?? 0,
            date: data.readOnlyAt ? formatDate(data.readOnlyAt) : "",
          })}
        </p>
        {data.problem && <p className="error">{t(`admin:license.problems.${data.problem}`)}</p>}
        {data.clockBehind && <p className="error">{t("admin:license.clockBehind")}</p>}
        {data.seatsOver > 0 && <p className="error">{t("admin:license.seatsOver", { count: data.seatsOver })}</p>}
        {!data.enforced && <p className="muted">{t("admin:license.notEnforced")}</p>}
      </section>

      <section className="card stack">
        <h3 style={{ margin: 0 }}>{t("admin:license.installationTitle")}</h3>
        <p className="muted" style={{ margin: 0 }}>{t("admin:license.installationText")}</p>
        <div className="row wrap">
          <code data-testid="installation-id">{data.installationId}</code>
          <button type="button" onClick={copyId}>
            {copied ? t("admin:license.copied") : t("admin:license.copy")}
          </button>
        </div>
      </section>

      {lic && (
        <section className="card stack">
          <h3 style={{ margin: 0 }}>{t("admin:license.detailsTitle")}</h3>
          <dl className="kv">
            <dt>{t("admin:license.fields.customer")}</dt>
            <dd>{lic.customer}</dd>
            <dt>{t("admin:license.fields.lid")}</dt>
            <dd>{lic.lid}</dd>
            <dt>{t("admin:license.fields.modules")}</dt>
            <dd>{lic.modules.length ? lic.modules.map((m) => t(`admin:license.moduleNames.${m}`, { defaultValue: m })).join(", ") : "—"}</dd>
            <dt>{t("admin:license.fields.seats")}</dt>
            <dd>{lic.seats === null ? t("admin:license.seatsUnlimited", { used: data.seatsUsed }) : t("admin:license.seatsOf", { used: data.seatsUsed, seats: lic.seats })}</dd>
            <dt>{t("admin:license.fields.validUntil")}</dt>
            <dd>{lic.validUntil ? formatDate(lic.validUntil) : t("admin:license.perpetual")}</dd>
            <dt>{t("admin:license.fields.supportUntil")}</dt>
            <dd>{formatDate(lic.supportUntil)}</dd>
          </dl>
        </section>
      )}

      <section className="card stack">
        <h3 style={{ margin: 0 }}>{lic ? t("admin:license.replaceTitle") : t("admin:license.uploadTitle")}</h3>
        <p className="muted" style={{ margin: 0 }}>{t("admin:license.uploadText")}</p>
        <div className="row wrap">
          <input
            ref={fileInput}
            type="file"
            accept=".json,application/json"
            aria-label={t("admin:license.fileLabel")}
            disabled={busy}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void upload(f);
            }}
          />
          {lic && (
            <button type="button" className="danger" disabled={busy} onClick={() => void remove()}>
              {t("admin:license.remove")}
            </button>
          )}
        </div>
        {msg && <p role="status">{msg}</p>}
      </section>
    </div>
  );
}
