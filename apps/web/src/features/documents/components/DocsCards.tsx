import type { ReactNode } from "react";
import { Trans, useTranslation } from "react-i18next";
import { type FileDto, type FolderDto, type VirtualFolderDto } from "@sitekeep/shared";
import { useLabel } from "../../../i18n";
import { fileDay } from "../docs-phone";

/** A file card; search hits also carry their folder and the text that matched. */
export type DocsCardFile = FileDto & { folderPath?: string; snippet?: string };

/**
 * Narrow view of a Dokümanlar folder (≤ 900px): folders as simple rows, then one card per file with
 * icon, name (wrapping), version, updated day and the approval/status badges. A tap opens the file
 * drawer; in "Seç" mode it ticks the file (and folder) instead, for ZIP İndir / İnceleme Başlat.
 */
export function DocsCards({
  folders = [],
  virtualFolders = [],
  files,
  selectedId,
  selecting,
  checked,
  iconFor,
  badges,
  emptyText,
  onOpenFolder,
  onOpenFile,
  onOpenVersion,
  onToggle,
  onVirtual,
}: {
  folders?: FolderDto[];
  virtualFolders?: VirtualFolderDto[];
  files: DocsCardFile[];
  selectedId?: string | null;
  selecting: boolean;
  /** Ticked rows as "file:<id>" / "folder:<id>". */
  checked: Set<string>;
  iconFor(extension: string): string;
  /** Approval and status badges of a file (links; a tap on them does not open the drawer). */
  badges?(file: DocsCardFile): ReactNode;
  /** Shown when there are no rows at all (null: nothing, e.g. while loading). */
  emptyText?: string | null;
  onOpenFolder(id: string): void;
  onOpenFile(id: string): void;
  onOpenVersion?(id: string): void;
  onToggle(key: string): void;
  /** A folder of the template that is not created yet (null: the user cannot upload here). */
  onVirtual?: ((name: string) => void) | null;
}) {
  const { t } = useTranslation(["documents", "common"]);
  const label = useLabel();
  if (!folders.length && !virtualFolders.length && !files.length)
    return emptyText ? <div className="muted record-cards-empty">{emptyText}</div> : null;
  const tick = (key: string, name: string) =>
    selecting && (
      <input type="checkbox" className="doc-card-check" aria-label={t("selectItem", { name })} checked={checked.has(key)} onChange={() => onToggle(key)} />
    );
  return (
    <ul className="doc-cards" aria-label={t("cards.folderContents")}>
      {folders.map((f) => (
        <li key={`folder:${f.id}`} className={`doc-folder${checked.has(`folder:${f.id}`) ? " checked" : ""}`}>
          {tick(`folder:${f.id}`, f.name)}
          <button
            type="button"
            className="doc-folder-main"
            data-tour-folder={f.name}
            onClick={() => (selecting ? onToggle(`folder:${f.id}`) : onOpenFolder(f.id))}
          >
            <span aria-hidden="true">📁</span>
            <span className="doc-card-name">{f.name}</span>
            {f.state && <span className="badge info">{f.stateLabel ?? label("folderState", f.state)}</span>}
            {!selecting && (
              <span className="muted" aria-hidden="true">
                ›
              </span>
            )}
          </button>
        </li>
      ))}
      {virtualFolders.map((v) => (
        <li key={`virtual:${v.name}`} className="doc-folder virtual">
          <button type="button" className="doc-folder-main" disabled={!onVirtual} onClick={() => onVirtual?.(v.name)}>
            <span aria-hidden="true">📁</span>
            <span className="doc-card-name">
              {v.name}
              <span className="muted small"> · {t("page.virtual.note")}</span>
            </span>
            {v.state && <span className="badge">{v.stateLabel ?? label("folderState", v.state)}</span>}
          </button>
        </li>
      ))}
      {files.map((f) => {
        const key = `file:${f.id}`;
        const extra = badges?.(f);
        return (
          <li key={key} className={`doc-card${f.id === selectedId ? " selected" : ""}${checked.has(key) ? " checked" : ""}`}>
            {tick(key, f.name)}
            <button type="button" className="doc-card-main" onClick={() => (selecting ? onToggle(key) : onOpenFile(f.id))}>
              <span className="doc-card-icon" aria-hidden="true">
                {iconFor(f.extension)}
              </span>
              <span className="doc-card-text">
                <span className="doc-card-name">{f.name}</span>
                <span className="muted small">
                  {!onOpenVersion && `V${f.currentVersion} · `}
                  {fileDay(f.latest.uploadedAt)}
                  {f.folderPath ? ` · ${f.folderPath}` : ""}
                </span>
                {f.snippet && (
                  <span className="small doc-card-snippet">
                    <Trans t={t} i18nKey="search.snippet" values={{ snippet: f.snippet }} components={{ m: <span className="muted" /> }} />
                  </span>
                )}
              </span>
            </button>
            {onOpenVersion && !selecting && (
              <button
                type="button"
                className="version-link"
                title={t("page.openVersionHistory", { name: f.name })}
                onClick={() => onOpenVersion(f.id)}
              >
                V{f.currentVersion}
              </button>
            )}
            {extra && <span className="doc-card-badges">{extra}</span>}
          </li>
        );
      })}
    </ul>
  );
}
