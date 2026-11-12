/**
 * Universal "Aç" page (/projects/:pid/open/:versionId): picks the viewer from the shared registry,
 * waits for server previews (sheet JSON, DXF) and shows a clear card when a file cannot be
 * previewed. PDFs open in the PDF viewer (markups work there). Word, OpenDocument text and
 * PowerPoint files are rendered in the browser, no server software needed; a converter's PDF
 * (optional plug-in) is used for legacy formats and offered for the exact page layout.
 */
import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link, Navigate, useParams } from "react-router-dom";
import { officeShow, viewerLabel, type PreviewDto, type PreviewKind, type VersionPreviewDto } from "@sitekeep/shared";
import { api, formatDate, formatSize } from "../shared/api/api";
import { documentsApi } from "../features/documents/api";
import { viewersApi } from "../shared/api/api-viewers";
import { useAuth } from "../app/context/auth";
import { useProject } from "../app/context/project";
import { LoadingIndicator } from "../shared/ui/LoadingIndicator";
import "./viewers.css";

const DocumentViewer = lazy(() => import("./DocumentViewer"));
const SheetViewer = lazy(() => import("./SheetViewer"));
const SlidesViewer = lazy(() => import("./SlidesViewer"));
// Picks the prebuilt 2D scene or the DXF and shows the Civil 3D / size cards (cad/CadGate.tsx).
const CadViewer = lazy(() => import("./cad/CadGate"));
const ImageViewer = lazy(() => import("./SimpleViewers").then((m) => ({ default: m.ImageViewer })));
const TextViewer = lazy(() => import("./SimpleViewers").then((m) => ({ default: m.TextViewer })));
const MediaViewer = lazy(() => import("./SimpleViewers").then((m) => ({ default: m.MediaViewer })));
const EmailViewer = lazy(() => import("./SimpleViewers").then((m) => ({ default: m.EmailViewer })));

/** Preview the viewer needs before it can show anything (office files: see officeShow). */
const NEEDS: Partial<Record<VersionPreviewDto["viewer"], PreviewKind>> = {
  sheet: "sheet",
  cad: "dxf",
};

const busy = (p?: PreviewDto) => p?.status === "pending" || p?.status === "processing";

export default function OpenPage() {
  const { t } = useTranslation("viewers");
  const project = useProject();
  const { versionId } = useParams();
  const vid = versionId!;
  const [info, setInfo] = useState<VersionPreviewDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    viewersApi.preview(project.id, vid).then(
      (d) => alive && setInfo(d),
      (e: Error) => alive && setError(e.message),
    );
    return () => {
      alive = false;
    };
  }, [project.id, vid, tick]);

  // Poll while a preview is being built.
  const waiting = info?.previews.some(busy) ?? false;
  useEffect(() => {
    if (!waiting) return;
    const t = setTimeout(() => setTick((n) => n + 1), 2000);
    return () => clearTimeout(t);
  }, [waiting, info]);

  if (error) return <div className="page error">{error}</div>;
  if (!info) return <LoadingIndicator className="page" />;
  if (info.viewer === "pdf") return <Navigate replace to={`/projects/${project.id}/view/${vid}`} />;
  if (info.viewer === "ifc") return <Navigate replace to={`/projects/${project.id}/viewer?v=${vid}`} />;

  const office = info.viewer === "document" || info.viewer === "slides" ? officeShow(info) : null;
  // Legacy formats (.doc, .rtf) with a converter's PDF: the PDF viewer, as before.
  if (info.viewer === "document" && office?.show === "pdf") return <Navigate replace to={`/projects/${project.id}/view/${vid}`} />;
  const need = NEEDS[info.viewer] ?? (office?.show === "wait" || office?.show === "convert" ? "pdf" : undefined);
  const preview = need ? info.previews.find((p) => p.kind === need) : undefined;

  const request = async (kind: PreviewKind) => {
    try {
      setInfo(await viewersApi.requestPreview(project.id, vid, kind));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  let body: ReactNode;
  if (info.viewer === "none") body = <NoPreview info={info} />;
  else if (office?.show === "convert") body = <ConverterNeeded info={info} preview={preview} onRetry={() => void request("pdf")} />;
  else if (office?.show === "wait") body = <OfficePdfWait info={info} preview={preview} onRequest={() => void request("pdf")} />;
  else if (need && preview?.status !== "ready") body = <PreviewState info={info} preview={preview} onRetry={() => void request(need)} />;
  else {
    const props = { projectId: project.id, info, onRequest: (k: PreviewKind) => void request(k) };
    switch (info.viewer) {
      case "document":
        body = <DocumentViewer {...props} />;
        break;
      case "sheet":
        body = <SheetViewer {...props} />;
        break;
      case "slides":
        body = <SlidesViewer {...props} />;
        break;
      case "cad":
        body = <CadViewer {...props} />;
        break;
      case "image":
        body = <ImageViewer {...props} />;
        break;
      case "video":
      case "audio":
        body = <MediaViewer {...props} />;
        break;
      case "email":
        body = <EmailViewer {...props} />;
        break;
      default:
        body = <TextViewer {...props} />;
    }
  }

  return (
    <div className="vw">
      <ViewerBar info={info} />
      <div className="vw-body">
        <Suspense fallback={<div className="vw-center muted">{t("open.loading")}</div>}>{body}</Suspense>
      </div>
    </div>
  );
}

function ViewerBar({ info }: { info: VersionPreviewDto }) {
  const { t, i18n } = useTranslation(["viewers", "common"]);
  const project = useProject();
  return (
    <div className="vw-bar">
      <Link className="btn small" to={`/projects/${project.id}/files/${info.folderId}?file=${info.fileId}`} title={t("open.bar.backHint")}>
        ← {t("open.bar.actions.folder")}
      </Link>
      <span className="vw-title" title={info.fileName}>
        {info.fileName}
      </span>
      <span className="badge">V{info.version}</span>
      {info.version !== info.currentVersion && <span className="badge warn">{t("open.badges.oldVersion")}</span>}
      <span className="badge info">{viewerLabel(info.viewer, i18n.language)}</span>
      <div className="spacer" />
      {info.canDownload && (
        <a className="btn small" href={documentsApi.downloadUrl(project.id, info.versionId)}>
          ⬇ {t("common:actions.download")}
        </a>
      )}
    </div>
  );
}
function PreviewState({ info, preview, onRetry }: { info: VersionPreviewDto; preview?: PreviewDto; onRetry(): void }) {
  const { t } = useTranslation(["viewers", "common"]);
  const { user } = useAuth();
  const project = useProject();
  const status = preview?.status ?? "pending";
  const canRetry = status === "failed" || status === "unavailable";
  return (
    <div className="vw-center">
      <div className="vw-card">
        <h2>{info.fileName}</h2>
        {status === "pending" || status === "processing" ? (
          <p>
            <span className="vw-spin" />
            {status === "pending" ? t("open.preview.messages.queued") : t("open.preview.messages.processing")}
          </p>
        ) : status === "unavailable" ? (
          <>
            <p className="notice">{t("open.preview.messages.unavailable")}</p>
            {user?.isAdmin && preview?.hint && <p className="small muted">{preview.hint}</p>}
            {!user?.isAdmin && <p className="small muted">{t("open.preview.messages.askAdmin")}</p>}
          </>
        ) : (
          <p className="error">{preview?.error ? t("open.preview.errors.failedWith", { error: preview.error }) : t("open.preview.errors.failed")}</p>
        )}
        <FileFacts info={info} />
        <div className="row wrap">
          {canRetry && <button onClick={onRetry}>{t("common:actions.retry")}</button>}
          {info.canDownload && (
            <a className="btn" href={documentsApi.downloadUrl(project.id, info.versionId)}>
              ⬇ {t("common:actions.download")}
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

/** Only a PDF can show this file and the converter is making it (or will, once asked). */
function OfficePdfWait({ info, preview, onRequest }: { info: VersionPreviewDto; preview?: PreviewDto; onRequest(): void }) {
  const asked = useRef(false);
  const busy = preview?.status === "pending" || preview?.status === "processing";
  // A converter configured after upload: ask for the PDF once.
  useEffect(() => {
    if (!busy && !asked.current && info.canRequest.includes("pdf")) {
      asked.current = true;
      onRequest();
    }
  }, [busy, info.canRequest, onRequest]);
  return <PreviewState info={info} preview={preview ?? { kind: "pdf", status: "pending", error: null, hint: null, meta: {}, updatedAt: "" }} onRetry={onRequest} />;
}

/** Legacy binary formats (.doc, .rtf, .ppt, .odp) without a converter: say so, offer the download. */
function ConverterNeeded({ info, preview, onRetry }: { info: VersionPreviewDto; preview?: PreviewDto; onRetry(): void }) {
  const { t } = useTranslation(["viewers", "common"]);
  const { user } = useAuth();
  const project = useProject();
  const failed = preview?.status === "failed";
  return (
    <div className="vw-center">
      <div className="vw-card">
        <h2>{t("open.converter.title")}</h2>
        <p className="muted small">
          {t("open.converter.description", { extension: info.extension })}
          {info.viewer === "document" ? ` ${t("open.converter.hintDocx")}` : info.extension !== "odp" ? ` ${t("open.converter.hintPptx")}` : ""}
        </p>
        {failed && (
          <p className="error small">{preview?.error ? t("open.converter.errors.failedWith", { error: preview.error }) : t("open.converter.errors.failed")}</p>
        )}
        {!info.pdfConverter &&
          (user?.isAdmin ? (
            <p className="small muted">{t("open.converter.adminHint")}</p>
          ) : (
            <p className="small muted">{t("open.converter.userHint")}</p>
          ))}
        <FileFacts info={info} />
        <div className="row wrap">
          {failed && info.pdfConverter && <button onClick={onRetry}>{t("common:actions.retry")}</button>}
          {info.canDownload ? (
            <a className="btn primary" href={documentsApi.downloadUrl(project.id, info.versionId)}>
              ⬇ {t("common:actions.download")}
            </a>
          ) : (
            <p className="notice small">{t("open.messages.noDownload")}</p>
          )}
        </div>
      </div>
    </div>
  );
}

function NoPreview({ info }: { info: VersionPreviewDto }) {
  const { t } = useTranslation(["viewers", "common"]);
  const project = useProject();
  return (
    <div className="vw-center">
      <div className="vw-card">
        <h2>{t("open.noPreview.title")}</h2>
        <p className="muted small">{t("open.noPreview.description", { extension: info.extension || "?" })}</p>
        <FileFacts info={info} />
        {info.canDownload ? (
          <a className="btn primary" href={documentsApi.downloadUrl(project.id, info.versionId)}>
            ⬇ {t("common:actions.download")}
          </a>
        ) : (
          <p className="notice small">{t("open.messages.noDownload")}</p>
        )}
      </div>
    </div>
  );
}

function FileFacts({ info }: { info: VersionPreviewDto }) {
  const { t } = useTranslation(["viewers", "common"]);
  return (
    <dl className="vw-meta">
      <dt>{t("common:fields.file")}</dt>
      <dd>{info.fileName}</dd>
      <dt>{t("open.fields.version")}</dt>
      <dd>
        V{info.version}
        {info.version !== info.currentVersion && ` ${t("open.currentVersion", { version: info.currentVersion })}`}
      </dd>
      <dt>{t("common:fields.size")}</dt>
      <dd>{formatSize(info.size)}</dd>
      <dt>{t("open.fields.uploaded")}</dt>
      <dd>{formatDate(info.uploadedAt)}</dd>
    </dl>
  );
}

export type { ViewerProps } from "./types";
