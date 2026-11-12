/**
 * Yönetim → OAuth Uygulamaları: OpenCDE clients (Solibri, IfcOpenShell, BCF tools) that connect
 * with the user's consent and the user's own permissions (docs/features/OPENCDE.md).
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AECPILOT_OAUTH_PRESET,
  OAUTH_SCOPES,
  oauthClientTypeHint,
  type OAuthClientDto,
  type OAuthClientType,
  type OAuthEndpointsDto,
  type OAuthScope,
} from "@sitekeep/shared";
import { api, formatDate } from "../../../shared/api/api";
import { oauthApi } from "../../../shared/api/api-oauth";
import { i18n, useLabel, label } from "../../../i18n";
import { Snippet } from "../../../shared/ai/AiBits";
import { webCapability } from "../../../sdk/capabilities";
import type { McpSettings } from "../../../shared/api/api";
import { useAsk } from "../../../shared/ui/Ask";
import { Dialog } from "../../../shared/ui/Dialog";
import { useLoad } from "../../../app/context/project";

function CopyValue({ value }: { value: string }) {
  const { t } = useTranslation("common");
  const [copied, setCopied] = useState(false);
  return (
    <div className="row" style={{ gap: 8, minWidth: 0 }}>
      <code>{value}</code>
      <button
        type="button"
        className="small"
        onClick={() =>
          void navigator.clipboard.writeText(value).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          })
        }
      >
        {copied ? t("status.copied") : t("actions.copy")}
      </button>
    </div>
  );
}

/** What an OpenCDE client's connection form asks for (Solibri "private connection" and others). */
function connectionValues(e: OAuthEndpointsDto, client?: OAuthClientDto): [string, string][] {
  return [
    [i18n.t("admin:oauth.values.baseUrl"), e.baseUrl],
    [i18n.t("admin:oauth.values.versions"), e.versionsUrl],
    [i18n.t("admin:oauth.values.auth"), e.authUrl],
    [i18n.t("admin:oauth.values.token"), e.tokenUrl],
    ...(client
      ? ([
          [i18n.t("admin:oauth.values.clientId"), client.clientId],
          ...client.redirectUris.map((u): [string, string] => [i18n.t("admin:oauth.values.redirect"), u]),
        ] as [string, string][])
      : []),
  ];
}

export function AdminOAuthSection() {
  const { t } = useTranslation(["admin", "common"]);
  const label = useLabel();
  const { confirm } = useAsk();
  const { data, error, reload } = useLoad(() => oauthApi.clients(), []);
  const [editing, setEditing] = useState<OAuthClientDto | "new" | null>(null);
  const [info, setInfo] = useState<OAuthClientDto | null>(null);
  const [secret, setSecret] = useState<{ name: string; value: string } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  async function act(fn: () => Promise<unknown>) {
    setMsg(null);
    try {
      await fn();
      reload();
    } catch (e) {
      setMsg((e as Error).message);
    }
  }

  const endpoints = data?.endpoints;
  return (
    <div className="stack">
      {(msg || error) && <p className="error">{msg ?? error}</p>}
      {!webCapability("ai.ui") && <TokenPolicyCard />}
      <div className="card">
        <h2>{t("oauth.connection.title")}</h2>
        <p className="muted small" style={{ marginTop: 0 }}>
          {t("oauth.connection.description")}
        </p>
        {endpoints && (
          <div className="oauth-values">
            {connectionValues(endpoints).map(([name, value]) => (
              <Pair key={name} label={name} value={value} />
            ))}
          </div>
        )}
        {endpoints && !endpoints.configured && (
          <p className="notice small" style={{ marginTop: 12 }}>
            {t("oauth.connection.notConfigured")}
          </p>
        )}
      </div>

      {secret && (
        <div className="notice">
          <div className="small">{t("oauth.secretNotice", { name: secret.name })}</div>
          <CopyValue value={secret.value} />
          <button className="small ghost" style={{ marginTop: 6 }} onClick={() => setSecret(null)}>
            {t("common:actions.close")}
          </button>
        </div>
      )}

      <div className="card">
        <div className="row" style={{ marginBottom: 8 }}>
          <h2 style={{ margin: 0 }}>{t("oauth.apps.title")}</h2>
          <div className="spacer" />
          {data && !data.clients.some((c) => c.redirectUris.includes(AECPILOT_OAUTH_PRESET.redirectUris[0]!)) && (
            <button
              title={t("oauth.apps.aecPilotHint")}
              onClick={() =>
                void act(async () => {
                  const r = await oauthApi.createClient(AECPILOT_OAUTH_PRESET);
                  setInfo(r.client);
                })
              }
            >
              {t("oauth.apps.actions.addAecPilot")}
            </button>
          )}
          <button className="primary" onClick={() => setEditing("new")}>
            {t("oauth.apps.actions.add")}
          </button>
        </div>
        <p className="muted small" style={{ marginTop: 0 }}>
          {t("oauth.apps.description")}
        </p>
        <table className="phone-cards">
          <thead>
            <tr>
              <th>{t("oauth.apps.columns.app")}</th>
              <th>{t("oauth.apps.columns.clientId")}</th>
              <th>{t("oauth.apps.columns.scopes")}</th>
              <th>{t("oauth.apps.columns.usage")}</th>
              <th style={{ width: 260 }} />
            </tr>
          </thead>
          <tbody>
            {data?.clients.map((c) => (
              <tr key={c.id}>
                <td className="pc-title">
                  {c.name}
                  <div className="row wrap" style={{ gap: 4, marginTop: 2 }}>
                    <span className="badge">{label("oauthClientType", c.type)}</span>
                    {!c.enabled && <span className="badge danger">{t("oauth.apps.badges.disabled")}</span>}
                  </div>
                  {c.description && <div className="muted small">{c.description}</div>}
                </td>
                <td>
                  <code className="small">{c.clientId}</code>
                </td>
                <td>
                  <div className="row wrap" style={{ gap: 4 }}>
                    {c.scopes.map((s) => (
                      <span key={s} className="badge info">
                        {label("oauthScope", s)}
                      </span>
                    ))}
                  </div>
                </td>
                <td className="muted small">
                  {t("oauth.apps.users", { count: c.userCount })}
                  <div>{c.lastUsedAt ? t("oauth.apps.lastUsed", { date: formatDate(c.lastUsedAt) }) : t("oauth.apps.neverUsed")}</div>
                </td>
                <td>
                  <div className="row wrap" style={{ gap: 4 }}>
                    <button className="small" onClick={() => setInfo(c)}>
                      {t("oauth.apps.actions.connectionDetails")}
                    </button>
                    <button className="small" onClick={() => setEditing(c)}>
                      {t("common:actions.edit")}
                    </button>
                    <button className="small" onClick={() => void act(() => oauthApi.updateClient(c.id, { enabled: !c.enabled }))}>
                      {c.enabled ? t("oauth.apps.actions.disable") : t("oauth.apps.actions.enable")}
                    </button>
                    {c.type === "confidential" && (
                      <button
                        className="small"
                        onClick={() =>
                          void confirm({
                            title: t("oauth.apps.rotateTitle"),
                            message: t("oauth.apps.rotateConfirm", { name: c.name }),
                            confirmLabel: t("oauth.apps.actions.regenerate"),
                            danger: true,
                          }).then((ok) => {
                            if (ok)
                              return act(async () => {
                                const r = await oauthApi.rotateSecret(c.id);
                                setSecret({ name: c.name, value: r.clientSecret });
                              });
                          })
                        }
                      >
                        {t("oauth.apps.actions.rotate")}
                      </button>
                    )}
                    <button
                      className="small danger"
                      onClick={() =>
                        void confirm({
                          title: t("oauth.apps.deleteTitle"),
                          message: t("oauth.apps.deleteConfirm", { name: c.name }),
                          confirmLabel: t("common:actions.delete"),
                          danger: true,
                        }).then((ok) => {
                          if (ok) return act(() => oauthApi.deleteClient(c.id));
                        })
                      }
                    >
                      {t("common:actions.delete")}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {data?.clients.length === 0 && (
              <tr>
                <td className="muted">{t("oauth.apps.empty")}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {editing && (
        <ClientDialog
          client={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(name, clientSecret) => {
            setEditing(null);
            if (clientSecret) setSecret({ name, value: clientSecret });
            reload();
          }}
        />
      )}
      {info && endpoints && (
        <Dialog title={t("oauth.info.title", { name: info.name })} onClose={() => setInfo(null)} wide>
          <p className="muted small" style={{ marginTop: 0 }}>
            {t("oauth.info.description")}
            {info.type === "confidential" && ` ${t("oauth.info.secretHint")}`}
          </p>
          <div className="oauth-values">
            {connectionValues(endpoints, info).map(([name, value], i) => (
              <Pair key={`${name}-${i}`} label={name} value={value} />
            ))}
          </div>
          <h3 style={{ marginTop: 16 }}>{t("oauth.info.copyAll.title")}</h3>
          <Snippet text={connectionValues(endpoints, info).map(([l, v]) => `${l}: ${v}`).join("\n")} />
        </Dialog>
      )}
    </div>
  );
}

function Pair({ label, value }: { label: string; value: string }) {
  return (
    <>
      <span className="muted small">{label}</span>
      <CopyValue value={value} />
    </>
  );
}

function ClientDialog({
  client,
  onClose,
  onSaved,
}: {
  client: OAuthClientDto | null;
  onClose(): void;
  onSaved(name: string, clientSecret: string | null): void;
}) {
  const { t, i18n } = useTranslation(["admin", "common"]);
  const label = useLabel();
  const [name, setName] = useState(client?.name ?? "");
  const [description, setDescription] = useState(client?.description ?? "");
  const [type, setType] = useState<OAuthClientType>(client?.type ?? "public");
  const [redirects, setRedirects] = useState((client?.redirectUris ?? []).join("\n"));
  const [scopes, setScopes] = useState<OAuthScope[]>(client?.scopes ?? ["bcf", "read"]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    setError(null);
    const redirectUris = redirects
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    try {
      if (client) {
        await oauthApi.updateClient(client.id, { name, description: description || null, redirectUris, scopes });
        onSaved(name, null);
      } else {
        const r = await oauthApi.createClient({ name, description: description || null, type, redirectUris, scopes });
        onSaved(name, r.clientSecret);
      }
    } catch (e) {
      const body = (e as { body?: { details?: { message?: string }[] } }).body;
      setError(body?.details?.map((d) => d.message).filter(Boolean).join(" ") || (e as Error).message);
      setBusy(false);
    }
  }

  return (
    <Dialog title={client ? t("oauth.dialog.editTitle") : t("oauth.dialog.newTitle")} onClose={onClose} wide>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <label>{t("common:fields.name")}</label>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("oauth.dialog.placeholder.name")} required maxLength={100} />
        <label>{t("common:fields.description")}</label>
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={t("oauth.dialog.placeholder.description")}
          maxLength={500}
        />
        {!client && (
          <>
            <label>{t("common:fields.type")}</label>
            <div className="stack" style={{ gap: 6 }}>
              {(["public", "confidential"] as const).map((kind) => (
                <label key={kind} className="check" style={{ margin: 0 }}>
                  <input type="radio" name="client-type" checked={type === kind} onChange={() => setType(kind)} /> {label("oauthClientType", kind)}
                  <span className="muted small"> — {oauthClientTypeHint(kind, i18n.language)}</span>
                </label>
              ))}
            </div>
          </>
        )}
        <label>{t("oauth.dialog.fields.redirects")}</label>
        <textarea
          rows={3}
          value={redirects}
          onChange={(e) => setRedirects(e.target.value)}
          placeholder={t("oauth.dialog.placeholder.redirects")}
          required
        />
        <p className="muted small" style={{ marginTop: 4 }}>
          {t("oauth.dialog.redirectHelp")}
        </p>
        <label>{t("oauth.dialog.fields.scopes")}</label>
        <div className="row wrap" style={{ gap: 12 }}>
          {OAUTH_SCOPES.map((s) => (
            <label key={s} className="check" style={{ margin: 0 }}>
              <input
                type="checkbox"
                checked={scopes.includes(s)}
                onChange={(e) => setScopes((list) => (e.target.checked ? [...list, s] : list.filter((x) => x !== s)))}
              />{" "}
              {label("oauthScope", s)}
            </label>
          ))}
        </div>
        <p className="muted small" style={{ marginTop: 4 }}>
          {t("oauth.dialog.scopesHelp")}
        </p>
        {error && <p className="error">{error}</p>}
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>
            {t("common:actions.cancel")}
          </button>
          <button className="primary" disabled={busy || !scopes.length}>
            {t("common:actions.save")}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

/**
 * API access token policy (who creates tokens, write tokens, lifetime) for installations without the
 * AI module; with it the policy sits on "Yapay Zekâ ve MCP" next to the MCP switch.
 */
function TokenPolicyCard() {
  const { t } = useTranslation("admin");
  const { data, setData, error } = useLoad(() => api.adminSettings(), []);
  const [msg, setMsg] = useState<string | null>(null);
  const mcp = data?.mcp;
  async function save(s: Partial<McpSettings>) {
    setMsg(null);
    try {
      setData(await api.updateMcpSettings(s));
    } catch (e) {
      setMsg((e as Error).message);
    }
  }
  if (!mcp) return error ? <p className="error">{error}</p> : null;
  return (
    <div className="card stack">
      <h2 style={{ margin: 0 }}>{t("oauth.tokens.title")}</h2>
      {msg && <p className="error">{msg}</p>}
      <label className="check">
        <input type="checkbox" checked={mcp.allowWriteTokens} onChange={(e) => void save({ allowWriteTokens: e.target.checked })} />
        {t("ai.queue.options.allowWrite")}
      </label>
      <div className="row wrap" style={{ alignItems: "flex-end" }}>
        <div style={{ minWidth: 240 }}>
          <label>{t("ai.queue.fields.tokenCreators")}</label>
          <select value={mcp.tokenCreators} onChange={(e) => void save({ tokenCreators: e.target.value as McpSettings["tokenCreators"] })}>
            <option value="everyone">{t("ai.queue.options.everyone")}</option>
            <option value="project_admins">{t("ai.queue.options.projectAdmins")}</option>
            <option value="admins">{t("ai.queue.options.admins")}</option>
          </select>
        </div>
        <div style={{ minWidth: 180 }}>
          <label>{t("ai.queue.fields.maxTokenDays")}</label>
          <select value={mcp.maxTokenDays ?? ""} onChange={(e) => void save({ maxTokenDays: e.target.value ? Number(e.target.value) : null })}>
            <option value="">{t("ai.queue.options.unlimited")}</option>
            {[30, 90, 180, 365].map((d) => (
              <option key={d} value={d}>
                {t("ai.queue.days", { count: d })}
              </option>
            ))}
          </select>
        </div>
      </div>
    </div>
  );
}
