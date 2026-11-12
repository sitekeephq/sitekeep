/**
 * Measurement values in Turkish number format: "12,34 m", "1.234,50 m²", "45,00°", "0,75 m³".
 * Lengths in metres with 2 decimals, areas m², angles in degrees, volumes m³.
 */
import type { ViewpointMeasurement } from "../core/types.js";

export type MeasureKind = ViewpointMeasurement["kind"];

const formatters = new Map<number, Intl.NumberFormat>();

/** 1234.5 → "1.234,50" (tr-TR grouping and decimal comma). NaN / Infinity → "—". */
export function formatNumberTr(value: number, decimals = 2): string {
  if (!Number.isFinite(value)) return "—";
  let f = formatters.get(decimals);
  if (!f) {
    f = new Intl.NumberFormat("tr-TR", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
    formatters.set(decimals, f);
  }
  const text = f.format(value);
  // -0,00 for tiny negative values reads like an error.
  return /^-0(,0+)?$/.test(text) ? text.slice(1) : text;
}

export const UNIT_SUFFIX: Record<MeasureKind, string> = { length: " m", area: " m²", angle: "°", volume: " m³" };

export const formatLength = (m: number) => `${formatNumberTr(m)}${UNIT_SUFFIX.length}`;
export const formatArea = (m2: number) => `${formatNumberTr(m2)}${UNIT_SUFFIX.area}`;
export const formatAngle = (deg: number) => `${formatNumberTr(deg)}${UNIT_SUFFIX.angle}`;
export const formatVolume = (m3: number) => `${formatNumberTr(m3)}${UNIT_SUFFIX.volume}`;

export function formatMeasure(kind: MeasureKind, value: number): string {
  return `${formatNumberTr(value)}${UNIT_SUFFIX[kind]}`;
}

/** List labels of the measurement kinds (measurement panel, phone menu). */
export const MEASURE_KIND_LABELS: Record<MeasureKind, string> = {
  length: "Uzunluk",
  area: "Alan",
  angle: "Açı",
  volume: "Hacim",
};
