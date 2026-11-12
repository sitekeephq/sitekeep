/**
 * Which module registers what (capabilities, report datasets): set while a module package loads
 * (app/modules.ts loads them one at a time), so registries can hide what a module that is off provides.
 * The core's own registrations have no owner and are always on.
 */
let loading: string | null = null;

export function setLoadingModule(id: string | null): void {
  loading = id;
}

/** The module being loaded right now, or null for the core. */
export function loadingModule(): string | null {
  return loading;
}
