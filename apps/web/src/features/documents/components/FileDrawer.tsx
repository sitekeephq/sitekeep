import { useEffect, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { LocationLinkField } from "../../../shared/ui/LocationSelect";
import { Link } from "react-router-dom";
import { can, docCompareKind, validateAttributes, viewerFor, viewerPath, type EffectiveAttributeDto, type PermissionLevel } from "@sitekeep/shared";
import { formatDate, formatNumber, formatSize } from "../../../shared/api/api";
import { documentsApi } from "../api";
import { useLoad } from "../../../app/context/project";
import { AntetPanel } from "./AntetPanel";
import { ApprovalBadge } from "./ApprovalBadge";
import { AttributeInput } from "../../../shared/ui/AttributeInput";
import { FileTransferDialog } from "./FileTransferDialog";
import { WhoCanSeeDialog } from "./WhoCanSeeDialog";
import { webCapability } from "../../../sdk";

// Parameter change bits come from the Coordinate module; without it the hook returns nothing. Read when
// used: modules are turned on at start (app/modules.ts), after this file loads; fixed for the session.
const paramFileCapability = () => webCapability("coordinate.paramFile");
function useParamFileStatus(projectId: string, fileId: string, enabled: boolean): unknown {
  const useStatus = paramFileCapability()?.useStatus;
  return useStatus ? useStatus(projectId, fileId, enabled) : null;
}
import { useAsk } from "../../../shared/ui/Ask";

export function FileDrawer({
  projectId,
  fileId,
  level,
  onClose,
  onChanged,
}: {
  projectId: string;
  fileId: string;
  level: PermissionLevel;
  onClose(): void;
  onChanged(): void;
}) {
  const { t, i18n } = useTranslation(["documents", "common"]);
  const { confirm, prompt } = useAsk();
  const { data: file, error, reload } = useLoad(() => documentsApi.file(projectId, fileId), [projectId, fileId]);
  const { data: approvals } = useLoad(() => documentsApi.fileApprovals(projectId, fileId), [projectId, fileId]);
  const folderId = file?.folderId;
  const { data: defs } = useLoad(
    () => (folderId ? documentsApi.folderAttributes(projectId, folderId) : Promise.resolve([] as EffectiveAttributeDto[])),
    [projectId, folderId],
  );
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [attrKey, setAttrKey] = useState("");
  const [attrValue, setAttrValue] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [whoOpen, setWhoOpen] = useState(false);
  const [transfer, setTransfer] = useState<"move" | "copy" | null>(null);
  const canEdit = can(level, "edit");
  const viewer = viewerFor(file?.name ?? "", i18n.language);
  const paramFile = paramFileCapability();
  const paramStatus = useParamFileStatus(projectId, fileId, viewer.kind === "ifc");
  const canDownload = can(level, "download");
  // Browser editing (WOPI, Connect module): "Düzenle" and "X düzenliyor"; reloads when the editor saved.
  // The installed modules never change while the app runs, so the hook order is stable.
  const connect = webCapability("connect.ui");
  const useFileOffice = connect?.useFileOffice ?? (() => null);
  const office = useFileOffice(projectId, file, () => {
    reload();
    onChanged();
  });

  // Start the typed-attribute form from the file's current values.
  useEffect(() => {
    if (file) setDraft(Object.fromEntries((defs ?? []).map((d) => [d.name, file.attributes[d.name] ?? ""])));
  }, [file, defs]);

  const typed = defs ?? [];
  const typedNames = new Set(typed.map((d) => d.name));
  const changed = file ? Object.fromEntries(Object.entries(draft).filter(([k, v]) => (file.attributes[k] ?? "") !== v)) : {};
  const draftErrors = validateAttributes(typed, changed, { partial: true, lang: i18n.language });

  async function act(fn: () => Promise<unknown>) {
    setMsg(null);
    try {
      await fn();
      reload();
      onChanged();
    } catch (e) {
      setMsg((e as Error).message);
    }
  }

  return (
    <aside className="drawer">
      <div className="row">
        <h2 style={{ margin: 0, wordBreak: "break-all" }}>{file?.name ?? "…"}</h2>
        <div className="spacer" />
        <button className="ghost" onClick={onClose} aria-label={t("common:actions.close")}>✕</button>
      </div>
      {error && <p className="error">{error}</p>}
      {msg && <p className="error">{msg}</p>}
      {file && (
        <div className="stack" style={{ marginTop: 12 }}>
          <h3 style={{ margin: 0 }}>{t("page.fileActions")}</h3>
          <div className="row wrap">
            {canDownload && (
              <a className="btn" href={documentsApi.downloadUrl(projectId, file.latest.id)}>
                {t("drawer.actions.download", { version: file.currentVersion })}
              </a>
            )}
            {viewer.kind !== "ifc" && viewer.kind !== "none" && (
              <Link className="btn primary" to={viewerPath(projectId, file.name, file.latest.id)} title={t("derivative.openAs", { kind: viewer.label })}>
                {t("drawer.actions.open")}
              </Link>
            )}
            {file && connect && <connect.OfficeEditButton projectId={projectId} fileId={file.id} office={office} />}
            {docCompareKind(file.extension) && file.versions.length > 1 && (
              <Link
                className="btn"
                to={`/projects/${projectId}/compare?to=${file.latest.id}`}
                title={t("drawer.compareRevisionHint")}
              >
                {t("drawer.actions.compareRevision")}
              </Link>
            )}
            {file.latest.derivativeStatus === "ready" && (
              <Link className="btn" to={`/projects/${projectId}/viewer?v=${file.latest.id}`}>
                {t("drawer.actions.openInModel")}
              </Link>
            )}
            {file.latest.derivativeStatus === "ready" && file.versions.filter((v) => v.derivativeStatus === "ready").length > 1 && (
              <Link
                className="btn"
                to={`/projects/${projectId}/viewer?v=${file.latest.id}&cmp=${file.versions.find((v) => v.id !== file.latest.id && v.derivativeStatus === "ready")!.id},${file.latest.id}`}
              >
                {t("drawer.actions.compareVersion")}
              </Link>
            )}
            {viewer.kind === "ifc" && paramFile && <paramFile.FileButton projectId={projectId} fileId={file.id} status={paramStatus} />}
            {can(level, "view") && (
              <button title={t("drawer.accessHint")} onClick={() => setWhoOpen(true)}>
                {t("drawer.actions.access")}
              </button>
            )}
            {canEdit && (
              <>
                <button onClick={() => setTransfer("move")}>{t("drawer.actions.move")}</button>
                <button
                  onClick={() =>
                    void prompt({ title: t("drawer.rename"), defaultValue: file.name, confirmLabel: t("common:actions.save") }).then(
                      (name) => {
                        if (name && name !== file.name) void act(() => documentsApi.updateFile(projectId, file.id, { name }));
                      },
                    )
                  }
                >
                  {t("drawer.actions.rename")}
                </button>
                <button
                  className="danger"
                  onClick={() =>
                    void confirm({
                      title: t("drawer.deleteTitle"),
                      message: t("drawer.deleteConfirm", { name: file.name }),
                      confirmLabel: t("common:actions.delete"),
                      danger: true,
                    }).then((ok) => {
                      if (!ok) return;
                      void act(async () => {
                        await documentsApi.deleteFile(projectId, file.id);
                        onClose();
                      });
                    })
                  }
                >
                  {t("drawer.actions.delete")}
                </button>
              </>
            )}
            {canDownload && <button onClick={() => setTransfer("copy")}>{t("drawer.actions.copy")}</button>}
          </div>
          {connect && <connect.OfficeLockNote office={office} />}

          {file.latest.ifcSummary && (
            <div className="card" style={{ padding: 12 }}>
              <h3>{t("drawer.ifc.heading")}</h3>
              <div className="small">
                <Trans
                  t={t}
                  i18nKey="drawer.ifc.summary"
                  values={{
                    schema: file.latest.ifcSummary.schema,
                    project: file.latest.ifcSummary.projectName ?? "—",
                    elements: formatNumber(file.latest.ifcSummary.elementCount),
                  }}
                  components={{ b: <strong /> }}
                />
              </div>
              <div className="row wrap small" style={{ marginTop: 6 }}>
                {Object.entries(file.latest.ifcSummary.byClass)
                  .sort((a, b) => b[1] - a[1])
                  .slice(0, 12)
                  .map(([k, v]) => (
                    <span key={k} className="badge">
                      {k.replace(/^Ifc/, "")} {v}
                    </span>
                  ))}
              </div>
            </div>
          )}

          {file.extension === "pdf" && (
            <AntetPanel
              projectId={projectId}
              file={file}
              canEdit={canEdit}
              onChanged={() => {
                reload();
                onChanged();
              }}
            />
          )}

          <div>
            <LocationLinkField projectId={projectId} kind="file" targetId={file.id} disabled={!canEdit} />
            <h3>{t("upload.attributes.heading")}</h3>
            {typed.length > 0 && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!Object.keys(changed).length || draftErrors.length) return;
                  void act(() => documentsApi.updateFile(projectId, file.id, { attributes: changed }));
                }}
              >
                <table className="props-table">
                  <tbody>
                    {typed.map((d) => (
                      <tr key={d.id}>
                        <td title={d.inherited ? t("page.attributeInherited") : undefined}>
                          {d.name}
                          {d.required && <span style={{ color: "var(--danger)" }}> *</span>}
                        </td>
                        <td>
                          {canEdit ? (
                            <AttributeInput
                              def={d}
                              value={draft[d.name] ?? ""}
                              onChange={(v) => setDraft((s) => ({ ...s, [d.name]: v }))}
                              style={{ padding: "3px 6px" }}
                            />
                          ) : (
                            (file.attributes[d.name] ?? <span className="muted">—</span>)
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {canEdit && draftErrors.length > 0 && (
                  <p className="error small">{draftErrors.map((e) => e.message).join(" ")}</p>
                )}
                {canEdit && (
                  <div className="row" style={{ marginTop: 8 }}>
                    <div className="spacer" />
                    <button
                      type="button"
                      className="small"
                      disabled={!Object.keys(changed).length}
                      onClick={() => setDraft(Object.fromEntries(typed.map((d) => [d.name, file.attributes[d.name] ?? ""])))}
                    >
                      {t("upload.suggestion.actions.undo")}
                    </button>
                    <button className="small primary" disabled={!Object.keys(changed).length || draftErrors.length > 0}>
                      {t("drawer.actions.saveAttributes")}
                    </button>
                  </div>
                )}
              </form>
            )}
            {Object.keys(file.attributes).some((k) => !typedNames.has(k)) && (
              <>
                {typed.length > 0 && <h4 className="muted small" style={{ margin: "12px 0 4px" }}>{t("drawer.otherAttributes.heading")}</h4>}
                <table className="props-table">
                  <tbody>
                    {Object.entries(file.attributes)
                      .filter(([k]) => !typedNames.has(k))
                      .map(([k, v]) => (
                        <tr key={k}>
                          <td>{k}</td>
                          <td>{v}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </>
            )}
            {Object.keys(file.attributes).length === 0 && typed.length === 0 && <p className="muted small">{t("drawer.noAttributes")}</p>}
            {canEdit && (
              <form
                className="row"
                style={{ marginTop: 8 }}
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!attrKey) return;
                  void act(() => documentsApi.updateFile(projectId, file.id, { attributes: { [attrKey]: attrValue } }));
                  setAttrKey("");
                  setAttrValue("");
                }}
              >
                <input placeholder={t("drawer.freeAttributeName")} value={attrKey} onChange={(e) => setAttrKey(e.target.value)} />
                <input placeholder={t("drawer.attributeValue")} value={attrValue} onChange={(e) => setAttrValue(e.target.value)} />
                <button>{t("common:actions.add")}</button>
              </form>
            )}
          </div>

          <div>
            <h3>{t("drawer.history.heading")}</h3>
            <table className="phone-cards">
              <tbody>
                {file.versions.map((v) => (
                  <tr key={v.id}>
                    <td className="pc-title" style={{ width: 50 }}>
                      <span className="badge">V{v.version}</span>
                    </td>
                    <td data-label={t("drawer.history.uploader")}>
                      <div>{v.uploadedByName}</div>
                      <div className="muted small">
                        {formatDate(v.uploadedAt)} · {formatSize(v.size)}
                      </div>
                      {v.comment && <div className="small">{v.comment}</div>}
                      {paramFile && <paramFile.VersionBadge status={paramStatus} versionId={v.id} />}
                      {approvals
                        ?.filter((x) => x.versionId === v.id)
                        .map((x) => (
                          <div key={`${x.reviewId}${x.isCopy ? "c" : ""}`} className="small" style={{ marginTop: 2 }}>
                            <ApprovalBadge projectId={projectId} approval={x} />{" "}
                            <span className="muted">{t("drawer.history.review", { number: x.reviewNumber })}</span>
                          </div>
                        ))}
                    </td>
                    <td className="pc-actions" style={{ width: 90, textAlign: "right" }}>
                      {canDownload && (
                        <a href={documentsApi.downloadUrl(projectId, v.id)} className="small">
                          {t("common:actions.download")}
                        </a>
                      )}
                      {viewer.kind !== "ifc" && viewer.kind !== "none" && (
                        <div>
                          <Link className="small" to={viewerPath(projectId, file.name, v.id)}>
                            {t("common:actions.open")}
                          </Link>
                        </div>
                      )}
                      {v.derivativeStatus === "ready" && (
                        <div>
                          <Link className="small" to={`/projects/${projectId}/viewer?v=${v.id}`}>
                            {t("drawer.history.model")}
                          </Link>
                        </div>
                      )}
                      {docCompareKind(file.extension) && v.version > 1 && (
                        <div>
                          <Link className="small" to={`/projects/${projectId}/compare?to=${v.id}`} title={t("drawer.history.compareHint")}>
                            {t("modelCompare.dialog.actions.compare")}
                          </Link>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted small mono">SHA-256: {file.latest.sha256.slice(0, 16)}…</p>
        </div>
      )}
      {whoOpen && file && (
        <WhoCanSeeDialog projectId={projectId} folderId={file.folderId} fileId={file.id} onClose={() => setWhoOpen(false)} />
      )}
      {transfer && file && (
        <FileTransferDialog
          projectId={projectId}
          currentFolderId={file.folderId}
          fileId={file.id}
          fileName={file.name}
          mode={transfer}
          onClose={() => setTransfer(null)}
          onDone={() => {
            setTransfer(null);
            onChanged();
            if (transfer === "move") onClose();
            else reload();
          }}
        />
      )}
    </aside>
  );
}
