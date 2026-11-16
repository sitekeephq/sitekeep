/**
 * Model markups beside the viewer: the list for the loaded models, markups of older versions to
 * carry over, and the selected markup with its comments, status, visibility and "Create Issue".
 */
import { useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { IssuePriority, ModelMarkupDto, ModelMarkupVisibility } from "@sitekeep/shared";
import { MODEL_MARKUP_COLORS } from "@sitekeep/shared";
import { useAuth } from "../../../app/context/auth";
import { useProject } from "../../../app/context/project";
import { formatDate } from "../../../shared/lib/format";
import { Dialog } from "../../../shared/ui/Dialog";
import { useLabel } from "../../../i18n";
import { modelMarkupApi } from "./api";
import type { ModelMarkups } from "./useModelMarkups";

export function MarkupPanel({ mm, onClose }: { mm: ModelMarkups; onClose(): void }) {
  const { t } = useTranslation(["modelMarkup", "common"]);
  const canCreate = mm.markupVersions.length > 0 && !!mm.engine;
  return (
    <section className="mm-panel" aria-label={t("panel")}>
      <div className="row">
        <h3>{t("title")}</h3>
        <div className="spacer" />
        <button type="button" className="ghost small" aria-label={t("actions.closePanel")} onClick={onClose}>
          ✕
        </button>
      </div>
      <div className="mm-actions">
        <button type="button" className="small" disabled={!canCreate || !!mm.mode} onClick={() => mm.setMode("pin")}>
          {t("actions.pin")}
        </button>
        <button type="button" className="small" disabled={!canCreate || !!mm.mode} onClick={() => mm.setMode("draw")}>
          {t("actions.draw")}
        </button>
      </div>
      {mm.loaded.length > 0 && !mm.markupVersions.length && <p className="muted small">{t("noPermission")}</p>}
      {mm.error && (
        <p className="error small">
          {mm.error}{" "}
          <button type="button" className="ghost small" onClick={() => mm.setError(null)}>
            ✕
          </button>
        </p>
      )}
      {mm.active ? <MarkupDetail mm={mm} /> : <MarkupList mm={mm} />}
      {mm.pending && <SaveMarkupDialog mm={mm} />}
    </section>
  );
}

function MarkupList({ mm }: { mm: ModelMarkups }) {
  const { t } = useTranslation(["modelMarkup", "common"]);
  if (!mm.loaded.length) return <p className="muted small">{t("noModels")}</p>;
  if (!mm.list) return <p className="muted small">{t("common:status.loading")}</p>;
  return (
    <>
      {mm.list.current.length === 0 && <p className="muted small">{t("empty")}</p>}
      <ul className="mm-list">
        {mm.list.current.map((m) => (
          <li key={m.id}>
            <MarkupRow m={m} onClick={() => mm.select(m.id)} />
          </li>
        ))}
      </ul>
      {mm.list.older.length > 0 && (
        <div className="mm-older">
          <h3>{t("older")}</h3>
          <p className="muted small">{t("olderHint")}</p>
          <ul className="mm-list">
            {mm.list.older.map((m) => (
              <li key={m.id}>
                <MarkupRow m={m} older onClick={() => mm.select(m.id)} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

function MarkupRow({ m, older, onClick }: { m: ModelMarkupDto; older?: boolean; onClick(): void }) {
  const { t } = useTranslation(["modelMarkup"]);
  return (
    <button type="button" className={`mm-item${m.status === "closed" ? " closed" : ""}`} onClick={onClick}>
      <span className="mm-dot" style={{ background: m.color }} />
      <span className="mm-item-body">
        <strong>{m.kind === "pin" ? "📍" : "✎"} {m.title || t("untitled")}</strong>
        <span className="muted small" style={{ display: "block" }}>
          {t("meta", { author: m.authorName ?? "", date: formatDate(m.createdAt) })}
        </span>
        <span className="mm-badges">
          {older && <span className="badge warn">{t("olderBadge", { version: m.version })}</span>}
          {m.status === "closed" && <span className="badge">{t("status.closed")}</span>}
          {m.visibility === "private" && <span className="badge info">{t("visibility.private")}</span>}
          {m.issueNumber != null && <span className="badge ok">{t("issueBadge", { number: m.issueNumber })}</span>}
          {m.anchor?.missing && <span className="badge danger">⚠</span>}
          {m.commentCount > 0 && <span className="badge">{t("commentCount", { count: m.commentCount })}</span>}
        </span>
      </span>
    </button>
  );
}

function MarkupDetail({ mm }: { mm: ModelMarkups }) {
  const { t } = useTranslation(["modelMarkup", "common"]);
  const project = useProject();
  const { user } = useAuth();
  const m = mm.active!;
  const older = mm.isOlder(m.id);
  const [comment, setComment] = useState("");
  const [issueOpen, setIssueOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const own = m.authorId === user?.id;
  const admin = !!project.isProjectAdmin;
  // An older markup is carried over to the loaded version of its file.
  const carryTarget = older ? mm.loaded.find((v) => mm.versionFiles[v] === m.fileId && mm.markupVersions.includes(v)) : undefined;

  async function run(fn: () => Promise<unknown>, after?: () => void) {
    setBusy(true);
    mm.setError(null);
    try {
      await fn();
      mm.reload();
      if (after) after();
      else mm.refreshActive();
    } catch (e) {
      mm.setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <button type="button" className="ghost small" onClick={() => mm.select(null)}>
        {t("actions.back")}
      </button>
      <h3 style={{ marginTop: 8, overflowWrap: "anywhere" }}>
        <span className="mm-dot" style={{ background: m.color, display: "inline-block", marginRight: 6 }} />
        {m.kind === "pin" ? "📍" : "✎"} {m.title || t("untitled")}
      </h3>
      <div className="muted small">
        {t(`kind.${m.kind}`)} · {t("versionMeta", { file: m.fileName ?? "", version: m.version })}
        <br />
        {t("meta", { author: m.authorName ?? "", date: formatDate(m.createdAt) })}
      </div>
      <div className="mm-badges" style={{ marginTop: 6 }}>
        <span className={`badge ${m.status === "open" ? "warn" : "ok"}`}>{t(`status.${m.status}`)}</span>
        <span className="badge info">{t(`visibility.${m.visibility}`)}</span>
        {m.issueId && m.issueNumber != null && (
          <Link className="badge ok" to={`/projects/${project.id}/issues/${m.issueId}`}>
            {t("issueBadge", { number: m.issueNumber })}
          </Link>
        )}
      </div>
      {m.anchor?.missing && <p className="small error">{t("anchorMissing")}</p>}
      {m.carriedFromId && <p className="muted small">{t("carried")}</p>}
      {older ? (
        <p className="muted small">{t("olderDetail", { version: m.version })}</p>
      ) : (
        mm.shownId !== m.id && (
          <p className="small">
            {m.kind === "drawing" && <span className="muted">{t("hidden")} </span>}
            <button type="button" className="small" onClick={() => mm.select(m.id)}>
              {t("actions.show")}
            </button>
          </p>
        )
      )}
      {m.viewpoint.snapshot && <img className="mm-snapshot" src={m.viewpoint.snapshot} alt={m.title || t("untitled")} />}
      <div className="mm-actions">
        {carryTarget && (
          <button
            type="button"
            className="small primary"
            disabled={busy}
            onClick={() =>
              void run(
                () =>
                  modelMarkupApi.carryOver(project.id, m.id, carryTarget).then((r) => mm.select(r.markup.id)),
                () => undefined,
              )
            }
          >
            {t("actions.carryOver")}
          </button>
        )}
        {!older && !m.issueId && (
          <button type="button" className="small primary" disabled={busy} onClick={() => setIssueOpen(true)}>
            {t("actions.toIssue")}
          </button>
        )}
        {(own || admin) && (
          <button
            type="button"
            className="small"
            disabled={busy}
            onClick={() => void run(() => modelMarkupApi.update(project.id, m.id, { status: m.status === "open" ? "closed" : "open" }))}
          >
            {m.status === "open" ? t("actions.closeMarkup") : t("actions.reopen")}
          </button>
        )}
        {own && (
          <button
            type="button"
            className="small"
            disabled={busy}
            onClick={() =>
              void run(() => modelMarkupApi.update(project.id, m.id, { visibility: m.visibility === "private" ? "project" : "private" }))
            }
          >
            {m.visibility === "private" ? t("actions.share") : t("actions.makePrivate")}
          </button>
        )}
        {(own || admin) && (
          <button
            type="button"
            className="small danger"
            disabled={busy}
            onClick={() => {
              if (!window.confirm(t("confirmDelete"))) return;
              void run(() => modelMarkupApi.remove(project.id, m.id), () => mm.select(null));
            }}
          >
            {t("actions.delete")}
          </button>
        )}
      </div>
      <h3 style={{ marginTop: 12 }}>{t("comments")}</h3>
      {m.comments.length === 0 && <p className="muted small">{t("noComments")}</p>}
      <ul className="mm-comments">
        {m.comments.map((c) => (
          <li key={c.id}>
            <div className="muted small">{t("meta", { author: c.authorName ?? "", date: formatDate(c.createdAt) })}</div>
            {c.body}
          </li>
        ))}
      </ul>
      {m.canComment && (
        <form
          className="mm-comment-form"
          onSubmit={(e) => {
            e.preventDefault();
            const body = comment.trim();
            if (!body) return;
            void run(() => modelMarkupApi.comment(project.id, m.id, body).then(() => setComment("")));
          }}
        >
          <textarea value={comment} placeholder={t("commentPlaceholder")} aria-label={t("commentPlaceholder")} onChange={(e) => setComment(e.target.value)} />
          <button type="submit" className="small" disabled={!comment.trim() || busy}>
            {t("actions.send")}
          </button>
        </form>
      )}
      {issueOpen && <IssueFromMarkupDialog mm={mm} onClose={() => setIssueOpen(false)} />}
    </div>
  );
}

function SaveMarkupDialog({ mm }: { mm: ModelMarkups }) {
  const { t } = useTranslation(["modelMarkup", "common"]);
  const p = mm.pending!;
  const [title, setTitle] = useState("");
  const [color, setColor] = useState(p.color);
  const [visibility, setVisibility] = useState<ModelMarkupVisibility>("private");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const created = await modelMarkupApi.create(mm.projectId, {
        kind: p.kind,
        versionId: p.versionId,
        title: title.trim(),
        color: p.kind === "pin" ? color : p.color,
        visibility,
        viewpoint: p.viewpoint,
        anchor: p.anchor ?? null,
        shapes: p.shapes,
      });
      mm.setPending(null);
      mm.setMode(null);
      mm.reload();
      mm.select(created.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog title={t("saveTitle")} onClose={() => mm.setPending(null)}>
      <label htmlFor="mm-title">{t("fields.title")}</label>
      <input id="mm-title" autoFocus value={title} maxLength={300} onChange={(e) => setTitle(e.target.value)} />
      {p.kind === "pin" && (
        <>
          <label>{t("fields.colour")}</label>
          <div className="row" style={{ gap: 6 }}>
            {MODEL_MARKUP_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                className="swatch"
                style={{ background: c, width: 22, height: 22, padding: 0, borderRadius: "50%", boxShadow: color === c ? "0 0 0 2px var(--primary)" : "0 0 0 1px var(--border)" }}
                onClick={() => setColor(c)}
                aria-label={t("colour", { colour: c })}
                aria-pressed={color === c}
              />
            ))}
          </div>
        </>
      )}
      <label>{t("fields.visibility")}</label>
      {(["private", "project"] as const).map((v) => (
        <label key={v} className="row" style={{ gap: 6, fontWeight: 400 }}>
          <input type="radio" name="mm-visibility" checked={visibility === v} onChange={() => setVisibility(v)} />
          <span>
            <strong>{t(`visibility.${v}`)}</strong> <span className="muted small">{t(`visibilityHint.${v}`)}</span>
          </span>
        </label>
      ))}
      {p.viewpoint.snapshot && <img className="mm-snapshot" src={p.viewpoint.snapshot} alt={t("saveTitle")} />}
      {error && <p className="error">{error}</p>}
      <div className="dialog-actions">
        <button type="button" onClick={() => mm.setPending(null)}>
          {t("actions.cancel")}
        </button>
        <button type="button" className="primary" disabled={busy} onClick={() => void save()}>
          {t("actions.save")}
        </button>
      </div>
    </Dialog>
  );
}

function IssueFromMarkupDialog({ mm, onClose }: { mm: ModelMarkups; onClose(): void }) {
  const { t } = useTranslation(["modelMarkup", "common"]);
  const label = useLabel();
  const m = mm.active!;
  const [title, setTitle] = useState(m.title);
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<IssuePriority>("normal");
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ id: string; number: number } | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const r = await modelMarkupApi.toIssue(mm.projectId, m.id, { title: title.trim(), description: description.trim() || null, priority });
      setCreated(r.issue);
      mm.reload();
      mm.refreshActive();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog title={t("issueTitle")} onClose={onClose}>
      {created ? (
        <>
          <p className="success">
            {t("issueCreated", { number: created.number })}{" "}
            <Link to={`/projects/${mm.projectId}/issues/${created.id}`}>{t("openIssue")}</Link>
          </p>
          <div className="dialog-actions">
            <button type="button" className="primary" onClick={onClose}>
              {t("common:actions.close")}
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="muted small">{t("issueHint")}</p>
          <label htmlFor="mm-issue-title">{t("fields.title")}</label>
          <input id="mm-issue-title" autoFocus value={title} maxLength={300} onChange={(e) => setTitle(e.target.value)} />
          <label htmlFor="mm-issue-description">{t("fields.description")}</label>
          <textarea id="mm-issue-description" value={description} onChange={(e) => setDescription(e.target.value)} />
          <label htmlFor="mm-issue-priority">{t("fields.priority")}</label>
          <select id="mm-issue-priority" value={priority} onChange={(e) => setPriority(e.target.value as IssuePriority)}>
            {(["low", "normal", "high", "critical"] as IssuePriority[]).map((p) => (
              <option key={p} value={p}>
                {label("issuePriority", p)}
              </option>
            ))}
          </select>
          {error && <p className="error">{error}</p>}
          <div className="dialog-actions">
            <button type="button" onClick={onClose}>
              {t("actions.cancel")}
            </button>
            <button type="button" className="primary" disabled={!title.trim() || busy} onClick={() => void submit()}>
              {t("common:actions.create")}
            </button>
          </div>
        </>
      )}
    </Dialog>
  );
}
