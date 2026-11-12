/** Built-in previews: image (zoom/pan), text with line numbers, Markdown, video/audio, e-mail (.eml). */
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useTranslation } from "react-i18next";
import { i18n } from "../i18n";
import { decodeText, viewersApi } from "../shared/api/api-viewers";
import { formatSize } from "../shared/api/api";
import { formatNumber, formatPercent, intlLocale } from "../shared/lib/format";
import { Markdown } from "../shared/ui/Markdown";
import { LoadingIndicator } from "../shared/ui/LoadingIndicator";
import type { ViewerProps } from "./types";

/** Text shown at most (larger files: download for the rest). */
const TEXT_LIMIT = 2 * 1024 * 1024;
const LINE_LIMIT = 50_000;

function useBytes(url: string) {
  const [data, setData] = useState<ArrayBuffer | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setData(null);
    viewersApi.bytes(url).then(
      (d) => alive && setData(d),
      (e: Error) => alive && setError(e.message),
    );
    return () => {
      alive = false;
    };
  }, [url]);
  return { data, error };
}

// ---------------------------------------------------------------------------------------------

export function ImageViewer({ projectId, info }: ViewerProps) {
  const { t } = useTranslation("viewers");
  const stage = useRef<HTMLDivElement>(null);
  const img = useRef<HTMLImageElement>(null);
  const [view, setView] = useState({ x: 0, y: 0, s: 1 });
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [error, setError] = useState(false);
  const drag = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ d: number; s: number } | null>(null);

  const fit = () => {
    const el = stage.current;
    if (!el || !natural) return;
    const s = Math.min(1, (el.clientWidth - 16) / natural.w, (el.clientHeight - 16) / natural.h);
    setView({ s, x: (el.clientWidth - natural.w * s) / 2, y: (el.clientHeight - natural.h * s) / 2 });
  };
  useEffect(fit, [natural]); // eslint-disable-line react-hooks/exhaustive-deps

  const zoomAt = (factor: number, cx: number, cy: number) =>
    setView((p) => {
      const s = Math.min(20, Math.max(0.02, p.s * factor));
      const k = s / p.s;
      return { s, x: cx - (cx - p.x) * k, y: cy - (cy - p.y) * k };
    });
  const zoomCenter = (factor: number) => {
    const el = stage.current!;
    zoomAt(factor, el.clientWidth / 2, el.clientHeight / 2);
  };

  useEffect(() => {
    const el = stage.current!;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      zoomAt(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX - r.left, e.clientY - r.top);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const onDown = (e: ReactPointerEvent) => {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinch.current = { d: Math.hypot(a!.x - b!.x, a!.y - b!.y), s: view.s };
      drag.current = null;
    } else drag.current = { x: e.clientX, y: e.clientY, tx: view.x, ty: view.y };
  };
  const onMove = (e: ReactPointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch.current && pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      const r = stage.current!.getBoundingClientRect();
      const factor = (pinch.current.s * (Math.hypot(a!.x - b!.x, a!.y - b!.y) / pinch.current.d)) / view.s;
      zoomAt(factor, (a!.x + b!.x) / 2 - r.left, (a!.y + b!.y) / 2 - r.top);
    } else if (drag.current) {
      const d = drag.current;
      setView((p) => ({ ...p, x: d.tx + e.clientX - d.x, y: d.ty + e.clientY - d.y }));
    }
  };
  const onUp = (e: ReactPointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    if (!pointers.current.size) drag.current = null;
  };

  return (
    <>
      <div className="vw-tool">
        <button className="small" onClick={() => zoomCenter(1 / 1.25)} aria-label={t("actions.zoomOut")}>
          −
        </button>
        <span className="small" style={{ minWidth: 44, textAlign: "center" }}>
          {formatPercent(view.s)}
        </span>
        <button className="small" onClick={() => zoomCenter(1.25)} aria-label={t("actions.zoomIn")}>
          +
        </button>
        <button className="small" onClick={fit}>
          {t("actions.fit")}
        </button>
        <button
          className="small"
          onClick={() => {
            const el = stage.current!;
            if (natural) setView({ s: 1, x: (el.clientWidth - natural.w) / 2, y: (el.clientHeight - natural.h) / 2 });
          }}
        >
          1:1
        </button>
        {natural && (
          <span className="small muted">
            {`${natural.w} × ${natural.h} px`}
          </span>
        )}
      </div>
      <div
        ref={stage}
        className={`img-stage${drag.current ? " dragging" : ""}`}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onDoubleClick={fit}
      >
        {error ? (
          <p className="error" style={{ margin: 16 }}>
            {t("simple.image.error")}
          </p>
        ) : (
          <img
            ref={img}
            src={viewersApi.mediaUrl(projectId, info.versionId)}
            alt={info.fileName}
            draggable={false}
            onLoad={(e) => setNatural({ w: e.currentTarget.naturalWidth || 800, h: e.currentTarget.naturalHeight || 600 })}
            onError={() => setError(true)}
            style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.s})`, visibility: natural ? "visible" : "hidden" }}
          />
        )}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------------------------

export function TextViewer({ projectId, info }: ViewerProps) {
  const { t } = useTranslation("viewers");
  const { data, error } = useBytes(viewersApi.mediaUrl(projectId, info.versionId));
  const [wrap, setWrap] = useState(true);
  const [raw, setRaw] = useState(false);
  if (error) return <p className="error" style={{ margin: 16 }}>{error}</p>;
  if (!data) return <LoadingIndicator className="vw-center" />;
  const cut = data.byteLength > TEXT_LIMIT;
  const text = decodeText(cut ? data.slice(0, TEXT_LIMIT) : data);
  const markdown = info.viewer === "markdown" && !raw;
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const shown = lines.length > LINE_LIMIT ? lines.slice(0, LINE_LIMIT) : lines;
  return (
    <>
      <div className="vw-tool">
        {info.viewer === "markdown" && (
          <button className={`small${raw ? " on" : ""}`} onClick={() => setRaw((r) => !r)}>
            {t("simple.text.actions.source")}
          </button>
        )}
        {!markdown && (
          <button className={`small${wrap ? " on" : ""}`} onClick={() => setWrap((w) => !w)}>
            {t("simple.text.actions.wrap")}
          </button>
        )}
        <span className="small muted">
          {t("simple.text.summary", { lines: formatNumber(lines.length), size: formatSize(info.size) })}
        </span>
        {(cut || shown.length < lines.length) && <span className="small notice">{t("simple.text.truncated")}</span>}
      </div>
      <div className="txt">
        {markdown ? (
          <div className="md-page">
            <Markdown text={text} />
          </div>
        ) : (
          <div className="txt-lines">
            {shown.map((l, i) => (
              <Line key={i} n={i + 1} text={l} wrap={wrap} />
            ))}
          </div>
        )}
      </div>
    </>
  );
}

function Line({ n, text, wrap }: { n: number; text: string; wrap: boolean }) {
  return (
    <>
      <span className="txt-no">{n}</span>
      <span className="txt-line" style={wrap ? undefined : { whiteSpace: "pre" }}>
        {text || " "}
      </span>
    </>
  );
}

// ---------------------------------------------------------------------------------------------

export function MediaViewer({ projectId, info }: ViewerProps) {
  const { t } = useTranslation("viewers");
  const src = viewersApi.mediaUrl(projectId, info.versionId);
  const [error, setError] = useState(false);
  return (
    <div className="media">
      {error ? (
        <p className="error">{info.viewer === "video" ? t("simple.media.videoError") : t("simple.media.audioError")}</p>
      ) : info.viewer === "video" ? (
        <video src={src} controls preload="metadata" playsInline onError={() => setError(true)} />
      ) : (
        <audio src={src} controls preload="metadata" onError={() => setError(true)} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// E-mail (.eml): headers, the plain-text body (HTML is shown as text, never rendered) and attachment names.

interface Part {
  headers: Map<string, string>;
  body: string;
}

function splitPart(raw: string): Part {
  const idx = raw.search(/\r?\n\r?\n/);
  const head = idx < 0 ? raw : raw.slice(0, idx);
  const body = idx < 0 ? "" : raw.slice(idx).replace(/^\r?\n\r?\n/, "");
  const headers = new Map<string, string>();
  for (const line of head.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    const m = /^([^:]+):\s*(.*)$/.exec(line);
    if (m) headers.set(m[1]!.toLowerCase(), m[2]!);
  }
  return { headers, body };
}

function bytesOf(s: string): Uint8Array {
  return Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);
}

function charsetDecode(bytes: Uint8Array, charset: string | undefined): string {
  try {
    return new TextDecoder(charset || "utf-8").decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

function decodeQp(s: string): Uint8Array {
  const clean = s.replace(/=\r?\n/g, "");
  const out: number[] = [];
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i]!;
    if (c === "=" && /^[0-9A-Fa-f]{2}$/.test(clean.slice(i + 1, i + 3))) {
      out.push(parseInt(clean.slice(i + 1, i + 3), 16));
      i += 2;
    } else out.push(c.charCodeAt(0) & 0xff);
  }
  return Uint8Array.from(out);
}

/** RFC 2047 encoded words: =?UTF-8?B?...?= and =?ISO-8859-9?Q?...?=. */
export function decodeWords(s: string): string {
  return s.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=(\s+(?==\?))?/g, (_, cs: string, enc: string, data: string) => {
    try {
      const bytes = enc.toUpperCase() === "B" ? bytesOf(atob(data)) : decodeQp(data.replace(/_/g, " "));
      return charsetDecode(bytes, cs);
    } catch {
      return data;
    }
  });
}

function param(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  const m = new RegExp(`${name}\\*?=(?:"([^"]*)"|([^;\\s]*))`, "i").exec(header);
  const v = m?.[1] ?? m?.[2];
  if (!v) return undefined;
  const ext = /^([^']*)'[^']*'(.*)$/.exec(v); // RFC 2231: utf-8''name
  return ext ? charsetDecode(decodeQp(ext[2]!.replace(/%/g, "=")), ext[1]) : decodeWords(v);
}

function partText(p: Part): string {
  const enc = (p.headers.get("content-transfer-encoding") ?? "").toLowerCase();
  const charset = param(p.headers.get("content-type"), "charset");
  let bytes: Uint8Array;
  if (enc === "base64") {
    try {
      bytes = bytesOf(atob(p.body.replace(/\s+/g, "")));
    } catch {
      bytes = bytesOf(p.body);
    }
  } else if (enc === "quoted-printable") bytes = decodeQp(p.body);
  else bytes = bytesOf(p.body);
  return charsetDecode(bytes, charset);
}

function htmlToText(html: string): string {
  const doc = new DOMParser().parseFromString(html.replace(/<(br|\/p|\/div|\/tr|\/li|\/h\d)[^>]*>/gi, "$&\n"), "text/html");
  return (doc.body.textContent ?? "").replace(/\n{3,}/g, "\n\n").trim();
}

export function parseEml(raw: string) {
  const top = splitPart(raw);
  let plain: string | null = null;
  let html: string | null = null;
  const attachments: { name: string; size: number }[] = [];
  const walk = (p: Part, depth: number) => {
    const type = (p.headers.get("content-type") ?? "text/plain").toLowerCase();
    const disp = p.headers.get("content-disposition") ?? "";
    const name = param(disp, "filename") ?? param(p.headers.get("content-type"), "name");
    if (type.startsWith("multipart/") && depth < 8) {
      const boundary = param(p.headers.get("content-type"), "boundary");
      if (!boundary) return;
      const chunks = p.body.split(new RegExp(`\\r?\\n?--${boundary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:--)?[ \\t]*\\r?\\n?`));
      for (const c of chunks.slice(1)) if (c.trim()) walk(splitPart(c), depth + 1);
    } else if (name || /^attachment/i.test(disp)) {
      const b64 = (p.headers.get("content-transfer-encoding") ?? "").toLowerCase() === "base64";
      attachments.push({ name: name ?? i18n.t("viewers:simple.email.attachmentName"), size: b64 ? Math.floor((p.body.replace(/\s+/g, "").length * 3) / 4) : p.body.length });
    } else if (type.startsWith("text/plain") && plain === null) plain = partText(p);
    else if (type.startsWith("text/html") && html === null) html = partText(p);
  };
  walk(top, 0);
  const h = (k: string) => decodeWords(top.headers.get(k) ?? "");
  return {
    from: h("from"),
    to: h("to"),
    cc: h("cc"),
    subject: h("subject"),
    date: h("date"),
    body: plain ?? (html !== null ? htmlToText(html) : ""),
    attachments,
  };
}

export function EmailViewer({ projectId, info }: ViewerProps) {
  const { t } = useTranslation(["viewers", "common"]);
  const { data, error } = useBytes(viewersApi.mediaUrl(projectId, info.versionId));
  if (error) return <p className="error" style={{ margin: 16 }}>{error}</p>;
  if (!data) return <LoadingIndicator className="vw-center" />;
  // Header bytes are kept 1:1 (latin1) so each part can be decoded with its own charset.
  const mail = parseEml(new TextDecoder("latin1").decode(data));
  const date = mail.date ? new Date(mail.date) : null;
  return (
    <div className="txt">
      <div className="eml">
        <h2 style={{ marginTop: 0 }}>{mail.subject || t("simple.email.noSubject")}</h2>
        <dl className="vw-meta">
          <dt>{t("simple.email.fields.from")}</dt>
          <dd>{mail.from}</dd>
          <dt>{t("simple.email.fields.to")}</dt>
          <dd>{mail.to}</dd>
          {mail.cc && (
            <>
              <dt>{t("simple.email.fields.cc")}</dt>
              <dd>{mail.cc}</dd>
            </>
          )}
          <dt>{t("common:fields.date")}</dt>
          <dd>{date && !Number.isNaN(date.getTime()) ? date.toLocaleString(intlLocale()) : mail.date}</dd>
          {mail.attachments.length > 0 && (
            <>
              <dt>{t("common:fields.attachments")}</dt>
              <dd>{mail.attachments.map((a) => `${a.name} (${formatSize(a.size)})`).join(", ")}</dd>
            </>
          )}
        </dl>
        <div className="eml-body">{mail.body || t("simple.email.noBody")}</div>
        {mail.attachments.length > 0 && <p className="muted small">{t("simple.email.attachmentsHint")}</p>}
      </div>
    </div>
  );
}
