import type { IconName } from "../shared/ui/Icon";
import type { ShellKey } from "./navigation/nav";
import { webModules } from "./modules";

/** The grouped project menu; names are "shell" keys, rendered with t(). */

export type ProjectNavItem = { to: string; labelKey: ShellKey; icon: IconName; adminOnly?: boolean; systemAdmin?: boolean };
/** A core entry whose page comes from a module: shown only when that module is enabled. */
type CoreNavItem = ProjectNavItem & { module?: string };

const CORE_NAV: { titleKey: ShellKey; items: CoreNavItem[] }[] = [
  {
    titleKey: "projectNav.groups.work",
    items: [
      { to: "today", labelKey: "projectNav.items.today", icon: "calendar" },
      { to: "works", labelKey: "projectNav.items.works", icon: "inbox" },
      { to: "files", labelKey: "projectNav.items.files", icon: "folder" },
      { to: "reviews", labelKey: "projectNav.items.reviews", icon: "check" },
    ],
  },
  {
    titleKey: "projectNav.groups.model",
    items: [
      { to: "viewer", labelKey: "projectNav.items.viewer", icon: "cube" },
      { to: "coordination", labelKey: "projectNav.items.coordination", icon: "layers" },
      { to: "issues", labelKey: "projectNav.items.issues", icon: "flag" },
    ],
  },
  {
    titleKey: "projectNav.groups.planning",
    items: [
      { to: "locations", labelKey: "projectNav.items.locations", icon: "pin" },
      { to: "reports", labelKey: "projectNav.items.reports", icon: "chart" },
      { to: "spec", labelKey: "projectNav.items.spec", icon: "doc" },
    ],
  },
  {
    titleKey: "projectNav.groups.admin",
    items: [
      { to: "deleted", labelKey: "projectNav.items.deleted", icon: "trash", adminOnly: true },
      { to: "settings", labelKey: "projectNav.items.settings", icon: "settings", adminOnly: true },
      { to: "sistem-durumu", labelKey: "projectNav.items.sistemDurumu", icon: "chart", systemAdmin: true },
      { to: "forma-esitleme", labelKey: "projectNav.items.formaEsitleme", icon: "link", adminOnly: true, module: "connect" },
    ],
  },
];

type ProjectNavGroup = { titleKey: ShellKey; items: ProjectNavItem[] };
let built: { from: readonly unknown[]; nav: ProjectNavGroup[]; items: ProjectNavItem[] } | null = null;

/**
 * The project menu with the modules that are on. Module entries go after the core ones of their group;
 * "planning" ones first (İş Programı, Sözleşmeler, Metraj before Konumlar / Raporlar / Şartname). Built on
 * first use, after app/modules.ts turned the modules on, and again if the set changes.
 */
export function projectNav(): ProjectNavGroup[] {
  if (built?.from === webModules) return built.nav;
  const nav = CORE_NAV.map(({ items, ...rest }) => {
    const g = { ...rest, items: items.filter((i) => !i.module || webModules.some((m) => m.id === i.module)).map(({ module: _m, ...i }) => i) };
    const group = g.titleKey.split(".").pop();
    const extra = webModules.flatMap((m) => m.projectNav ?? []).filter((n) => n.group === group).map(({ group: _g, ...item }) => item);
    if (!extra.length) return g;
    const at = group === "planning" ? 0 : g.items.length;
    return { ...g, items: [...g.items.slice(0, at), ...extra, ...g.items.slice(at)] };
  });
  built = { from: webModules, nav, items: nav.flatMap((group) => group.items) };
  return nav;
}

export function projectNavItems(): ProjectNavItem[] {
  projectNav();
  return built!.items;
}
