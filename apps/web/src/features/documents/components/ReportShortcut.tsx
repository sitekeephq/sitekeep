import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { reportModuleEnabled, resolveModules, type ReportModule } from "@sitekeep/shared";
import { useProject } from "../../../app/context/project";
import { useLabel } from "../../../i18n";
import { webCapability } from "../../../sdk/capabilities";

/**
 * URL of the module's reports: with the Platform module the report builder scoped to the module (AI
 * when available, else the module's templates); without it the module's fixed lists (CSV).
 */
export function reportBuilderUrl(projectId: string, module: ReportModule): string {
  return webCapability("platform.reports")
    ? `/projects/${projectId}/reports?new=ai&module=${module}`
    : `/projects/${projectId}/reports?view=lists&module=${module}`;
}

/**
 * "Rapor" on a module page: opens the report builder scoped to the module, so only the module's
 * datasets go to the AI and its templates come first (Platform module); in Community the module's lists.
 */
export function ReportShortcut({ module, small }: { module: ReportModule; small?: boolean }) {
  const { t } = useTranslation(["documents", "common"]);
  const label = useLabel();
  const project = useProject();
  // Reports (or the module itself) off in this project: no shortcut.
  if (!reportModuleEnabled(project.modules ?? resolveModules(null), module)) return null;
  return (
    <Link
      className={`btn${small ? " small" : ""}`}
      to={reportBuilderUrl(project.id, module)}
      title={t(webCapability("platform.reports") ? "reportShortcut.hint" : "reportShortcut.hintLists", { module: label("reportModule", module) })}
    >
      {t("more.actions.report")}
    </Link>
  );
}

/** Report module of an İşler section (?bolum=…); the whole list is "works". */
export function worksSectionModule(section: string | undefined): ReportModule {
  const map: Record<string, ReportModule> = {
    yazismalar: "correspondence",
    toplantilar: "meetings",
    "bilgi-talepleri": "rfi",
    "teknik-onaylar": "submittals",
    gonderimler: "transmittals",
  };
  return (section && map[section]) || "works";
}
