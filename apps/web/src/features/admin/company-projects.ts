import type { CompanyDto } from "@sitekeep/shared";

/** Administration → Companies, project filter (docs/features/COMPANIES.md): "" = all, "-" = on no project. */
export const NO_PROJECT = "-";

/** The projects named by the companies' links, by code, each once. */
export function companyProjectOptions(companies: readonly CompanyDto[]): { id: string; code: string; name: string }[] {
  const byId = new Map(companies.flatMap((c) => c.projects ?? []).map((p) => [p.id, p]));
  return [...byId.values()].sort((a, b) => a.code.localeCompare(b.code));
}

/** The companies on the chosen project, or on none ("-"), or all (""). */
export function filterCompaniesByProject<T extends CompanyDto>(companies: readonly T[], projectId: string): T[] {
  if (!projectId) return [...companies];
  if (projectId === NO_PROJECT) return companies.filter((c) => !c.projects?.length);
  return companies.filter((c) => c.projects?.some((p) => p.id === projectId));
}
