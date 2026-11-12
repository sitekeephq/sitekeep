import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import {
  docCompareKind,
  normaliseRegions,
  splitExtension,
  type DiffRegion,
  type DocCompareDto,
  type PageRegions,
} from "@sitekeep/shared";
import { i18n } from "../../../../i18n";
import { api } from "../../../../shared/api/api";
import { documentsApi } from "../../api";
import { PageDiffer, diffPair, renderPair, toCanvas, type Offset } from "../../../../pdf/compare-engine";
import { openPdf } from "../../../../pdf/pdfjs";

export const MAX_ANALYZE = 60;
export const ANALYZE_PX = 2000;
export type CompareDocs = { a: PDFDocumentProxy; b: PDFDocumentProxy };

type Params = {
  projectId: string;
  from: string | null;
  to: string | null;
  page: number;
  setFrom(from: string): void;
  onMessage(message: string): void;
};

export function useDocCompareData({ projectId, from, to, page, setFrom, onMessage }: Params) {
  const [dto, setDto] = useState<DocCompareDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [docs, setDocs] = useState<CompareDocs | null>(null);
  const [pdfError, setPdfError] = useState<string | null>(null);
  const [regions, setRegions] = useState<PageRegions[] | null>(null);
  const [analysis, setAnalysis] = useState<{ done: number; total: number } | null>(null);
  const [offsets, setOffsets] = useState<Record<number, Offset>>({});
  const [rev, setRev] = useState(0);
  const differ = useRef<PageDiffer | null>(null);
  const analysedFor = useRef<string | null>(null);
  const aiStarted = useRef<string | null>(null);
  const getDiffer = useCallback(() => (differ.current ??= new PageDiffer()), []);

  useEffect(() => () => differ.current?.terminate(), []);

  useEffect(() => {
    if (!to || from) return;
    let alive = true;
    void (async () => {
      try {
        const info = await api.versionInfo(projectId, to);
        const file = await documentsApi.file(projectId, info.fileId);
        const prev = file.versions.filter((v) => v.version < info.version).sort((a, b) => b.version - a.version)[0];
        if (!alive) return;
        if (!prev) setError(i18n.t("documents:compare.errors.noPrevious"));
        else setFrom(prev.id);
      } catch (e) {
        if (alive) setError((e as Error).message);
      }
    })();
    return () => {
      alive = false;
    };
  }, [projectId, from, to, setFrom]);

  useEffect(() => {
    if (!from || !to) return;
    let alive = true;
    setDto(null);
    setError(null);
    api.docCompare(projectId, from, to).then(
      (value) => alive && setDto(value),
      (e: Error) => alive && setError(e.message),
    );
    return () => {
      alive = false;
    };
  }, [projectId, from, to]);

  const busy = !!dto && (dto.status === "running" || dto.ai.status === "running");
  useEffect(() => {
    if (!dto || !busy) return;
    const timer = setTimeout(() => {
      api.docComparison(projectId, dto.id).then(setDto, () => {});
    }, 1500);
    return () => clearTimeout(timer);
  }, [dto, busy, projectId]);

  const extension = dto ? splitExtension(dto.to.fileName).extension.toLowerCase() : "";
  const isPdf = docCompareKind(extension) === "pdf";

  useEffect(() => {
    if (!dto || !isPdf) return;
    let alive = true;
    const opened: { destroy(): Promise<void> }[] = [];
    setDocs(null);
    setPdfError(null);
    void Promise.all([openPdf(api.contentUrl(projectId, dto.from.versionId)), openPdf(api.contentUrl(projectId, dto.to.versionId))])
      .then(([a, b]) => {
        opened.push(a, b);
        if (alive) setDocs({ a: a.doc, b: b.doc });
      })
      .catch((e: Error) => alive && setPdfError(i18n.t("documents:compare.errors.pdf", { error: e.message })));
    return () => {
      alive = false;
      for (const openedPdf of opened) void openedPdf.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, dto?.id, isPdf]);

  useEffect(() => {
    if (!dto || !docs || analysedFor.current === dto.id) return;
    analysedFor.current = dto.id;
    if (dto.regions) {
      setRegions(dto.regions);
      return;
    }
    let alive = true;
    void (async () => {
      const total = Math.min(Math.max(docs.a.numPages, docs.b.numPages), MAX_ANALYZE);
      const output: PageRegions[] = [];
      setAnalysis({ done: 0, total });
      for (let current = 1; current <= total && alive; current++) {
        output.push(await analysePage(getDiffer(), docs, current, { dx: 0, dy: 0 }));
        setAnalysis({ done: current, total });
        setRegions([...output]);
      }
      if (!alive) return;
      setAnalysis(null);
      try {
        setDto(await api.saveCompareRegions(projectId, dto.id, output));
      } catch {
        // Regions remain available locally.
      }
    })();
    return () => {
      alive = false;
      analysedFor.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dto?.id, docs, rev]);

  useEffect(() => {
    if (!dto || dto.status !== "done" || !dto.ai.available || dto.ai.status !== "none") return;
    if (isPdf && !dto.regions && !pdfError && (analysis || !regions)) return;
    if (aiStarted.current === dto.id) return;
    aiStarted.current = dto.id;
    api.startCompareSummary(projectId, dto.id).then(setDto, (e: Error) => onMessage(e.message));
  }, [dto, isPdf, analysis, regions, pdfError, projectId, onMessage]);

  const nudge = useCallback(
    async (dx: number, dy: number) => {
      if (!docs || !dto) return;
      const current = offsets[page] ?? { dx: 0, dy: 0 };
      const next = dx === 0 && dy === 0 ? { dx: 0, dy: 0 } : { dx: current.dx + dx, dy: current.dy + dy };
      setOffsets((values) => ({ ...values, [page]: next }));
      const pageRegions = await analysePage(getDiffer(), docs, page, next);
      const list = [...(regions ?? []).filter((item) => item.page !== page), pageRegions].sort((a, b) => a.page - b.page);
      setRegions(list);
      try {
        setDto(await api.saveCompareRegions(projectId, dto.id, list));
      } catch {
        // Regions remain available locally.
      }
    },
    [docs, dto, getDiffer, offsets, page, projectId, regions],
  );

  const rebuild = useCallback(async () => {
    if (!dto) return;
    analysedFor.current = null;
    aiStarted.current = null;
    setRegions(null);
    setOffsets({});
    setDto(await api.docCompare(projectId, dto.from.versionId, dto.to.versionId, true));
    setRev((value) => value + 1);
  }, [dto, projectId]);

  return {
    dto,
    setDto: setDto as Dispatch<SetStateAction<DocCompareDto | null>>,
    error,
    docs,
    pdfError,
    regions,
    setRegions,
    analysis,
    offsets,
    isPdf,
    getDiffer,
    nudge,
    rebuild,
  };
}

export function tokenHex(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
}

export async function analysePage(differ: PageDiffer, docs: CompareDocs, page: number, offset: Offset): Promise<PageRegions> {
  const a = page <= docs.a.numPages ? await docs.a.getPage(page) : null;
  const b = page <= docs.b.numPages ? await docs.b.getPage(page) : null;
  if (!a || !b) return { page, only: a ? "A" : "B", regions: [] };
  const viewport = b.getViewport({ scale: 1 });
  const scale = ANALYZE_PX / Math.max(viewport.width, viewport.height);
  const pair = await renderPair(a, b, scale, offset);
  const result = await diffPair(differ, pair, false);
  return { page, regions: normaliseRegions(result.regions, pair.w, pair.h) };
}

export async function comparisonThumbnail(
  differ: PageDiffer,
  docs: CompareDocs,
  page: number,
  offset: Offset,
  regions: DiffRegion[],
): Promise<string> {
  const a = page <= docs.a.numPages ? await docs.a.getPage(page) : null;
  const b = page <= docs.b.numPages ? await docs.b.getPage(page) : null;
  const viewport = (b ?? a)!.getViewport({ scale: 1 });
  const pair = await renderPair(a, b, 1100 / Math.max(viewport.width, viewport.height), offset);
  const result = await diffPair(differ, pair, true);
  const canvas = toCanvas(result.composite!, result.w, result.h);
  const context = canvas.getContext("2d")!;
  context.strokeStyle = tokenHex("--diff-region", "#f79009");
  context.lineWidth = 2;
  for (const region of regions) {
    context.strokeRect(
      region.box.x0 * canvas.width - 3,
      region.box.y0 * canvas.height - 3,
      (region.box.x1 - region.box.x0) * canvas.width + 6,
      (region.box.y1 - region.box.y0) * canvas.height + 6,
    );
  }
  return canvas.toDataURL("image/jpeg", 0.82);
}
