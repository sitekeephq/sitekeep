/** Leaf project-module primitives. Keep this file free of domain imports. */
export const PROJECT_MODULES = [
  "correspondence",
  "rfi",
  "submittals",
  "meetings",
  "transmittals",
  "issues",
  "reviews",
  "forms",
  "coordination",
  "schedule",
  "spec",
  "reports",
] as const;

export type ProjectModule = (typeof PROJECT_MODULES)[number];
export type ProjectModuleState = Record<ProjectModule, boolean>;

export function isProjectModule(v: unknown): v is ProjectModule {
  return typeof v === "string" && (PROJECT_MODULES as readonly string[]).includes(v);
}

/** Missing stored switches count as enabled. */
export function resolveModules(stored?: Partial<Record<string, unknown>> | null): ProjectModuleState {
  const out = {} as ProjectModuleState;
  for (const module of PROJECT_MODULES) out[module] = stored?.[module] !== false;
  return out;
}

export function allModulesOn(): ProjectModuleState {
  return resolveModules(null);
}
