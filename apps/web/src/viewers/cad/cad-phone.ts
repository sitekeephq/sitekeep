import { i18n } from "../../i18n";
import type { MoreMenuItem } from "../../shared/ui/MoreMenu";
import { TOOLS, toolLabel, type ToolKey } from "./measure";

export type CadMoreKey = ToolKey | "fit_all" | "snap" | "bg" | "model" | "copy" | "clear";

export interface CadMoreState {
  loaded: boolean;
  tool: ToolKey | null;
  snap: boolean;
  bg: "dark" | "light";
  modelOnly: boolean;
  /** Measurements in the list. */
  count: number;
}

/**
 * DWG/DXF viewer tools that move into "⋯ Diğer" on phones (≤ 700px); Sığdır and Katmanlar stay
 * on the bar. Measuring tools only once the drawing is loaded.
 */
export function cadMoreItems(s: CadMoreState): MoreMenuItem<CadMoreKey>[] {
  const t = i18n.t.bind(i18n);
  const items: MoreMenuItem<CadMoreKey>[] = [{ key: "fit_all", label: `⤢ ${t("viewers:cad.toolbar.actions.fitAll")}` }];
  if (s.loaded) {
    for (const tool of TOOLS) items.push({ key: tool.key, label: `${tool.icon} ${toolLabel(tool.key)}`, checked: s.tool === tool.key });
    items.push({ key: "snap", label: `⌁ ${t("viewers:cad.toolbar.actions.snap")}`, checked: s.snap });
  }
  items.push({ key: "bg", label: s.bg === "dark" ? `☀ ${t("viewers:cad.toolbar.actions.lightBackground")}` : `☾ ${t("viewers:cad.toolbar.actions.darkBackground")}` });
  items.push({ key: "model", label: `▭ ${t("viewers:cad.toolbar.actions.modelSpaceOnly")}`, checked: s.modelOnly });
  if (s.count) {
    items.push({ key: "copy", label: `⧉ ${t("viewers:cad.measure.actions.copy")}` });
    items.push({ key: "clear", label: `✕ ${t("viewers:cad.measure.actions.clearAll")}` });
  }
  return items;
}
