/**
 * PowerPoint (.pptx) slides rendered in the browser with @aiden0z/pptx-renderer (Apache-2.0):
 * text with per-run formatting, bullets, pictures, shapes, groups, tables, charts, SmartArt
 * fallbacks, backgrounds and theme colours, laid out at slide size and scaled with CSS.
 * The renderer builds DOM nodes (text via textContent), keeps only http(s) links and limits ZIP
 * sizes. Loaded on demand; a converter's PDF is used instead when it exists.
 */
import { sanitizeElement } from "./sanitize";

export interface SlideMount {
  /** Clipped wrapper of the slide (width × scale by height × scale). */
  element: HTMLElement;
  ready: Promise<void>;
  dispose(): void;
}

export interface HtmlDeck {
  kind: "html";
  count: number;
  /** Slide size in CSS px. */
  width: number;
  height: number;
  /** Charts are drawn with an entry animation (about a second): printing waits for it. */
  hasCharts: boolean;
  /** Renders slide `index` (0-based) into `el`, scaled. */
  mount(index: number, el: HTMLElement, scale: number): SlideMount | null;
  destroy(): void;
}

export async function renderPptx(data: ArrayBuffer): Promise<HtmlDeck> {
  const { PptxViewer, parseZipLazyMedia, buildPresentation, RECOMMENDED_ZIP_LIMITS } = await import("@aiden0z/pptx-renderer");
  const files = await parseZipLazyMedia(data, RECOMMENDED_ZIP_LIMITS);
  const presentation = buildPresentation(files, { lazySlides: true });
  // The viewer only renders into the containers given below; its own container stays detached.
  const viewer = new PptxViewer(document.createElement("div"), { fitMode: "none", pdfjs: false });
  viewer.load(presentation);
  return {
    kind: "html",
    count: presentation.slides.length,
    width: presentation.width,
    height: presentation.height,
    hasCharts: presentation.charts.size > 0,
    mount(index, el, scale) {
      const h = viewer.renderThumbnailToContainer(index, el, { scale });
      if (!h) return null;
      // Defence in depth: the renderer already drops unsafe links and media.
      sanitizeElement(h.element);
      return h;
    },
    destroy() {
      viewer.destroy();
    },
  };
}
