/**
 * Administration → Sign-in Security → OpenID Connect providers (docs/features/OIDC_SIGN_IN.md):
 * Entra ID, Keycloak, Okta, Google Workspace, Authentik … Each provider is its own connection in the
 * Privacy Centre.
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { OIDC_DEFAULTS, type CompanyDto, type OidcProviderDto, type OidcProviderInput } from "@sitekeep/shared";
import { api } from "../../../shared/api/api";
import { oidcApi } from "../../../shared/api/api-oidc";
import { useLoad } from "../../../app/context/project";
import { useAsk } from "../../../shared/ui/Ask";
import { Dialog } from "../../../shared/ui/Dialog";
import { LoadingIndicator } from "../../../shared/ui/LoadingIndicator";

export function AdminOidcSection() {
  const { t } = useTranslation(["admin", "common"]);
  const { data, reload } = useLoad(() => oidcApi.list(), []);
  const { data: companies } = useLoad(() => api.companies(), []);
  const { confirm } = useAsk();
  const [editing, setEditing] = useState<OidcProviderDto | "new" | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function act(fn: () => Promise<unknown>, done?: string) {
    setMsg(null);
    try {
      await fn();
      if (done) setMsg({ ok: true, text: done });
      reload();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    }
  }

  return (
    <div className="card" data-testid="admin-oidc">
      <div className="row wrap" style={{ gap: 12 }}>
        <div style={{ flex: "1 1 280px" }}>
          <h2 style={{ margin: 0 }}>{t("oidc.title")}</h2>
          <p className="muted small" style={{ margin: "6px 0 0" }}>
            {t("oidc.description")}
          </p>
        </div>
        <button className="primary" onClick={() => setEditing("new")}>
          {t("oidc.actions.add")}
        </button>
      </div>
      {!data ? (
        <LoadingIndicator />
      ) : (
        <table style={{ marginTop: 12 }}>
          <thead>
            <tr>
              <th>{t("oidc.columns.provider")}</th>
              <th>{t("oidc.columns.issuer")}</th>
              <th>{t("oidc.columns.accounts")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.map((p) => (
              <tr key={p.id}>
                <td>
                  <span className="oidc-dot" style={{ background: p.buttonColor }} aria-hidden="true" /> <strong>{p.name}</strong>
                  <div className="muted small">
                    {p.id}
                    {!p.enabled && ` · ${t("oidc.off")}`}
                  </div>
                </td>
                <td className="small" style={{ wordBreak: "break-all" }}>
                  {p.issuer}
                </td>
                <td className="small">{p.createAccounts ? t("oidc.accounts.create") : t("oidc.accounts.existing")}</td>
                <td>
                  <div className="row wrap" style={{ gap: 4 }}>
                    <button
                      className="small"
                      onClick={() =>
                        void act(async () => {
                          const r = await oidcApi.test(p.id);
                          setMsg({ ok: true, text: t("oidc.testOk", { issuer: r.issuer, algorithms: r.algorithms.join(", ") }) });
                        })
                      }
                    >
                      {t("oidc.actions.test")}
                    </button>
                    <button className="small" onClick={() => setEditing(p)}>
                      {t("common:actions.edit")}
                    </button>
                    <button
                      className="small danger"
                      onClick={() =>
                        void confirm({
                          title: t("oidc.deleteTitle"),
                          message: t("oidc.deleteConfirm", { name: p.name }),
                          confirmLabel: t("common:actions.delete"),
                          danger: true,
                        }).then((ok) => {
                          if (ok) return act(() => oidcApi.remove(p.id));
                        })
                      }
                    >
                      {t("common:actions.delete")}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {data.length === 0 && (
              <tr>
                <td className="muted" colSpan={4}>
                  {t("oidc.empty")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}
      {msg && <p className={msg.ok ? "success" : "error"}>{msg.text}</p>}
      {editing && (
        <ProviderDialog
          provider={editing === "new" ? null : editing}
          companies={companies ?? []}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            setMsg({ ok: true, text: t("oidc.saved") });
            reload();
          }}
        />
      )}
    </div>
  );
}

const ID_EXAMPLE = "entra"; // i18n-ok
const DOMAINS_EXAMPLE = "contoso.com, contoso.com.tr"; // i18n-ok

const EMPTY: OidcProviderInput = {
  id: "",
  name: "",
  enabled: OIDC_DEFAULTS.enabled,
  issuer: "",
  clientId: "",
  clientSecret: "",
  scopes: OIDC_DEFAULTS.scopes,
  buttonLabel: "",
  buttonColor: OIDC_DEFAULTS.buttonColor,
  allowedDomains: [],
  createAccounts: OIDC_DEFAULTS.createAccounts,
  defaultCompanyId: null,
  emailClaim: OIDC_DEFAULTS.emailClaim,
  nameClaim: OIDC_DEFAULTS.nameClaim,
  trustUnverifiedEmail: OIDC_DEFAULTS.trustUnverifiedEmail,
  trustProviderMfa: OIDC_DEFAULTS.trustProviderMfa,
  groupsClaim: OIDC_DEFAULTS.groupsClaim,
  adminGroup: null,
};

function ProviderDialog({
  provider,
  companies,
  onClose,
  onSaved,
}: {
  provider: OidcProviderDto | null;
  companies: CompanyDto[];
  onClose(): void;
  onSaved(): void;
}) {
  const { t } = useTranslation(["admin", "common"]);
  const [form, setForm] = useState<OidcProviderInput>(() => {
    if (!provider) return EMPTY;
    const { hasClientSecret: _h, redirectUri: _r, ...rest } = provider;
    return { ...rest, clientSecret: undefined };
  });
  const [domains, setDomains] = useState((provider?.allowedDomains ?? []).join(", "));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof OidcProviderInput>(k: K, v: OidcProviderInput[K]) => setForm((f) => ({ ...f, [k]: v }));

  async function save() {
    setBusy(true);
    setError(null);
    const body: OidcProviderInput = {
      ...form,
      allowedDomains: domains.split(/[\s,;]+/).filter(Boolean),
      adminGroup: form.adminGroup?.trim() || null,
    };
    // Empty secret while editing: keep the stored one.
    if (provider && !body.clientSecret) delete body.clientSecret;
    try {
      if (provider) await oidcApi.update(provider.id, body);
      else await oidcApi.create(body);
      onSaved();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  const text = (k: "name" | "issuer" | "clientId" | "scopes" | "buttonLabel" | "emailClaim" | "nameClaim" | "groupsClaim", opts: { placeholder?: string; required?: boolean; disabled?: boolean } = {}) => (
    <>
      <label htmlFor={`oidc-${k}`}>{t(`oidc.fields.${k}`)}</label>
      <input
        id={`oidc-${k}`}
        value={form[k]}
        onChange={(e) => set(k, e.target.value)}
        placeholder={opts.placeholder}
        required={opts.required}
        disabled={opts.disabled}
      />
    </>
  );

  return (
    <Dialog title={provider ? t("oidc.dialog.editTitle", { name: provider.name }) : t("oidc.dialog.newTitle")} onClose={onClose} wide>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: "0 12px" }}>
          <div>
            <label htmlFor="oidc-id">{t("oidc.fields.id")}</label>
            <input
              id="oidc-id"
              value={form.id}
              onChange={(e) => set("id", e.target.value.toLowerCase())}
              placeholder={ID_EXAMPLE}
              pattern="[a-z0-9]([a-z0-9\-]{0,30}[a-z0-9])?"
              required
              disabled={!!provider}
            />
            <div className="muted small">{t("oidc.help.id")}</div>
          </div>
          <div>{text("name", { placeholder: "Contoso Entra ID", required: true })}</div>
        </div>
        {text("issuer", { placeholder: "https://login.microsoftonline.com/<tenant-id>/v2.0", required: true })}
        <div className="muted small">{t("oidc.help.issuer")}</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: "0 12px" }}>
          <div>{text("clientId", { required: true })}</div>
          <div>
            <label htmlFor="oidc-secret">{t("oidc.fields.clientSecret")}</label>
            <input
              id="oidc-secret"
              type="password"
              autoComplete="new-password"
              value={form.clientSecret ?? ""}
              onChange={(e) => set("clientSecret", e.target.value)}
              placeholder={provider?.hasClientSecret ? t("oidc.secretStored") : t("oidc.secretNone")}
            />
          </div>
        </div>
        {text("scopes")}
        {provider && (
          <>
            <label>{t("oidc.fields.redirectUri")}</label>
            <code className="small" style={{ wordBreak: "break-all" }}>
              {provider.redirectUri}
            </code>
          </>
        )}
        {!provider && <div className="muted small">{t("oidc.help.redirectUri")}</div>}

        <h3>{t("oidc.sections.button")}</h3>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: "0 12px" }}>
          <div>{text("buttonLabel", { placeholder: t("oidc.placeholder.buttonLabel"), required: true })}</div>
          <div>
            <label htmlFor="oidc-color">{t("oidc.fields.buttonColor")}</label>
            <input id="oidc-color" type="color" value={form.buttonColor} onChange={(e) => set("buttonColor", e.target.value)} style={{ height: 36, padding: 2 }} />
          </div>
        </div>

        <h3>{t("oidc.sections.accounts")}</h3>
        <label htmlFor="oidc-domains">{t("oidc.fields.allowedDomains")}</label>
        <input id="oidc-domains" value={domains} onChange={(e) => setDomains(e.target.value)} placeholder={DOMAINS_EXAMPLE} />
        <div className="muted small">{t("oidc.help.allowedDomains")}</div>
        <label className="check">
          <input type="checkbox" checked={form.enabled} onChange={(e) => set("enabled", e.target.checked)} /> {t("oidc.options.enabled")}
        </label>
        <label className="check">
          <input type="checkbox" checked={form.createAccounts} onChange={(e) => set("createAccounts", e.target.checked)} /> {t("oidc.options.createAccounts")}
        </label>
        <div className="muted small">{t("oidc.help.createAccounts")}</div>
        {form.createAccounts && (
          <>
            <label htmlFor="oidc-company">{t("oidc.fields.defaultCompany")}</label>
            <select id="oidc-company" value={form.defaultCompanyId ?? ""} onChange={(e) => set("defaultCompanyId", e.target.value || null)}>
              <option value="">{t("oidc.noCompany")}</option>
              {companies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </>
        )}

        <h3>{t("oidc.sections.claims")}</h3>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: "0 12px" }}>
          <div>{text("emailClaim", { required: true })}</div>
          <div>{text("nameClaim", { required: true })}</div>
          <div>{text("groupsClaim", { required: true })}</div>
        </div>
        <label htmlFor="oidc-admin-group">{t("oidc.fields.adminGroup")}</label>
        <input id="oidc-admin-group" value={form.adminGroup ?? ""} onChange={(e) => set("adminGroup", e.target.value)} placeholder={t("oidc.placeholder.adminGroup")} />
        <div className="muted small">{t("oidc.help.adminGroup")}</div>

        <h3>{t("oidc.sections.trust")}</h3>
        <label className="check">
          <input type="checkbox" checked={form.trustUnverifiedEmail} onChange={(e) => set("trustUnverifiedEmail", e.target.checked)} />{" "}
          {t("oidc.options.trustUnverifiedEmail")}
        </label>
        <div className="muted small">{t("oidc.help.trustUnverifiedEmail")}</div>
        <label className="check">
          <input type="checkbox" checked={form.trustProviderMfa} onChange={(e) => set("trustProviderMfa", e.target.checked)} /> {t("oidc.options.trustProviderMfa")}
        </label>
        <div className="muted small">{t("oidc.help.trustProviderMfa")}</div>

        {error && <p className="error">{error}</p>}
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>
            {t("common:actions.cancel")}
          </button>
          <button className="primary" disabled={busy}>
            {t("common:actions.save")}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
