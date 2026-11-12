/**
 * Measuring tools of the DWG/DXF viewer: what each tool needs, its result text and
 * the clipboard text of the list. Points are true drawing coordinates (the viewer's origin
 * shift added back). Pure TS (tests: apps/web/test/viewers/cad-measure.test.ts).
 */
import { i18n } from "../../i18n";
import { angleDeg, dist, polygonArea, polylineLength, type Pt } from "./geometry";
import type en from "../../i18n/locales/en/viewers.json";
import { formatAngle, formatArea, formatCoord, formatLength, type DisplayUnit } from "./units";

type HINTS = (typeof en)["cad"]["hints"];

export type ToolKey = "length" | "chain" | "area" | "angle" | "coord" | "info";
export type MeasureTool = Exclude<ToolKey, "info">;

/** Tools of the toolbar; names come from toolLabel() (the interface language at render). */
export const TOOLS: { key: ToolKey; icon: string }[] = [
  { key: "length", icon: "📏" },
  { key: "chain", icon: "〰" },
  { key: "area", icon: "▱" },
  { key: "angle", icon: "∠" },
  { key: "coord", icon: "⌖" },
  { key: "info", icon: "ⓘ" },
];

/** Title Case name of a tool ("Chain Length"). */
export function toolLabel(tool: ToolKey): string {
  return i18n.t(`viewers:cad.tools.${tool}`);
}

export interface Measurement {
  id: number;
  tool: MeasureTool;
  pts: Pt[];
}

/** Points that complete the tool on their own; null: open-ended (double click / Enter ends). */
export function pointsNeeded(tool: ToolKey): number | null {
  return tool === "length" ? 2 : tool === "angle" ? 3 : tool === "coord" || tool === "info" ? 1 : null;
}

/** Fewest points of a finished measurement. */
export function minPoints(tool: ToolKey): number {
  return tool === "area" ? 3 : tool === "chain" ? 2 : (pointsNeeded(tool) ?? 1);
}

/** The instruction for the next click (sentence case, shown under the toolbar). */
export function hintText(tool: ToolKey, n: number): string {
  const h = (key: keyof HINTS) => i18n.t(`viewers:cad.hints.${key}`);
  switch (tool) {
    case "length":
      return n === 0 ? h("lengthFirst") : h("lengthSecond");
    case "chain":
      return n === 0 ? h("chainStart") : n === 1 ? h("chainNext") : h("chainNextOrFinish");
    case "area":
      return n < 3 ? h("areaCorners") : h("areaNextOrClose");
    case "angle":
      return n === 0 ? h("angleFirstArm") : n === 1 ? h("angleVertex") : h("angleSecondArm");
    case "coord":
      return h("coord");
    case "info":
      return h("info");
  }
}

export interface UnitFmt {
  /** Metres per drawing unit. */
  metres: number;
  unit: DisplayUnit;
}

export interface Described {
  value: string;
  detail?: string;
}

/** Result text of a (possibly unfinished) measurement. */
export function describe(tool: MeasureTool, pts: Pt[], f: UnitFmt): Described {
  const L = (v: number) => formatLength(v, f.metres, f.unit);
  switch (tool) {
    case "length": {
      if (pts.length < 2) return { value: "—" };
      const [a, b] = [pts[0]!, pts[1]!];
      return { value: L(dist(a, b)), detail: `ΔX ${L(b.x - a.x)} · ΔY ${L(b.y - a.y)}` };
    }
    case "chain":
      return { value: L(polylineLength(pts)), detail: i18n.t("viewers:cad.measure.segments", { count: Math.max(0, pts.length - 1) }) };
    case "area":
      return { value: formatArea(polygonArea(pts), f.metres, f.unit), detail: i18n.t("viewers:cad.measure.perimeter", { length: L(polylineLength(pts, true)) }) };
    case "angle":
      return { value: pts.length < 3 ? "—" : formatAngle(angleDeg(pts[0]!, pts[1]!, pts[2]!)) };
    case "coord": {
      const p = pts[0];
      if (!p) return { value: "—" };
      return { value: `X ${formatCoord(p.x, f.metres, f.unit)} · Y ${formatCoord(p.y, f.metres, f.unit)} (${f.unit})` };
    }
  }
}

/** Plain text of the list for "Copy to Clipboard". */
export function clipboardText(items: Measurement[], f: UnitFmt, heading: string): string {
  const lines = [heading];
  items.forEach((m, i) => {
    const d = describe(m.tool, m.pts, f);
    lines.push(`${i + 1}. ${toolLabel(m.tool)}: ${d.value}${d.detail ? ` (${d.detail})` : ""}`);
  });
  return lines.join("\n");
}
