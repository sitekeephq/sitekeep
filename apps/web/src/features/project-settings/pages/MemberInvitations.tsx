/**
 * Project Settings → Members: inviting people by e-mail (docs/features/INVITATIONS.md). An address
 * with an account is added at once; anyone else gets an invitation (e-mail, or a link for the
 * inviter to hand over). Open and expired invitations can be sent again or revoked.
 */
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  INVITATION_LANGUAGES,
  type CompanyDto,
  type InvitationDeliveryDto,
  type InvitationLanguage,
  type InvitationStatus,
  type ProjectRoleDto,
} from "@sitekeep/shared";
import { invitationsApi } from "../../../shared/api/api-invitations";
import { useLoad } from "../../../app/context/project";
import { useAsk } from "../../../shared/ui/Ask";
import { InvitationLink } from "../../../shared/ui/InvitationLink";
import { currentIntlLocale } from "../../../i18n";

const STATUS_BADGE: Record<InvitationStatus, string> = { open: "info", expired: "warn", accepted: "ok", revoked: "" };

export function MemberInvitations({
  projectId,
  companies,
  roles,
  onChanged,
}: {
  projectId: string;
  companies: CompanyDto[];
  roles: ProjectRoleDto[];
  onChanged(): void;
}) {
  const { t } = useTranslation(["projectSettings", "common"]);
  const { confirm } = useAsk();
  const { data, error, reload } = useLoad(() => invitationsApi.list(projectId), [projectId]);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [companyId, setCompanyId] = useState("");
  const [roleId, setRoleId] = useState("");
  const [teamId, setTeamId] = useState("");
  const [projectAdmin, setProjectAdmin] = useState(false);
  const [language, setLanguage] = useState<"" | InvitationLanguage>("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [result, setResult] = useState<{ email: string; text: string; delivery?: InvitationDeliveryDto } | null>(null);
  if (error || !data) return null;

  const plainRoles = roles.filter((r) => r.kind !== "task_team");
  const teams = roles.filter((r) => r.kind === "task_team");
  const date = (iso: string) => new Intl.DateTimeFormat(currentIntlLocale(), { dateStyle: "medium" }).format(new Date(iso));

  async function act(fn: () => Promise<void>) {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      reload();
      onChanged();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    const address = email.trim().toLowerCase();
    void act(async () => {
      const res = await invitationsApi.invite(projectId, {
        email: address,
        ...(name.trim() ? { name: name.trim() } : {}),
        ...(companyId ? { companyId } : {}),
        roleIds: [roleId, teamId].filter(Boolean),
        isProjectAdmin: projectAdmin,
        ...(language ? { language } : {}),
      });
      setResult(
        res.status === "added"
          ? { email: address, text: t("members.invite.added", { email: address }) }
          : { email: address, text: t("members.invite.invited", { email: address }), delivery: res.invitation },
      );
      setEmail("");
      setName("");
      setProjectAdmin(false);
    });
  }

  return (
    <section className="stack member-invitations" data-testid="member-invitations" style={{ marginTop: 16 }}>
      <h3 style={{ margin: 0 }}>{t("members.invite.heading")}</h3>
      {data.canInvite ? (
        <>
          <p className="muted small" style={{ margin: 0 }}>
            {data.mail.enabled ? t("members.invite.mailOn") : data.mail.configured ? t("members.invite.mailSwitchedOff") : t("members.invite.mailOff")}
          </p>
          <form className="row wrap" onSubmit={submit}>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder={t("members.invite.emailPlaceholder")}
              aria-label={t("members.invite.email")}
              style={{ flex: "2 1 220px" }}
            />
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("members.invite.namePlaceholder")}
              aria-label={t("members.invite.name")}
              maxLength={200}
              style={{ flex: "1 1 160px" }}
            />
            <select value={companyId} onChange={(e) => setCompanyId(e.target.value)} aria-label={t("members.invite.company")} style={{ flex: "1 1 160px" }}>
              <option value="">{t("members.invite.noCompany")}</option>
              {companies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <select value={roleId} onChange={(e) => setRoleId(e.target.value)} aria-label={t("members.invite.role")} style={{ flex: "1 1 160px" }}>
              <option value="">{t("members.invite.noRole")}</option>
              {plainRoles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
            {teams.length > 0 && (
              <select value={teamId} onChange={(e) => setTeamId(e.target.value)} aria-label={t("members.invite.team")} style={{ flex: "1 1 160px" }}>
                <option value="">{t("members.invite.teamFromCompany")}</option>
                {teams.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
            )}
            <select value={language} onChange={(e) => setLanguage(e.target.value as "" | InvitationLanguage)} aria-label={t("members.invite.language")}>
              <option value="">{t("members.invite.languageDefault")}</option>
              {INVITATION_LANGUAGES.map((l) => (
                <option key={l} value={l}>
                  {t(`members.invite.languages.${l}`)}
                </option>
              ))}
            </select>
            <label className="check">
              <input type="checkbox" checked={projectAdmin} onChange={(e) => setProjectAdmin(e.target.checked)} />
              {t("members.columns.projectAdmin")}
            </label>
            <button className="primary" disabled={busy || !email.trim()}>
              {t("members.invite.submit")}
            </button>
          </form>
        </>
      ) : (
        <p className="muted small" style={{ margin: 0 }}>
          {t("members.invite.notAllowed")}
        </p>
      )}
      {result && (
        <div className="notice small" role="status">
          <p style={{ margin: "0 0 6px" }}>{result.text}</p>
          {result.delivery && <InvitationLink email={result.email} delivery={result.delivery} />}
        </div>
      )}
      {msg && (
        <p className="error" role="alert">
          {msg}
        </p>
      )}
      {data.invitations.length > 0 && (
        <table className="phone-cards" data-testid="invitation-list">
          <thead>
            <tr>
              <th>{t("members.columns.email")}</th>
              <th>{t("members.columns.company")}</th>
              <th>{t("members.invite.status")}</th>
              <th>{t("members.invite.expires")}</th>
              <th style={{ width: 200 }} />
            </tr>
          </thead>
          <tbody>
            {data.invitations.map((i) => (
              <tr key={i.id} data-email={i.email} data-status={i.status}>
                <td className="pc-title">
                  {i.email}
                  {i.name && i.name !== i.email.split("@")[0] && <div className="muted small">{i.name}</div>}
                </td>
                <td data-label={t("members.columns.company")}>{i.companyName ?? "—"}</td>
                <td data-label={t("members.invite.status")}>
                  <span className={`badge ${STATUS_BADGE[i.status]}`}>{t(`members.invite.statuses.${i.status}`)}</span>
                  {i.mailedAt && i.status === "open" && <span className="muted small"> {t("members.invite.mailedOn", { date: date(i.mailedAt) })}</span>}
                </td>
                <td data-label={t("members.invite.expires")}>{i.status === "open" || i.status === "expired" ? date(i.expiresAt) : "—"}</td>
                <td className="row pc-actions">
                  {(i.status === "open" || i.status === "expired") && (
                    <>
                      {data.canInvite && (
                        <button
                          type="button"
                          className="small"
                          disabled={busy}
                          onClick={() =>
                            void act(async () => {
                              const delivery = await invitationsApi.resend(projectId, i.id);
                              setResult({ email: i.email, text: t("members.invite.resent", { email: i.email }), delivery });
                            })
                          }
                        >
                          {t("members.invite.resend")}
                        </button>
                      )}
                      <button
                        type="button"
                        className="small danger"
                        disabled={busy}
                        onClick={() =>
                          void confirm({
                            title: t("members.invite.revokeTitle"),
                            message: t("members.invite.revokeConfirm", { email: i.email }),
                            confirmLabel: t("members.invite.revoke"),
                            danger: true,
                          }).then((ok) => {
                            if (ok)
                              return act(async () => {
                                await invitationsApi.revoke(projectId, i.id);
                                setResult(null);
                              });
                          })
                        }
                      >
                        {t("members.invite.revoke")}
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
