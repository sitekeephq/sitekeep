/**
 * "Revizyon karşılaştır": two versions of a document side by side.
 * Visual rendering and diff panels live in document components; this page coordinates actions.
 */
import { useCallback, useState, type ReactNode } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Link, useSearchParams } from "react-router-dom";
import {
  type DiffRegion,
  type MarkupDto,
  type MarkupShape,
  type NBox,
  type PageRegions,
  type SummaryBullet,
} from "@sitekeep/shared";
import { useLabel } from "../../../i18n";
import { intlLocale } from "../../../shared/lib/format";
import { api } from "../../../shared/api/api";
import { useProject } from "../../../app/context/project";
import { MarkupIssueDialog } from "../components/MarkupIssueDialog";
import { DocCompareHeader } from "../components/DocCompareHeader";
import { AiComparePanel, AntetTable, RegionList, TextDiffList } from "../components/DocComparePanels";
import { DocCompareVisualStage } from "../components/DocCompareVisualStage";
import {
  comparisonThumbnail,
  MAX_ANALYZE,
  tokenHex,
  useDocCompareData,
} from "../components/hooks/useDocCompareData";

export function DocComparePage() {
  const { t } = useTranslation(["documents", "common"]);
  const label = useLabel();
  const project = useProject();
  const [params, setParams] = useSearchParams();
  const from = params.get("from");
  const to = params.get("to");
  const pageNum = Math.max(1, Number(params.get("page")) || 1);
  const [message, setMessage] = useState<ReactNode>(null);
  const setFrom = useCallback(
    (versionId: string) => setParams((current) => (current.set("from", versionId), current), { replace: true }),
    [setParams],
  );
  const onDataMessage = useCallback((value: string) => setMessage(value), []);
  const {
    dto,
    setDto,
    error,
    docs,
    pdfError,
    regions,
    analysis,
    offsets,
    isPdf,
    getDiffer,
    nudge,
    rebuild,
  } = useDocCompareData({
    projectId: project.id,
    from,
    to,
    page: pageNum,
    setFrom,
    onMessage: onDataMessage,
  });

  const [selected, setSelected] = useState<{ page: number; index: number } | null>(null);
  const [focus, setFocus] = useState<{ page: number; box: NBox; seq: number } | null>(null);
  const [issueFor, setIssueFor] = useState<{
    markup: MarkupDto | null;
    page: number;
    title: string;
    description: string;
    created?: boolean;
  } | null>(null);
  const [working, setWorking] = useState<string | null>(null);

  const goTo = useCallback(
    (page: number) => setParams((current) => (current.set("page", String(page)), current), { replace: true }),
    [setParams],
  );
  const setPair = (oldVersion: string, newVersion: string) => setParams({ from: oldVersion, to: newVersion }, { replace: false });
  const pageCount = docs
    ? Math.max(docs.a.numPages, docs.b.numPages)
    : Math.max(dto?.result?.pageCountA ?? 1, dto?.result?.pageCountB ?? 1);
  const pageRegions = regions?.find((item) => item.page === pageNum) ?? null;
  const regionTotal = (regions ?? []).reduce((sum, item) => sum + item.regions.length, 0);

  function focusOn(page: number, box: NBox | undefined, index?: number) {
    if (page !== pageNum) goTo(page);
    setSelected(index !== undefined ? { page, index } : null);
    if (box) setFocus({ page, box, seq: Date.now() });
  }

  async function act(key: string, action: () => Promise<void>) {
    setMessage(null);
    setWorking(key);
    try {
      await action();
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setWorking(null);
    }
  }

  async function cloudShapes(page: number, list: DiffRegion[]): Promise<MarkupShape[]> {
    const pdfPage = await docs!.b.getPage(page);
    const viewport = pdfPage.getViewport({ scale: 1 });
    const point = (normalX: number, normalY: number): [number, number] => {
      const [x, y] = viewport.convertToPdfPoint(normalX * viewport.width, normalY * viewport.height) as [number, number];
      return [Math.round(x * 100) / 100, Math.round(y * 100) / 100];
    };
    const color = tokenHex("--diff-region", "#f79009");
    const padding = 0.006;
    return list.slice(0, 200).map((region) => ({
      type: "cloud" as const,
      color,
      width: 2,
      from: point(Math.max(0, region.box.x0 - padding), Math.max(0, region.box.y0 - padding)),
      to: point(Math.min(1, region.box.x1 + padding), Math.min(1, region.box.y1 + padding)),
    }));
  }

  async function saveMarkups() {
    if (!dto || !docs || !regions) return;
    await act("markup", async () => {
      let pages = 0;
      let count = 0;
      for (const page of regions) {
        if (page.only || !page.regions.length || page.page > docs.b.numPages) continue;
        await api.createMarkup(project.id, dto.to.versionId, { page: page.page, shapes: await cloudShapes(page.page, page.regions) });
        pages++;
        count += Math.min(page.regions.length, 200);
      }
      setMessage(
        count ? (
          <span className="success">
            {t("docCompare.messages.markupsSaved", { count, pages })}{" "}
            <Link to={`/projects/${project.id}/view/${dto.to.versionId}?page=${regions.find((page) => page.regions.length && !page.only)?.page ?? 1}`}>{t("docCompare.actions.openInViewer")}</Link>
          </span>
        ) : t("docCompare.messages.nothingToSave"),
      );
    });
  }

  async function issueFromRegion(page: number, index: number, title?: string) {
    if (!dto || !docs) return;
    const region = regions?.find((item) => item.page === page)?.regions[index];
    if (!region || page > docs.b.numPages) return;
    await act("issue", async () => {
      const markup = await api.createMarkup(project.id, dto.to.versionId, { page, shapes: await cloudShapes(page, [region]) });
      setIssueFor({
        markup,
        page,
        title: title ?? t("docCompare.issueTitle", { page, kind: label("diffRegion", region.kind).toLocaleLowerCase(intlLocale()) }),
        description: t("docCompare.issueDescriptionPage", { file: dto.to.fileName, from: dto.from.version, to: dto.to.version, page }),
      });
    });
  }

  function issueFromBullet(bullet: SummaryBullet) {
    if (!dto) return;
    if (isPdf && bullet.page && bullet.region !== undefined) {
      void issueFromRegion(bullet.page, bullet.region, bullet.text);
      return;
    }
    setIssueFor({
      markup: null,
      page: bullet.page ?? 1,
      title: bullet.text,
      description: bullet.page
        ? t("docCompare.issueDescriptionPage", { file: dto.to.fileName, from: dto.from.version, to: dto.to.version, page: bullet.page })
        : t("docCompare.issueDescription", { file: dto.to.fileName, from: dto.from.version, to: dto.to.version }),
    });
  }

  async function report() {
    if (!dto) return;
    await act("report", async () => {
      const thumbnails: { page: number; image: string }[] = [];
      if (docs && regions) {
        const textPages = new Set((dto.result?.pages ?? []).map((page) => page.page));
        const pages = [...new Set([...regions.filter((page) => page.regions.length || page.only).map((page) => page.page), ...textPages])]
          .sort((a, b) => a - b)
          .slice(0, 8);
        for (const page of pages) {
          thumbnails.push({
            page,
            image: await comparisonThumbnail(
              getDiffer(),
              docs,
              page,
              offsets[page] ?? { dx: 0, dy: 0 },
              regions.find((item) => item.page === page)?.regions ?? [],
            ),
          });
        }
      }
      const { blob, name } = await api.compareReport(project.id, dto.id, thumbnails);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = name;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    });
  }

  async function reviewNote(reviewId: string, number: number) {
    if (!dto) return;
    await act("review", async () => {
      await api.compareReviewNote(project.id, dto.id, reviewId);
      setMessage(
        <span className="success">
          {t("docCompare.messages.noteAdded", { number })} <Link to={`/projects/${project.id}/reviews/${reviewId}`}>{t("docCompare.actions.openReview")}</Link>
        </span>,
      );
    });
  }

  if (error) return <div className="page error">{error}</div>;
  if (!from || !to) return <div className="page muted">{to ? t("docCompare.findingPrevious") : t("docCompare.chooseVersions")}</div>;

  return (
    <div className="doccmp">
      <DocCompareHeader dto={dto} onPair={setPair}>
        {dto && (
          <>
            {isPdf && (
              <button className="small" disabled={!regionTotal || !dto.canMarkup || !!working} onClick={() => void saveMarkups()} title={dto.canMarkup ? t("docCompare.saveMarkupsHint") : t("docCompare.noMarkupPermission")}>
                {t("docCompare.actions.saveMarkups")}
              </button>
            )}
            <button className="small" disabled={dto.status !== "done" || !!working} onClick={() => void report()}>
              {working === "report" ? <span className="spin" /> : "⬇"} {t("modelCompare.summary.report")}
            </button>
            <button className="small ghost" title={t("docCompare.rebuildHint")} onClick={() => void act("rebuild", rebuild)}>↻</button>
          </>
        )}
      </DocCompareHeader>

      <div className="doccmp-main">
        {!dto ? (
          <p className="muted" style={{ margin: 16 }}>{t("docCompare.preparing")}</p>
        ) : isPdf ? (
          <DocCompareVisualStage
            docs={docs}
            error={pdfError}
            dto={dto}
            page={Math.min(pageNum, pageCount)}
            pageCount={pageCount}
            onPage={goTo}
            regions={pageRegions?.regions ?? []}
            only={pageRegions?.only}
            selected={selected?.page === pageNum ? selected.index : null}
            onSelect={(index) => setSelected({ page: pageNum, index })}
            focus={focus?.page === pageNum ? focus : null}
            offset={offsets[pageNum] ?? { dx: 0, dy: 0 }}
            onNudge={(dx, dy) => void nudge(dx, dy)}
            differ={getDiffer}
          />
        ) : (
          <div className="doccmp-text"><TextDiffList dto={dto} onFocus={focusOn} full /></div>
        )}
      </div>

      <aside className="doccmp-side">
        {message && <p className={typeof message === "string" ? "error small" : "small"}>{message}</p>}
        {dto && (
          <>
            <AiComparePanel dto={dto} onDto={setDto} onBullet={(bullet) => bullet.page && focusOn(bullet.page, regionBox(regions, bullet), bullet.region)} onIssue={issueFromBullet} />
            {dto.activeReviews.length > 0 && (
              <div className="notice small" style={{ marginTop: 10 }}>
                {dto.activeReviews.map((review) => (
                  <div key={review.reviewId} className="row wrap" style={{ gap: 6 }}>
                    <span><Trans t={t} i18nKey="docCompare.inReview" values={{ code: review.code ?? t("drawer.history.review", { number: review.number }) }} components={{ a: <Link to={`/projects/${project.id}/reviews/${review.reviewId}`} /> }} /></span>
                    <button className="small" disabled={dto.status !== "done" || !!working} onClick={() => void reviewNote(review.reviewId, review.number)}>{t("docCompare.actions.addToReview")}</button>
                  </div>
                ))}
              </div>
            )}
            {dto.flags.length > 0 && (
              <>
                <h3>{t("docCompare.checks.heading")}</h3>
                {dto.flags.map((flag) => <p key={flag.code} className={`small ${flag.severity === "warn" ? "notice" : "muted"}`} style={{ margin: "4px 0" }}>{flag.severity === "warn" ? "⚠ " : ""}{flag.message}</p>)}
              </>
            )}
            {isPdf && (
              <>
                <h3>{t("docCompare.regionsHeading", { count: regionTotal })}{analysis && <span className="muted small"> · {t("docCompare.analysis", { done: analysis.done, total: analysis.total })}</span>}</h3>
                {!regions && !analysis && <p className="muted small">{t("docCompare.visualRunning")}</p>}
                {regions && regionTotal === 0 && !analysis && <p className="muted small">{t("docCompare.noVisualDiff")}</p>}
                {docs && Math.max(docs.a.numPages, docs.b.numPages) > MAX_ANALYZE && <p className="muted small">{t("docCompare.analysedFirst", { count: MAX_ANALYZE })}</p>}
                <RegionList regions={regions ?? []} selected={selected} onFocus={focusOn} onIssue={(page, index) => void issueFromRegion(page, index)} canIssue={!!dto.canMarkup && !working} />
              </>
            )}
            <AntetTable dto={dto} onFocus={focusOn} />
            {isPdf && <TextDiffList dto={dto} onFocus={focusOn} />}
          </>
        )}
      </aside>

      {issueFor && dto && (
        <MarkupIssueDialog
          markup={issueFor.markup}
          fileName={dto.to.fileName}
          version={dto.to.version}
          versionId={dto.to.versionId}
          page={issueFor.page}
          initialTitle={issueFor.title}
          initialDescription={issueFor.description}
          onClose={() => {
            if (issueFor.markup && !issueFor.created) void api.deleteMarkup(project.id, issueFor.markup.id).catch(() => {});
            setIssueFor(null);
          }}
          onCreated={() => setIssueFor((current) => current ? { ...current, created: true } : current)}
        />
      )}
    </div>
  );
}

function regionBox(regions: PageRegions[] | null, bullet: SummaryBullet): NBox | undefined {
  if (bullet.page === undefined || bullet.region === undefined) return undefined;
  return regions?.find((page) => page.page === bullet.page)?.regions[bullet.region]?.box;
}
