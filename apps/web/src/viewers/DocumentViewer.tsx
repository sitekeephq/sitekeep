/**
 * Word and OpenDocument text in the browser, no server software:
 * - .docx/.docm/.dotx: docx-preview (Apache-2.0): pages with their size and margins, headers and
 *   footers, tables, pictures, footnotes, embedded fonts
 * - .odt/.ott: a small ODF reader (office/odf.ts): headings, paragraphs, lists, tables, pictures
 * Zoom, fit width, page count, find, print / save as PDF. The converter's PDF (optional plug-in)
 * is one click away when it exists.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { browserOffice, officePdfAction } from "@sitekeep/shared";
import { i18n } from "../i18n";
import { api } from "../shared/api/api";
import { documentsApi } from "../features/documents/api";
import { viewersApi } from "../shared/api/api-viewers";
import type { ViewerProps } from "./types";
import { DomFinder } from "./office/find";
import { parseOdt, type OdfBlock, type OdfDocument, type OdfInline } from "./office/odf";
import { FindBar, LargeFileCard, PdfLayoutButton, PrintMenu, ZoomControls } from "./office/OfficeTools";
import { printContent } from "./office/print";
import { sanitizeElement } from "./office/sanitize";

/** Above this size the file is opened only on request. */
const LARGE = 60 * 1024 * 1024;

export default function DocumentViewer(props: ViewerProps) {
  const { t } = useTranslation("common");
  const [force, setForce] = useState(false);
  const { info, projectId } = props;
  if (info.size > LARGE && !force)
    return (
      <LargeFileCard
        size={info.size}
        onOpen={() => setForce(true)}
        download={
          info.canDownload && (
            <a className="btn" href={documentsApi.downloadUrl(projectId, info.versionId)}>
              ⬇ {t("actions.download")}
            </a>
          )
        }
      />
    );
  return <DocumentBody {...props} />;
}

type Loaded = { kind: "docx"; pages: number; pageWidth: number } | { kind: "odt"; doc: OdfDocument; urls: Map<string, string> };

function DocumentBody({ projectId, info, onRequest }: ViewerProps) {
  const { t } = useTranslation("viewers");
  const renderer = browserOffice(info.extension);
  const stage = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  /** docx-preview owns this element's children; React never renders into it. */
  const docxHost = useRef<HTMLDivElement>(null);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [finder, setFinder] = useState<DomFinder | null>(null);

  // Load and render once per version.
  useEffect(() => {
    let alive = true;
    let urls: Map<string, string> | null = null;
    setLoaded(null);
    setError(null);
    (async () => {
      const data = await viewersApi.bytes(viewersApi.mediaUrl(projectId, info.versionId));
      if (!alive) return;
      if (renderer === "docx") {
        const { renderAsync } = await import("docx-preview");
        const el = docxHost.current;
        if (!alive || !el) return;
        await renderAsync(data, el, el, {
          className: "docx",
          inWrapper: true,
          breakPages: true,
          // Word's own page ends (saved by Word) give the real page count.
          ignoreLastRenderedPageBreak: false,
          renderHeaders: true,
          renderFooters: true,
          renderFootnotes: true,
          renderEndnotes: true,
          renderComments: false,
          renderChanges: false,
          // Embedded HTML would run in an iframe of this site: never.
          renderAltChunks: false,
          useBase64URL: false,
          experimental: true,
        });
        if (!alive) return;
        sanitizeElement(el);
        const sections = el.querySelectorAll<HTMLElement>(".docx-wrapper > section.docx");
        setLoaded({ kind: "docx", pages: sections.length, pageWidth: sections[0]?.offsetWidth || 794 });
      } else {
        const JSZip = (await import("jszip")).default;
        const zip = await JSZip.loadAsync(data);
        const content = await zip.file("content.xml")?.async("string");
        if (!content) throw new Error(i18n.t("viewers:document.errors.noContent"));
        const styles = await zip.file("styles.xml")?.async("string");
        const doc = parseOdt(content, styles);
        urls = new Map();
        for (const p of doc.images) {
          const f = zip.file(p);
          if (f) urls.set(p, URL.createObjectURL(new Blob([await f.async("arraybuffer")], { type: imageType(p) })));
        }
        if (alive) setLoaded({ kind: "odt", doc, urls });
      }
    })().catch((e: Error) => alive && setError(e.message || i18n.t("viewers:document.errors.openFailed")));
    const docxEl = docxHost.current;
    return () => {
      alive = false;
      if (urls) for (const u of urls.values()) URL.revokeObjectURL(u);
      // docx-preview's pictures and embedded fonts are blob URLs: release them with the view.
      if (docxEl) {
        const blobs = new Set<string>();
        for (const img of docxEl.querySelectorAll<HTMLImageElement>("img[src^='blob:']")) blobs.add(img.src);
        for (const st of docxEl.querySelectorAll("style")) for (const m of st.textContent?.matchAll(/url\((['"]?)(blob:[^'")]+)\1\)/g) ?? []) blobs.add(m[2]!);
        for (const u of blobs) URL.revokeObjectURL(u);
        docxEl.textContent = "";
      }
    };
  }, [projectId, info.versionId, renderer]);

  const page = useCallback((): HTMLElement | null => {
    const el = host.current;
    if (!el) return null;
    return el.querySelector<HTMLElement>(".docx-wrapper") ?? el.querySelector<HTMLElement>(".odf-page");
  }, []);

  const pageWidth = loaded?.kind === "docx" ? loaded.pageWidth : 794;
  const fit = useCallback(() => {
    const w = stage.current?.clientWidth ?? 0;
    if (!w) return;
    setZoom(Math.max(0.25, Math.min(3, Math.floor(((w - 32) / pageWidth) * 100) / 100)));
  }, [pageWidth]);

  // First view: fit the page when it is wider than the window (phones), else 100 %.
  useLayoutEffect(() => {
    if (!loaded) return;
    const w = stage.current?.clientWidth ?? 0;
    if (w && w - 32 < pageWidth) fit();
    else setZoom(1);
    setFinder(host.current ? new DomFinder(host.current) : null);
  }, [loaded]); // eslint-disable-line react-hooks/exhaustive-deps

  useLayoutEffect(() => {
    const p = page();
    if (p) p.style.zoom = String(zoom);
  }, [zoom, loaded, page]);

  // Ctrl+F goes to the find box.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
        const input = stage.current?.parentElement?.querySelector<HTMLInputElement>(".vw-find input");
        if (input) {
          e.preventDefault();
          input.focus();
          input.select();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const print = async () => {
    const el = host.current;
    if (!el || !loaded) return;
    if (loaded.kind === "docx") await printDocx(el);
    else {
      const p = el.querySelector(".odf-page");
      if (p)
        await printContent(
          (root) => {
            const c = p.cloneNode(true) as HTMLElement;
            c.style.zoom = "";
            c.classList.add("vw-doc");
            root.appendChild(c);
          },
          { size: "A4", margin: "20mm" },
        );
    }
  };

  const pdfReady = officePdfAction(info) === "open";
  const pdfLink = `/projects/${projectId}/view/${info.versionId}`;
  return (
    <>
      <div className="vw-tool">
        <ZoomControls zoom={zoom} onZoom={setZoom} onFit={fit} />
        {loaded?.kind === "docx" && (
          <span className="small muted" title={t("document.pagesHint")}>
            {t("document.pages", { count: loaded.pages })}
          </span>
        )}
        {loaded?.kind === "odt" && (
          <span className="badge" title={t("document.simpleViewHint")}>
            {t("document.badges.simpleView")}
          </span>
        )}
        <FindBar finder={finder} version={loaded} />
        <div className="spacer" />
        <PrintMenu
          onPrint={print}
          disabled={!loaded}
          exactPdf={
            pdfReady ? (
              <p className="small">
                <Trans t={t} i18nKey="office.print.exactPdf" components={{ link: <Link to={pdfLink} /> }} />
              </p>
            ) : undefined
          }
        />
        <PdfLayoutButton info={info} onRequest={onRequest} to={pdfLink} />
      </div>
      <div className="vw-stage doc-stage" ref={stage}>
        {error && <DocError message={error} info={info} projectId={projectId} />}
        {!loaded && !error && (
          <div className="vw-center muted">
            <span className="vw-spin" />
            {t("document.messages.preparing")}
          </div>
        )}
        <div ref={host} className="doc-host" hidden={!!error}>
          <div ref={docxHost} />
          {loaded?.kind === "odt" && <OdfView doc={loaded.doc} urls={loaded.urls} />}
        </div>
      </div>
    </>
  );
}

function DocError({ message, info, projectId }: { message: string; info: ViewerProps["info"]; projectId: string }) {
  const { t } = useTranslation(["viewers", "common"]);
  return (
    <div className="vw-center">
      <div className="vw-card">
        <h2>{t("document.failed.title")}</h2>
        <p className="error small">{message}</p>
        <p className="muted small">{t("document.failed.description")}</p>
        {info.canDownload && (
          <a className="btn" href={documentsApi.downloadUrl(projectId, info.versionId)}>
            ⬇ {t("common:actions.download")}
          </a>
        )}
      </div>
    </div>
  );
}

/** Each docx page on its own sheet of paper; mixed page sizes (landscape sections) use named pages. */
async function printDocx(el: HTMLElement) {
  const sections = Array.from(el.querySelectorAll<HTMLElement>(".docx-wrapper > section.docx"));
  const names = new Map<string, string>();
  const css: string[] = [];
  const pageOf = (s: HTMLElement) => {
    const key = `${s.style.width || "210mm"} ${s.style.minHeight || "297mm"}`;
    let name = names.get(key);
    if (!name) {
      name = `vwp${names.size}`;
      names.set(key, name);
      css.push(`@page ${name} { size: ${key}; margin: 0; }`);
    }
    return name;
  };
  const pages = sections.map(pageOf);
  const first = [...names.keys()][0] ?? "A4";
  await printContent(
    (root) => {
      const wrapper = document.createElement("div");
      wrapper.className = "docx-wrapper vw-doc";
      sections.forEach((s, i) => {
        const c = s.cloneNode(true) as HTMLElement;
        c.style.setProperty("page", pages[i]!);
        wrapper.appendChild(c);
      });
      root.appendChild(wrapper);
    },
    { size: first, margin: "0", css: css.join("\n") },
  );
}

function imageType(p: string): string {
  const ext = p.split(".").pop()?.toLowerCase();
  return ext === "jpg" || ext === "jpeg"
    ? "image/jpeg"
    : ext === "gif"
      ? "image/gif"
      : ext === "svg"
        ? "image/svg+xml"
        : ext === "webp"
          ? "image/webp"
          : ext === "bmp"
            ? "image/bmp"
            : "image/png";
}

// ---------------------------------------------------------------------------------------------
// ODF view (React elements only; nothing from the file becomes HTML)
// ---------------------------------------------------------------------------------------------

function OdfView({ doc, urls }: { doc: OdfDocument; urls: Map<string, string> }) {
  const { t } = useTranslation("viewers");
  return (
    <div className="odf-page">
      {doc.blocks.length ? <Blocks blocks={doc.blocks} urls={urls} /> : <p className="muted">{t("document.empty")}</p>}
    </div>
  );
}

function Blocks({ blocks, urls }: { blocks: OdfBlock[]; urls: Map<string, string> }) {
  return (
    <>
      {blocks.map((b, i) => (
        <Block key={i} b={b} urls={urls} />
      ))}
    </>
  );
}

function Block({ b, urls }: { b: OdfBlock; urls: Map<string, string> }): ReactNode {
  switch (b.t) {
    case "h": {
      const H = `h${b.level}` as "h1";
      return (
        <H style={{ textAlign: b.align }}>
          <Runs runs={b.runs} urls={urls} />
        </H>
      );
    }
    case "p":
      return <p style={{ textAlign: b.align }}>{b.runs.length ? <Runs runs={b.runs} urls={urls} /> : <br />}</p>;
    case "list": {
      const L = b.ordered ? "ol" : "ul";
      return (
        <L>
          {b.items.map((it, i) => (
            <li key={i}>
              <Blocks blocks={it} urls={urls} />
            </li>
          ))}
        </L>
      );
    }
    case "table":
      return (
        <table>
          <tbody>
            {b.rows.map((row, r) => (
              <tr key={r}>
                {row.map((c, k) => (
                  <td key={k} colSpan={c.colSpan > 1 ? c.colSpan : undefined} rowSpan={c.rowSpan > 1 ? c.rowSpan : undefined}>
                    <Blocks blocks={c.blocks} urls={urls} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      );
    case "pagebreak":
      return <PageBreak />;
  }
}

function PageBreak() {
  const { t } = useTranslation("viewers");
  return <hr className="odf-break" aria-label={t("document.pageBreak")} />;
}

function Runs({ runs, urls }: { runs: OdfInline[]; urls: Map<string, string> }) {
  return (
    <>
      {runs.map((r, i) => {
        if (r.t === "br") return <br key={i} />;
        if (r.t === "img") {
          const src = urls.get(r.src);
          return src ? <img key={i} src={src} alt="" style={{ width: r.width, height: r.height }} /> : null;
        }
        const style: CSSProperties = {
          fontWeight: r.b ? 700 : undefined,
          fontStyle: r.i ? "italic" : undefined,
          textDecoration: [r.u && "underline", r.s && "line-through"].filter(Boolean).join(" ") || undefined,
          color: r.color,
        };
        return r.href ? (
          <a key={i} href={r.href} target="_blank" rel="noopener noreferrer" style={style}>
            {r.text}
          </a>
        ) : (
          <span key={i} style={style}>
            {r.text}
          </span>
        );
      })}
    </>
  );
}
