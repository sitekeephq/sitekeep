/** First-run product tour: Bugün → Dokümanlar (S16 istasyonu) → Model görüntüleyici. */
import type { ParseKeys } from "i18next";

/** Key of the "onboarding" namespace; translated when the step is shown. */
export type OnboardingKey = ParseKeys<"onboarding">;

export const TOUR_STORAGE_KEY = "cde.productTour.v1";
export const TOUR_QUERY = "tur";
export const TOUR_MENU_EVENT = "cde:tour-menu";
export const TOUR_START_EVENT = "cde:start-tour";
export const FOLDER_TOUR_PREFIX = "folder:";
export const STATION_TOUR_GROUP = "s16";

export function startProductTour() {
  window.dispatchEvent(new Event(TOUR_START_EVENT));
}

export type TourRoute = "today" | "files" | "viewer";

export type TourStep = {
  id: string;
  route: TourRoute;
  /** `data-tour` value, or `folder:<klasör adı>` for a named folder row/node (folder names are project data). */
  target: string;
  /** Used when `target` is missing (e.g. no upload permission). */
  fallback?: string;
  titleKey: OnboardingKey;
  bodyKey: OnboardingKey;
  /** Keep the phone project menu open so a sidenav target is visible. */
  openNav?: boolean;
  /** İleri (or a click in the spotlight) activates the highlighted control. */
  click?: boolean;
  /** Scroll the docs grid so date/approval columns are in view. */
  scroll?: "end";
  /** If the target is missing, skip every remaining step in this group. */
  optionalGroup?: string;
};

export const TOUR_STEPS: TourStep[] = [
  {
    id: "nav-today",
    route: "today",
    target: "nav-today",
    openNav: true,
    titleKey: "tour.steps.navToday.title",
    bodyKey: "tour.steps.navToday.body",
  },
  {
    id: "today-grid",
    route: "today",
    target: "today-grid",
    fallback: "today-page",
    titleKey: "tour.steps.todayGrid.title",
    bodyKey: "tour.steps.todayGrid.body",
  },
  {
    id: "nav-files",
    route: "files",
    target: "nav-files",
    openNav: true,
    titleKey: "tour.steps.navFiles.title",
    bodyKey: "tour.steps.navFiles.body",
  },
  {
    id: "files-tree",
    route: "files",
    target: "files-tree",
    fallback: "files-toolbar",
    titleKey: "tour.steps.filesTree.title",
    bodyKey: "tour.steps.filesTree.body",
  },
  {
    id: "files-upload",
    route: "files",
    target: "files-upload",
    fallback: "files-toolbar",
    titleKey: "tour.steps.filesUpload.title",
    bodyKey: "tour.steps.filesUpload.body",
  },
  {
    id: "folder-tasarim",
    route: "files",
    target: `${FOLDER_TOUR_PREFIX}01-TASARIM ÇALIŞMALARI`, // i18n-ok: folder name in the demo project data
    optionalGroup: STATION_TOUR_GROUP,
    click: true,
    titleKey: "tour.steps.folderTasarim.title",
    bodyKey: "tour.steps.folderTasarim.body",
  },
  {
    id: "folder-onaya",
    route: "files",
    target: `${FOLDER_TOUR_PREFIX}02-Onaya Sunulan (Shared for Approval)`, // i18n-ok: folder name in the demo project data
    optionalGroup: STATION_TOUR_GROUP,
    click: true,
    titleKey: "tour.steps.folderOnaya.title",
    bodyKey: "tour.steps.folderOnaya.body",
  },
  {
    id: "folder-istasyonlar",
    route: "files",
    target: `${FOLDER_TOUR_PREFIX}002-İstasyonlar`, // i18n-ok: folder name in the demo project data
    optionalGroup: STATION_TOUR_GROUP,
    click: true,
    titleKey: "tour.steps.folderIstasyonlar.title",
    bodyKey: "tour.steps.folderIstasyonlar.body",
  },
  {
    id: "folder-s16",
    route: "files",
    target: `${FOLDER_TOUR_PREFIX}S16`, // i18n-ok: folder name in the demo project data
    optionalGroup: STATION_TOUR_GROUP,
    click: true,
    titleKey: "tour.steps.folderS16.title",
    bodyKey: "tour.steps.folderS16.body",
  },
  {
    id: "discipline-folders",
    route: "files",
    target: "files-list",
    fallback: "files-toolbar",
    optionalGroup: STATION_TOUR_GROUP,
    titleKey: "tour.steps.disciplineFolders.title",
    bodyKey: "tour.steps.disciplineFolders.body",
  },
  {
    id: "folder-mimari",
    route: "files",
    target: `${FOLDER_TOUR_PREFIX}01-Mimari`, // i18n-ok: folder name in the demo project data
    optionalGroup: STATION_TOUR_GROUP,
    click: true,
    titleKey: "tour.steps.folderMimari.title",
    bodyKey: "tour.steps.folderMimari.body",
  },
  {
    id: "docs-meta",
    route: "files",
    target: "docs-approval",
    fallback: "docs-date",
    optionalGroup: STATION_TOUR_GROUP,
    scroll: "end",
    titleKey: "tour.steps.docsMeta.title",
    bodyKey: "tour.steps.docsMeta.body",
  },
  {
    id: "open-model",
    route: "files",
    target: "open-model",
    optionalGroup: STATION_TOUR_GROUP,
    click: true,
    titleKey: "tour.steps.openModel.title",
    bodyKey: "tour.steps.openModel.body",
  },
  {
    id: "nav-viewer",
    route: "viewer",
    target: "nav-viewer",
    openNav: true,
    titleKey: "tour.steps.navViewer.title",
    bodyKey: "tour.steps.navViewer.body",
  },
  {
    id: "viewer-models",
    route: "viewer",
    target: "viewer-models",
    titleKey: "tour.steps.viewerModels.title",
    bodyKey: "tour.steps.viewerModels.body",
  },
  {
    id: "viewer-hud",
    route: "viewer",
    target: "viewer-hud",
    titleKey: "tour.steps.viewerHud.title",
    bodyKey: "tour.steps.viewerHud.body",
  },
];

export function isTourDone(): boolean {
  try {
    return localStorage.getItem(TOUR_STORAGE_KEY) === "done";
  } catch {
    return true;
  }
}

export function markTourDone(): void {
  try {
    localStorage.setItem(TOUR_STORAGE_KEY, "done");
  } catch {
    // Private mode: the tour simply will not persist.
  }
}

export function nextTourIndex(from: number, skipGroup?: string): number {
  if (!skipGroup) return from + 1;
  const i = TOUR_STEPS.findIndex((s, j) => j > from && s.optionalGroup !== skipGroup);
  return i === -1 ? TOUR_STEPS.length : i;
}

function selectorFor(id: string): string {
  const escape = (value: string) => {
    if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(value);
    return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  };
  if (id.startsWith(FOLDER_TOUR_PREFIX)) {
    return `[data-tour-folder="${escape(id.slice(FOLDER_TOUR_PREFIX.length))}"]`;
  }
  return `[data-tour="${escape(id)}"]`;
}

export function visibleTourTarget(id: string): HTMLElement | null {
  const nodes = document.querySelectorAll<HTMLElement>(selectorFor(id));
  for (const el of nodes) {
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") continue;
    const r = el.getBoundingClientRect();
    if (r.width >= 8 && r.height >= 8) return el;
  }
  return null;
}

export function scrollTourTarget(el: HTMLElement, mode?: TourStep["scroll"]) {
  const scroller = el.closest(".docs-list, .docs-cards-wrap") as HTMLElement | null;
  if (mode === "end" && scroller) scroller.scrollTo({ left: scroller.scrollWidth, behavior: "smooth" });
  el.scrollIntoView({ block: "nearest", inline: "nearest" });
}
