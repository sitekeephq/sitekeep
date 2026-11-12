import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";
import { companyCodeInput, usersFinding, type CompanyDto, type GoogleAuthSettings } from "@sitekeep/shared";
import { api } from "../../../shared/api/api";
import { useAuth } from "../../../app/context/auth";
import { useLoad } from "../../../app/context/project";
import { useAsk } from "../../../shared/ui/Ask";
import { Dialog } from "../../../shared/ui/Dialog";
import { LoadingIndicator } from "../../../shared/ui/LoadingIndicator";
import { webCapability } from "../../../sdk/capabilities";
import { AdminOfficeSection } from "./AdminOffice";
import { AdminOAuthSection } from "./AdminOAuth";
import { AdminPrivacySection } from "./AdminPrivacy";
import { AdminStatusSection } from "./AdminStatus";
import { AdminLicenseSection } from "./AdminLicense";

type AdminTab = "users" | "ai" | "office" | "oauth" | "privacy" | "status" | "license" | "forma";
const ALL_ADMIN_TABS: AdminTab[] = ["users", "ai", "office", "oauth", "privacy", "status", "license", "forma"];

export function AdminPage() {
  const { t } = useTranslation("admin");
  // ?tab=privacy opens a tab directly (the "dış bağlantılar kapalı" banner links there).
  const [params] = useSearchParams();
  const wanted = params.get("tab") as AdminTab | null;
  // "Yapay Zekâ ve MCP" is the AI module's.
  const AdminAiSection = webCapability("ai.ui")?.AdminAiSection;
  // "Forma Eşitleme" is the Connect module's.
  const AdminFormaSyncSection = webCapability("connect.ui")?.AdminFormaSyncSection;
  const ADMIN_TABS = ALL_ADMIN_TABS.filter((k) => (k !== "ai" || !!AdminAiSection) && (k !== "forma" || !!AdminFormaSyncSection));
  const [tab, setTab] = useState<AdminTab>(wanted && ADMIN_TABS.includes(wanted) ? wanted : "users");
  return (
    <div className="page stack">
      <div className="row wrap">
        <h1 style={{ margin: 0 }}>{t("title")}</h1>
        <div className="spacer" />
        {ADMIN_TABS.map((k) => (
          <button key={k} className={tab === k ? "primary" : ""} onClick={() => setTab(k)}>
            {t(`tabs.${k}`)}
          </button>
        ))}
      </div>
      {tab === "users" ? (
        <UsersAndCompanies />
      ) : tab === "ai" && AdminAiSection ? (
        <AdminAiSection />
      ) : tab === "office" ? (
        <AdminOfficeSection />
      ) : tab === "oauth" ? (
        <AdminOAuthSection />
      ) : tab === "privacy" ? (
        <AdminPrivacySection />
      ) : tab === "status" ? (
        <AdminStatusSection />
      ) : tab === "license" ? (
        <AdminLicenseSection />
      ) : AdminFormaSyncSection ? (
        <AdminFormaSyncSection />
      ) : null}
    </div>
  );
}

function UsersAndCompanies() {
  const { t } = useTranslation(["admin", "common"]);
  const { prompt } = useAsk();
  const { user: me } = useAuth();
  const { data: users, reload } = useLoad(() => api.users(), []);
  const { data: companies, reload: reloadCompanies } = useLoad(() => api.companies(), []);
  const [newUser, setNewUser] = useState(false);
  const [company, setCompany] = useState("");
  const [companyCode, setCompanyCode] = useState("");
  const [msg, setMsg] = useState<string | null>(null);

  async function act(fn: () => Promise<unknown>) {
    setMsg(null);
    try {
      await fn();
      reload();
      reloadCompanies();
    } catch (e) {
      setMsg((e as Error).message);
    }
  }

  return (
    <div className="stack">
      {msg && <p className="error">{msg}</p>}
      <GoogleDomainCard onError={setMsg} />
      <div className="card">
        <div className="row" style={{ marginBottom: 8 }}>
          <h2 style={{ margin: 0 }}>{t("users.title")}</h2>
          <div className="spacer" />
          <button className="primary" onClick={() => setNewUser(true)}>
            {t("users.actions.add")}
          </button>
        </div>
        <table className="phone-cards">
          <thead>
            <tr>
              <th>{t("common:fields.name")}</th>
              <th>{t("common:fields.email")}</th>
              <th>{t("common:fields.company")}</th>
              <th style={{ width: 130 }}>{t("users.columns.systemAdmin")}</th>
              <th style={{ width: 230 }} />
            </tr>
          </thead>
          <tbody>
            {users?.map((u) => (
              <tr key={u.id}>
                <td className="pc-title">{u.name}</td>
                <td className="muted">{u.email}</td>
                <td data-label={t("common:fields.company")}>
                  <select
                    value={u.companyId ?? ""}
                    onChange={(e) => void act(() => api.updateUser(u.id, { companyId: e.target.value || null }))}
                  >
                    <option value="">{t("common:dash")}</option>
                    {companies?.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="pc-inline" data-label={t("users.columns.systemAdmin")}>
                  {u.isAdmin ? <span className="badge info">{t("common:actions.yes")}</span> : <span className="muted">{t("common:dash")}</span>}
                </td>
                <td className="row pc-actions">
                  <button
                    className="small"
                    onClick={() =>
                      void prompt({
                        title: t("users.actions.setPassword"),
                        message: t("users.passwordPrompt", { name: u.name }),
                        password: true,
                        confirmLabel: t("common:actions.save"),
                      }).then((pw) => {
                        if (pw) void act(() => api.updateUser(u.id, { password: pw }));
                      })
                    }
                  >
                    {t("users.actions.setPassword")}
                  </button>
                  {u.id !== me?.id && (
                    <button className="small" onClick={() => void act(() => api.updateUser(u.id, { isAdmin: !u.isAdmin }))}>
                      {u.isAdmin ? t("users.actions.revokeAdmin") : t("users.actions.makeAdmin")}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="card">
        <h2>{t("companies.title")}</h2>
        <p className="muted small" style={{ marginTop: 0 }}>
          {t("companies.help")}
        </p>
        <table className="phone-cards">
          <thead>
            <tr>
              <th>{t("common:fields.company")}</th>
              <th style={{ width: 140 }}>{t("companies.columns.shortCode")}</th>
              <th style={{ minWidth: 220 }}>{t("companies.columns.address")}</th>
              <th style={{ minWidth: 200 }}>{t("common:fields.email")}</th>
              <th style={{ width: 80 }}>{t("companies.columns.people")}</th>
            </tr>
          </thead>
          <tbody>
            {companies?.map((c) => (
              <tr key={c.id}>
                <td className="pc-title">{c.name}</td>
                <td data-label={t("companies.columns.shortCode")}>
                  <CompanyCodeInput key={c.code ?? ""} company={c} onSave={(code) => act(() => api.updateCompany(c.id, { code }))} />
                </td>
                <td data-label={t("companies.columns.address")}>
                  <CompanyTextInput
                    key={`a:${c.address ?? ""}`}
                    value={c.address ?? ""}
                    multiline
                    label={t("companies.fields.addressOf", { name: c.name })}
                    onSave={(address) => act(() => api.updateCompany(c.id, { address: address || null }))}
                  />
                </td>
                <td data-label={t("common:fields.email")}>
                  <CompanyTextInput
                    key={`e:${c.email ?? ""}`}
                    value={c.email ?? ""}
                    type="email"
                    label={t("companies.fields.emailOf", { name: c.name })}
                    onSave={(email) => act(() => api.updateCompany(c.id, { email: email || null }))}
                  />
                </td>
                <td className="pc-inline" data-label={t("companies.columns.people")}>
                  {users?.filter((u) => u.companyId === c.id).length ?? 0}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <form
          className="row wrap"
          style={{ marginTop: 12 }}
          onSubmit={(e) => {
            e.preventDefault();
            if (company.trim())
              void act(async () => {
                await api.createCompany(company.trim(), companyCode || null);
                setCompany("");
                setCompanyCode("");
              });
          }}
        >
          <input placeholder={t("companies.placeholder.name")} value={company} onChange={(e) => setCompany(e.target.value)} />
          <input
            placeholder={t("companies.placeholder.code")}
            value={companyCode}
            maxLength={8}
            style={{ width: 130 }}
            onChange={(e) => setCompanyCode(companyCodeInput(e.target.value))}
          />
          <button>{t("common:actions.add")}</button>
        </form>
      </div>
      {newUser && <NewUserDialog companies={companies ?? []} onClose={() => setNewUser(false)} onCreated={reload} />}
    </div>
  );
}

/** Inline code editor; saves on Enter or when leaving the field, Escape restores. */
function CompanyCodeInput({ company, onSave }: { company: CompanyDto; onSave(code: string | null): Promise<void> }) {
  const { t } = useTranslation(["admin", "common"]);
  const [value, setValue] = useState(company.code ?? "");
  const save = () => {
    if (value !== (company.code ?? "")) void onSave(value || null);
  };
  return (
    <input
      value={value}
      maxLength={8}
      placeholder={t("common:dash")}
      aria-label={t("companies.aria.shortCode", { name: company.name })}
      onChange={(e) => setValue(companyCodeInput(e.target.value))}
      onBlur={save}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          save();
        }
        if (e.key === "Escape") setValue(company.code ?? "");
      }}
    />
  );
}

/** Inline address / e-mail editor; saves when leaving the field (Enter saves a single-line field), Escape restores. */
function CompanyTextInput({
  value: initial,
  label,
  multiline,
  type = "text",
  onSave,
}: {
  value: string;
  label: string;
  multiline?: boolean;
  type?: string;
  onSave(v: string): Promise<void>;
}) {
  const { t } = useTranslation("common");
  const [value, setValue] = useState(initial);
  const save = () => {
    if (value.trim() !== initial) void onSave(value.trim());
  };
  const common = {
    value,
    placeholder: t("dash"),
    "aria-label": label,
    onBlur: save,
  };
  return multiline ? (
    <textarea
      {...common}
      rows={1}
      style={{ minHeight: 30, resize: "vertical" }}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => e.key === "Escape" && setValue(initial)}
    />
  ) : (
    <input
      {...common}
      type={type}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          save();
        }
        if (e.key === "Escape") setValue(initial);
      }}
    />
  );
}

function GoogleDomainCard({ onError }: { onError(message: string | null): void }) {
  const { t } = useTranslation(["admin", "common"]);
  const { data, reload } = useLoad(() => api.googleAuthSettings(), []);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  async function save(next: GoogleAuthSettings) {
    setBusy(true);
    onError(null);
    try {
      await api.updateGoogleAuthSettings(next);
      reload();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function addDomain() {
    const raw = draft.trim();
    if (!raw || !data) return;
    await save({ ...data, domains: [...data.domains, raw] });
    setDraft("");
  }

  if (!data) {
    return (
      <div className="card">
        <h2 style={{ margin: 0 }}>{t("googleDomain.title")}</h2>
        <LoadingIndicator />
      </div>
    );
  }
  return (
    <div className="card">
      <div className="row wrap" style={{ marginBottom: 8, gap: 12 }}>
        <div style={{ flex: "1 1 280px" }}>
          <h2 style={{ margin: 0 }}>{t("googleDomain.title")}</h2>
          <p className="muted small" style={{ margin: "6px 0 0" }}>
            {t("googleDomain.description")}
          </p>
        </div>
        <label className="row" style={{ color: "var(--text)", fontSize: 13, margin: 0 }}>
          <input
            type="checkbox"
            style={{ width: "auto" }}
            checked={data.domainAllowlistEnabled}
            disabled={busy}
            onChange={(e) => void save({ ...data, domainAllowlistEnabled: e.target.checked })}
          />{" "}
          {t("googleDomain.options.autoCreate")}
        </label>
      </div>
      <div className="row wrap" style={{ gap: 8 }}>
        {data.domains.length === 0 ? (
          <span className="muted small">{t("googleDomain.empty")}</span>
        ) : (
          data.domains.map((domain) => (
            <span key={domain} className="badge info" style={{ gap: 8 }}>
              @{domain}
              <button
                type="button"
                className="small"
                disabled={busy}
                onClick={() => void save({ ...data, domains: data.domains.filter((item) => item !== domain) })}
              >
                {t("common:actions.delete")}
              </button>
            </span>
          ))
        )}
      </div>
      <form
        className="row wrap"
        style={{ marginTop: 12 }}
        onSubmit={(e) => {
          e.preventDefault();
          void addDomain();
        }}
      >
        <input
          placeholder={t("googleDomain.placeholder")}
          value={draft}
          disabled={busy}
          onChange={(e) => setDraft(e.target.value)}
          aria-label={t("googleDomain.inputLabel")}
        />
        <button type="submit" disabled={busy || !draft.trim()}>
          {t("googleDomain.actions.addDomain")}
        </button>
      </form>
    </div>
  );
}

function NewUserDialog({ companies, onClose, onCreated }: { companies: CompanyDto[]; onClose(): void; onCreated(): void }) {
  const { t, i18n } = useTranslation(["admin", "common"]);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [companyId, setCompanyId] = useState("");
  const [isAdmin, setIsAdmin] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Kapasite (docs/onprem/kapasite.md §5): warn before the account pushes the server past its tier; never blocks.
  const { data: capacity } = useLoad(() => api.adminCapacity(), []);
  const after = capacity ? usersFinding(capacity.hardware, capacity.counts.registered + 1, i18n.language) : null;
  return (
    <Dialog title={t("newUser.title")} onClose={onClose}>
      {after && after.level !== "ok" && (
        <p className={after.level === "danger" ? "error" : "notice"} style={{ marginTop: 0 }} data-testid="capacity-user-warning">
          {t("newUser.capacityWarning", { finding: after.title, action: after.action })}
        </p>
      )}
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await api.createUser({ email, name, password, companyId: companyId || null, isAdmin });
            onCreated();
            onClose();
          } catch (err) {
            setError((err as Error).message);
          }
        }}
      >
        <label>{t("newUser.fields.fullName")}</label>
        <input value={name} onChange={(e) => setName(e.target.value)} required />
        <label>{t("common:fields.email")}</label>
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        <label>{t("newUser.fields.initialPassword")}</label>
        <input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        <label>{t("common:fields.company")}</label>
        <select value={companyId} onChange={(e) => setCompanyId(e.target.value)}>
          <option value="">{t("common:dash")}</option>
          {companies.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <label className="row" style={{ color: "var(--text)", fontSize: 13 }}>
          <input type="checkbox" style={{ width: "auto" }} checked={isAdmin} onChange={(e) => setIsAdmin(e.target.checked)} />{" "}
          {t("newUser.fields.systemAdmin")}
        </label>
        {error && <p className="error">{error}</p>}
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>
            {t("common:actions.cancel")}
          </button>
          <button className="primary">{t("common:actions.create")}</button>
        </div>
      </form>
    </Dialog>
  );
}
