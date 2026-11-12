import { useMemo, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { foldTr, type TrashFileDto, type TrashFolderDto } from "@sitekeep/shared";
import { i18n } from "../../../i18n";
import { ApiError, formatDate, formatSize } from "../../../shared/api/api";
import { documentsApi } from "../api";
import { useAuth } from "../../../app/context/auth";
import { useLoad, useProject } from "../../../app/context/project";
import { useAsk } from "../../../shared/ui/Ask";
import { Dialog } from "../../../shared/ui/Dialog";
import { Icon } from "../../../shared/ui/Icon";
import { LoadingIndicator, LoadingSpinner } from "../../../shared/ui/LoadingIndicator";
type Item = { kind: "folder"; item: TrashFolderDto } | { kind: "file"; item: TrashFileDto };
type KindFilter = "all" | "folder" | "file";

const keyOf = (i: Item) => `${i.kind}:${i.item.id}`;
const restorable = (i: Item) => (i.kind === "folder" ? i.item.parentAlive : i.item.folderAlive);

/** "3 dk önce", "2 gün önce"; the exact time is in the title. */
export function timeAgo(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return i18n.t("documents:deleted.ago.now");
  const m = Math.round(s / 60);
  if (m < 60) return i18n.t("documents:deleted.ago.minutes", { count: m });
  const h = Math.round(m / 60);
  if (h < 24) return i18n.t("documents:deleted.ago.hours", { count: h });
  const d = Math.round(h / 24);
  if (d < 30) return i18n.t("documents:deleted.ago.days", { count: d });
  return formatDate(iso);
}

/**
 * Silinenler: deleted files and folders of the project, newest first. Project administrators
 * restore them to where they were; system administrators also delete them permanently.
 */
export function DeletedItems({ embedded = false }: { embedded?: boolean }) {
  const { t } = useTranslation(["documents", "common"]);
  const { prompt } = useAsk();
  const project = useProject();
  const { user } = useAuth();
  const { data, error, reload } = useLoad(() => documentsApi.trash(project.id), [project.id]);
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<KindFilter>("all");
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [purging, setPurging] = useState<Item[] | null>(null);
  const canPurge = !!user?.isAdmin;

  const items = useMemo<Item[]>(() => {
    if (!data) return [];
    const all: Item[] = [
      ...data.folders.map((item) => ({ kind: "folder" as const, item })),
      ...data.files.map((item) => ({ kind: "file" as const, item })),
    ];
    const q = foldTr(query.trim());
    return all
      .filter((i) => kind === "all" || i.kind === kind)
      .filter((i) => !q || foldTr(`${i.item.name} ${i.item.path} ${i.item.deletedByName ?? ""}`).includes(q))
      .sort((a, b) => b.item.deletedAt.localeCompare(a.item.deletedAt));
  }, [data, query, kind]);

  const selected = items.filter((i) => checked.has(keyOf(i)));
  const allChecked = items.length > 0 && selected.length === items.length;

  async function restoreOne(i: Item, newName?: string): Promise<string | null> {
    try {
      if (i.kind === "file") await documentsApi.restoreFile(project.id, i.item.id, newName);
      else await documentsApi.restoreFolder(project.id, i.item.id, newName);
      return null;
    } catch (e) {
      const err = e as ApiError;
      const reason = (err.body as { details?: { reason?: string } } | undefined)?.details?.reason;
      if (err.status === 409 && reason === "name_conflict" && newName === undefined) {
        const next = await prompt({
          title: t("deleted.newName"),
          message: err.message,
          defaultValue: withSuffix(i.item.name, i.kind),
          confirmLabel: t("deleted.actions.restore"),
        });
        if (next?.trim() && next.trim() !== i.item.name) return restoreOne(i, next.trim());
        return t("deleted.nameConflict");
      }
      return err.message;
    }
  }

  async function restore(list: Item[]) {
    setMsg(null);
    setBusy("restore");
    const failed: string[] = [];
    let done = 0;
    for (const i of list) {
      const err = await restoreOne(i);
      if (err) failed.push(`${i.item.name}: ${err}`);
      else done++;
    }
    setBusy(null);
    setChecked(new Set());
    if (failed.length) setMsg({ ok: false, text: t("deleted.messages.restorePartial", { count: done, errors: failed.join(" · ") }) });
    else
      setMsg({
        ok: true,
        text: list.length === 1 ? t("deleted.messages.restoredOne", { name: list[0].item.name }) : t("deleted.messages.restored", { count: done }),
      });
    reload();
  }

  const toggle = (k: string) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

  const counts = { all: (data?.folders.length ?? 0) + (data?.files.length ?? 0), folder: data?.folders.length ?? 0, file: data?.files.length ?? 0 };

  return (
    <div className={embedded ? "deleted-page stack" : "page deleted-page stack"}>
      {!embedded && (
        <div className="deleted-head">
          <div>
            <h1>{t("deleted.title")}</h1>
            <p className="muted">
              {t("deleted.description")} {canPurge ? t("deleted.purgeNote") : t("deleted.purgeAdminOnly")}
            </p>
          </div>
        </div>
      )}

      <div className="deleted-toolbar">
        <div className="segmented" role="tablist" aria-label={t("common:fields.type")}>
          {(
            [
              ["all", t("common:status.all")],
              ["folder", t("deleted.tabs.folders")],
              ["file", t("deleted.tabs.files")],
            ] as const
          ).map(([k, label]) => (
            <button key={k} role="tab" aria-selected={kind === k} className={kind === k ? "active" : ""} onClick={() => setKind(k)}>
              {label} <span className="segmented-count">{counts[k]}</span>
            </button>
          ))}
        </div>
        <label className="docs-search deleted-search">
          <Icon name="search" size={16} />
          <input placeholder={t("deleted.searchPlaceholder")} value={query} onChange={(e) => setQuery(e.target.value)} aria-label={t("deleted.searchLabel")} />
        </label>
        <span className="spacer" />
        {selected.length > 0 && (
          <>
            <span className="muted small">{t("deleted.selected", { count: selected.length })}</span>
            <button
              className="primary"
              disabled={!!busy || !selected.some(restorable)}
              onClick={() => void restore(selected.filter(restorable))}
            >
              {busy === "restore" ? <LoadingSpinner className="small" /> : <Icon name="refresh" size={16} />}
              {t("deleted.actions.restore")}
            </button>
            {canPurge && (
              <button className="danger" disabled={!!busy} onClick={() => setPurging(selected)}>
                <Icon name="trash" size={16} />
                {t("deleted.actions.purge")}
              </button>
            )}
          </>
        )}
        <button className="ghost icon-button" title={t("common:actions.refresh")} aria-label={t("common:actions.refresh")} onClick={reload}>
          <Icon name="refresh" size={16} />
        </button>
      </div>

      {error && <p className="error">{error}</p>}
      {msg && <p className={msg.ok ? "success" : "error"}>{msg.text}</p>}

      <div className="card deleted-card">
        <table className="deleted-table phone-cards">
          <thead>
            <tr>
              <th style={{ width: 40 }}>
                <input
                  type="checkbox"
                  style={{ width: "auto" }}
                  aria-label={t("common:actions.selectAll")}
                  checked={allChecked}
                  onChange={() => setChecked(allChecked ? new Set() : new Set(items.map(keyOf)))}
                />
              </th>
              <th>{t("common:fields.name")}</th>
              <th style={{ width: 240 }}>{t("deleted.columns.location")}</th>
              <th style={{ width: 140 }}>{t("deleted.columns.content")}</th>
              <th style={{ width: 150 }}>{t("deleted.columns.deletedBy")}</th>
              <th style={{ width: 120 }}>{t("deleted.columns.deletedAt")}</th>
              <th style={{ width: 150 }} />
            </tr>
          </thead>
          <tbody>
            {!data && !error && (
              <tr>
                <td colSpan={7}>
                  <LoadingIndicator compact />
                </td>
              </tr>
            )}
            {data && !items.length && (
              <tr>
                <td colSpan={7} className="empty-cell">
                  {counts.all ? t("deleted.noMatch") : t("deleted.empty")}
                </td>
              </tr>
            )}
            {items.map((i) => {
              const k = keyOf(i);
              const ok = restorable(i);
              return (
                <tr key={k} className={checked.has(k) ? "selected" : undefined}>
                  <td>
                    <input type="checkbox" style={{ width: "auto" }} aria-label={t("selectItem", { name: i.item.name })} checked={checked.has(k)} onChange={() => toggle(k)} />
                  </td>
                  <td data-label={t("common:fields.name")}>
                    <span className="name-cell">
                      <span className="name-icon">
                        <Icon name={i.kind === "folder" ? "folder" : "file"} size={18} />
                      </span>
                      <span className="name-text" title={i.item.name}>
                        {i.item.name}
                      </span>
                    </span>
                  </td>
                  <td data-label={t("deleted.columns.location")} className="muted small truncate" title={i.item.path}>
                    {i.item.path || t("deleted.projectFiles")}
                    {!ok && (
                      <span className="badge warn" style={{ marginLeft: 6 }}>
                        {i.kind === "folder" ? t("deleted.parentDeleted") : t("deleted.folderDeleted")}
                      </span>
                    )}
                  </td>
                  <td data-label={t("deleted.columns.content")} className="muted small">
                    {i.kind === "folder" ? t("autodesk.counts", { folders: i.item.folderCount, files: i.item.fileCount }) : `V${i.item.currentVersion} · ${formatSize(i.item.size)}`}
                  </td>
                  <td data-label={t("deleted.columns.deletedBy")} className="small">
                    {i.item.deletedByName ?? "—"}
                  </td>
                  <td data-label={t("deleted.columns.deletedAt")} className="small" title={formatDate(i.item.deletedAt)}>
                    {timeAgo(i.item.deletedAt)}
                  </td>
                  <td className="deleted-actions">
                    <button
                      className="small"
                      disabled={!ok || !!busy}
                      title={ok ? t("deleted.restoreHint") : i.kind === "folder" ? t("deleted.parentDeletedHint") : t("deleted.folderDeletedHint")}
                      onClick={() => void restore([i])}
                    >
                      {t("deleted.actions.restore")}
                    </button>
                    {canPurge && (
                      <button className="small ghost deleted-purge" disabled={!!busy} title={t("deleted.purgeLabel")} aria-label={t("deleted.purgeItem", { name: i.item.name })} onClick={() => setPurging([i])}>
                        <Icon name="trash" size={15} />
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {purging && (
        <PurgeDialog
          items={purging}
          onClose={() => setPurging(null)}
          onDone={(text, ok) => {
            setPurging(null);
            setChecked(new Set());
            setMsg({ ok, text });
            reload();
          }}
        />
      )}
    </div>
  );
}

function PurgeDialog({ items, onClose, onDone }: { items: Item[]; onClose(): void; onDone(text: string, ok: boolean): void }) {
  const { t } = useTranslation(["documents", "common"]);
  const project = useProject();
  const single = items.length === 1 ? items[0] : null;
  const confirmText = single ? single.item.name : t("deleted.purge.confirmWord");
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);

  async function purge() {
    setBusy(true);
    const failed: string[] = [];
    for (const i of items) {
      try {
        if (i.kind === "file") await documentsApi.purgeFile(project.id, i.item.id);
        else await documentsApi.purgeFolder(project.id, i.item.id);
      } catch (e) {
        failed.push(`${i.item.name}: ${(e as Error).message}`);
      }
    }
    const done = items.length - failed.length;
    if (failed.length) onDone(t("deleted.messages.purgePartial", { count: done, errors: failed.join(" · ") }), false);
    else onDone(single ? t("deleted.messages.purgedOne", { name: single.item.name }) : t("deleted.messages.purged", { count: done }), true);
  }

  return (
    <Dialog title={t("deleted.purge.title")} onClose={() => !busy && onClose()}>
      <p className="error" style={{ marginTop: 0 }}>
        {single
          ? single.kind === "folder"
            ? t("deleted.purge.folder", { name: single.item.name })
            : t("deleted.purge.file", { name: single.item.name })
          : t("deleted.purge.many", { count: items.length })}{" "}
        {t("deleted.purge.irreversible")}
      </p>
      {!single && (
        <ul className="bulk-delete-list">
          {items.slice(0, 8).map((i) => (
            <li key={keyOf(i)}>{i.item.name}</li>
          ))}
          {items.length > 8 && <li className="muted">{t("deleted.purge.more", { count: items.length - 8 })}</li>}
        </ul>
      )}
      <label>
        <Trans t={t} i18nKey="deleted.purge.typeToConfirm" values={{ text: confirmText }} components={{ b: <strong /> }} />
      </label>
      <input value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus />
      <div className="dialog-actions">
        <button onClick={onClose} disabled={busy}>
          {t("common:actions.cancel")}
        </button>
        <button className="danger" disabled={busy || typed.trim() !== confirmText} onClick={() => void purge()}>
          {busy ? <LoadingSpinner className="small" /> : t("deleted.actions.purge")}
        </button>
      </div>
    </Dialog>
  );
}

function withSuffix(name: string, kind: "file" | "folder"): string {
  const dot = name.lastIndexOf(".");
  const suffix = i18n.t("documents:deleted.restoredSuffix");
  return kind === "file" && dot > 0 ? `${name.slice(0, dot)} ${suffix}${name.slice(dot)}` : `${name} ${suffix}`;
}

export function DeletedPage() {
  return <DeletedItems />;
}
