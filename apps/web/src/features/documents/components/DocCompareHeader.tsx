import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { docCompareKind, splitExtension, type DocCompareDto } from "@sitekeep/shared";
import { documentsApi } from "../api";
import { useLoad, useProject } from "../../../app/context/project";
import { LoadingIndicator } from "../../../shared/ui/LoadingIndicator";
import { ReportShortcut } from "./ReportShortcut";

export function DocCompareHeader({
  dto,
  onPair,
  children,
}: {
  dto: DocCompareDto | null;
  onPair(from: string, to: string): void;
  children: ReactNode;
}) {
  const { t } = useTranslation(["documents", "common"]);
  const project = useProject();
  const { data: fileA } = useLoad(() => (dto ? documentsApi.file(project.id, dto.from.fileId) : Promise.resolve(null)), [project.id, dto?.from.fileId]);
  const { data: fileB } = useLoad(
    () => (dto ? (dto.to.fileId === dto.from.fileId ? Promise.resolve(null) : documentsApi.file(project.id, dto.to.fileId)) : Promise.resolve(null)),
    [project.id, dto?.to.fileId, dto?.from.fileId],
  );
  const filesB = fileB ?? fileA;
  const [other, setOther] = useState(false);
  const { data: siblings } = useLoad(
    () => (other && filesB ? documentsApi.contents(project.id, filesB.folderId) : Promise.resolve(null)),
    [project.id, other, filesB?.folderId],
  );
  if (!dto) return <LoadingIndicator className="doccmp-head" compact />;
  const extension = splitExtension(dto.to.fileName).extension.toLowerCase();
  const sameFile = dto.from.fileId === dto.to.fileId;
  const versionOptions = (file: typeof fileA) =>
    (file?.versions ?? []).map((version) => (
      <option key={version.id} value={version.id}>
        {version.version === file!.currentVersion ? t("compare.header.currentVersion", { version: version.version }) : `V${version.version}`}
      </option>
    ));
  return (
    <div className="doccmp-head">
      <Link className="small" to={`/projects/${project.id}/files/${filesB?.folderId ?? ""}`} title={t("compare.header.backToFolder")}>←</Link>
      <strong style={{ wordBreak: "break-all" }}>{sameFile ? dto.to.fileName : `${dto.from.fileName} ⇄ ${dto.to.fileName}`}</strong>
      <span className="row" style={{ gap: 4 }}>
        <span className="badge diff-removed">{t("compare.header.old")}</span>
        <select value={dto.from.versionId} onChange={(event) => onPair(event.target.value, dto.to.versionId)} aria-label={t("compare.header.oldVersion")}>
          {fileA ? versionOptions(fileA) : <option value={dto.from.versionId}>V{dto.from.version}</option>}
        </select>
        <button className="small ghost" title={t("compare.header.swap")} onClick={() => onPair(dto.to.versionId, dto.from.versionId)}>⇄</button>
        <span className="badge diff-added">{t("compare.header.new")}</span>
        <select value={dto.to.versionId} onChange={(event) => onPair(dto.from.versionId, event.target.value)} aria-label={t("compare.header.newVersion")}>
          {filesB ? versionOptions(filesB) : <option value={dto.to.versionId}>V{dto.to.version}</option>}
        </select>
      </span>
      {(dto.from.revision || dto.to.revision) && <span className="small muted">{t("compare.header.revisions", { from: dto.from.revision ?? "?", to: dto.to.revision ?? "?" })}</span>}
      {!other ? (
        <button className="small ghost" onClick={() => setOther(true)} title={t("compare.header.otherFileHint")}>{t("compare.header.actions.otherFile")}</button>
      ) : (
        <select
          value=""
          onChange={(event) => {
            const file = siblings?.files.find((item) => item.id === event.target.value);
            if (file) onPair(file.latest.id, dto.to.versionId);
            setOther(false);
          }}
          aria-label={t("compare.header.otherFile")}
        >
          <option value="">{t("compare.header.chooseFile")}</option>
          {(siblings?.files ?? [])
            .filter((file) => file.id !== dto.to.fileId && docCompareKind(file.extension) === docCompareKind(extension))
            .map((file) => <option key={file.id} value={file.id}>{file.name} (V{file.currentVersion})</option>)}
        </select>
      )}
      <div className="spacer" />
      <ReportShortcut module="doccompare" small />
      {children}
    </div>
  );
}
