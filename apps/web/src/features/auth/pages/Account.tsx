import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api, formatDate, type TokenScope } from "../../../shared/api/api";
import { useAuth } from "../../../app/context/auth";
import { useLoad } from "../../../app/context/project";
import { Snippet, mcpUrl } from "../../../shared/ai/AiBits";
import { webCapability } from "../../../sdk/capabilities";

import { oauthApi } from "../../../shared/api/api-oauth";
import { viewerAboutText } from "../../../shared/lib/about";
import { useAsk } from "../../../shared/ui/Ask";
import { useLabel } from "../../../i18n";


export function AccountPage() {
  const { t } = useTranslation(["auth", "common"]);
  const { user } = useAuth();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  return (
    <div className="page stack" style={{ maxWidth: 820 }}>
      <h1>{t("account.title")}</h1>
      <div className="card">
        <div>
          <strong>{user?.name}</strong>
        </div>
        <div className="muted">{user?.email}</div>
      </div>

      <TokensCard />

      <ConnectedAppsCard />

      <div className="card">
        <h2>{t("account.password.heading")}</h2>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              await api.changePassword(current, next);
              setMsg({ ok: true, text: t("account.password.messages.changed") });
              setCurrent("");
              setNext("");
            } catch (err) {
              setMsg({ ok: false, text: (err as Error).message });
            }
          }}
        >
          <label>{t("account.password.fields.current")}</label>
          <input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
          <label>{t("account.password.fields.next")}</label>
          <input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} required />
          {msg && <p className={msg.ok ? "success" : "error"}>{msg.text}</p>}
          <div className="dialog-actions">
            <button className="primary">{t("account.password.actions.change")}</button>
          </div>
        </form>
      </div>

      <div className="card">
        <h2>{t("account.about.heading")}</h2>
        <p className="small" style={{ margin: 0 }}>
          {viewerAboutText()}
        </p>
      </div>
    </div>
  );
}

function TokensCard() {
  const { t } = useTranslation(["auth", "common"]);
  const { confirm } = useAsk();
  const { data: tokens, reload } = useLoad(() => api.tokens(), []);
  const { data: policy } = useLoad(() => api.tokenPolicy(), []);
  const { data: projects } = useLoad(() => api.projects(), []);
  const [name, setName] = useState("");
  const [scope, setScope] = useState<TokenScope>("read");
  const [restrict, setRestrict] = useState(false);
  const [projectIds, setProjectIds] = useState<string[]>([]);
  const [days, setDays] = useState("90");
  const [newToken, setNewToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const projectCode = new Map(projects?.map((p) => [p.id, p.code]));
  const max = policy?.maxTokenDays ?? null;
  const dayOptions = [30, 90, 365].filter((d) => max === null || d <= max);
  if (max !== null && !dayOptions.includes(max)) dayOptions.push(max);
  const effectiveDays = max !== null && (days === "" || Number(days) > max) ? String(max) : days;

  async function create() {
    setError(null);
    if (restrict && projectIds.length === 0) {
      setError(t("tokens.errors.noProject"));
      return;
    }
    try {
      const created = await api.createToken({
        name,
        scope,
        projectIds: restrict ? projectIds : null,
        expiresInDays: effectiveDays ? Number(effectiveDays) : null,
      });
      setNewToken(created.token);
      setName("");
      reload();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className="card">
      <h2>{t("tokens.heading")}</h2>
      <p className="muted small" style={{ marginTop: 0 }}>
        {t("tokens.description")}
      </p>
      <table className="phone-cards">
        <tbody>
          {tokens?.map((tk) => {
            const expired = !!tk.expiresAt && new Date(tk.expiresAt).getTime() < Date.now();
            return (
              <tr key={tk.id}>
                <td>
                  {tk.name}
                  <div className="row wrap" style={{ gap: 4, marginTop: 2 }}>
                    {tk.scope === "write" ? <span className="badge warn">{t("tokens.badges.readWrite")}</span> : <span className="badge ok">{t("tokens.badges.readOnly")}</span>}
                    {tk.projectIds ? (
                      tk.projectIds.map((id) => (
                        <span key={id} className="badge info">
                          {projectCode.get(id) ?? "?"}
                        </span>
                      ))
                    ) : (
                      <span className="badge">{t("tokens.badges.allProjects")}</span>
                    )}
                  </div>
                </td>
                <td className="muted small">{t("tokens.createdOn", { date: formatDate(tk.createdAt) })}</td>
                <td className="muted small">
                  {tk.expiresAt ? (
                    expired ? (
                      <span className="badge danger">{t("tokens.badges.expired")}</span>
                    ) : (
                      t("tokens.expiresOn", { date: formatDate(tk.expiresAt) })
                    )
                  ) : (
                    t("tokens.noExpiry")
                  )}
                </td>
                <td className="muted small">{tk.lastUsedAt ? t("lastUsedOn", { date: formatDate(tk.lastUsedAt) }) : t("neverUsed")}</td>
                <td style={{ width: 80 }}>
                  <button
                    className="small danger"
                    onClick={() =>
                      void confirm({
                        title: t("tokens.revoke.title"),
                        message: t("tokens.revoke.confirm", { name: tk.name }),
                        confirmLabel: t("tokens.actions.revoke"),
                        danger: true,
                      }).then((ok) => {
                        if (ok) return api.deleteToken(tk.id).then(reload);
                      })
                    }
                  >
                    {t("tokens.actions.revoke")}
                  </button>
                </td>
              </tr>
            );
          })}
          {tokens?.length === 0 && (
            <tr>
              <td className="muted">{t("tokens.empty")}</td>
            </tr>
          )}
        </tbody>
      </table>

      {policy && !policy.canCreate && (
        <p className="notice" style={{ marginTop: 12 }}>
          {t("tokens.notAllowed", { reason: policy.reason })}
        </p>
      )}
      {policy?.canCreate && (
        <form
          style={{ marginTop: 12 }}
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <h3>{t("tokens.new.heading")}</h3>
          <label>{t("common:fields.name")}</label>
          <input placeholder={t("tokens.new.namePlaceholder")} value={name} onChange={(e) => setName(e.target.value)} required />
          <div className="row wrap" style={{ alignItems: "flex-start" }}>
            <div style={{ minWidth: 240, flex: 1 }}>
              <label>{t("tokens.new.fields.scope")}</label>
              <select value={scope} onChange={(e) => setScope(e.target.value as TokenScope)}>
                <option value="read">{t("tokens.badges.readOnly")}</option>
                <option value="write" disabled={!policy.allowWriteTokens}>
                  {policy.allowWriteTokens ? t("tokens.badges.readWrite") : t("tokens.new.readWriteBlocked")}
                </option>
              </select>
            </div>
            <div style={{ minWidth: 200, flex: 1 }}>
              <label>{t("tokens.new.fields.validity")}</label>
              <select value={effectiveDays} onChange={(e) => setDays(e.target.value)}>
                {dayOptions.map((d) => (
                  <option key={d} value={d}>
                    {t("tokens.new.days", { count: d })}
                  </option>
                ))}
                {max === null && <option value="">{t("tokens.noExpiry")}</option>}
              </select>
            </div>
          </div>
          <label className="check">
            <input type="checkbox" checked={restrict} onChange={(e) => setRestrict(e.target.checked)} /> {t("tokens.new.options.restrict")}
          </label>
          {restrict && (
            <div className="row wrap" style={{ gap: 12, marginBottom: 8 }}>
              {projects?.map((p) => (
                <label key={p.id} className="check" style={{ margin: 0 }}>
                  <input
                    type="checkbox"
                    checked={projectIds.includes(p.id)}
                    onChange={(e) => setProjectIds((ids) => (e.target.checked ? [...ids, p.id] : ids.filter((x) => x !== p.id)))}
                  />
                  <span className="badge info">{p.code}</span> {p.name}
                </label>
              ))}
            </div>
          )}
          {error && <p className="error">{error}</p>}
          <div className="dialog-actions" style={{ marginTop: 8 }}>
            <button className="primary">{t("common:actions.create")}</button>
          </div>
        </form>
      )}
      {newToken && (
        <div className="notice" style={{ marginTop: 12 }}>
          <div className="small">{t("tokens.new.copyNow")}</div>
          <code style={{ wordBreak: "break-all" }}>{newToken}</code>
          <div style={{ marginTop: 6 }}>
            <button className="small" onClick={() => void navigator.clipboard.writeText(newToken)}>
              {t("common:actions.copy")}
            </button>{" "}
            <button className="small ghost" onClick={() => setNewToken(null)}>
              {t("common:actions.close")}
            </button>
          </div>
        </div>
      )}
      {policy?.mcpEnabled && !!webCapability("ai.ui") /* MCP comes with the AI module */ && (
        <>
          <h3 style={{ marginTop: 16 }}>{t("tokens.connector.heading")}</h3>
          <p className="muted small" style={{ marginTop: 0 }}>
            {t("tokens.connector.description")}
          </p>
          <Snippet text={`npm run connector -w @sitekeep/mcp -- login cursor\nCDE_URL=${window.location.origin} CDE_TOKEN='<TOKEN>' npm run connector -w @sitekeep/mcp -- run --runtime cursor`} />
          <Snippet text={`claude auth login\nCDE_URL=${window.location.origin} CDE_TOKEN='<TOKEN>' npm run connector -w @sitekeep/mcp -- run --runtime claude`} />
          <h3 style={{ marginTop: 16 }}>{t("tokens.mcp.heading")}</h3>
          <p className="muted small" style={{ marginTop: 0 }}>
            {t("tokens.mcp.description")}
          </p>
          <Snippet text={`claude mcp add --transport http sitekeep ${mcpUrl()} --header "Authorization: Bearer <TOKEN>"`} />
        </>
      )}
    </div>
  );
}

/** OpenCDE applications (Solibri …) the user approved through OAuth (docs/features/OPENCDE.md). */
function ConnectedAppsCard() {
  const { t } = useTranslation(["auth", "common"]);
  const label = useLabel();
  const { confirm } = useAsk();
  const { data: apps, error, reload } = useLoad(() => oauthApi.connectedApps(), []);
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <div className="card">
      <h2>{t("apps.heading")}</h2>
      <p className="muted small" style={{ marginTop: 0 }}>
        {t("apps.description")}
      </p>
      {(msg || error) && <p className="error">{msg ?? error}</p>}
      <table className="phone-cards">
        <tbody>
          {apps?.map((a) => (
            <tr key={a.id}>
              <td className="pc-title">
                {a.name}
                <div className="row wrap" style={{ gap: 4, marginTop: 2 }}>
                  {a.scopes.map((s) => (
                    <span key={s} className="badge info">
                      {label("oauthScope", s)}
                    </span>
                  ))}
                  {!a.active && <span className="badge">{t("apps.badges.inactive")}</span>}
                </div>
              </td>
              <td className="muted small">{a.consentedAt ? t("apps.consentedOn", { date: formatDate(a.consentedAt) }) : ""}</td>
              <td className="muted small">{a.lastUsedAt ? t("lastUsedOn", { date: formatDate(a.lastUsedAt) }) : t("neverUsed")}</td>
              <td style={{ width: 130 }}>
                <button
                  className="small danger"
                  onClick={() =>
                    void confirm({
                      title: t("apps.actions.revoke"),
                      message: t("apps.revokeConfirm", { name: a.name }),
                      confirmLabel: t("common:actions.remove"),
                      danger: true,
                    }).then((ok) => {
                      if (ok) return oauthApi.revokeApp(a.id).then(reload, (e: Error) => setMsg(e.message));
                    })
                  }
                >
                  {t("apps.actions.revoke")}
                </button>
              </td>
            </tr>
          ))}
          {apps?.length === 0 && (
            <tr>
              <td className="muted">{t("apps.empty")}</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
