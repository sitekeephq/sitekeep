import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import {
  viewerFor,
  viewerLabel,
  viewerPath,
  type EffectiveAttributeDto,
  type FileDto,
  type FolderDto,
} from "@sitekeep/shared";
import { useLabel } from "../../i18n";
import { Icon } from "../../shared/ui/Icon";

/** Editable description shared by file and folder rows. */
export function DescriptionCell({
  value,
  canEdit,
  onSave,
}: {
  value: string | null;
  canEdit: boolean;
  onSave(description: string | null): Promise<void>;
}) {
  const { t } = useTranslation(["documents", "common"]);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null | undefined>(undefined);
  useEffect(() => setPending(undefined), [value]);
  const shown = pending !== undefined ? pending : value;
  const cancelled = useRef(false);

  async function save() {
    const next = draft.trim() || null;
    setEditing(false);
    if (cancelled.current || next === (shown || null)) return;
    setPending(next);
    setError(null);
    try {
      await onSave(next);
    } catch (e) {
      setPending(undefined);
      setError((e as Error).message);
    }
  }

  if (editing)
    return (
      <div className="desc-edit">
        <input
          autoFocus
          value={draft}
          maxLength={500}
          placeholder={t("description.placeholder")}
          aria-label={t("common:fields.description")}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => void save()}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") {
              cancelled.current = true;
              e.currentTarget.blur();
            }
          }}
        />
      </div>
    );

  return (
    <div className={`desc-cell${canEdit ? " editable" : ""}`}>
      <span
        className={error ? "desc-text error" : shown ? "desc-text" : "desc-text muted"}
        title={error ? t("description.errors.saveFailedWith", { error }) : (shown ?? undefined)}
      >
        {error ? t("description.errors.saveFailed") : shown || (canEdit ? "" : "—")}
      </span>
      {canEdit && (
        <button
          type="button"
          className="ghost icon-button desc-pen"
          title={t("description.edit")}
          aria-label={t("description.edit")}
          onClick={() => {
            setDraft(shown ?? "");
            setError(null);
            cancelled.current = false;
            setEditing(true);
          }}
        >
          <Icon name="pen" size={14} />
        </button>
      )}
    </div>
  );
}

export function FolderRow({
  folder,
  extraColumns,
  checked,
  onToggle,
  onOpen,
  canEdit,
  onSaveDescription,
}: {
  folder: FolderDto;
  extraColumns: number;
  checked: boolean;
  onToggle(): void;
  onOpen(): void;
  canEdit: boolean;
  onSaveDescription(description: string | null): Promise<void>;
}) {
  const { t } = useTranslation(["documents", "common"]);
  const label = useLabel();
  return (
    <tr className="clickable" data-tour-folder={folder.name} onClick={onOpen}>
      <td className="sticky-col sticky-check" onClick={(e) => e.stopPropagation()}>
        <input type="checkbox" style={{ width: "auto" }} aria-label={t("selectItem", { name: folder.name })} checked={checked} onChange={onToggle} />
      </td>
      <td className="sticky-col sticky-name">
        <span className="name-cell">
          <span className="name-icon">
            <Icon name="folder" size={18} />
          </span>
          <span className="name-text">{folder.name}</span>
        </span>
      </td>
      <td onClick={(e) => e.stopPropagation()}>
        <DescriptionCell value={folder.description ?? null} canEdit={canEdit} onSave={onSaveDescription} />
      </td>
      <td className="muted">--</td>
      <td colSpan={4 + extraColumns} />
      <td>{folder.state && <span className="badge info">{folder.stateLabel ?? label("folderState", folder.state)}</span>}</td>
    </tr>
  );
}

/** Second header row: browser-side name and attribute filters. */
export function FilterRow({
  defs,
  filters,
  onChange,
}: {
  defs: EffectiveAttributeDto[];
  filters: Record<string, string>;
  onChange(f: Record<string, string>): void;
}) {
  const { t } = useTranslation(["documents", "common"]);
  const set = (k: string, v: string) => onChange({ ...filters, [k]: v });
  const cell = (key: string, child: ReactNode = null) => (
    <th
      key={key}
      className={`filter-cell${key === "check" ? " sticky-col sticky-check" : key === "name" ? " sticky-col sticky-name" : ""}`}
    >
      {child}
    </th>
  );
  return (
    <tr>
      {cell("check")}
      {cell("name", <input placeholder={t("filters.nameContains")} value={filters.__name ?? ""} onChange={(e) => set("__name", e.target.value)} />)}
      {cell(
        "description",
        <input placeholder={t("filters.descriptionContains")} value={filters.__description ?? ""} onChange={(e) => set("__description", e.target.value)} />,
      )}
      {cell("version")}
      {defs.map((d) =>
        cell(
          d.id,
          d.type === "list" ? (
            <select value={filters[d.name] ?? ""} onChange={(e) => set(d.name, e.target.value)}>
              <option value="">{t("common:status.all")}</option>
              {d.options.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          ) : (
            <input placeholder={t("filters.contains")} value={filters[d.name] ?? ""} onChange={(e) => set(d.name, e.target.value)} />
          ),
        ),
      )}
      {cell("size")}
      {cell("user")}
      {cell("date")}
      {cell("approval")}
      {cell(
        "clear",
        Object.values(filters).some(Boolean) ? (
          <button className="small ghost" onClick={() => onChange({})}>
            {t("common:actions.clear")}
          </button>
        ) : null,
      )}
    </tr>
  );
}

/** Phone equivalent of the table's filter row. */
export function PhoneFilters({
  defs,
  filters,
  onChange,
}: {
  defs: EffectiveAttributeDto[];
  filters: Record<string, string>;
  onChange(f: Record<string, string>): void;
}) {
  const { t } = useTranslation(["documents", "common"]);
  const set = (k: string, v: string) => onChange({ ...filters, [k]: v });
  return (
    <div className="docs-phone-filters">
      <label>
        {t("common:fields.name")}
        <input placeholder={t("filters.nameContains")} value={filters.__name ?? ""} onChange={(e) => set("__name", e.target.value)} />
      </label>
      {defs.map((d) => (
        <label key={d.id}>
          {d.name}
          {d.type === "list" ? (
            <select value={filters[d.name] ?? ""} onChange={(e) => set(d.name, e.target.value)}>
              <option value="">{t("common:status.all")}</option>
              {d.options.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          ) : (
            <input placeholder={t("filters.contains")} value={filters[d.name] ?? ""} onChange={(e) => set(d.name, e.target.value)} />
          )}
        </label>
      ))}
      {Object.values(filters).some(Boolean) && (
        <button className="small ghost" onClick={() => onChange({})}>
          {t("common:actions.clear")}
        </button>
      )}
    </div>
  );
}

export function DerivativeBadge({ file, projectId }: { file: FileDto; projectId: string }) {
  const { t, i18n } = useTranslation(["documents", "common"]);
  const status = file.latest.derivativeStatus;
  const kind = viewerFor(file.name).kind;
  if (kind !== "ifc" && kind !== "none")
    return (
      <Link
        to={viewerPath(projectId, file.name, file.latest.id)}
        onClick={(e) => e.stopPropagation()}
        className="badge info"
        title={t("derivative.openAs", { kind: viewerLabel(kind, i18n.language) })}
      >
        {t("common:actions.open")}
      </Link>
    );
  if (status === "none") return null;
  if (status === "ready")
    return (
      <Link
        to={`/projects/${projectId}/viewer?v=${file.latest.id}`}
        onClick={(e) => e.stopPropagation()}
        className="badge ok"
        data-tour="open-model"
      >
        {t("derivative.actions.openModel")}
      </Link>
    );
  if (status === "failed")
    return (
      <span className="badge danger" title={file.latest.derivativeError ?? ""}>
        {t("derivative.status.failed")}
      </span>
    );
  return <span className="badge warn">{t("derivative.status.processing")}</span>;
}

export function iconFor(ext: string): string {
  if (ext === "ifc") return "🧊";
  if (ext === "pdf") return "📕";
  if (["dwg", "dxf"].includes(ext)) return "📐";
  if (["rvt", "nwd", "nwc"].includes(ext)) return "🏗";
  if (["png", "jpg", "jpeg"].includes(ext)) return "🖼";
  const kind = viewerFor(`x.${ext}`).kind;
  if (kind === "sheet") return "📊";
  if (kind === "document") return "📝";
  if (kind === "slides") return "📽";
  if (kind === "image") return "🖼";
  if (kind === "video" || kind === "audio") return "🎞";
  if (kind === "email") return "✉";
  return "📄";
}
