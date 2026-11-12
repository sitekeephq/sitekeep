/**
 * Module switches per project (docs/product/SIMPLIFICATION.md, 1. aşama): a project administrator turns
 * modules off in Proje Ayarları → Modüller. An off module disappears from the menu, the İşler
 * views, "+ Yeni", the Model tabs, the "Sor" assistant's tools and the report builder. Its data is
 * kept: existing records still open and the API serves them, only new records are refused.
 *
 * Documents (Dokümanlar) and generic works are the core and cannot be turned off.
 */
import type { ParamChangeSettings } from "../coordination/param-change.js";
import type { ReportModule } from "../reports/reports.js";
import type { WorkCategory } from "../works/work-catalog.js";
import { type ProjectModule, type ProjectModuleState } from "./module-state.js";
import { SHARED_DEFAULT_LANGUAGE, labelText, sharedText } from "../platform/i18n.js";

export * from "./module-state.js";

/** Module names in Proje Ayarları → Modüller (Title Case). */
export const PROJECT_MODULE_LABELS_TR: Record<ProjectModule, string> = {
  correspondence: "Yazışma",
  rfi: "Bilgi Talebi",
  submittals: "Teknik Onay",
  meetings: "Toplantı ve Eylem",
  transmittals: "Gönderim Formu",
  issues: "Sorun",
  reviews: "İnceleme",
  forms: "Form",
  coordination: "Koordinasyon",
  schedule: "İş Programı",
  spec: "Şartname Analizi",
  reports: "Raporlar",
};

/** One sentence per module for the settings screen. */
export function projectModuleHelp(m: ProjectModule, lang: string = SHARED_DEFAULT_LANGUAGE): string {
  return sharedText(lang, `modules.help.${m}`);
}

/** Stored in projects.settings (jsonb). Missing modules count as on. */
export interface ProjectSettings {
  modules?: Partial<Record<ProjectModule, boolean>>;
  /** Parameter change requests (Değişiklik Talebi): approval switch and approver role. */
  paramChange?: Partial<ParamChangeSettings>;
}

/** Module a work category belongs to; generic works belong to none and are always available. */
export function moduleOfWorkCategory(category: WorkCategory | string): ProjectModule | null {
  switch (category) {
    case "correspondence":
      return "correspondence";
    case "rfi":
      return "rfi";
    case "submittal":
    case "submittal_package":
      return "submittals";
    case "meeting":
    case "action":
      return "meetings";
    case "transmittal":
      return "transmittals";
    default:
      return null;
  }
}

/** Project module behind a report module family; null = always available while reports are on. */
export function moduleOfReportModule(m: ReportModule | string | undefined): ProjectModule | null {
  switch (m) {
    case "correspondence":
      return "correspondence";
    case "rfi":
      return "rfi";
    case "submittals":
      return "submittals";
    case "meetings":
      return "meetings";
    case "transmittals":
      return "transmittals";
    case "issues":
      return "issues";
    case "reviews":
      return "reviews";
    case "forms":
      return "forms";
    case "coordination":
      return "coordination";
    case "schedule":
      return "schedule";
    case "spec":
      return "spec";
    default:
      return null;
  }
}

/** A report family is usable when reports are on and its own module (if any) is on. */
export function reportModuleEnabled(modules: ProjectModuleState, m: ReportModule | string | undefined): boolean {
  if (!modules.reports) return false;
  const own = moduleOfReportModule(m);
  return !own || modules[own];
}

/** Refusal text for a new record of an off module. */
export function moduleOffMessage(m: ProjectModule, lang: string = SHARED_DEFAULT_LANGUAGE): string {
  return sharedText(lang, "modules.offMessage", { module: labelText(lang, "projectModule", m) });
}

/**
 * Template defaults: the generic ISO 19650 template starts with documents, reviews, issues,
 * correspondence and reports; the rest can be turned on later.
 */
export const ISO19650_DEFAULT_MODULES: ProjectModuleState = {
  correspondence: true,
  rfi: false,
  submittals: false,
  meetings: false,
  transmittals: false,
  issues: true,
  reviews: true,
  forms: false,
  coordination: false,
  schedule: false,
  spec: false,
  reports: true,
};
