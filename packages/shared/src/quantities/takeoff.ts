/**
 * 2B metraj (take-off) on drawings: lengths, areas and counts measured on a PDF page or a DWG/DXF
 * sheet. Points are stored in the drawing's own units (PDF user space points, CAD drawing units);
 * a per-page scale (two-point calibration, or the CAD file's units) turns them into metres.
 */
import type { CostUnit } from "../schedule/sim.js";

export const TAKEOFF_KINDS = ["length", "area", "count"] as const;

export type TakeoffKind = (typeof TAKEOFF_KINDS)[number];

export type TakeoffPoint = [number, number];

export type TakeoffScaleMethod = "calibration" | "drawing_units";

export interface TakeoffScaleDto {
  page: number;
  /** Metres per drawing unit (PDF point or CAD unit). */
  metresPerUnit: number;
  method: TakeoffScaleMethod;
  /** Calibration line and its real length in metres. */
  points: [TakeoffPoint, TakeoffPoint] | null;
  realLength: number | null;
  updatedAt: string;
}

export interface TakeoffItemDto {
  id: string;
  versionId: string;
  page: number;
  kind: TakeoffKind;
  points: TakeoffPoint[];
  label: string;
  group: string;
  /** Area to subtract (opening): counted negative in its group. */
  deduct: boolean;
  color: string;
  costItemId: string | null;
  costItemCode: string | null;
  /** Metres, square metres or a count; null when the page has no scale. Negative for a deduction. */
  quantity: number | null;
  unit: CostUnit;
  amount: number | null;
  authorId: string;
  authorName: string;
  createdAt: string;
}

export interface TakeoffGroupDto {
  group: string;
  kind: TakeoffKind;
  unit: CostUnit;
  items: number;
  /** Items without a quantity (page not calibrated). */
  unscaled: number;
  quantity: number;
  amount: number | null;
}

export interface TakeoffDto {
  versionId: string;
  fileId: string;
  fileName: string;
  version: number;
  extension: string;
  canEdit: boolean;
  scales: TakeoffScaleDto[];
  items: TakeoffItemDto[];
  groups: TakeoffGroupDto[];
}

export function polylineLength(points: TakeoffPoint[], closed = false): number {
  let s = 0;
  for (let i = 1; i < points.length; i++) s += Math.hypot(points[i]![0] - points[i - 1]![0], points[i]![1] - points[i - 1]![1]);
  if (closed && points.length > 2) s += Math.hypot(points[0]![0] - points.at(-1)![0], points[0]![1] - points.at(-1)![1]);
  return s;
}

/** Shoelace area (absolute) of a closed polygon. */
export function polygonArea(points: TakeoffPoint[]): number {
  let s = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    s += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(s) / 2;
}
