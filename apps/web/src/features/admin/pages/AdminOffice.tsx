/**
 * Yönetim → Office Entegrasyonu: browser editor (WOPI: ONLYOFFICE Docs / Collabora Online)
 * and the office → PDF converter (ONLYOFFICE, Collabora, Gotenberg; local soffice as a last resort).
 */
import { useEffect, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import {
  type OfficeConverterKind,
  type OfficeEditorKind,
  type OfficeSettingsDto,
  type OfficeSettingsInput,
  type OfficeTestResultDto,
} from "@sitekeep/shared";
import { officeApi, type AdminOfficeDto } from "../../../shared/api/api-office";
import { useLoad } from "../../../app/context/project";
import { LoadingIndicator } from "../../../shared/ui/LoadingIndicator";

/** Order of the choices; names and texts: admin:office.editorNames/editorTexts.<kind>. */
const EDITORS: OfficeEditorKind[] = ["none", "onlyoffice", "collabora"];
/** Order of the choices; names and texts: admin:office.converterNames/converterTexts.<kind>. */
const CONVERTERS: OfficeConverterKind[] = ["auto", "onlyoffice", "collabora", "gotenberg", "local", "none"];

const TTL_HOURS = [1, 2, 4, 8, 10, 12, 24];

interface Draft {
  editor: OfficeSettingsDto["editor"];
  converter: OfficeSettingsDto["converter"];
  wopiBaseUrl: string;
  tokenTtlMinutes: number;
  jwtSecret: string;
  removeJwt: boolean;
  gotenbergAuth: string;
  removeGotenberg: boolean;
}

const toDraft = (s: OfficeSettingsDto): Draft => ({
  editor: { ...s.editor },
  converter: { ...s.converter },
  wopiBaseUrl: s.wopiBaseUrl ?? "",
  tokenTtlMinutes: s.tokenTtlMinutes,
  jwtSecret: "",
  removeJwt: false,
  gotenbergAuth: "",
  removeGotenberg: false,
});

export function AdminOfficeSection() {
  const { t } = useTranslation(["admin", "common"]);
  const { data, error, setData } = useLoad(() => officeApi.adminOffice(), []);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [test, setTest] = useState<OfficeTestResultDto | "running" | string | null>(null);

  useEffect(() => {
    if (data) setDraft(toDraft(data.settings));
  }, [data]);

  if (error) return <p className="error">{error}</p>;
  if (!data || !draft) return <LoadingIndicator />;
  const { settings, status } = data;
  const d = draft;
  const setEditor = (p: Partial<Draft["editor"]>) => setDraft({ ...d, editor: { ...d.editor, ...p } });
  const setConv = (p: Partial<Draft["converter"]>) => setDraft({ ...d, converter: { ...d.converter, ...p } });
  const usesOnlyoffice = d.editor.kind === "onlyoffice" || d.converter.kind === "onlyoffice";
  const convNeedsUrl = d.converter.kind === "onlyoffice" || d.converter.kind === "collabora" || d.converter.kind === "gotenberg";

  async function save() {
    setMsg(null);
    setSaved(false);
    const input: OfficeSettingsInput = {
      editor: { ...d.editor, url: d.editor.url || null, publicUrl: d.editor.publicUrl || null },
      converter: { ...d.converter, url: d.converter.url || null },
      wopiBaseUrl: d.wopiBaseUrl.trim() || null,
      tokenTtlMinutes: d.tokenTtlMinutes,
    };
    if (d.jwtSecret) input.jwtSecret = d.jwtSecret;
    else if (d.removeJwt) input.jwtSecret = null;
    if (d.gotenbergAuth) input.gotenbergAuth = d.gotenbergAuth;
    else if (d.removeGotenberg) input.gotenbergAuth = null;
    try {
      setData((await officeApi.saveAdminOffice(input)) as AdminOfficeDto);
      setSaved(true);
      setTest(null);
    } catch (e) {
      setMsg((e as Error).message);
    }
  }

  async function runTest() {
    setTest("running");
    try {
      setTest(await officeApi.testAdminOffice());
    } catch (e) {
      setTest((e as Error).message);
    }
  }

  const editableCount = status.editor.editExtensions.length;
  return (
    <div className="stack">
      {msg && <p className="error">{msg}</p>}

      <div className="card">
        <div className="row wrap" style={{ marginBottom: 8 }}>
          <h2 style={{ margin: 0 }}>{t("office.overview.title")}</h2>
          <div className="spacer" />
          <button onClick={() => void runTest()} disabled={test === "running"} title={t("office.overview.testHint")}>
            {test === "running" ? t("office.overview.testing") : t("shared.actions.testConnection")}
          </button>
        </div>
        <table className="props-table">
          <tbody>
            <tr>
              <td>{t("office.overview.fields.browserEditing")}</td>
              <td>
                {status.editor.configured ? (
                  status.editor.error ? (
                    <span style={{ color: "var(--danger)" }}>{status.editor.error}</span>
                  ) : (
                    <>
                      <span className="badge ok">{status.editor.label}</span>{" "}
                      <span className="muted small">
                        {status.editor.proofKey
                          ? t("office.overview.editableWithProof", { count: editableCount })
                          : t("office.overview.editableNoProof", { count: editableCount })}
                      </span>
                    </>
                  )
                ) : (
                  <span className="muted">{t("office.overview.off")}</span>
                )}
              </td>
            </tr>
            <tr>
              <td>{t("office.overview.fields.officeToPdf")}</td>
              <td>
                {/* i18n: server text (converter label and message) */}
                <span className={`badge ${status.converter.available ? "ok" : "warn"}`}>
                  {status.converter.auto && status.converter.kind
                    ? t("office.overview.converterAuto", { label: status.converter.label })
                    : status.converter.label}
                </span>{" "}
                <span className="muted small">{status.converter.message}</span>
              </td>
            </tr>
          </tbody>
        </table>
        {test && test !== "running" && (
          <div className="small" style={{ marginTop: 8 }}>
            {typeof test === "string" ? (
              <span style={{ color: "var(--danger)" }}>{test}</span>
            ) : (
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {/* i18n: server text (test steps) */}
                {test.steps.map((s) => (
                  <li key={s.name} style={{ color: s.ok ? "var(--ok)" : "var(--danger)" }}>
                    <strong>{s.name}:</strong> <span style={{ color: "var(--text)" }}>{s.message}</span>
                  </li>
                ))}
                <li className="muted">{`${test.latencyMs} ms`}</li>
              </ul>
            )}
          </div>
        )}
        {settings.fromEnv.length > 0 && (
          <p className="muted small" style={{ marginBottom: 0 }}>
            <Trans t={t} i18nKey="office.overview.fromEnv" values={{ vars: settings.fromEnv.join(", ") }} components={{ code: <code /> }} />
          </p>
        )}
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>{t("office.wopi.title")}</h2>
        <div className="choices">
          {EDITORS.map((kind) => (
            <label key={kind} className={`choice${d.editor.kind === kind ? " selected" : ""}`}>
              <input type="radio" name="office-editor" checked={d.editor.kind === kind} onChange={() => setEditor({ kind })} />
              <strong>{t(`office.editorNames.${kind}`)}</strong>
              <span className="muted"> {t(`office.editorTexts.${kind}`)}</span>
            </label>
          ))}
        </div>
        {d.editor.kind !== "none" && (
          <>
            <label>{t("office.wopi.fields.editorUrl")}</label>
            <input
              className="mono"
              placeholder={d.editor.kind === "onlyoffice" ? "http://onlyoffice" : "http://collabora:9980"}
              value={d.editor.url ?? ""}
              onChange={(e) => setEditor({ url: e.target.value })}
            />
            <label>{t("office.wopi.fields.publicUrl")}</label>
            <input
              className="mono"
              placeholder={t("office.wopi.placeholder.publicUrl")}
              value={d.editor.publicUrl ?? ""}
              onChange={(e) => setEditor({ publicUrl: e.target.value })}
            />
            <label className="check">
              <input type="checkbox" checked={d.editor.verifyProof} onChange={(e) => setEditor({ verifyProof: e.target.checked })} />
              {t("office.wopi.options.verifyProof")}
            </label>
          </>
        )}
        <label>{t("office.wopi.fields.wopiBase")}</label>
        <div className="row" style={{ gap: 6 }}>
          <input
            className="mono"
            placeholder={t("office.wopi.placeholder.wopiBase", { origin: window.location.origin })}
            value={d.wopiBaseUrl}
            onChange={(e) => setDraft({ ...d, wopiBaseUrl: e.target.value })}
          />
          <button type="button" className="small" onClick={() => setDraft({ ...d, wopiBaseUrl: window.location.origin })}>
            {t("office.wopi.actions.useThis")}
          </button>
        </div>
        <p className="muted small" style={{ margin: "4px 0 0" }}>
          <Trans t={t} i18nKey="office.wopi.help" components={{ code: <code /> }} />
        </p>
        {usesOnlyoffice && (
          <>
            <label>{t("office.wopi.fields.jwt")}</label>
            <input
              type="password"
              autoComplete="off"
              placeholder={settings.hasJwtSecret ? t("shared.placeholder.keyStored") : ""}
              value={d.jwtSecret}
              onChange={(e) => setDraft({ ...d, jwtSecret: e.target.value })}
            />
            {settings.hasJwtSecret && !d.jwtSecret && (
              <label className="check">
                <input type="checkbox" checked={d.removeJwt} onChange={(e) => setDraft({ ...d, removeJwt: e.target.checked })} />{" "}
                {t("shared.actions.removeKey")}
              </label>
            )}
          </>
        )}
        <label>{t("office.wopi.fields.sessionTtl")}</label>
        <select
          style={{ width: "auto" }}
          value={d.tokenTtlMinutes}
          onChange={(e) => setDraft({ ...d, tokenTtlMinutes: Number(e.target.value) })}
        >
          {[...new Set([...TTL_HOURS.map((h) => h * 60), d.tokenTtlMinutes])].sort((a, b) => a - b).map((m) => (
            <option key={m} value={m}>
              {m % 60 === 0 ? t("office.wopi.hours", { count: m / 60 }) : t("office.wopi.minutes", { count: m })}
            </option>
          ))}
        </select>
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>{t("office.converter.title")}</h2>
        <p className="muted small" style={{ marginTop: 0 }}>
          {t("office.converter.description")}
        </p>
        <div className="choices">
          {CONVERTERS.map((kind) => (
            <label key={kind} className={`choice${d.converter.kind === kind ? " selected" : ""}`}>
              <input type="radio" name="office-converter" checked={d.converter.kind === kind} onChange={() => setConv({ kind })} />
              <strong>{t(`office.converterNames.${kind}`)}</strong>
              <span className="muted"> {t(`office.converterTexts.${kind}`)}</span>
            </label>
          ))}
        </div>
        {convNeedsUrl && (
          <>
            <label>{t("office.converter.fields.url")}</label>
            <input
              className="mono"
              placeholder={
                d.converter.kind === d.editor.kind
                  ? t("office.converter.placeholder.sameAsEditor")
                  : d.converter.kind === "gotenberg"
                    ? "http://gotenberg:3000"
                    : "http://…"
              }
              value={d.converter.url ?? ""}
              onChange={(e) => setConv({ url: e.target.value })}
            />
          </>
        )}
        {d.converter.kind === "gotenberg" && (
          <>
            <label>{t("office.converter.fields.gotenbergAuth")}</label>
            <input
              type="password"
              autoComplete="off"
              placeholder={settings.hasGotenbergAuth ? t("office.converter.placeholder.stored") : ""}
              value={d.gotenbergAuth}
              onChange={(e) => setDraft({ ...d, gotenbergAuth: e.target.value })}
            />
            {settings.hasGotenbergAuth && !d.gotenbergAuth && (
              <label className="check">
                <input type="checkbox" checked={d.removeGotenberg} onChange={(e) => setDraft({ ...d, removeGotenberg: e.target.checked })} />{" "}
                {t("office.converter.actions.removeStored")}
              </label>
            )}
          </>
        )}
        <div className="row wrap" style={{ gap: 12, marginTop: 8 }}>
          <NumberField label={t("office.converter.fields.timeout")} value={d.converter.timeoutSec} min={5} max={3600} onChange={(v) => setConv({ timeoutSec: v })} />
          <NumberField label={t("office.converter.fields.maxFile")} value={d.converter.maxFileMb} min={1} max={2048} onChange={(v) => setConv({ maxFileMb: v })} />
          <NumberField label={t("office.converter.fields.concurrency")} value={d.converter.concurrency} min={1} max={8} onChange={(v) => setConv({ concurrency: v })} />
          <NumberField label={t("office.converter.fields.retries")} value={d.converter.retries} min={0} max={5} onChange={(v) => setConv({ retries: v })} />
        </div>
      </div>

      <div className="row">
        {saved && <span className="muted small">{t("messages.saved")}</span>}
        <div className="spacer" />
        <button onClick={() => setDraft(toDraft(settings))}>{t("office.actions.revert")}</button>
        <button className="primary" onClick={() => void save()}>
          {t("common:actions.save")}
        </button>
      </div>
    </div>
  );
}

function NumberField({ label, value, min, max, onChange }: { label: string; value: number; min: number; max: number; onChange(v: number): void }) {
  return (
    <div style={{ minWidth: 140 }}>
      <label>{label}</label>
      <input
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (Number.isFinite(n)) onChange(Math.min(max, Math.max(min, Math.round(n))));
        }}
      />
    </div>
  );
}
