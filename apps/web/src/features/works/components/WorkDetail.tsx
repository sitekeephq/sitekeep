import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useLocation, useNavigate } from "react-router-dom";
import {
  type CompanyDto,
  type DeliveryStatus,
  type WorkDetailDto,
  type WorkEventDto,
  type WorkLinkDto,
  type WorkTypeDto,
} from "@sitekeep/shared";
import { api, formatDate, formatDay } from "../../../shared/api/api";
import { worksApi } from "../../../shared/api/api-works";
import { i18n, label, labelEntries, useLabel } from "../../../i18n";
import { useLoad, useProject, useRevealOnNarrow } from "../../../app/context/project";
import { LoadingIndicator } from "../../../shared/ui/LoadingIndicator";
import { BuildPanel } from "./WorksBuild";
import { LetterPanel } from "./WorksLetter";
import { WorkStatusBadge } from "./work-status";
import { EditDialog, FilePickerDialog, LinkPickerDialog, SendDialog } from "./WorkDialogs";

export function WorkDetail({
  workId,
  types,
  companies,
  onChanged,
}: {
  workId: string;
  types: WorkTypeDto[];
  companies: CompanyDto[];
  onChanged(): void;
}) {
  const { t } = useTranslation(["works", "common"]);
  const project = useProject();
  const navigate = useNavigate();
  const { search: keep } = useLocation();
  const { data: w, error, setData, reload } = useLoad(() => worksApi.get(project.id, workId), [project.id, workId]);
  const { data: members } = useLoad(() => api.members(project.id), [project.id]);
  const [dialog, setDialog] = useState<"send" | "files" | "link" | "edit" | null>(null);
  const [comment, setComment] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const type = types.find((x) => x.id === w?.typeId);
  const panelRef = useRevealOnNarrow<HTMLElement>(w?.id);

  async function act(fn: () => Promise<WorkDetailDto>) {
    setMsg(null);
    try {
      const d = await fn();
      if (d.id === workId) setData(d);
      onChanged();
      return d;
    } catch (e) {
      setMsg((e as Error).message);
      return null;
    }
  }

  if (error)
    return (
      <aside className="panel right">
        <p className="error">{error}</p>
      </aside>
    );
  if (!w || !type)
    return (
      <aside className="panel right">
        <LoadingIndicator />
      </aside>
    );
  const n = (id: string | null | undefined) => (id ? (w.names[id] ?? "?") : "—");
  const draft = w.status === "taslak";
  const links = (role: string) => w.links.filter((l) => l.role === role);
  const letter = w.category === "correspondence" ? w.letter : null;

  return (
    <aside className="panel right" ref={panelRef}>
      <div className="row">
        <span className="muted small">
          {type.icon} {w.typeName}
        </span>
        <div className="spacer" />
        <button className="ghost small" onClick={() => navigate(`/projects/${project.id}/works${keep}`)} aria-label={t("common:actions.close")}>
          ✕
        </button>
      </div>
      <div className="mono" style={{ marginTop: 4 }}>
        {w.number}
      </div>
      <h2 style={{ marginTop: 4 }}>{w.title}</h2>
      <div className="row wrap">
        <WorkStatusBadge w={w} />
        {w.replyRequired && !w.closed && <span className="badge warn">{t("list.badges.replyAwaited")}</span>}
        {w.dueDate && <span className={`badge ${w.overdue ? "danger" : ""}`}>{t("detail.badges.due", { date: formatDay(w.dueDate) })}</span>}
      </div>

      <div className="row wrap" style={{ marginTop: 12 }}>
        {w.canSend && (
          <button className="primary" onClick={() => setDialog("send")}>
            {t("detail.actions.send")}
          </button>
        )}
        {w.canReceive && (
          <button className="primary" onClick={() => void act(() => worksApi.receive(project.id, w.id))}>
            {t("detail.actions.receive")}
          </button>
        )}
        {w.canReply && (
          <button
            onClick={async () => {
              const d = await act(() => worksApi.reply(project.id, w.id));
              if (d) navigate(`/projects/${project.id}/works/${d.id}${keep}`);
            }}
          >
            {t("detail.actions.reply")}
          </button>
        )}
        {w.canEdit && <button onClick={() => setDialog("edit")}>{t("common:actions.edit")}</button>}
        {w.canEdit && w.category === "transmittal" && !draft && (
          <button onClick={() => void act(() => worksApi.cover(project.id, w.id))}>{t("detail.actions.refreshCover")}</button>
        )}
      </div>
      {msg && <p className="error">{msg}</p>}

      {w.build && (
        <BuildPanel
          w={w}
          members={members ?? []}
          companies={companies}
          onChanged={() => {
            reload();
            onChanged();
          }}
        />
      )}

      <table className="props-table" style={{ marginTop: 12 }}>
        <tbody>
          <tr>
            <td>{t("detail.fields.from")}</td>
            <td>{n(w.fromCompanyId)}</td>
          </tr>
          <tr>
            <td>{t("editWork.fields.to")}</td>
            <td>{w.toCompanyIds.map(n).join(", ") || "—"}</td>
          </tr>
          <tr>
            <td>{t("editWork.fields.cc")}</td>
            <td>{w.ccCompanyIds.map(n).join(", ") || "—"}</td>
          </tr>
          <tr>
            <td>{t("common:fields.owner")}</td>
            <td>{n(w.assigneeUserId)}</td>
          </tr>
          <tr>
            <td>{t("common:fields.createdBy")}</td>
            <td>
              {w.createdByName} · {formatDate(w.createdAt)}
            </td>
          </tr>
          {type.fields.map((f) =>
            w.fields[f.key] !== undefined && w.fields[f.key] !== "" ? (
              <tr key={f.key}>
                <td>{f.label}</td>
                <td style={{ whiteSpace: "pre-wrap" }}>
                  {typeof w.fields[f.key] === "boolean" ? (w.fields[f.key] ? t("common:actions.yes") : t("common:actions.no")) : String(w.fields[f.key])}
                </td>
              </tr>
            ) : null,
          )}
        </tbody>
      </table>

      {w.canEdit && !(letter && (w.status === "arsivlendi" || w.status === "iptal")) && (
        <div className="row" style={{ marginTop: 8 }}>
          <label style={{ margin: 0 }}>{t("common:fields.status")}</label>
          <select
            style={{ width: 180 }}
            value={w.status}
            onChange={(e) => void act(() => worksApi.update(project.id, w.id, { status: e.target.value }))}
          >
            {type.statuses
              .filter((s) => s.key !== "gonderildi" || w.status === "gonderildi")
              .filter((s) => !letter || (s.key !== "arsivlendi" && s.key !== "iptal"))
              .map((s) => (
                <option key={s.key} value={s.key}>
                  {s.label}
                </option>
              ))}
          </select>
        </div>
      )}

      {letter && (
        <LetterPanel
          w={w}
          incoming={!!type.settings.incoming}
          companies={companies}
          act={act}
          onDeleted={() => {
            onChanged();
            navigate(`/projects/${project.id}/works${keep}`);
          }}
        />
      )}

      {w.delivery && <DeliveryBox w={w} onSave={(d) => void act(() => worksApi.updateDelivery(project.id, w.id, d))} />}
      {w.receipts.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <h3>{t("detail.receipts.title")}</h3>
          {w.receipts.map((r) => (
            <div key={r.companyId} className="small">
              ✓ <strong>{r.companyName}</strong> · {r.receivedByName} · {formatDate(r.receivedAt)}
            </div>
          ))}
        </div>
      )}

      <div className="row" style={{ marginTop: 16 }}>
        <h3 style={{ margin: 0 }}>{t("common:fields.attachments")}</h3>
        <div className="spacer" />
        {w.canEdit && draft && (
          <button className="small" onClick={() => setDialog("files")}>
            {t("detail.actions.addFileVersion")}
          </button>
        )}
      </div>
      {links("kapak").map((l) => (
        <LinkRow key={l.id} w={w} l={l} />
      ))}
      {links("ek").map((l) => (
        <LinkRow
          key={l.id}
          w={w}
          l={l}
          onRemove={w.canEdit && draft ? () => void act(() => worksApi.removeLink(project.id, w.id, l.id)) : undefined}
          onSigned={
            w.canEdit && draft && l.target.label.toLowerCase().endsWith(".pdf")
              ? (s) => void act(() => worksApi.setSigned(project.id, w.id, l.id, s))
              : undefined
          }
        />
      ))}
      {!links("ek").length && !links("kapak").length && <p className="muted small">{t("detail.attachments.empty")}</p>}

      <div className="row" style={{ marginTop: 16 }}>
        <h3 style={{ margin: 0 }}>{t("detail.links.title")}</h3>
        <div className="spacer" />
        {w.canEdit && (
          <button className="small" onClick={() => setDialog("link")}>
            {t("detail.actions.link")}
          </button>
        )}
      </div>
      {[...links("ilgi"), ...links("kaynak")].map((l) => (
        <LinkRow
          key={l.id}
          w={w}
          l={l}
          onRemove={w.canEdit && l.role === "ilgi" ? () => void act(() => worksApi.removeLink(project.id, w.id, l.id)) : undefined}
        />
      ))}
      {letter && w.backlinks.length > 0 && (
        <div className="muted small" style={{ marginTop: 6 }}>
          {t("detail.links.backlinksHeading")}
        </div>
      )}
      {w.backlinks.map((l) => (
        <div key={l.id} className="model-item small">
          <span>↩</span>
          <div>
            <Link to={l.target.link ?? "#"}>{l.target.label}</Link>
            <div className="muted">{l.meta.reply ? t("detail.links.replyToThis") : t("detail.links.refersToThis")}</div>
          </div>
        </div>
      ))}
      {![...links("ilgi"), ...links("kaynak")].length && !w.backlinks.length && <p className="muted small">{t("detail.links.empty")}</p>}

      {w.category === "correspondence" &&
        (letter ? letter.threadCount > 0 : w.backlinks.length > 0 || links("ilgi").some((l) => l.kind === "work")) && (
          <Thread workId={w.id} count={letter?.threadCount} />
        )}

      <h3 style={{ marginTop: 16 }}>{t("detail.timeline.title")}</h3>
      {w.events.map((e) => (
        <div key={e.id} className="small" style={{ borderBottom: "1px solid var(--border)", padding: "6px 0" }}>
          <span className="muted">{formatDate(e.at)}</span> · <strong>{e.userName ?? t("today.changes.system")}</strong>{" "}
          {eventText(e, w, (k) => type.statuses.find((x) => x.key === k)?.label ?? k)}
          {e.kind === "comment" && <div style={{ whiteSpace: "pre-wrap" }}>{e.message}</div>}
        </div>
      ))}
      <form
        onSubmit={async (ev) => {
          ev.preventDefault();
          if (!comment.trim()) return;
          if (await act(() => worksApi.comment(project.id, w.id, comment))) setComment("");
        }}
      >
        <textarea placeholder={t("detail.commentPlaceholder")} value={comment} onChange={(e) => setComment(e.target.value)} style={{ marginTop: 8 }} />
        <div className="dialog-actions" style={{ marginTop: 8 }}>
          <button className="primary" disabled={!comment.trim()}>
            {t("common:actions.add")}
          </button>
        </div>
      </form>

      {dialog === "send" && (
        <SendDialog
          w={w}
          onClose={() => setDialog(null)}
          onSend={async (s) => (await act(() => worksApi.send(project.id, w.id, s))) && setDialog(null)}
        />
      )}
      {dialog === "files" && (
        <FilePickerDialog
          onClose={() => setDialog(null)}
          exclude={w.links.map((l) => l.targetId)}
          onPick={async (ids) =>
            (await act(() => worksApi.addLinks(project.id, w.id, ids.map((id) => ({ kind: "file_version", targetId: id }))))) &&
            setDialog(null)
          }
        />
      )}
      {dialog === "link" && (
        <LinkPickerDialog
          workId={w.id}
          onClose={() => setDialog(null)}
          onPick={async (l) => (await act(() => worksApi.addLinks(project.id, w.id, [l]))) && setDialog(null)}
        />
      )}
      {dialog === "edit" && (
        <EditDialog
          w={w}
          type={type}
          companies={companies}
          members={members ?? []}
          onClose={() => setDialog(null)}
          onSave={async (patch) => (await act(() => worksApi.update(project.id, w.id, patch))) && setDialog(null)}
        />
      )}
    </aside>
  );
}

function eventText(e: WorkEventDto, w: WorkDetailDto, statusLabel: (key: string) => string): string {
  const d = e.details ?? {};
  const t = i18n.getFixedT(null, "works");
  const note = e.message ?? "";
  switch (e.kind) {
    case "created":
      return e.message ? t("detail.events.createdWithNote", { note }) : t("detail.events.created");
    case "updated":
      return t("detail.events.updated");
    case "status":
      return t("detail.events.status", { from: statusLabel(String(d.from)), to: statusLabel(String(d.to)) });
    case "linked":
      return t("detail.events.linked");
    case "unlinked":
      return t("detail.events.unlinked");
    case "sent":
      return d.reference
        ? t("detail.events.sentWithReference", { channel: String(d.channel), reference: String(d.reference) })
        : t("detail.events.sent", { channel: String(d.channel) });
    case "delivery":
      return d.status
        ? t("detail.events.deliveryWithStatus", { status: label("deliveryStatus", String(d.status)) })
        : t("detail.events.delivery");
    case "received":
      return t("detail.events.received", { company: w.names[String(d.companyId)] ?? "" });
    case "replied":
      return e.message ?? t("detail.events.replied");
    case "answered":
      return e.message ?? t("detail.events.answered");
    case "cover_pdf":
      return t("detail.events.coverPdf", { file: note });
    case "comment":
      return t("detail.events.comment");
    case "minutes":
      return e.message ? t("detail.events.minutesWithNote", { note }) : t("detail.events.minutes");
    case "submitted":
      return e.message ? t("detail.events.submittedWithNote", { note }) : t("detail.events.submitted");
    case "responded": {
      const result = d.label ? String(d.label) : "";
      if (result && e.message) return t("detail.events.respondedWithResultAndNote", { result, note });
      if (result) return t("detail.events.respondedWithResult", { result });
      if (e.message) return t("detail.events.respondedWithNote", { note });
      return t("detail.events.responded");
    }
    case "decided":
      return t("detail.events.decided", { result: e.message ?? String(d.label ?? "") });
    case "revised":
      return e.message ?? t("detail.events.revised");
    case "cancelled":
      return e.message ? t("detail.events.cancelledWithNote", { note }) : t("detail.events.cancelled");
    case "archived":
      return t("detail.events.archived");
    case "reopened":
      return t("detail.events.reopened");
    case "letter":
      return t("detail.events.letter");
    case "letter_pdf":
      return t("detail.events.letterPdf", { file: note });
    case "mail":
      return e.message ?? t("detail.events.mail");
    default:
      return e.kind;
  }
}

function LinkRow({ w, l, onRemove, onSigned }: { w: WorkDetailDto; l: WorkLinkDto; onRemove?(): void; onSigned?(v: boolean): void }) {
  const { t } = useTranslation(["works", "common"]);
  const label = useLabel();
  const project = useProject();
  const icon = l.role === "kapak" ? "🧾" : l.kind === "file_version" ? "📄" : l.kind === "work" ? "✉️" : l.kind === "review" ? "✅" : "⚠️";
  return (
    <div className="model-item small">
      <span>{icon}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        {l.target.link ? <Link to={l.target.link}>{l.target.label}</Link> : <span>{l.target.label}</span>}
        <div className="muted">
          {l.role === "kapak" && w.category === "correspondence" ? t("detail.links.officialLetterPdf") : label("workLinkRole", l.role)}
          {l.kind === "file_version" && ` · V${l.target.version}`}
          {l.target.revision && ` · Rev ${l.target.revision}`}
          {l.target.status && ` · ${l.target.status}`}
          {l.meta.reply && ` · ${t("detail.links.reply")}`}
          {l.meta.signed && ` · ${t("detail.links.signedPdf")}`}
        </div>
        {onSigned && (
          <label className="check" style={{ margin: "4px 0 0" }}>
            <input type="checkbox" checked={!!l.meta.signed} onChange={(e) => onSigned(e.target.checked)} /> {t("detail.options.signedPdf")}
          </label>
        )}
      </div>
      {l.kind === "file_version" && !l.target.missing && (
        <a className="btn small" href={worksApi.downloadUrl(project.id, w.id, l.id)}>
          {t("common:actions.download")}
        </a>
      )}
      {onRemove && (
        <button className="ghost small" title={t("common:actions.remove")} onClick={onRemove}>
          ✕
        </button>
      )}
    </div>
  );
}

function DeliveryBox({
  w,
  onSave,
}: {
  w: WorkDetailDto;
  onSave(d: { status?: DeliveryStatus; reference?: string | null }): void;
}) {
  const { t } = useTranslation(["works", "common"]);
  const label = useLabel();
  const d = w.delivery!;
  const [ref, setRef] = useState(d.reference ?? "");
  const manual = d.channel !== "cde";
  return (
    <div className="card" style={{ marginTop: 12, padding: 10 }}>
      <div className="small">
        <strong>{t("detail.delivery.heading")}</strong> {d.channelLabel} · {label("deliveryStatus", d.status)} · {d.sentAt ? formatDate(d.sentAt) : ""}
      </div>
      {d.note && <div className="small muted">{d.note}</div>}
      {manual && w.canEdit ? (
        <div className="row" style={{ marginTop: 6 }}>
          <input placeholder={t("detail.delivery.referencePlaceholder")} value={ref} onChange={(e) => setRef(e.target.value)} />
          <select value={d.status} onChange={(e) => onSave({ status: e.target.value as DeliveryStatus })} style={{ width: 150 }}>
            {labelEntries("deliveryStatus").map(([s, text]) => (
              <option key={s} value={s}>
                {text}
              </option>
            ))}
          </select>
          <button className="small" disabled={ref === (d.reference ?? "")} onClick={() => onSave({ reference: ref || null })}>
            {t("common:actions.save")}
          </button>
        </div>
      ) : (
        d.reference && <div className="small">{t("detail.delivery.reference", { reference: d.reference })}</div>
      )}
    </div>
  );
}

/** "Yazışma zinciri (n)": letters linked by "ilgi" in both directions, oldest first. */
function Thread({ workId, count }: { workId: string; count?: number }) {
  const { t } = useTranslation(["works", "common"]);
  const project = useProject();
  const [open, setOpen] = useState(true);
  const { data } = useLoad(() => worksApi.thread(project.id, workId), [project.id, workId]);
  if (!data || data.length < 2) return null;
  return (
    <div style={{ marginTop: 16 }}>
      <button className="ghost small" style={{ padding: 0 }} onClick={() => setOpen(!open)} aria-expanded={open}>
        <h3 style={{ margin: 0 }}>
          {open ? "▾" : "▸"} {t("detail.thread.title", { count: count ?? data.length - 1 })}
        </h3>
      </button>
      {open &&
        data.map((x) => (
          <div key={x.id} className="model-item small" style={{ paddingLeft: x.refs.length ? 16 : 4 }}>
            <span>{x.refs.length ? "↳" : "•"}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              {x.id === workId ? <strong>{x.number}</strong> : <Link to={`/projects/${project.id}/works/${x.id}`}>{x.number}</Link>} ·{" "}
              {x.title}
              <div className="muted">
                {x.typeName} · {formatDate(x.sentAt ?? x.createdAt)}
              </div>
            </div>
            <span className={`badge ${x.statusTone}`}>{x.statusLabel}</span>
          </div>
        ))}
    </div>
  );
}
