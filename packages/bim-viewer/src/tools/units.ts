/**
 * Measurement values in the viewer language's number format: "12,34 m" (tr) / "12.34 m" (en), "45,00°", "0,75 m³".
 * Lengths in metres with 2 decimals, areas m², angles in degrees, volumes m³.
 */
import type { ViewpointMeasurement } from "../core/types.js";
import { viewerLanguage, vt } from "../i18n.js";

export type MeasureKind = ViewpointMeasurement["kind"];

const formatters = new Map<string, Intl.NumberFormat>();

/**
 * Number in the viewer language: 1234.5 → "1.234,50" in Turkish, "1,234.50" in English
 * (setViewerLanguage). NaN / Infinity → "—". The name stays for hosts before 0.6.0.
 */
export function formatNumberTr(value: number, decimals = 2): string {
  if (!Number.isFinite(value)) return "—";
  const locale = viewerLanguage() === "tr" ? "tr-TR" : "en-GB";
  let f = formatters.get(`${locale}:${decimals}`);
  if (!f) {
    f = new Intl.NumberFormat(locale, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
    formatters.set(`${locale}:${decimals}`, f);
  }
  const text = f.format(value);
  // -0,00 for tiny negative values reads like an error.
  return /^-0([.,]0+)?$/.test(text) ? text.slice(1) : text;
}

export const UNIT_SUFFIX: Record<MeasureKind, string> = { length: " m", area: " m²", angle: "°", volume: " m³" };

export const formatLength = (m: number) => `${formatNumberTr(m)}${UNIT_SUFFIX.length}`;
export const formatArea = (m2: number) => `${formatNumberTr(m2)}${UNIT_SUFFIX.area}`;
export const formatAngle = (deg: number) => `${formatNumberTr(deg)}${UNIT_SUFFIX.angle}`;
export const formatVolume = (m3: number) => `${formatNumberTr(m3)}${UNIT_SUFFIX.volume}`;

export function formatMeasure(kind: MeasureKind, value: number): string {
  return `${formatNumberTr(value)}${UNIT_SUFFIX[kind]}`;
}

/** Label of a measurement kind in the viewer language (measurement panel, phone menu). */
export function measureKindLabel(kind: MeasureKind): string {
  return vt(`measure.${kind}`);
}

/** @deprecated Turkish labels kept for hosts before 0.6.0; use measureKindLabel(). */
export const MEASURE_KIND_LABELS: Record<MeasureKind, string> = {
  length: "Uzunluk",
  area: "Alan",
  angle: "Açı",
  volume: "Hacim",
};
