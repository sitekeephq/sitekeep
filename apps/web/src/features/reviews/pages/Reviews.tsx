import { useEffect, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  OUTCOME_TONE,
  chainCellSymbol,
  chainText,
  docCompareKind,
  stepOutcomeOptions,
  type ChainCellDto,
  type OnBehalfOfDto,
  type OutcomeCode,
  type ReviewDetailDto,
  type WorkflowActionDto,
  type WorkflowAssignee,
  type WorkflowStatus,
} from "@sitekeep/shared";
import { api, formatDate, intlLocale } from "../../../shared/api/api";
import { i18n, label, labelEntries, useLabel } from "../../../i18n";
import { useLoad, useProject } from "../../../app/context/project";
import { useAsk } from "../../../shared/ui/Ask";
import { Dialog } from "../../../shared/ui/Dialog";
import { AssigneePicker, assigneeLabel } from "../../../shared/ui/AssigneePicker";
import { AttributeInput } from "../../../shared/ui/AttributeInput";
import { reportBuilderUrl, ReportShortcut } from "../../documents/components/ReportShortcut";
import { useEmbedded } from "../../../app/context/embedded";
import { RecordCards, usePhoneWidth } from "../../../shared/ui/RecordCards";
import { MoreMenu } from "../../../shared/ui/MoreMenu";
import { LoadingIndicator } from "../../../shared/ui/LoadingIndicator";

const STATUS_CLASS: Record<WorkflowStatus, string> = { running: "warn", completed: "ok", cancelled: "" };

export function OutcomeBadge({ code, label }: { code: OutcomeCode | null | undefined; label?: string | null }) {
  const outcomeLabel = useLabel();
  if (!code) return <span className="muted">—</span>;
  return <span className={`badge ${OUTCOME_TONE[code]}`}>{label || outcomeLabel("outcome", code)}</span>;
}

const CELL_TONE: Record<ChainCellDto["state"], string> = { done: "ok", current: "warn", pending: "", returned: "danger", skipped: "" };

/** Per-file chain: Tasarımcı ✓ → Yüklenici ✓ → Müşavir ⧗ → İdare ·. */
export function ChainCells({ cells }: { cells: ChainCellDto[] | undefined }) {
  const { t } = useTranslation("reviews");
  if (!cells?.length) return null;
  return (
    <span className="row wrap" style={{ gap: 2 }} title={chainText(cells)}>
      {cells.map((c, i) => (
        <span key={i} className="row" style={{ gap: 2 }}>
          {i > 0 && <span className="muted small">→</span>}
          <span
            className={`badge ${c.overdue ? "danger" : c.state === "done" && c.outcome ? OUTCOME_TONE[c.outcome] : CELL_TONE[c.state]}`}
            title={[c.name, c.label, c.dueAt ? t("chain.due", { date: new Date(c.dueAt).toLocaleDateString(intlLocale()) }) : null]
              .filter(Boolean)
              .join(" · ")}
          >
            {c.name} {chainCellSymbol(c)}
          </span>
        </span>
      ))}
    </span>
  );
}

function dueText(iso: string | null): { text: string; overdue: boolean } | null {
  if (!iso) return null;
  const d = new Date(iso);
  return { text: d.toLocaleDateString(intlLocale()), overdue: d.getTime() < Date.now() };
}

export function ReviewsPage() {
  const { rid } = useParams();
  return rid ? <ReviewDetail key={rid} reviewId={rid} /> : <ReviewList />;
}

function ReviewList() {
  const { t } = useTranslation(["reviews", "common"]);
  const { t: ts } = useTranslation("shell");
  const statusLabel = useLabel();
  const project = useProject();
  const navigate = useNavigate();
  const embedded = useEmbedded();
  // The status filter lives in the URL (?durum=…), so the İşler hub can save it as a view.
  const [search, setSearch] = useSearchParams();
  const status = search.get("durum") ?? "";
  const setStatus = (v: string) =>
    setSearch(
      (p) => {
        if (v) p.set("durum", v);
        else p.delete("durum");
        p.delete("gorunum");
        return p;
      },
      { replace: true },
    );
  const { data: reviews, error } = useLoad(() => api.reviews(project.id, status || undefined), [project.id, status, embedded?.refreshKey]);
  const phone = usePhoneWidth();

  return (
    <div className="page" style={{ maxWidth: "none" }}>
      <div className="row wrap" style={{ marginBottom: 12 }}>
        {!embedded && <h1 style={{ margin: 0 }}>{ts("nav.hubViews.incelemeler")}</h1>}
        <div className="spacer" />
        <select style={{ width: "min(180px, 100%)", flex: "1 1 140px" }} value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">{t("list.options.allStatuses")}</option>
          {labelEntries("workflowStatus").map(([s, text]) => (
            <option key={s} value={s}>
              {text}
            </option>
          ))}
        </select>
        {phone ? (
          <>
            <Link className="btn" to={`/projects/${project.id}/files`}>
              {t("list.actions.newFromDocuments")}
            </Link>
            <MoreMenu
              items={[{ key: "report", label: t("list.actions.report") }]}
              onSelect={(key) => {
                if (key === "report") navigate(reportBuilderUrl(project.id, "reviews"));
              }}
            />
          </>
        ) : (
          <>
            <ReportShortcut module="reviews" />
            <Link className="btn" to={`/projects/${project.id}/files`}>
              {t("list.actions.newFromDocuments")}
            </Link>
          </>
        )}
      </div>
      {error && <p className="error">{error}</p>}
      {phone ? (
        <RecordCards
          label={ts("nav.hubViews.incelemeler")}
          onOpen={(id) => navigate(`/projects/${project.id}/reviews/${id}`)}
          emptyText={reviews ? t("list.empty") : null}
          groups={[
            {
              key: "",
              label: "",
              rows: (reviews ?? []).map((r) => ({
                id: r.id,
                number: r.code ?? `#${r.number}`,
                title: r.name,
                meta: [r.templateName, r.status === "running" ? `${r.stepIndex + 1}/${r.stepCount} · ${r.stepName}` : null],
                status: { label: statusLabel("workflowStatus", r.status), tone: STATUS_CLASS[r.status] },
                due: r.status === "running" ? dueText(r.stepDueAt) : null,
                chips: r.myTurn ? [{ label: t("list.badges.myTurn"), tone: "info" }] : [],
              })),
            },
          ]}
        />
      ) : (
        <div className="card" style={{ padding: 0 }}>
          <table>
            <thead>
              <tr>
                <th style={{ width: 120 }}>{t("list.columns.number")}</th>
                <th>{t("common:fields.name")}</th>
                <th style={{ width: 120 }}>{t("common:fields.status")}</th>
                <th style={{ width: 220 }}>{t("list.columns.step")}</th>
                <th style={{ width: 100 }}>{t("common:fields.dueDate")}</th>
                <th style={{ width: 70 }}>{t("common:fields.file")}</th>
                <th style={{ width: 150 }}>{t("list.columns.startedBy")}</th>
                <th style={{ width: 120 }}>{t("common:fields.date")}</th>
              </tr>
            </thead>
            <tbody>
              {reviews?.map((r) => {
                const due = r.status === "running" ? dueText(r.stepDueAt) : null;
                return (
                  <tr key={r.id} className="clickable" onClick={() => navigate(`/projects/${project.id}/reviews/${r.id}`)}>
                    <td className="muted">{r.code ?? `#${r.number}`}</td>
                    <td>
                      {r.name}
                      {r.myTurn && (
                        <span className="badge info" style={{ marginLeft: 6 }}>
                          {t("list.badges.myTurn")}
                        </span>
                      )}
                      <div className="muted small">{r.templateName}</div>
                    </td>
                    <td>
                      <span className={`badge ${STATUS_CLASS[r.status]}`}>{statusLabel("workflowStatus", r.status)}</span>
                    </td>
                    <td className="small">
                      {r.status === "running" ? `${r.stepIndex + 1}/${r.stepCount} · ${r.stepName}` : "—"}
                    </td>
                    <td className={`small${due?.overdue ? " error" : " muted"}`}>
                      {due?.text ?? "—"}
                      {due?.overdue && (
                        <span className="badge danger" style={{ marginLeft: 4 }}>
                          {t("list.badges.overdue")}
                        </span>
                      )}
                    </td>
                    <td className="muted">{r.fileCount}</td>
                    <td className="muted">{r.startedByName}</td>
                    <td className="muted small">{formatDate(r.createdAt)}</td>
                  </tr>
                );
              })}
              {reviews?.length === 0 && (
                <tr>
                  <td colSpan={8} className="muted" style={{ textAlign: "center", padding: 32 }}>
                    {t("list.empty")}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ReviewDetail({ reviewId }: { reviewId: string }) {
  const { t } = useTranslation(["reviews", "common"]);
  const { t: ts } = useTranslation("shell");
  const statusLabel = useLabel();
  const { prompt } = useAsk();
  const project = useProject();
  const { data: review, error, setData } = useLoad(() => api.review(project.id, reviewId), [project.id, reviewId]);
  const [dialog, setDialog] = useState<"reassign" | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  if (error) return <div className="page error">{error}</div>;
  if (!review) return <LoadingIndicator className="page" />;
  const r = review;
  const due = r.status === "running" ? dueText(r.stepDueAt) : null;

  async function cancel() {
    const reason = await prompt({
      title: t("detail.cancel.title"),
      message: t("detail.cancel.message"),
      confirmLabel: t("detail.actions.cancel"),
    });
    if (reason === null) return;
    setMsg(null);
    try {
      setData(await api.cancelReview(project.id, r.id, reason));
    } catch (e) {
      setMsg((e as Error).message);
    }
  }

  return (
    <div className="page" style={{ maxWidth: "none" }}>
      <div className="muted small detail-back">
        <Link to={`/projects/${project.id}/reviews`}>← {ts("nav.hubViews.incelemeler")}</Link>
      </div>
      <div className="row wrap" style={{ margin: "6px 0 12px" }}>
        <h1 style={{ margin: 0 }}>
          {r.code ? (r.code === r.name ? r.code : `${r.code} · ${r.name}`) : `#${r.number} ${r.name}`}
        </h1>
        <span className={`badge ${STATUS_CLASS[r.status]}`}>{statusLabel("workflowStatus", r.status)}</span>
        {due && <span className={`badge ${due.overdue ? "danger" : ""}`}>{t("chain.due", { date: due.text })}</span>}
        <div className="spacer" />
        {r.canReassign && <button onClick={() => setDialog("reassign")}>{t("detail.actions.reassign")}</button>}
        {r.canCancel && (
          <button className="danger" onClick={() => void cancel()}>
            {t("detail.actions.cancel")}
          </button>
        )}
      </div>
      <div className="muted small">
        {r.templateName} · {r.startedByName} · {formatDate(r.createdAt)}
        {r.targetFolderPath && (
          <>
            {" "}
            · {t("detail.approvedTo")} <strong>{r.targetFolderPath}</strong>
            {r.targetPattern && <span className="mono"> / {r.targetPattern}</span>}
          </>
        )}
      </div>
      {r.note && <p style={{ whiteSpace: "pre-wrap" }}>{r.note}</p>}
      {msg && <p className="error">{msg}</p>}

      <StepBar review={r} />

      {r.canAct ? (
        <ActForm review={r} onDone={setData} />
      ) : (
        <FilesTable review={r} />
      )}

      <div className="row wrap review-detail-split">
        <div className="card">
          <h3>{t("detail.marks.title")}</h3>
          {r.marks.length === 0 && <p className="muted small">{t("detail.marks.empty")}</p>}
          {r.steps.map((s, i) => {
            const marks = r.marks.filter((m) => m.stepIndex === i);
            if (!marks.length) return null;
            return (
              <div key={i} style={{ marginBottom: 12 }}>
                <div className="small" style={{ fontWeight: 600 }}>
                  {i + 1}. {s.name}
                </div>
                <table className="phone-cards">
                  <tbody>
                    {marks.map((m) => (
                      <tr key={`${m.reviewFileId}${m.userId}`}>
                        <td className="pc-title" style={{ width: 160 }}>
                          {m.userName}
                          {behalfText(m.onBehalfOf) && <div className="muted small">{behalfText(m.onBehalfOf)}</div>}
                        </td>
                        <td data-label={t("common:fields.file")}>{r.files.find((f) => f.id === m.reviewFileId)?.fileName}</td>
                        <td data-label={t("common:fields.result")} style={{ width: 150 }}>
                          <OutcomeBadge code={m.outcome} label={m.label} />
                        </td>
                        <td className="small" data-label={t("common:fields.comment")}>{m.comment}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          })}
        </div>
        <div className="card">
          <h3>{t("detail.timeline.title")}</h3>
          {r.actions.map((x) => (
            <div key={x.id} style={{ borderBottom: "1px solid var(--border)", padding: "6px 0" }}>
              <div className="small">
                <strong>{actionText(x, r)}</strong>
              </div>
              <div className="muted small">
                {x.userName ?? t("detail.timeline.system")}
                {behalfText(x.onBehalfOf) && (
                  <>
                    {" "}
                    <span className="badge info">{behalfText(x.onBehalfOf)}</span>
                  </>
                )}{" "}
                · {formatDate(x.at)}
              </div>
              {x.comment && <div className="small" style={{ whiteSpace: "pre-wrap" }}>{x.comment}</div>}
            </div>
          ))}
        </div>
      </div>

      {dialog === "reassign" && (
        <ReassignDialog
          review={r}
          onClose={() => setDialog(null)}
          onSaved={(d) => {
            setData(d);
            setDialog(null);
          }}
        />
      )}
    </div>
  );
}

/** "Mimari Ekip adına" / "MSV firması adına" — the team or company an answer was given for. */
export function behalfText(list: OnBehalfOfDto[] | undefined): string | null {
  if (!list?.length) return null;
  const t = i18n.getFixedT(null, "reviews");
  const names = list
    .map((b) =>
      b.type === "company"
        ? t("behalf.company", { name: b.name ?? "?" })
        : b.id === "project_admin"
          ? t("behalf.projectAdmins")
          : t("behalf.team", { name: b.name ?? t("behalf.deletedRole") }),
    )
    .join(", ");
  return t("behalf.onBehalfOf", { names });
}

function actionText(x: WorkflowActionDto, r: ReviewDetailDto): string {
  const t = i18n.getFixedT(null, "reviews");
  const step = r.steps[x.stepIndex]?.name ?? t("actions.stepN", { n: x.stepIndex + 1 });
  switch (x.kind) {
    case "start":
      return t("actions.start");
    case "submit":
      return x.outcome
        ? t("actions.submitWithOutcome", { step, outcome: label("outcome", x.outcome) })
        : t("actions.submit", { step });
    case "step_completed": {
      const returned = x.details?.returned;
      if (Array.isArray(returned) && returned.length)
        return t("actions.stepCompletedReturned", { step, count: returned.length });
      return t("actions.stepCompleted", { step });
    }
    case "completed":
      return t("actions.completed");
    case "cancel":
      return t("actions.cancel");
    case "reassign":
      return t("actions.reassign", { step });
    case "note":
      return t("actions.note");
    default:
      return x.kind;
  }
}

function StepBar({ review: r }: { review: ReviewDetailDto }) {
  const { t } = useTranslation("reviews");
  const label = useLabel();
  return (
    <div className="row wrap" style={{ gap: 8, margin: "16px 0", alignItems: "stretch" }}>
      {r.steps.map((s, i) => {
        const done = r.status === "completed" || i < r.stepIndex;
        const current = r.status === "running" && i === r.stepIndex;
        const stage = s.stage !== undefined ? r.chain?.stages?.[s.stage] : undefined;
        return (
          <div
            key={i}
            className="card"
            style={{
              padding: 10,
              minWidth: 180,
              flex: 1,
              borderColor: current ? "var(--primary)" : undefined,
              opacity: !done && !current ? 0.7 : 1,
            }}
          >
            <div className="row small">
              <strong>
                {i + 1}. {s.name}
              </strong>
              <div className="spacer" />
              {done && <span className="badge ok">{t("steps.badges.done")}</span>}
              {current && <span className="badge warn">{t("steps.badges.current")}</span>}
            </div>
            {stage && (
              <div className="small" style={{ marginTop: 2 }}>
                <span className="badge info">{stage.name || label("reviewParty", stage.party)}</span>
                {stage.days ? <span className="muted"> · {t("steps.stageDays", { count: stage.days })}</span> : null}
              </div>
            )}
            <div className="small muted" style={{ marginTop: 4 }}>
              {s.assignees.map((a) => assigneeLabel(a, r.names)).join(", ")}
              {s.resolvedBy && ` (${s.resolvedBy.attribute} = ${s.resolvedBy.values.join(", ")})`}
            </div>
            {s.requiredAttributes?.length ? (
              <div className="small muted">{t("steps.required", { attributes: s.requiredAttributes.join(", ") })}</div>
            ) : null}
            <div className="small muted">
              {label("stepRule", s.rule)}
              {s.days ? ` · ${t("steps.days", { count: s.days })}` : ""}
            </div>
            {current && r.submittedBy.length > 0 && (
              <div className="small" style={{ marginTop: 4 }}>
                {t("steps.submittedBy", { names: r.submittedBy.map((u) => r.names[u] ?? "?").join(", ") })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function FilesTable({ review: r }: { review: ReviewDetailDto }) {
  const { t } = useTranslation(["reviews", "common"]);
  const project = useProject();
  const hasChain = !!r.chain?.stages?.length;
  return (
    <div className="card" style={{ padding: 0 }}>
      <table className="phone-cards">
        <thead>
          <tr>
            <th>{t("common:fields.file")}</th>
            <th style={{ width: 60 }}>{t("files.columns.version")}</th>
            {r.steps.map((s, i) => (
              <th key={i} style={{ width: 150 }}>
                {i + 1}. {s.name}
              </th>
            ))}
            {hasChain && <th>{t("files.columns.chain")}</th>}
            <th style={{ width: 150 }}>{t("common:fields.result")}</th>
            {r.targetFolderId && <th style={{ width: 240 }}>{t("files.columns.copy")}</th>}
          </tr>
        </thead>
        <tbody>
          {r.files.map((f) => (
            <tr key={f.id}>
              <td className="pc-title">
                <a href={api.reviewFileDownloadUrl(project.id, r.id, f.id)}>{f.fileName}</a>
              </td>
              <td data-label={t("files.columns.version")}>
                <span className="badge">V{f.version}</span>
                {f.version > 1 && docCompareKind(f.fileName.split(".").pop() ?? "") && (
                  <Link className="small" style={{ marginLeft: 6 }} to={`/projects/${project.id}/compare?to=${f.fileVersionId}`} title={t("files.compareHint")}>
                    ⇄
                  </Link>
                )}
              </td>
              {r.steps.map((s, i) => (
                <td key={i} data-label={`${i + 1}. ${s.name}`}>
                  <OutcomeBadge code={f.stepResults[String(i)]} label={f.stepLabels?.[String(i)]} />
                </td>
              ))}
              {hasChain && (
                <td data-label={t("files.columns.chain")}>
                  <ChainCells cells={f.chain} />
                </td>
              )}
              <td data-label={t("common:fields.result")}>
                {r.status === "completed" || f.stoppedAtStep != null ? (
                  <OutcomeBadge code={f.finalStatus} label={f.finalLabel} />
                ) : (
                  <span className="muted">—</span>
                )}
                {f.stoppedAtStep != null && <div className="small muted">{t("files.badges.returned")}</div>}
              </td>
              {r.targetFolderId && (
                <td className="small" data-label={t("files.columns.copy")}>
                  {f.copiedFileId && <span className="badge ok">{t("files.badges.copied")}</span>}
                  {f.targetPath && <div className="muted">{f.targetPath}</div>}
                  {!!f.copyUnresolved?.length && (
                    <div className="error">{t("files.errors.unresolved", { fields: f.copyUnresolved.map((u) => `{${u}}`).join(", ") })}</div>
                  )}
                  {f.copyError && <span className="error" style={{ display: "block", padding: "2px 6px" }}>{f.copyError}</span>}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ActForm({ review: r, onDone }: { review: ReviewDetailDto; onDone(d: ReviewDetailDto): void }) {
  const { t, i18n } = useTranslation(["reviews", "common"]);
  const project = useProject();
  const step = r.steps[r.stepIndex]!;
  const options = stepOutcomeOptions(step, i18n.language);
  const required = step.requiredAttributes ?? [];
  // Files sent back by a stop stage take no part in later steps.
  const active = r.files.filter((f) => f.stoppedAtStep == null);
  const hasChain = !!r.chain?.stages?.length;
  const [outcomes, setOutcomes] = useState<Record<string, string>>({});
  const [comments, setComments] = useState<Record<string, string>>({});
  const [attrs, setAttrs] = useState<Record<string, Record<string, string>>>({});
  const [comment, setComment] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setOutcomes({});
    // Pre-fill required attributes with the values already on the files.
    setAttrs(
      Object.fromEntries(
        r.files.map((f) => [f.id, Object.fromEntries(required.map((n) => [n, f.attributes?.[n] ?? ""]))]),
      ),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [r.stepIndex]);
  const missing =
    active.some((f) => !outcomes[f.id]) || active.some((f) => required.some((n) => !(attrs[f.id]?.[n] ?? "").trim()));

  async function submit() {
    setError(null);
    setBusy(true);
    try {
      onDone(
        await api.submitReview(project.id, r.id, {
          comment: comment || null,
          files: active.map((f) => ({
            reviewFileId: f.id,
            outcome: outcomes[f.id]!,
            comment: comments[f.id] || null,
          })),
          ...(required.length ? { attributes: Object.fromEntries(active.map((f) => [f.id, attrs[f.id] ?? {}])) } : {}),
        }),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card" style={{ padding: 0, borderColor: "var(--primary)" }}>
      <div className="row wrap" style={{ padding: "10px 12px", borderBottom: "1px solid var(--border)" }}>
        <strong>
          {t("act.title", { n: r.stepIndex + 1, step: step.name })}
        </strong>
        <span className="muted small">
          {required.length ? t("act.instructionsWithAttributes", { attributes: required.join(", ") }) : t("act.instructions")}
        </span>
        {behalfText(r.actingFor) && (
          <span className="badge info" title={t("act.behalfHint")}>
            {t("act.answeringFor", { who: behalfText(r.actingFor) })}
          </span>
        )}
        <div className="spacer" />
        <select
          style={{ width: 240 }}
          value=""
          onChange={(e) => {
            const v = e.target.value;
            if (v) setOutcomes(Object.fromEntries(active.map((f) => [f.id, v])));
          }}
        >
          <option value="">{t("act.options.applyToAll")}</option>
          {options.map((o) => (
            <option key={o.code} value={o.code}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
      <table className="phone-cards">
        <thead>
          <tr>
            <th>{t("common:fields.file")}</th>
            <th style={{ width: 60 }}>{t("files.columns.version")}</th>
            {hasChain ? (
              <th>{t("files.columns.chain")}</th>
            ) : (
              r.steps.slice(0, r.stepIndex).map((s, i) => (
                <th key={i} style={{ width: 140 }}>
                  {i + 1}. {s.name}
                </th>
              ))
            )}
            {required.map((n) => (
              <th key={n} style={{ width: 150 }}>
                {n} *
              </th>
            ))}
            <th style={{ width: 230 }}>{t("act.columns.yourResult")}</th>
            <th style={{ width: 240 }}>{t("act.columns.note")}</th>
          </tr>
        </thead>
        <tbody>
          {r.files.map((f) => {
            const stopped = f.stoppedAtStep != null;
            return (
              <tr key={f.id} style={stopped ? { opacity: 0.6 } : undefined}>
                <td className="pc-title">
                  <a href={api.reviewFileDownloadUrl(project.id, r.id, f.id)}>{f.fileName}</a>
                </td>
                <td data-label={t("files.columns.version")}>
                  <span className="badge">V{f.version}</span>
                </td>
                {hasChain ? (
                  <td data-label={t("files.columns.chain")}>
                    <ChainCells cells={f.chain} />
                  </td>
                ) : (
                  r.steps.slice(0, r.stepIndex).map((s, i) => (
                    <td key={i} data-label={`${i + 1}. ${s.name}`}>
                      <OutcomeBadge code={f.stepResults[String(i)]} label={f.stepLabels?.[String(i)]} />
                    </td>
                  ))
                )}
                {required.map((n) => {
                  const def = r.attributeDefinitions?.find((d) => d.name === n) ?? { name: n, type: "text" as const };
                  return (
                    <td key={n} data-label={`${n} *`}>
                      {stopped ? (
                        <span className="muted">—</span>
                      ) : (
                        <AttributeInput
                          def={def}
                          value={attrs[f.id]?.[n] ?? ""}
                          onChange={(val) => setAttrs((a) => ({ ...a, [f.id]: { ...a[f.id], [n]: val } }))}
                        />
                      )}
                    </td>
                  );
                })}
                <td data-label={t("act.columns.yourResult")}>
                  {stopped ? (
                    <span className="small muted">
                      <Trans
                        t={t}
                        i18nKey="act.returned"
                        components={{ badge: <OutcomeBadge code={f.finalStatus} label={f.finalLabel} /> }}
                      />
                    </span>
                  ) : (
                    <select value={outcomes[f.id] ?? ""} onChange={(e) => setOutcomes((o) => ({ ...o, [f.id]: e.target.value }))}>
                      <option value="">{t("act.options.choose")}</option>
                      {options.map((o) => (
                        <option key={o.code} value={o.code}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  )}
                </td>
                <td data-label={t("act.columns.note")}>
                  {!stopped && (
                    <input
                      value={comments[f.id] ?? ""}
                      placeholder={t("act.fileNotePlaceholder")}
                      onChange={(e) => setComments((c) => ({ ...c, [f.id]: e.target.value }))}
                    />
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div style={{ padding: 12 }}>
        <textarea placeholder={t("act.commentPlaceholder")} value={comment} onChange={(e) => setComment(e.target.value)} style={{ minHeight: 60 }} />
        {error && <p className="error">{error}</p>}
        <div className="dialog-actions" style={{ marginTop: 8 }}>
          <button className="primary" disabled={busy || missing} onClick={() => void submit()}>
            {t("act.actions.submit")}
          </button>
        </div>
      </div>
    </div>
  );
}

function ReassignDialog({
  review: r,
  onClose,
  onSaved,
}: {
  review: ReviewDetailDto;
  onClose(): void;
  onSaved(d: ReviewDetailDto): void;
}) {
  const { t } = useTranslation(["reviews", "common"]);
  const project = useProject();
  const { data: members } = useLoad(() => api.members(project.id), [project.id]);
  const { data: companies } = useLoad(() => api.companies(), []);
  const { data: roles } = useLoad(() => api.roles(project.id), [project.id]);
  const [assignees, setAssignees] = useState<WorkflowAssignee[]>(r.steps[r.stepIndex]!.assignees);
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog title={t("reassign.title", { step: r.steps[r.stepIndex]!.name })} onClose={onClose}>
      <p className="muted small" style={{ marginTop: 0 }}>
        {t("reassign.description")}
      </p>
      <AssigneePicker value={assignees} onChange={setAssignees} members={members} companies={companies} roles={roles} />
      {error && <p className="error">{error}</p>}
      <div className="dialog-actions">
        <button onClick={onClose}>{t("common:actions.cancel")}</button>
        <button
          className="primary"
          disabled={!assignees.length}
          onClick={async () => {
            try {
              onSaved(await api.reassignReview(project.id, r.id, assignees));
            } catch (e) {
              setError((e as Error).message);
            }
          }}
        >
          {t("common:actions.save")}
        </button>
      </div>
    </Dialog>
  );
}
