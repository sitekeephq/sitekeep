import { reportModuleEnabled, type ReportDatasetDto } from "@sitekeep/shared";
import type { ProjectAccess } from "../core/security/access.js";
import { projectModules } from "../projects/modules.js";
import { reportDatasets } from "./datasets.js";

/** Datasets the caller may use whose module is on in the project, described in `lang`. */
export function enabledDatasets(a: ProjectAccess, lang: string): ReportDatasetDto[] {
  const modules = projectModules(a.project);
  return reportDatasets.describe({ access: a }, lang).filter((d) => reportModuleEnabled(modules, d.module));
}
