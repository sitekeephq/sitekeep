import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { reportModuleEnabled, resolveModules, type ReportModule } from "@sitekeep/shared";
import { useProject } from "../../../app/context/project";
import { useLabel } from "../../../i18n";

/** URL of the report builder scoped to a module (AI when available, else the module's templates). */
export function reportBuilderUrl(projectId: string, module: ReportModule): string {
  return `/projects/${projectId}/reports?new=ai&module=${module}`;
}

/**
 * "Rapor" on a module page: opens the report builder scoped to the module, so only the module's
 * datasets go to the AI and its templates come first.
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
      title={t("reportShortcut.hint", { module: label("reportModule", module) })}
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
