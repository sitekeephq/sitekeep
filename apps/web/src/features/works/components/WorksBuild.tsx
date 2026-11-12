/**
 * RFI, submittal and meeting extras inside the "İşler" detail panel: the workflow panel of works; Manage adds package items, meetings, registers and the spec import
 * (manage.ui). Same CSS classes as Works.tsx; kept plain on purpose.
 */
import { useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router-dom";
import { type CompanyDto, type MemberDto, type WorkDetailDto, type WorkFlowStepDto } from "@sitekeep/shared";
import { formatDate, intlLocale } from "../../../shared/api/api";
import { buildApi } from "../../../shared/api/api-works";
import { useAsk } from "../../../shared/ui/Ask";
import { useProject } from "../../../app/context/project";
import { webCapability } from "../../../sdk/capabilities";

const STEP_STATE: Record<WorkFlowStepDto["state"], [string, string]> = {
  done: ["✓", "ok"],
  current: ["⧗", "warn"],
  pending: ["·", ""],
  returned: ["✗", "danger"],
  skipped: ["–", ""],
};

export function BuildPanel({
  w,
  members,
  companies,
  onChanged,
}: {
  w: WorkDetailDto;
  members: MemberDto[];
  companies: CompanyDto[];
  onChanged(): void;
}) {
  const { t } = useTranslation(["works", "common"]);
  const project = useProject();
  const { confirm } = useAsk();
  const navigate = useNavigate();
  // Submittal package items and the meeting box are Manage's.
  const manage = webCapability("manage.ui");
  const b = w.build;
  const [msg, setMsg] = useState<string | null>(null);
  const [comment, setComment] = useState("");
  if (!b) return null;
  const n = (id: string) => w.names[id] ?? companies.find((c) => c.id === id)?.name ?? "?";

  async function act(fn: () => Promise<unknown>) {
    setMsg(null);
    try {
      await fn();
      onChanged();
    } catch (e) {
      setMsg((e as Error).message);
    }
  }

  return (
    <div style={{ marginTop: 12 }}>
      <div className="row wrap">
        {(b.category === "submittal" || b.revisions.length > 0) && <span className="badge info">{t("build.badges.rev", { rev: b.rev })}</span>}
        {b.ballInCourt.length > 0 && <span className="badge warn">{t("build.badges.ballInCourt", { names: b.ballInCourt.map(n).join(", ") })}</span>}
        {b.parent && (
          <span className="small">
            <Trans
              t={t}
              i18nKey="build.parent"
              values={{ number: b.parent.number }}
              components={{ link: <Link to={`/projects/${project.id}/works/${b.parent.id}`} /> }}
            />
          </span>
        )}
      </div>
      {(b.canSubmit || b.canRevise || b.canCancel) && (
        <div className="row wrap" style={{ marginTop: 8 }}>
          {b.canSubmit && (
            <>
              <input style={{ flex: 1, minWidth: 160 }} placeholder={t("build.submitNotePlaceholder")} value={comment} onChange={(e) => setComment(e.target.value)} />
              <button className="primary" onClick={() => void act(() => buildApi.submit(project.id, w.id, comment))}>
                {b.category === "submittal_package" ? t("build.actions.submitItems") : t("build.actions.submit")}
              </button>
            </>
          )}
          {b.canRevise && (
            <button onClick={() => void act(() => buildApi.revise(project.id, w.id))}>{t("build.actions.revise", { rev: b.rev + 1 })}</button>
          )}
          {b.canCancel && (
            <button
              className="danger"
              onClick={() =>
                void confirm({
                  title: t("build.cancel.title"),
                  message: t("build.cancel.confirm"),
                  confirmLabel: t("letter.actions.cancel"),
                  danger: true,
                }).then((ok) => {
                  if (ok) return act(() => buildApi.cancel(project.id, w.id));
                })
              }
            >
              {t("letter.actions.cancel")}
            </button>
          )}
        </div>
      )}
      {msg && <p className="error">{msg}</p>}

      {b.category === "rfi" && (
        <div className="card" style={{ marginTop: 12 }}>
          <h3 style={{ marginTop: 0 }}>{t("build.rfi.question")}</h3>
          <p style={{ whiteSpace: "pre-wrap" }}>{String(w.fields.soru ?? "—")}</p>
          {w.fields.onerilen_cozum ? (
            <>
              <h3>{t("build.rfi.proposedSolution")}</h3>
              <p style={{ whiteSpace: "pre-wrap" }}>{String(w.fields.onerilen_cozum)}</p>
            </>
          ) : null}
          <h3>{t("build.rfi.officialResponse")}</h3>
          {b.officialResponse ? (
            <p style={{ whiteSpace: "pre-wrap", borderLeft: "3px solid var(--ok, #1a7f37)", paddingLeft: 10 }}>{b.officialResponse}</p>
          ) : (
            <p className="muted">{t("build.rfi.notAnswered")}</p>
          )}
        </div>
      )}

      {b.workflow && <FlowBox w={w} onChanged={onChanged} />}

      {b.revisions.length > 1 || (b.category === "submittal" && b.revisions.length > 0) ? (
        <div style={{ marginTop: 12 }}>
          <h3>{t("build.revisions.title")}</h3>
          <table className="phone-cards">
            <thead>
              <tr>
                <th style={{ width: 44 }}>{t("build.columns.rev")}</th>
                <th>{t("build.columns.submission")}</th>
                <th>{t("common:fields.result")}</th>
                <th>{t("common:fields.attachments")}</th>
              </tr>
            </thead>
            <tbody>
              {[...b.revisions].reverse().map((r) => (
                <tr key={r.id}>
                  <td className="mono">{r.rev}</td>
                  <td className="small">
                    {formatDate(r.submittedAt)} · {r.submittedByName}
                    {r.comment && <div className="muted">{r.comment}</div>}
                  </td>
                  <td className="small">
                    {r.status === "running" ? <span className="badge warn">{t("build.revisions.inReview")}</span> : r.status === "cancelled" ? t("build.revisions.cancelled") : r.outcomeLabel}
                    {r.decidedAt && <div className="muted">{formatDate(r.decidedAt)}</div>}
                    {r.steps
                      .flatMap((s) => s.answers)
                      .filter((x) => x.comment)
                      .map((x, i) => (
                        <div key={i} className="muted">
                          {x.userName}: {x.comment}
                        </div>
                      ))}
                  </td>
                  <td className="small">{r.attachments.map((x) => `${x.name} V${x.version}`).join(", ") || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {b.category === "submittal_package" && manage && <manage.PackageItems w={w} onChanged={onChanged} />}

      {b.category === "meeting" && b.meeting && manage && (
        <manage.MeetingBox
          w={w}
          members={members}
          companies={companies}
          onChanged={onChanged}
          onNext={async () => {
            setMsg(null);
            try {
              const r = await buildApi.nextMeeting(project.id, w.id);
              onChanged();
              navigate(`/projects/${project.id}/works/${r.id}`);
            } catch (e) {
              setMsg((e as Error).message);
            }
          }}
        />
      )}
    </div>
  );
}

function FlowBox({ w, onChanged }: { w: WorkDetailDto; onChanged(): void }) {
  const { t } = useTranslation(["works", "common"]);
  const project = useProject();
  const f = w.build!.workflow!;
  const [outcome, setOutcome] = useState(f.options[0]?.code ?? "");
  const [comment, setComment] = useState("");
  const [response, setResponse] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const kind = f.options.find((o) => o.code === outcome)?.kind;
  const needsResponse = f.needsResponse && kind !== "revise" && kind !== "rejected";

  async function send() {
    setMsg(null);
    try {
      await buildApi.respond(project.id, w.id, { outcome, comment: comment || null, response: response || null });
      onChanged();
    } catch (e) {
      setMsg((e as Error).message);
    }
  }

  return (
    <div style={{ marginTop: 12 }}>
      <h3>
        {t("build.flow.title", { rev: f.rev })} <span className="muted small">({f.templateName})</span>
      </h3>
      {f.steps.map((s) => (
        <div key={s.index} className="small" style={{ padding: "4px 0", borderBottom: "1px solid var(--border, #e5e7eb)" }}>
          <span className={`badge ${STEP_STATE[s.state][1]}`}>{STEP_STATE[s.state][0]}</span> <strong>{s.name}</strong>{" "}
          <span className="muted">{s.assignees.join(", ")}</span>
          {s.dueAt && <span className={s.overdue ? "error" : "muted"}> · {t("build.flow.due", { date: new Date(s.dueAt).toLocaleDateString(intlLocale()) })}</span>}
          {s.answers.map((x, i) => (
            <div key={i} style={{ marginLeft: 22 }}>
              {x.userName}
              {x.onBehalfOf.length > 0 && <span className="muted"> ({t("build.flow.onBehalfOf", { names: x.onBehalfOf.join(", ") })})</span>}: <strong>{x.label}</strong>
              {x.comment && <span> — {x.comment}</span>}
              {x.response && <div style={{ whiteSpace: "pre-wrap" }}>“{x.response}”</div>}
            </div>
          ))}
        </div>
      ))}
      {f.canAct && (
        <div className="card" style={{ marginTop: 8 }}>
          <label>{t("common:fields.result")}{f.actingFor.length > 0 && <span className="muted"> · {t("build.flow.onBehalfOf", { names: f.actingFor.join(", ") })}</span>}</label>
          <div className="row wrap">
            {f.options.map((o) => (
              <button key={o.code} className={outcome === o.code ? "primary small" : "small"} onClick={() => setOutcome(o.code)}>
                {o.label}
              </button>
            ))}
          </div>
          {f.needsResponse && (
            <>
              <label>{needsResponse ? t("build.flow.fields.officialResponseRequired") : t("build.rfi.officialResponse")}</label>
              <textarea rows={4} value={response} onChange={(e) => setResponse(e.target.value)} />
            </>
          )}
          <label>{t("common:fields.comment")}</label>
          <textarea rows={2} value={comment} onChange={(e) => setComment(e.target.value)} />
          {msg && <p className="error">{msg}</p>}
          <div className="row">
            <div className="spacer" />
            <button className="primary" disabled={!outcome || (needsResponse && !response.trim())} onClick={() => void send()}>
              {t("build.flow.actions.respond")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
