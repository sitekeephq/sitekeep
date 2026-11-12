/**
 * Web module contract (docs/modules/README.md). A module (ee/<id>, later its own package) adds
 * project pages, menu entries and capabilities through one object; the core never imports a
 * module directly except in app/modules.ts.
 */
import type { ReactNode } from "react";
import type { IconName } from "../shared/ui/Icon";
import type { ShellKey } from "../app/navigation/nav";
import { provideWebCapability, type WebCapabilities } from "./capabilities";

export interface WebModule {
  id: string;
  /** Pages under /projects/:pid/ (React Router paths relative to the project). */
  projectRoutes?: { path: string; element: ReactNode }[];
  /** Project menu entries, appended to the named group. */
  projectNav?: { group: "work" | "model" | "planning" | "admin"; to: string; labelKey: ShellKey; icon: IconName; adminOnly?: boolean }[];
  capabilities?: Partial<WebCapabilities>;
}

/** A module describes itself; nothing is registered until the app turns it on (activateWebModule). */
export function defineWebModule(m: WebModule): WebModule {
  return m;
}

/** Turns a module on: its capabilities become available (app/modules.ts, for the modules the server runs). */
export function activateWebModule(m: WebModule): void {
  for (const [key, impl] of Object.entries(m.capabilities ?? {}) as [keyof WebCapabilities, never][]) provideWebCapability(key, impl);
}
