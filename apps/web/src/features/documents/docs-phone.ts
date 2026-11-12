/**
 * Dokümanlar on narrow screens (≤ 900px, when the folder tree is hidden): the toolbar keeps the search box, "Yükle" and a "Diğer" (⋯) menu
 * with the rest; the file table becomes a list of cards (components/DocsCards.tsx).
 */
import { i18n } from "../../i18n";
import { formatDay } from "../../shared/api/api";
import { localToday } from "../works/record-cards";

export type DocsMoreKey =
  | "select"
  | "filter"
  | "inFolder"
  | "report"
  | "spec"
  | "autodesk"
  | "newFolder"
  | "permissions"
  | "settings";

export interface DocsMoreItem {
  key: DocsMoreKey;
  label: string;
  /** On/off items (Seç, Filtre, Bu Klasörde Ara) show a check mark; others leave it undefined. */
  checked?: boolean;
  disabled?: boolean;
  note?: string;
}

export interface DocsMoreOptions {
  /** Şartname module on: "Şartnameden Teknik Onay Listesi". */
  spec: boolean;
  /** Reports on for documents: "Rapor". */
  report: boolean;
  /** A search is shown: the column filters do not apply to it. */
  searching: boolean;
  /** "manage" on the folder: Yeni Klasör, Yetkiler, Klasör Ayarları (folder admin, as on desktop). */
  canManage: boolean;
  filtersOn: boolean;
  inFolder: boolean;
  selecting: boolean;
  /** Desktop: rows always have checkboxes, so there is no "Seç". */
  desktop?: boolean;
  /** "Autodesk Dokümanları" view of the folder. */
  autodesk?: boolean;
}

/** Items of the "Diğer" menu, in order; folder-admin items only with "manage" on the folder. */
export function docsMoreItems(o: DocsMoreOptions): DocsMoreItem[] {
  const items: DocsMoreItem[] = o.desktop ? [] : [{ key: "select", label: i18n.t("documents:more.actions.select"), checked: o.selecting }];
  if (o.desktop && o.canManage)
    items.push(
      { key: "newFolder", label: i18n.t("documents:more.actions.newFolder") },
      { key: "permissions", label: i18n.t("documents:more.actions.permissions") },
      { key: "settings", label: i18n.t("documents:more.actions.settings") },
    );
  if (!o.searching) items.push({ key: "filter", label: o.desktop ? i18n.t("documents:more.actions.columnFilters") : i18n.t("documents:more.actions.filter"), checked: o.filtersOn });
  items.push({ key: "inFolder", label: i18n.t("documents:more.actions.inFolder"), checked: o.inFolder });
  if (o.autodesk) items.push({ key: "autodesk", label: i18n.t("documents:more.actions.autodesk"), disabled: true, note: i18n.t("documents:more.status.offline") });
  if (o.report) items.push({ key: "report", label: i18n.t("documents:more.actions.report") });
  if (o.spec) items.push({ key: "spec", label: i18n.t("documents:more.actions.spec") });
  if (!o.desktop && o.canManage)
    items.push(
      { key: "newFolder", label: i18n.t("documents:more.actions.newFolder") },
      { key: "permissions", label: i18n.t("documents:more.actions.permissions") },
      { key: "settings", label: i18n.t("documents:more.actions.settings") },
    );
  return items;
}

/** Local day of an ISO time, as shown on a file card ("01.10.2026"). */
export function fileDay(iso: string): string {
  return formatDay(localToday(new Date(iso)));
}
