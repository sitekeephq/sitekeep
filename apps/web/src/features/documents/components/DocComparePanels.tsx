import { useState } from "react";
import { useTranslation } from "react-i18next";
import { type DocCompareDto, type NBox, type PageRegions, type SummaryBullet, type TextChange } from "@sitekeep/shared";
import { useLabel } from "../../../i18n";
import { api } from "../../../shared/api/api";
import { useProject } from "../../../app/context/project";
import { AiTaskButton } from "../../../shared/ai/AiTaskButton";

export function AiComparePanel({
  dto,
  onDto,
  onBullet,
  onIssue,
}: {
  dto: DocCompareDto;
  onDto(dto: DocCompareDto): void;
  onBullet(bullet: SummaryBullet): void;
  onIssue(bullet: SummaryBullet): void;
}) {
  const { t } = useTranslation(["documents", "common"]);
  const project = useProject();
  const [error, setError] = useState<string | null>(null);
  const ai = dto.ai;
  const start = (force: boolean) => api.startCompareSummary(project.id, dto.id, force).then(onDto, (e: Error) => setError(e.message));
  const bullets = ai.status === "done" && ai.bullets.length ? ai.bullets : null;
  const list = (items: SummaryBullet[]) => (
    <ul>
      {items.map((bullet, index) => (
        <li key={index} className={bullet.severity === "warn" ? "warn" : undefined}>
          {bullet.page ? <a href="#" onClick={(event) => (event.preventDefault(), onBullet(bullet))} title={t("compare.ai.goToPage")}>{t("compare.ai.pageShort", { page: bullet.page })}</a> : null}
          {bullet.page ? " " : ""}{bullet.text}{" "}
          <button className="small ghost" style={{ padding: "0 4px" }} title={t("compare.ai.createIssue")} onClick={() => onIssue(bullet)}>⚑</button>
        </li>
      ))}
    </ul>
  );
  return (
    <div className="doccmp-ai">
      <div className="row">
        <strong>{t("compare.ai.heading")}</strong>
        <div className="spacer" />
        {ai.available && dto.status === "done" && ai.status !== "running" && (
          <button className="small ghost" onClick={() => void start(ai.status === "done")} title={t("compare.ai.rewriteHint")}>{ai.status === "done" ? t("compare.ai.actions.rewrite") : t("common:actions.create")}</button>
        )}
        {dto.status === "done" && ai.status !== "running" && (
          <AiTaskButton projectId={project.id} kind="doc_compare_summary" input={{ comparisonId: dto.id }} small onResult={(result) => onDto(result as DocCompareDto)} />
        )}
      </div>
      {dto.status === "running" && <p className="small muted"><span className="spin" /> {t("compare.ai.comparingText")}</p>}
      {dto.status === "failed" && <p className="small error">{t("compare.ai.errors.failed", { error: dto.error })}</p>}
      {ai.status === "running" && <p className="small muted"><span className="spin" /> {ai.progress ?? t("compare.ai.preparing")} {t("compare.ai.keepWorking")}</p>}
      {bullets && (
        <>
          {list(bullets)}
          <p className="muted small" style={{ margin: "6px 0 0" }}>{t("compare.ai.disclaimer", { model: ai.model })}</p>
        </>
      )}
      {!bullets && dto.status === "done" && (
        <>
          {list(dto.summary)}
          <p className="muted small" style={{ margin: "6px 0 0" }}>
            {!ai.available
              ? t("compare.ai.ruleBasedUnavailable", { reason: ai.note ?? t("compare.ai.off") })
              : ai.status === "failed"
                ? t("compare.ai.errors.summaryFailed", { error: ai.error ?? t("compare.ai.errorFallback") })
                : t("compare.ai.ruleBasedQuick")}
          </p>
        </>
      )}
      {ai.available && ai.note && <p className="muted small">{ai.note}</p>}
      {error && <p className="error small">{error}</p>}
    </div>
  );
}

export function RegionList({
  regions,
  selected,
  onFocus,
  onIssue,
  canIssue,
}: {
  regions: PageRegions[];
  selected: { page: number; index: number } | null;
  onFocus(page: number, box: NBox, index: number): void;
  onIssue(page: number, index: number): void;
  canIssue: boolean;
}) {
  const { t } = useTranslation(["documents", "common"]);
  const label = useLabel();
  const [all, setAll] = useState(false);
  const rows = regions.flatMap((page) => page.only ? [] : page.regions.map((region, index) => ({ page: page.page, index, region })));
  const shown = all ? rows : rows.slice(0, 40);
  return (
    <div>
      {regions.filter((page) => page.only).map((page) => (
        <div key={`o${page.page}`} className="small" style={{ margin: "4px 0" }}>
          <span className={`badge ${page.only === "B" ? "diff-added" : "diff-removed"}`}>{page.only === "B" ? t("compare.regions.badges.newPage") : t("compare.regions.badges.deletedPage")}</span> {t("compare.regions.page", { page: page.page })}
        </div>
      ))}
      {shown.map(({ page, index, region }) => (
        <div key={`${page}-${index}`} className={`doccmp-item${selected?.page === page && selected.index === index ? " active" : ""}`} onClick={() => onFocus(page, region.box, index)}>
          <span className={`badge diff-${region.kind}`}>{label("diffRegion", region.kind)}</span>
          <span className="grow">{t("compare.regions.item", { page, n: index + 1 })}<span className="muted"> · {Math.round((region.box.x1 - region.box.x0) * 100)}×{Math.round((region.box.y1 - region.box.y0) * 100)}%</span></span>
          {canIssue && <button className="small ghost" style={{ padding: "0 4px" }} title={t("compare.regions.createIssue")} onClick={(event) => { event.stopPropagation(); onIssue(page, index); }}>⚑</button>}
        </div>
      ))}
      {rows.length > shown.length && <button className="small ghost" onClick={() => setAll(true)}>{t("compare.regions.actions.showAll", { count: rows.length })}</button>}
    </div>
  );
}

export function AntetTable({ dto, onFocus }: { dto: DocCompareDto; onFocus(page: number, box: NBox | undefined): void }) {
  const { t } = useTranslation(["documents", "common"]);
  const result = dto.result;
  if (!result || result.kind !== "pdf" || !result.antet.length) return null;
  return (
    <>
      <h3>{t("compare.text.antetHeading")}</h3>
      <table className="props-table small">
        <tbody>
          {result.antet.map((change, index) => (
            <tr key={index} style={{ cursor: result.antetRegion ? "pointer" : undefined }} onClick={() => onFocus(1, result.antetRegion ?? undefined)}>
              <td>{change.label}</td>
              <td><del className="diff-old">{change.old ?? "—"}</del> → <ins className="diff-new">{change.new ?? "—"}</ins></td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function Words({ change }: { change: TextChange }) {
  if (change.kind === "added") return <ins className="diff-new">{change.new}</ins>;
  if (change.kind === "removed") return <del className="diff-old">{change.old}</del>;
  return <>{(change.words ?? []).map(([operation, text], index) => operation === 0 ? <span key={index}>{text}</span> : operation === 1 ? <ins key={index} className="diff-new">{text}</ins> : <del key={index} className="diff-old">{text}</del>)}</>;
}

export function TextDiffList({ dto, onFocus, full }: { dto: DocCompareDto; onFocus(page: number, box: NBox | undefined): void; full?: boolean }) {
  const { t } = useTranslation(["documents", "common"]);
  const result = dto.result;
  const [open, setOpen] = useState<Record<number, boolean>>({});
  if (!result) return null;
  const heading =
    result.kind === "pdf"
      ? t("compare.text.headings.pdf")
      : result.kind === "docx"
        ? t("compare.text.headings.docx")
        : result.kind === "text"
          ? t("compare.text.headings.text")
          : t("compare.text.headings.cells");
  return (
    <>
      <h3>{heading} <span className="muted small">({t("compare.text.totals", { changed: result.totals.changed, added: result.totals.added, removed: result.totals.removed })})</span></h3>
      {result.note && <p className="notice small">{result.note}</p>}
      {result.identical && <p className="muted small">{t("compare.text.identical")}</p>}
      {!result.identical && result.hasText && !result.pages.length && !result.sheets?.some((sheet) => sheet.status !== "same") && <p className="muted small">{t("compare.text.noDiff")}</p>}
      {result.sheets?.filter((sheet) => sheet.status !== "same").map((sheet) => (
        <div key={sheet.name} style={{ marginBottom: 10 }}>
          <div className="small" style={{ fontWeight: 600 }}>
            {sheet.name} {sheet.status !== "changed"
              ? <span className={`badge diff-${sheet.status}`}>{sheet.status === "added" ? t("compare.regions.badges.newPage") : t("compare.regions.badges.deletedPage")}</span>
              : <span className="muted">{t("compare.text.sheetTotals", { changed: sheet.changed, added: sheet.added, removed: sheet.removed })}</span>}
          </div>
          <table className="small"><tbody>
            {sheet.rows.map((row, index) => (
              <tr key={index}>
                <td style={{ width: 70 }} className="muted">{t("compare.text.row", { row: row.rowB ?? row.rowA })}</td>
                <td>
                  {row.kind === "changed"
                    ? (row.cells ?? []).map((cell, cellIndex) => <span key={cellIndex} style={{ marginRight: 10 }}><strong>{cell.col}</strong> <del className="diff-old">{cell.old || "∅"}</del> → <ins className="diff-new">{cell.new || "∅"}</ins></span>)
                    : row.kind === "added" ? <ins className="diff-new">{row.text}</ins> : <del className="diff-old">{row.text}</del>}
                </td>
              </tr>
            ))}
          </tbody></table>
          {sheet.more && <p className="muted small">{t("compare.text.moreRows", { count: sheet.more })}</p>}
        </div>
      ))}
      {result.pages.map((page) => {
        const isOpen = full || open[page.page] || result.pages.length <= 3;
        return (
          <div key={page.page} style={{ marginBottom: 8 }}>
            <div className="row small" style={{ cursor: "pointer" }} onClick={() => setOpen({ ...open, [page.page]: !isOpen })}>
              <strong>{result.kind === "pdf" ? t("compare.regions.page", { page: page.page }) : t("compare.text.text")}</strong>
              <span className="muted">{t("compare.text.pageTotals", { changed: page.changed, added: page.added, removed: page.removed })}</span>
              <div className="spacer" />{!full && <span className="muted">{isOpen ? "▾" : "▸"}</span>}
            </div>
            {isOpen && page.changes.map((change, index) => (
              <div key={index} className="doccmp-item" onClick={() => (result.kind === "pdf" ? onFocus(change.pageB ?? change.pageA ?? page.page, change.boxB ?? change.boxA) : undefined)} style={{ cursor: result.kind === "pdf" ? "pointer" : "default" }}>
                <span className={`badge diff-${change.kind}`}>{change.kind === "added" ? "+" : change.kind === "removed" ? "−" : "~"}</span>
                <span className="grow"><Words change={change} />{change.antet && <span className="muted"> {t("compare.text.antetTag")}</span>}</span>
              </div>
            ))}
            {isOpen && page.more ? <p className="muted small">{t("compare.text.moreChanges", { count: page.more })}</p> : null}
          </div>
        );
      })}
    </>
  );
}
