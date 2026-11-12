/**
 * Drawing units of a DXF ($INSUNITS in the HEADER section) and number formatting of measurements
 * in the interface language. Pure functions, no DOM (unit tests: apps/web/test/cad-units.test.ts).
 */
import { i18n } from "../../i18n";
import type en from "../../i18n/locales/en/viewers.json";
import { intlLocale } from "../../shared/lib/format";

export interface UnitInfo {
  /** $INSUNITS code. */
  code: number;
  /** Name in the interface language ("Millimetre"), read when shown. */
  readonly label: string;
  /** Short symbol ("mm"). */
  readonly short: string;
  /** Metres per drawing unit; null when the file is unitless. */
  metres: number | null;
}

const US_FT = 1200 / 3937;

type UnitName = keyof (typeof en)["cad"]["units"]["names"];

function unit(code: number, name: UnitName, short: string | null, metres: number | null): UnitInfo {
  return {
    code,
    metres,
    get label() {
      return i18n.t(`viewers:cad.units.names.${name}`);
    },
    get short() {
      return short ?? i18n.t("viewers:cad.units.unitShort");
    },
  };
}

/** AutoCAD $INSUNITS codes (0 = unitless). */
export const INSUNITS: Record<number, UnitInfo> = Object.fromEntries(
  (
    [
      [0, "unitless", null, null],
      [1, "inch", "in", 0.0254],
      [2, "foot", "ft", 0.3048],
      [3, "mile", "mi", 1609.344],
      [4, "millimetre", "mm", 0.001],
      [5, "centimetre", "cm", 0.01],
      [6, "metre", "m", 1],
      [7, "kilometre", "km", 1000],
      [8, "microinch", "µin", 2.54e-8],
      [9, "mil", "mil", 2.54e-5],
      [10, "yard", "yd", 0.9144],
      [11, "angstrom", "Å", 1e-10],
      [12, "nanometre", "nm", 1e-9],
      [13, "micron", "µm", 1e-6],
      [14, "decimetre", "dm", 0.1],
      [15, "decametre", "dam", 10],
      [16, "hectometre", "hm", 100],
      [17, "gigametre", "Gm", 1e9],
      [18, "astronomicalUnit", "AU", 1.495978707e11],
      [19, "lightYear", "ly", 9.4607304725808e15],
      [20, "parsec", "pc", 3.0856775814913673e16],
      [21, "usSurveyFoot", "ft (US)", US_FT],
      [22, "usSurveyInch", "in (US)", US_FT / 12],
      [23, "usSurveyYard", "yd (US)", US_FT * 3],
      [24, "usSurveyMile", "mi (US)", US_FT * 5280],
    ] as const
  ).map(([code, name, short, metres]) => [code, unit(code, name, short, metres)]),
);

/** Units offered as an override of the file's unit ("Çizim Birimi"). */
export const OVERRIDE_UNITS = [4, 5, 6, 1, 2] as const;

export type DisplayUnit = "mm" | "cm" | "m";
export const DISPLAY_UNITS: Record<DisplayUnit, number> = { mm: 0.001, cm: 0.01, m: 1 };

export function unitInfo(code: number | null | undefined): UnitInfo {
  return (code !== null && code !== undefined && INSUNITS[code]) || INSUNITS[0]!;
}

export interface DxfHeaderUnits {
  /** $INSUNITS, null when the header does not have it. */
  insunits: number | null;
  /** $MEASUREMENT: 0 imperial, 1 metric; null when missing. */
  measurement: number | null;
}

/**
 * Reads $INSUNITS / $MEASUREMENT from the start of an ASCII DXF (the HEADER section comes
 * first). `done` is true when the header ended, so no more text is needed.
 */
export function parseDxfHeaderUnits(text: string): DxfHeaderUnits & { done: boolean } {
  const lines = text.split(/\r?\n/);
  const out: DxfHeaderUnits & { done: boolean } = { insunits: null, measurement: null, done: false };
  for (let i = 1; i < lines.length; i++) {
    const s = lines[i]!.trim();
    if (s === "ENDSEC" && lines[i - 1]!.trim() === "0") {
      out.done = true;
      break;
    }
    if (lines[i - 1]!.trim() !== "9") continue;
    if (s !== "$INSUNITS" && s !== "$MEASUREMENT") continue;
    if (i + 2 >= lines.length) break;
    if (lines[i + 1]!.trim() !== "70") continue;
    const v = Number.parseInt(lines[i + 2]!.trim(), 10);
    if (!Number.isFinite(v)) continue;
    if (s === "$INSUNITS") out.insunits = v;
    else out.measurement = v;
  }
  return out;
}

/**
 * Streams the start of a DXF and stops at the end of the HEADER (or after `maxBytes`), so a large
 * drawing is not downloaded twice. Binary DXF and failures give null units.
 */
export async function readDxfHeaderUnits(url: string, signal?: AbortSignal, maxBytes = 2 * 1024 * 1024): Promise<DxfHeaderUnits> {
  const none: DxfHeaderUnits = { insunits: null, measurement: null };
  const res = await fetch(url, { credentials: "same-origin", signal });
  if (!res.ok || !res.body) return none;
  const reader = res.body.getReader();
  const dec = new TextDecoder("latin1");
  let text = "";
  let read = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (value) {
        read += value.byteLength;
        text += dec.decode(value, { stream: true });
        if (text.startsWith("AutoCAD Binary DXF")) return none;
        const r = parseDxfHeaderUnits(text);
        if (r.done || (r.insunits !== null && r.measurement !== null) || read >= maxBytes) return { insunits: r.insunits, measurement: r.measurement };
      }
      if (done) {
        const r = parseDxfHeaderUnits(text);
        return { insunits: r.insunits, measurement: r.measurement };
      }
    }
  } finally {
    reader.cancel().catch(() => undefined);
  }
}

const nf = new Map<string, Intl.NumberFormat>();
function num(v: number, digits: number): string {
  const locale = intlLocale();
  const key = `${locale}|${digits}`;
  let f = nf.get(key);
  if (!f) {
    f = new Intl.NumberFormat(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits });
    nf.set(key, f);
  }
  // No "-0,00".
  return f.format(Object.is(v, -0) || Math.abs(v) < 0.5 * 10 ** -digits ? 0 : v);
}

const DIGITS: Record<DisplayUnit, number> = { m: 2, cm: 1, mm: 0 };
const COORD_DIGITS: Record<DisplayUnit, number> = { m: 3, cm: 1, mm: 0 };

/** Drawing units → display unit factor. */
export function toDisplay(metresPerUnit: number, unit: DisplayUnit): number {
  return metresPerUnit / DISPLAY_UNITS[unit];
}

/** "12.34 m" / "12,34 m" */
export function formatLength(drawingLength: number, metresPerUnit: number, unit: DisplayUnit): string {
  return `${num(drawingLength * toDisplay(metresPerUnit, unit), DIGITS[unit])} ${unit}`;
}

/** "56,70 m²" */
export function formatArea(drawingArea: number, metresPerUnit: number, unit: DisplayUnit): string {
  const k = toDisplay(metresPerUnit, unit);
  return `${num(drawingArea * k * k, DIGITS[unit])} ${unit}²`;
}

/** "45,0°" */
export function formatAngle(deg: number): string {
  return `${num(deg, 1)}°`;
}

/** One coordinate in the display unit, without the unit ("423.000,125"). */
export function formatCoord(drawingValue: number, metresPerUnit: number, unit: DisplayUnit): string {
  return num(drawingValue * toDisplay(metresPerUnit, unit), COORD_DIGITS[unit]);
}
