/**
 * Viewer tools in the phone "⋯ Diğer" menu (≤ 700px the tool rail is hidden). Keys start with "t:" so
 * the viewer page can tell them from its own items (viewer-phone.ts).
 */
import type { ToolCommand } from "./shortcuts.js";

export interface MoreMenuItem<K extends string = string> { key: K; label: string; checked?: boolean; }

export type ToolPanel = "sections" | "measure" | "plan" | "visibility";

export type ToolMoreKey = `t:${ToolCommand}` | "t:measure:volume" | `t:panel:${ToolPanel}`;

/** What the menu needs to know about the tools (a subset of ToolsState). */
export interface ToolMenuState {
  nav: "orbit" | "walk" | "plan";
  sectionPlacing: boolean;
  box: boolean;
  planes: unknown[];
  measureTool: string | null;
  measurements: unknown[];
  hasSelection: boolean;
  hidden: boolean;
  xray: boolean;
}

export function isToolMoreKey(key: string): key is ToolMoreKey {
  return key.startsWith("t:");
}

export function toolMoreItems(s: ToolMenuState | null): MoreMenuItem<ToolMoreKey>[] {
  if (!s) return [];
  const items: MoreMenuItem<ToolMoreKey>[] = [
    { key: "t:nav:orbit", label: "◎ Yörünge", checked: s.nav === "orbit" },
    { key: "t:nav:walk", label: "🚶 Yürüme", checked: s.nav === "walk" },
    { key: "t:nav:plan", label: "▦ Plan", checked: s.nav === "plan" },
    { key: "t:section:box", label: "▣ Kesit Kutusu", checked: s.box },
    { key: "t:section:plane", label: "✂ Kesit Düzlemi", checked: s.sectionPlacing },
  ];
  if (s.planes.length || s.box) items.push({ key: "t:panel:sections", label: `✂ Kesitler (${s.planes.length + (s.box ? 1 : 0)})` });
  items.push({ key: "t:measure:length", label: "📏 Ölçü Al", checked: s.measureTool === "length" });
  if (s.hasSelection) items.push({ key: "t:measure:volume", label: "📦 Seçimin Hacmi" });
  if (s.measurements.length) items.push({ key: "t:panel:measure", label: `📏 Ölçüler (${s.measurements.length})` });
  if (s.hasSelection) {
    items.push({ key: "t:hide", label: "◌ Gizle" });
    items.push({ key: "t:isolate", label: "◉ Yalnız Göster" });
  }
  if (s.hidden) items.push({ key: "t:show_all", label: "👁 Tümünü Göster" });
  items.push({ key: "t:xray", label: "⧉ X-Işını", checked: s.xray });
  items.push({ key: "t:screenshot", label: "📷 Görüntü Al (PNG)" });
  return items;
}
