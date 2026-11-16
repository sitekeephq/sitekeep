/**
 * Delivery plan (ISO-7, docs/features/DELIVERY_PLAN.md): the master information delivery plan
 * (MIDP) with its milestones and filters, and one tab per task team with its task information
 * delivery plan (TIDP). Project administrators and a team's lead add, edit, import and delete rows;
 * the status of each row comes from the CDE.
 */
import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useSearchParams } from "react-router-dom";
import {
  DELIVERABLE_STATUSES,
  formatPlanTarget,
  milestoneHeader,
  type DeliverableDto,
  type DeliverableStatus,
  type DeliveryMilestoneDto,
  type DeliveryPlanDto,
  type DeliveryPlanImportReportDto,
  type DeliveryPlanTeamDto,
  type MemberDto,
  type ProjectRoleDto,
} from "@sitekeep/shared";
import { useLoad, useProject } from "../../app/context/project";
import { api } from "../../shared/api/api";
import { useAsk } from "../../shared/ui/Ask";
import { Dialog } from "../../shared/ui/Dialog";
import { Icon } from "../../shared/ui/Icon";
import { LoadingIndicator } from "../../shared/ui/LoadingIndicator";
import { deliveryPlanApi } from "./api";
import "./delivery-plan.css";

const STATUS_TONE: Record<DeliverableStatus, string> = { not_started: "", wip: "warn", shared: "info", published: "ok" };

type Msg = { ok: boolean; text: string } | null;

export function DeliveryPlanPage() {
  const { t } = useTranslation(["cde", "common"]);
  const project = useProject();
  const [params, setParams] = useSearchParams();
  const tab = params.get("team") ?? "";
  const plan = useLoad(() => deliveryPlanApi.plan(project.id), [project.id]);
  const [msg, setMsg] = useState<Msg>(null);
  const [editing, setEditing] = useState<DeliverableDto | "new" | null>(null);
  const [importing, setImporting] = useState(false);
  const data = plan.data;
  const team = data?.teams.find((x) => x.id === tab) ?? null;
  const setTab = (id: string) =>
    setParams(
      (p) => {
        if (id) p.set("team", id);
        else p.delete("team");
        return p;
      },
      { replace: true },
    );
  const editableTeams = data?.teams.filter((x) => x.canEdit) ?? [];

  return (
    <div className="page delivery-plan-page" data-testid="delivery-plan">
      <div className="page-header">
        <div>
          <h1>{t("deliveryPlan.title")}</h1>
          <p>{t("deliveryPlan.description")}</p>
        </div>
        <div className="row wrap">
          <a className="btn" href={deliveryPlanApi.exportUrl(project.id, "xlsx", team?.id)} download data-testid="delivery-export-xlsx">
            <Icon name="download" size={14} /> {t("deliveryPlan.export.xlsx")}
          </a>
          <a className="btn" href={deliveryPlanApi.exportUrl(project.id, "csv", team?.id)} download data-testid="delivery-export-csv">
            {t("deliveryPlan.export.csv")}
          </a>
          {editableTeams.length > 0 && (
            <button type="button" onClick={() => setImporting(true)} data-testid="delivery-import">
              <Icon name="upload" size={14} /> {t("deliveryPlan.import.button")}
            </button>
          )}
          {editableTeams.length > 0 && (
            <button type="button" className="primary" onClick={() => setEditing("new")} data-testid="delivery-add">
              <Icon name="plus" size={14} /> {t("deliveryPlan.deliverable.add")}
            </button>
          )}
        </div>
      </div>

      {msg && (
        <div className={msg.ok ? "success" : "error"} role="status">
          {msg.text}
        </div>
      )}
      {plan.error && <div className="error">{plan.error}</div>}
      {!data && !plan.error && <LoadingIndicator />}
      {data && (
        <>
          {!data.teams.length && <div className="card muted">{data.canManage ? t("deliveryPlan.noTeams") : t("deliveryPlan.notMember")}</div>}
          <nav className="tabs delivery-tabs" aria-label={t("deliveryPlan.tabs.label")}>
            <a href="#" className={!team ? "active" : ""} onClick={(e) => (e.preventDefault(), setTab(""))} data-testid="delivery-tab-midp">
              {t("deliveryPlan.tabs.midp")}
            </a>
            {data.teams.map((x) => (
              <a key={x.id} href="#" className={team?.id === x.id ? "active" : ""} onClick={(e) => (e.preventDefault(), setTab(x.id))} data-testid="delivery-tab-team">
                {t("deliveryPlan.tabs.tidp", { team: x.code || x.name })}
                {x.late > 0 && <span className="badge danger delivery-tab-late">{x.late}</span>}
              </a>
            ))}
          </nav>
          {!team && <Milestones plan={data} reload={plan.reload} setMsg={setMsg} />}
          {team && <TeamHead team={team} canManage={data.canManage} reload={plan.reload} setMsg={setMsg} />}
          <DeliverableTable plan={data} team={team} onEdit={setEditing} reload={plan.reload} setMsg={setMsg} />
        </>
      )}

      {data && editing && (
        <DeliverableDialog
          plan={data}
          row={editing === "new" ? null : editing}
          defaultTeam={team && team.canEdit ? team.id : (editableTeams[0]?.id ?? "")}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            setMsg({ ok: true, text: t("deliveryPlan.deliverable.saved") });
            plan.reload();
          }}
        />
      )}
      {data && importing && (
        <ImportDialog
          teams={editableTeams}
          defaultTeam={team && team.canEdit ? team.id : ""}
          onClose={() => setImporting(false)}
          onDone={(r) => {
            setImporting(false);
            setMsg({ ok: true, text: t("deliveryPlan.import.done", { created: r.created, updated: r.updated }) });
            plan.reload();
          }}
        />
      )}
    </div>
  );
}

function Milestones({ plan, reload, setMsg }: { plan: DeliveryPlanDto; reload(): void; setMsg(m: Msg): void }) {
  const { t } = useTranslation("cde");
  const project = useProject();
  const { confirm } = useAsk();
  const [editing, setEditing] = useState<DeliveryMilestoneDto | "new" | null>(null);
  const remove = async (m: DeliveryMilestoneDto) => {
    if (!(await confirm({ title: t("deliveryPlan.milestones.edit"), message: t("deliveryPlan.milestones.deleteConfirm", { name: m.name }), danger: true }))) return;
    try {
      await deliveryPlanApi.deleteMilestone(project.id, m.id);
      reload();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    }
  };
  return (
    <section className="card delivery-milestones" data-testid="delivery-milestones">
      <div className="row">
        <h2>{t("deliveryPlan.milestones.heading")}</h2>
        <span className="spacer" />
        {plan.canManage && (
          <button type="button" className="ghost" onClick={() => setEditing("new")} data-testid="delivery-milestone-add">
            <Icon name="plus" size={14} /> {t("deliveryPlan.milestones.add")}
          </button>
        )}
      </div>
      {!plan.milestones.length && <p className="muted">{t("deliveryPlan.milestones.none")}</p>}
      <ol className="delivery-milestone-list">
        {plan.milestones.map((m) => (
          <li key={m.id}>
            <strong>{milestoneHeader(m)}</strong>
            <span className="muted">{m.dueDate ?? t("deliveryPlan.milestones.noDate")}</span>
            {plan.canManage && (
              <>
                <button type="button" className="ghost" aria-label={t("deliveryPlan.milestones.edit")} onClick={() => setEditing(m)}>
                  <Icon name="pen" size={14} />
                </button>
                <button type="button" className="ghost" aria-label={t("deliveryPlan.deliverable.delete")} onClick={() => void remove(m)}>
                  <Icon name="trash" size={14} />
                </button>
              </>
            )}
          </li>
        ))}
      </ol>
      {editing && (
        <MilestoneDialog
          milestone={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            reload();
          }}
        />
      )}
    </section>
  );
}

function MilestoneDialog({ milestone, onClose, onSaved }: { milestone: DeliveryMilestoneDto | null; onClose(): void; onSaved(): void }) {
  const { t } = useTranslation("cde");
  const project = useProject();
  const [code, setCode] = useState(milestone?.code ?? "");
  const [name, setName] = useState(milestone?.name ?? "");
  const [dueDate, setDueDate] = useState(milestone?.dueDate ?? "");
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    const body = { code: code.trim() || null, name: name.trim(), dueDate: dueDate || null };
    try {
      if (milestone) await deliveryPlanApi.updateMilestone(project.id, milestone.id, body);
      else await deliveryPlanApi.addMilestone(project.id, body);
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <Dialog title={t(milestone ? "deliveryPlan.milestones.edit" : "deliveryPlan.milestones.add")} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <label htmlFor="ms-code">{t("deliveryPlan.milestones.code")}</label>
        <input id="ms-code" value={code} maxLength={20} onChange={(e) => setCode(e.target.value)} />
        <label htmlFor="ms-name">{t("deliveryPlan.milestones.name")}</label>
        <input id="ms-name" value={name} required maxLength={200} onChange={(e) => setName(e.target.value)} />
        <label htmlFor="ms-date">{t("deliveryPlan.milestones.dueDate")}</label>
        <input id="ms-date" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="row dialog-actions">
          <span className="spacer" />
          <button type="button" onClick={onClose}>
            {t("deliveryPlan.cancel")}
          </button>
          <button type="submit" className="primary" disabled={!name.trim()}>
            {t("deliveryPlan.deliverable.save")}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function TeamHead({ team, canManage, reload, setMsg }: { team: DeliveryPlanTeamDto; canManage: boolean; reload(): void; setMsg(m: Msg): void }) {
  const { t } = useTranslation("cde");
  const project = useProject();
  const people = useLoad(
    () => (canManage ? Promise.all([api.roles(project.id), api.members(project.id)]) : Promise.resolve<[ProjectRoleDto[], MemberDto[]]>([[], []])),
    [project.id, canManage],
  );
  const memberIds = new Set(people.data?.[0].find((r) => r.id === team.id)?.memberIds ?? []);
  const members = (people.data?.[1] ?? []).filter((m) => memberIds.has(m.userId));
  const setLead = async (userId: string) => {
    try {
      await deliveryPlanApi.setLead(project.id, team.id, userId || null);
      reload();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    }
  };
  return (
    <section className="card delivery-team" data-testid="delivery-team">
      <div className="row wrap">
        <h2>{team.name}</h2>
        {team.code && <span className="badge">{team.code}</span>}
        <span className="spacer" />
        <label htmlFor="delivery-lead" className="delivery-inline-label">
          {t("deliveryPlan.lead.label")}
        </label>
        {canManage ? (
          <select id="delivery-lead" value={team.leadUserId ?? ""} onChange={(e) => void setLead(e.target.value)} data-testid="delivery-lead">
            <option value="">{t("deliveryPlan.lead.none")}</option>
            {members.map((m) => (
              <option key={m.userId} value={m.userId}>
                {m.name}
              </option>
            ))}
            {team.leadUserId && !memberIds.has(team.leadUserId) && <option value={team.leadUserId}>{team.leadName ?? team.leadUserId}</option>}
          </select>
        ) : (
          <span id="delivery-lead">{team.leadName ?? t("deliveryPlan.lead.none")}</span>
        )}
      </div>
      <p className="field-hint">{t("deliveryPlan.lead.hint")}</p>
    </section>
  );
}

function DeliverableTable({
  plan,
  team,
  onEdit,
  reload,
  setMsg,
}: {
  plan: DeliveryPlanDto;
  team: DeliveryPlanTeamDto | null;
  onEdit(d: DeliverableDto): void;
  reload(): void;
  setMsg(m: Msg): void;
}) {
  const { t } = useTranslation("cde");
  const project = useProject();
  const { confirm } = useAsk();
  const [q, setQ] = useState("");
  const [teamFilter, setTeamFilter] = useState("");
  const [status, setStatus] = useState<DeliverableStatus | "">("");
  const [lateOnly, setLateOnly] = useState(false);
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return plan.deliverables.filter(
      (d) =>
        (team ? d.teamId === team.id : !teamFilter || d.teamId === teamFilter) &&
        (!status || d.status === status) &&
        (!lateOnly || d.late) &&
        (!needle || d.code.toLowerCase().includes(needle) || d.title.toLowerCase().includes(needle)),
    );
  }, [plan.deliverables, team, teamFilter, status, lateOnly, q]);
  const scoped = team ? plan.deliverables.filter((d) => d.teamId === team.id) : plan.deliverables;
  const remove = async (d: DeliverableDto) => {
    if (!(await confirm({ title: t("deliveryPlan.deliverable.delete"), message: t("deliveryPlan.deliverable.deleteConfirm", { code: d.code }), danger: true }))) return;
    try {
      await deliveryPlanApi.deleteDeliverable(project.id, d.id);
      reload();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    }
  };
  return (
    <section className="delivery-table-wrap">
      <div className="row wrap delivery-filters">
        <input type="search" placeholder={t("deliveryPlan.filters.search")} aria-label={t("deliveryPlan.filters.search")} value={q} onChange={(e) => setQ(e.target.value)} />
        {!team && (
          <select aria-label={t("deliveryPlan.filters.team")} value={teamFilter} onChange={(e) => setTeamFilter(e.target.value)} data-testid="delivery-filter-team">
            <option value="">{t("deliveryPlan.filters.allTeams")}</option>
            {plan.teams.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </select>
        )}
        <select aria-label={t("deliveryPlan.filters.status")} value={status} onChange={(e) => setStatus(e.target.value as DeliverableStatus | "")} data-testid="delivery-filter-status">
          <option value="">{t("deliveryPlan.filters.allStatuses")}</option>
          {DELIVERABLE_STATUSES.map((s) => (
            <option key={s} value={s}>
              {t(`deliveryPlan.statuses.${s}`)}
            </option>
          ))}
        </select>
        <label className="check delivery-inline-label">
          <input type="checkbox" checked={lateOnly} onChange={(e) => setLateOnly(e.target.checked)} data-testid="delivery-filter-late" /> {t("deliveryPlan.filters.late")}
        </label>
        <span className="spacer" />
        <span className="muted small">{t("deliveryPlan.summary", { count: scoped.length, late: scoped.filter((d) => d.late).length })}</span>
      </div>
      {!rows.length ? (
        <div className="card muted">{scoped.length ? t("deliveryPlan.emptyFiltered") : t("deliveryPlan.empty")}</div>
      ) : (
        <div className="delivery-scroll">
          <table className="data-table delivery-table" data-testid="delivery-table">
            <thead>
              <tr>
                <th>{t("deliveryPlan.columns.code")}</th>
                <th>{t("deliveryPlan.columns.title")}</th>
                {!team && <th>{t("deliveryPlan.columns.team")}</th>}
                <th>{t("deliveryPlan.columns.discipline")}</th>
                <th>{t("deliveryPlan.columns.docType")}</th>
                {plan.milestones.map((m) => (
                  <th key={m.id} title={m.dueDate ?? undefined}>
                    {m.code || m.name}
                  </th>
                ))}
                <th>{t("deliveryPlan.columns.dueShared")}</th>
                <th>{t("deliveryPlan.columns.duePublished")}</th>
                <th>{t("deliveryPlan.columns.status")}</th>
                <th>{t("deliveryPlan.columns.document")}</th>
                <th aria-label={t("deliveryPlan.columns.actions")} />
              </tr>
            </thead>
            <tbody>
              {rows.map((d) => (
                <tr key={d.id} data-testid="delivery-row" data-code={d.code} className={d.late ? "delivery-late" : undefined}>
                  <td className="mono">{d.code}</td>
                  <td>{d.title}</td>
                  {!team && <td>{d.teamName ?? <span className="muted">{t("deliveryPlan.noTeam")}</span>}</td>}
                  <td>{d.discipline}</td>
                  <td>{d.docType}</td>
                  {plan.milestones.map((m) => (
                    <td key={m.id} className="mono">
                      {formatPlanTarget(d.targets.find((x) => x.milestoneId === m.id))}
                    </td>
                  ))}
                  <td className={d.late === "shared" ? "delivery-due-late" : undefined}>{d.dueShared}</td>
                  <td className={d.late === "published" ? "delivery-due-late" : undefined}>{d.duePublished}</td>
                  <td>
                    <span className={`badge ${STATUS_TONE[d.status]}`} data-testid="delivery-status">
                      {t(`deliveryPlan.statuses.${d.status}`)}
                    </span>
                    {d.late && (
                      <span className="badge danger delivery-late-badge" data-testid="delivery-late">
                        {t(`deliveryPlan.late.${d.late}`)}
                      </span>
                    )}
                  </td>
                  <td>
                    <DocumentCell d={d} pid={project.id} />
                  </td>
                  <td className="delivery-actions">
                    {d.canEdit && (
                      <>
                        <button type="button" className="ghost" aria-label={t("deliveryPlan.deliverable.edit")} onClick={() => onEdit(d)}>
                          <Icon name="pen" size={14} />
                        </button>
                        <button type="button" className="ghost" aria-label={t("deliveryPlan.deliverable.delete")} onClick={() => void remove(d)}>
                          <Icon name="trash" size={14} />
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function DocumentCell({ d, pid }: { d: DeliverableDto; pid: string }) {
  const { t } = useTranslation("cde");
  if (!d.document) return <span className="muted small">{t("deliveryPlan.notRegistered")}</span>;
  const codes = [d.document.revisionCode, d.document.suitabilityCode].filter(Boolean).join(" · ");
  if (!d.document.fileId) return <span className="muted small">{[t("deliveryPlan.notVisible"), codes].filter(Boolean).join(" · ")}</span>;
  return (
    <span className="small">
      <Link to={`/projects/${pid}/files/${d.document.folderId}?file=${d.document.fileId}`} data-testid="delivery-document">
        {d.document.name}
      </Link>
      {codes && <span className="muted"> · {codes}</span>}
    </span>
  );
}

function DeliverableDialog({
  plan,
  row,
  defaultTeam,
  onClose,
  onSaved,
}: {
  plan: DeliveryPlanDto;
  row: DeliverableDto | null;
  defaultTeam: string;
  onClose(): void;
  onSaved(): void;
}) {
  const { t } = useTranslation("cde");
  const project = useProject();
  const teams = plan.teams.filter((x) => x.canEdit || x.id === row?.teamId);
  const [form, setForm] = useState({
    teamId: row?.teamId ?? defaultTeam,
    code: row?.code ?? "",
    title: row?.title ?? "",
    discipline: row?.discipline ?? "",
    docType: row?.docType ?? "",
    dueShared: row?.dueShared ?? "",
    duePublished: row?.duePublished ?? "",
    notes: row?.notes ?? "",
  });
  const [targets, setTargets] = useState<Record<string, { suitabilityCode: string; revisionCode: string }>>(() =>
    Object.fromEntries(plan.milestones.map((m) => {
      const x = row?.targets.find((y) => y.milestoneId === m.id);
      return [m.id, { suitabilityCode: x?.suitabilityCode ?? "", revisionCode: x?.revisionCode ?? "" }];
    })),
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const field = (k: keyof typeof form) => ({ value: form[k], onChange: (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value })) });
  const save = async () => {
    setBusy(true);
    setError(null);
    const body = {
      teamId: form.teamId,
      code: form.code.trim(),
      title: form.title.trim(),
      discipline: form.discipline.trim() || null,
      docType: form.docType.trim() || null,
      dueShared: form.dueShared || null,
      duePublished: form.duePublished || null,
      notes: form.notes.trim() || null,
      targets: plan.milestones.map((m) => ({
        milestoneId: m.id,
        suitabilityCode: targets[m.id]?.suitabilityCode.trim() || null,
        revisionCode: targets[m.id]?.revisionCode.trim() || null,
      })),
    };
    try {
      if (row) await deliveryPlanApi.updateDeliverable(project.id, row.id, body);
      else await deliveryPlanApi.addDeliverable(project.id, body);
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title={t(row ? "deliveryPlan.deliverable.edit" : "deliveryPlan.deliverable.add")} onClose={onClose} wide>
      <form
        data-testid="delivery-form"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="delivery-form-grid">
          <div>
            <label htmlFor="dl-team">{t("deliveryPlan.columns.team")}</label>
            <select id="dl-team" required {...field("teamId")}>
              {teams.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="dl-code">{t("deliveryPlan.columns.code")}</label>
            <input id="dl-code" required maxLength={200} className="mono" {...field("code")} />
            <p className="field-hint">{t("deliveryPlan.deliverable.codeHint")}</p>
          </div>
          <div className="delivery-form-wide">
            <label htmlFor="dl-title">{t("deliveryPlan.columns.title")}</label>
            <input id="dl-title" required maxLength={500} {...field("title")} />
          </div>
          <div>
            <label htmlFor="dl-discipline">{t("deliveryPlan.columns.discipline")}</label>
            <input id="dl-discipline" maxLength={100} {...field("discipline")} />
          </div>
          <div>
            <label htmlFor="dl-type">{t("deliveryPlan.columns.docType")}</label>
            <input id="dl-type" maxLength={100} {...field("docType")} />
          </div>
          <div>
            <label htmlFor="dl-shared">{t("deliveryPlan.columns.dueShared")}</label>
            <input id="dl-shared" type="date" {...field("dueShared")} />
          </div>
          <div>
            <label htmlFor="dl-published">{t("deliveryPlan.columns.duePublished")}</label>
            <input id="dl-published" type="date" {...field("duePublished")} />
          </div>
        </div>
        {plan.milestones.length > 0 && (
          <fieldset className="delivery-targets">
            <legend>{t("deliveryPlan.deliverable.targets")}</legend>
            {plan.milestones.map((m) => (
              <div key={m.id} className="row">
                <span className="delivery-target-name">{milestoneHeader(m)}</span>
                <input
                  aria-label={`${milestoneHeader(m)} ${t("deliveryPlan.deliverable.suitability")}`}
                  placeholder={t("deliveryPlan.deliverable.suitability")}
                  maxLength={20}
                  value={targets[m.id]?.suitabilityCode ?? ""}
                  onChange={(e) => setTargets((x) => ({ ...x, [m.id]: { ...x[m.id]!, suitabilityCode: e.target.value } }))}
                />
                <input
                  aria-label={`${milestoneHeader(m)} ${t("deliveryPlan.deliverable.revision")}`}
                  placeholder={t("deliveryPlan.deliverable.revision")}
                  maxLength={20}
                  value={targets[m.id]?.revisionCode ?? ""}
                  onChange={(e) => setTargets((x) => ({ ...x, [m.id]: { ...x[m.id]!, revisionCode: e.target.value } }))}
                />
              </div>
            ))}
          </fieldset>
        )}
        <label htmlFor="dl-notes">{t("deliveryPlan.deliverable.notes")}</label>
        <textarea id="dl-notes" rows={2} maxLength={2000} {...field("notes")} />
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="row dialog-actions">
          <span className="spacer" />
          <button type="button" onClick={onClose}>
            {t("deliveryPlan.cancel")}
          </button>
          <button type="submit" className="primary" disabled={busy || !form.teamId || !form.code.trim() || !form.title.trim()}>
            {t("deliveryPlan.deliverable.save")}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsDataURL(file);
  });
}

function ImportDialog({
  teams,
  defaultTeam,
  onClose,
  onDone,
}: {
  teams: DeliveryPlanTeamDto[];
  defaultTeam: string;
  onClose(): void;
  onDone(r: DeliveryPlanImportReportDto): void;
}) {
  const { t } = useTranslation("cde");
  const project = useProject();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<{ name: string; content: string } | null>(null);
  const [teamId, setTeamId] = useState(defaultTeam);
  const [report, setReport] = useState<DeliveryPlanImportReportDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (dryRun: boolean) => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const r = await deliveryPlanApi.importFile(project.id, { fileName: file.name, content: file.content, teamId: teamId || null, dryRun });
      if (r.applied) onDone(r);
      else setReport(r);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title={t("deliveryPlan.import.title")} onClose={onClose} wide>
      <p className="muted small">{t("deliveryPlan.import.hint")}</p>
      <label htmlFor="dl-import-file">{t("deliveryPlan.import.file")}</label>
      <input
        id="dl-import-file"
        ref={input}
        type="file"
        accept=".csv,.xlsx,.txt,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        data-testid="delivery-import-file"
        onChange={async (e) => {
          const f = e.target.files?.[0];
          setReport(null);
          setFile(f ? { name: f.name, content: await readBase64(f) } : null);
        }}
      />
      <label htmlFor="dl-import-team">{t("deliveryPlan.import.into")}</label>
      <select id="dl-import-team" value={teamId} onChange={(e) => (setTeamId(e.target.value), setReport(null))}>
        <option value="">—</option>
        {teams.map((x) => (
          <option key={x.id} value={x.id}>
            {x.name}
          </option>
        ))}
      </select>
      {report && (
        <div className="stack delivery-import-report" data-testid="delivery-import-report">
          <p>{t("deliveryPlan.import.report", { created: report.created, updated: report.updated, unchanged: report.unchanged })}</p>
          {report.errors.length > 0 && (
            <div className="error" role="alert">
              <p>{t("deliveryPlan.import.errors")}</p>
              <ul>
                {report.errors.map((e) => (
                  <li key={`${e.row}:${e.message}`}>
                    {t("deliveryPlan.import.row", { row: e.row })}: {e.message}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="row dialog-actions">
        <span className="spacer" />
        <button type="button" onClick={onClose}>
          {t("deliveryPlan.cancel")}
        </button>
        <button type="button" disabled={!file || busy} onClick={() => void run(true)} data-testid="delivery-import-check">
          {t("deliveryPlan.import.check")}
        </button>
        <button
          type="button"
          className="primary"
          disabled={!file || busy || !report || report.errors.length > 0}
          onClick={() => void run(false)}
          data-testid="delivery-import-apply"
        >
          {t("deliveryPlan.import.apply")}
        </button>
      </div>
    </Dialog>
  );
}
