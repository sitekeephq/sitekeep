import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { REPORT_IFRAME_SANDBOX, buildReportSrcdoc, type ProjectDto, type ReportData } from "@sitekeep/shared";

/**
 * CSP nonce of this page: the server puts it on index.html's script tags (privacy/headers.ts).
 * Undefined in development (Vite serves the page without a policy).
 */
export function pageCspNonce(): string | undefined {
  const el = document.querySelector<HTMLScriptElement>("script[nonce]");
  return el?.nonce || el?.getAttribute("nonce") || undefined;
}

export interface ReportFrameHandle {
  print(): void;
}

interface Props {
  html: string;
  data: ReportData;
  errors?: Record<string, string>;
  generatedAt: string;
  project: ProjectDto;
  /** Code → label maps of the dashboard's datasets (field name → code → label). */
  labels?: Record<string, Record<string, string>>;
  onError?(message: string): void;
}

/**
 * Renders dashboard HTML in a sandboxed iframe (scripts only, opaque origin). The frame
 * gets data, never the session or API addresses; later data arrives via postMessage.
 */
export const ReportFrame = forwardRef<ReportFrameHandle, Props>(function ReportFrame(
  { html, data, errors, generatedAt, project, labels, onError },
  ref,
) {
  const { t, i18n } = useTranslation("reports");
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(480);
  const [rebuild, setRebuild] = useState(0);
  const [escaped, setEscaped] = useState(false);
  const embedded = useRef<ReportData | null>(null);
  const loads = useRef(0);
  const latest = useRef({ data, errors, generatedAt, labels, onError });
  latest.current = { data, errors, generatedAt, labels, onError };

  // Rebuilt only when the HTML changes (or the frame asks for a reload); data is posted, so a
  // live refresh redraws the charts in place: no reload, no flicker, scroll position kept.
  const srcdoc = useMemo(() => {
    const cur = latest.current;
    embedded.current = cur.data;
    return buildReportSrcdoc({
      html,
      data: cur.data,
      errors: cur.errors,
      generatedAt: cur.generatedAt,
      project: { id: project.id, code: project.code, name: project.name },
      labels: cur.labels,
      lang: i18n.language,
      // The srcdoc frame inherits the page CSP: its inline scripts need the page's nonce.
      nonce: pageCspNonce(),
    });
  }, [html, rebuild, project.id, project.code, project.name, i18n.language]);

  useEffect(() => {
    loads.current = 0;
    setEscaped(false);
  }, [srcdoc]);

  useEffect(() => {
    if (embedded.current === data) return;
    embedded.current = data;
    frame.current?.contentWindow?.postMessage({ type: "cde:data", data, errors: errors ?? {}, generatedAt, labels: labels ?? {} }, "*");
  }, [data, errors, generatedAt, labels]);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (!frame.current || e.source !== frame.current.contentWindow) return;
      const m = e.data as { type?: string; height?: unknown; message?: unknown } | null;
      if (!m || typeof m !== "object") return;
      if (m.type === "cde:height" && typeof m.height === "number" && Number.isFinite(m.height))
        setHeight(Math.min(Math.max(Math.ceil(m.height), 120), 20000));
      else if (m.type === "cde:reload") setRebuild((n) => n + 1);
      else if (m.type === "cde:error") latest.current.onError?.(String(m.message).slice(0, 500));
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  useImperativeHandle(ref, () => ({
    print: () => frame.current?.contentWindow?.postMessage({ type: "cde:print" }, "*"),
  }));

  if (escaped)
    return (
      <div className="error">
        {t("frame.errors.escaped")}{" "}
        <button className="small" onClick={() => setRebuild((n) => n + 1)}>
          {t("frame.actions.reload")}
        </button>
      </div>
    );

  return (
    <iframe
      ref={frame}
      title={t("frame.frameName")}
      className="report-frame"
      sandbox={REPORT_IFRAME_SANDBOX}
      referrerPolicy="no-referrer"
      srcDoc={srcdoc}
      style={{ height }}
      onLoad={() => {
        // A second load of the same srcdoc means the dashboard navigated itself away.
        loads.current += 1;
        if (loads.current > 1) setEscaped(true);
      }}
    />
  );
});
