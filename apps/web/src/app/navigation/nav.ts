/**
 * The project menu, the "İşler" views, the Model tabs and the settings tabs, kept apart from the
 * components so the Title Case check (test/app/ui-terms.test.ts) and the route table test
 * (test/app/routes.test.ts) can read them without rendering anything. docs/product/SIMPLIFICATION.md, 1. aşama.
 *
 * Names are translation keys of the "shell" namespace (docs/architecture/i18n.md): render them with
 * `t(item.labelKey)` from `useTranslation("shell")`.
 */
import type { ParseKeys } from "i18next";
import type { HubViewKey, ProjectModule } from "@sitekeep/shared";

export type ShellKey = ParseKeys<"shell">;

export type NavIconName =
  | "today" | "works" | "files" | "reviews" | "spec" | "model" | "coordination" | "issues" | "forms"
  | "locations" | "schedule" | "reports" | "settings" | "ask" | "fold" | "chevron" | "menu"
  | "letters" | "meetings" | "rfi" | "submittals" | "transmittals" | "plus" | "filter" | "star" | "upload";

/** The five menu items, plus "ayarlar" for Proje Ayarları at the bottom. */
export type NavKey = "bugun" | "isler" | "dokumanlar" | "model" | "raporlar" | "ayarlar";

export interface NavItem {
  key: NavKey;
  /** Path under /projects/:pid/ ("" = the project home, Bugün). */
  to: string;
  labelKey: ShellKey;
  icon: NavIconName;
  /** Hidden when this module is off in the project. */
  module?: ProjectModule;
}

/** The project menu: five items, no group headers. */
export const NAV_ITEMS: NavItem[] = [
  { key: "bugun", to: "", labelKey: "nav.items.bugun", icon: "today" },
  { key: "isler", to: "works", labelKey: "nav.items.isler", icon: "works" },
  { key: "dokumanlar", to: "files", labelKey: "nav.items.dokumanlar", icon: "files" },
  { key: "model", to: "viewer", labelKey: "nav.items.model", icon: "model" },
  { key: "raporlar", to: "reports", labelKey: "nav.items.raporlar", icon: "reports", module: "reports" },
];

/** Menu entry at the bottom (members who are not administrators see only Konumlar there). */
export const NAV_SETTINGS: NavItem = { key: "ayarlar", to: "settings", labelKey: "nav.items.ayarlar", icon: "settings" };

/** The "Sor" assistant button at the top of the menu. */
export const NAV_ASK_LABEL: ShellKey = "nav.ask";

/** Sections of "İşler" (?bolum=…): one list, filtered by category. */
export const WORK_SECTIONS: { key: string; labelKey: ShellKey; categories: string[]; quick: string[]; newLabelKey: ShellKey; module: ProjectModule }[] = [
  { key: "yazismalar", labelKey: "nav.workSections.yazismalar", categories: ["correspondence"], quick: ["awaiting", "unmailed", "archived", "cancelled"], newLabelKey: "nav.workSections.yazismalarNew", module: "correspondence" },
  { key: "bilgi-talepleri", labelKey: "nav.workSections.bilgiTalepleri", categories: ["rfi"], quick: ["rfi-log"], newLabelKey: "nav.workSections.bilgiTalepleriNew", module: "rfi" },
  { key: "teknik-onaylar", labelKey: "nav.workSections.teknikOnaylar", categories: ["submittal", "submittal_package"], quick: ["register"], newLabelKey: "nav.workSections.teknikOnaylarNew", module: "submittals" },
  { key: "toplantilar", labelKey: "nav.workSections.toplantilar", categories: ["meeting", "action"], quick: [], newLabelKey: "nav.workSections.toplantilarNew", module: "meetings" },
  { key: "gonderimler", labelKey: "nav.workSections.gonderimler", categories: ["transmittal"], quick: [], newLabelKey: "nav.workSections.gonderimlerNew", module: "transmittals" },
];

/** Quick filters of "İşler": correspondence views (Odoo "Yazışmalar" filters) and the two list views. */
export const WORK_QUICK_FILTERS: { key: string; labelKey: ShellKey; category?: string; view?: "rfi" | "submittal"; letters?: string }[] = [
  { key: "rfi", labelKey: "nav.quickFilters.rfi", category: "rfi" },
  { key: "submittal", labelKey: "nav.quickFilters.submittal", category: "submittal,submittal_package" },
  { key: "meeting", labelKey: "nav.quickFilters.meeting", category: "meeting" },
  { key: "action", labelKey: "nav.quickFilters.action", category: "action" },
  { key: "rfi-log", labelKey: "nav.quickFilters.rfiLog", view: "rfi" },
  { key: "register", labelKey: "nav.quickFilters.register", view: "submittal" },
  { key: "awaiting", labelKey: "nav.quickFilters.awaiting", letters: "awaiting" },
  { key: "unmailed", labelKey: "nav.quickFilters.unmailed", letters: "unmailed" },
  { key: "archived", labelKey: "nav.quickFilters.archived", letters: "archived" },
  { key: "cancelled", labelKey: "nav.quickFilters.cancelled", letters: "cancelled" },
];

/** Page of a hub view: the works list, or an existing page rendered inside the hub. */
export type HubPath = "works" | "issues" | "reviews" | "forms";

export interface HubView {
  key: HubViewKey;
  labelKey: ShellKey;
  icon: NavIconName;
  path: HubPath;
  /** Works section (?bolum=…). */
  section?: string;
  module?: ProjectModule;
  /** The view's pages belong to this installed module (app/modules.ts); hidden without it. */
  webModule?: string;
}

/** Views of the İşler hub in display order; the user's saved views follow them. */
export const HUB_VIEWS: HubView[] = [
  { key: "bana", labelKey: "nav.hubViews.bana", icon: "today", path: "works", section: "bana" },
  { key: "tum", labelKey: "nav.hubViews.tum", icon: "works", path: "works" },
  { key: "yazismalar", labelKey: "nav.hubViews.yazismalar", icon: "letters", path: "works", section: "yazismalar", module: "correspondence" },
  { key: "bilgi-talepleri", labelKey: "nav.hubViews.bilgiTalepleri", icon: "rfi", path: "works", section: "bilgi-talepleri", module: "rfi" },
  { key: "teknik-onaylar", labelKey: "nav.hubViews.teknikOnaylar", icon: "submittals", path: "works", section: "teknik-onaylar", module: "submittals" },
  { key: "toplantilar", labelKey: "nav.hubViews.toplantilar", icon: "meetings", path: "works", section: "toplantilar", module: "meetings" },
  { key: "gonderimler", labelKey: "nav.hubViews.gonderimler", icon: "transmittals", path: "works", section: "gonderimler", module: "transmittals" },
  { key: "sorunlar", labelKey: "nav.hubViews.sorunlar", icon: "issues", path: "issues", module: "issues" },
  { key: "incelemeler", labelKey: "nav.hubViews.incelemeler", icon: "reviews", path: "reviews", module: "reviews" },
  { key: "formlar", labelKey: "nav.hubViews.formlar", icon: "forms", path: "forms", module: "forms", webModule: "field" },
];

/** Labels of the hub's own controls. */
export const HUB_LABELS = {
  views: "nav.hub.views",
  savedViews: "nav.hub.savedViews",
  saveView: "nav.hub.saveView",
  manageViews: "nav.hub.manageViews",
  newRecord: "nav.hub.newRecord",
  filters: "nav.hub.filters",
  clearFilters: "nav.hub.clearFilters",
  shareWithProject: "nav.hub.shareWithProject",
} as const satisfies Record<string, ShellKey>;

/** Tabs of "Model". */
export const MODEL_TABS: { key: "viewer" | "coordination" | "schedule" | "params"; to: string; labelKey: ShellKey; module?: ProjectModule; webModule?: string }[] = [
  { key: "viewer", to: "viewer", labelKey: "nav.modelTabs.viewer" },
  { key: "coordination", to: "coordination", labelKey: "nav.modelTabs.coordination", module: "coordination" },
  { key: "schedule", to: "schedule", labelKey: "nav.modelTabs.schedule", module: "schedule", webModule: "planning" },
  // Değişiklik Talebi (docs/features/PARAMETER_CHANGE.md): new requests need the Koordinasyon module.
  { key: "params", to: "param-changes", labelKey: "nav.modelTabs.params", module: "coordination", webModule: "coordinate" },
];

export type SettingsTabKey =
  | "uyeler" | "roller" | "moduller" | "konumlar" | "sablon" | "yapay-zeka"
  | "isimlendirme" | "is-akislari" | "is-tipleri" | "oznitelikler" | "aktivite" | "sistem-durumu";

/**
 * Tabs of Proje Ayarları (?sekme=…). Advanced tabs show after "Gelişmiş Ayarları Göster";
 * `everyone`: also for members who are not project administrators (read-only for them).
 */
export const SETTINGS_TABS: { key: SettingsTabKey; labelKey: ShellKey; advanced?: boolean; everyone?: boolean; systemAdmin?: boolean }[] = [
  { key: "uyeler", labelKey: "nav.settingsTabs.uyeler" },
  { key: "roller", labelKey: "nav.settingsTabs.roller" },
  { key: "moduller", labelKey: "nav.settingsTabs.moduller" },
  { key: "konumlar", labelKey: "nav.settingsTabs.konumlar", everyone: true },
  { key: "sablon", labelKey: "nav.settingsTabs.sablon" },
  { key: "yapay-zeka", labelKey: "nav.settingsTabs.yapayZeka", everyone: true },
  { key: "isimlendirme", labelKey: "nav.settingsTabs.isimlendirme", advanced: true },
  { key: "is-akislari", labelKey: "nav.settingsTabs.isAkislari", advanced: true },
  { key: "is-tipleri", labelKey: "nav.settingsTabs.isTipleri", advanced: true },
  { key: "oznitelikler", labelKey: "nav.settingsTabs.oznitelikler", advanced: true },
  { key: "aktivite", labelKey: "nav.settingsTabs.aktivite", advanced: true },
  { key: "sistem-durumu", labelKey: "nav.settingsTabs.sistemDurumu", systemAdmin: true },
];

export const SETTINGS_ADVANCED_LABEL: ShellKey = "nav.showAdvanced";
