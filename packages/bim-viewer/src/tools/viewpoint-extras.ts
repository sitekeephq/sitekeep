/**
 * Section planes / box and measurements saved with issue viewpoints and model set views.
 * Both fields are optional: older viewpoints have neither and read back as "nothing", and a
 * viewpoint without sections or measurements stays byte-for-byte the old shape.
 */
import type { ViewpointMeasurement, ViewpointSectionPlane, ViewpointSections, Vec3 } from "../core/types.js";

export interface ViewerExtras {
  sections: ViewpointSections;
  measurements: ViewpointMeasurement[];
}

export const emptyExtras = (): ViewerExtras => ({ sections: { planes: [], box: null }, measurements: [] });

const round = (n: number) => Math.round(n * 1e4) / 1e4;
const r3 = (v: Vec3): Vec3 => [round(v[0]), round(v[1]), round(v[2])];

/** Viewer state → the optional viewpoint fields (left out when empty). */
export function toViewpointExtras(extras: ViewerExtras): { sections?: ViewpointSections; measurements?: ViewpointMeasurement[] } {
  const out: { sections?: ViewpointSections; measurements?: ViewpointMeasurement[] } = {};
  const { planes, box } = extras.sections;
  if (planes.length || box) {
    out.sections = {
      planes: planes.map((p) => ({ origin: r3(p.origin), normal: r3(p.normal), ...(p.enabled === false ? { enabled: false } : {}) })),
      ...(box ? { box: { min: r3(box.min), max: r3(box.max) } } : {}),
    };
  }
  if (extras.measurements.length) {
    out.measurements = extras.measurements.map((m): ViewpointMeasurement => {
      const value = round(m.value);
      switch (m.kind) {
        case "length":
          return { kind: "length", points: [r3(m.points[0]), r3(m.points[1])], value };
        case "angle":
          return { kind: "angle", points: [r3(m.points[0]), r3(m.points[1]), r3(m.points[2])], value };
        case "area":
          return { kind: "area", points: m.points.map(r3), value };
        case "volume":
          return { kind: "volume", guids: [...m.guids], value };
      }
    });
  }
  return out;
}

const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
function vec3(x: unknown): Vec3 | null {
  return Array.isArray(x) && x.length === 3 && x.every(isNum) ? [x[0]!, x[1]!, x[2]!] : null;
}
const obj = (x: unknown): Record<string, unknown> | null => (x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : null);

function plane(x: unknown): ViewpointSectionPlane | null {
  const o = obj(x);
  const origin = vec3(o?.origin);
  const normal = vec3(o?.normal);
  if (!o || !origin || !normal) return null;
  const len = Math.hypot(...normal);
  if (len < 1e-9) return null;
  return { origin, normal: [normal[0] / len, normal[1] / len, normal[2] / len], ...(o.enabled === false ? { enabled: false } : {}) };
}

function measurement(x: unknown): ViewpointMeasurement | null {
  const o = obj(x);
  if (!o || !isNum(o.value)) return null;
  const points = Array.isArray(o.points) ? o.points.map(vec3) : [];
  if (points.some((p) => !p)) return null;
  const pts = points as Vec3[];
  switch (o.kind) {
    case "length":
      return pts.length === 2 ? { kind: "length", points: [pts[0]!, pts[1]!], value: o.value } : null;
    case "angle":
      return pts.length === 3 ? { kind: "angle", points: [pts[0]!, pts[1]!, pts[2]!], value: o.value } : null;
    case "area":
      return pts.length >= 3 ? { kind: "area", points: pts, value: o.value } : null;
    case "volume": {
      const guids = Array.isArray(o.guids) ? o.guids.filter((g): g is string => typeof g === "string" && !!g) : [];
      return guids.length ? { kind: "volume", guids, value: o.value } : null;
    }
    default:
      return null;
  }
}

/**
 * Reads sections and measurements from a viewpoint or saved view state. Tolerant: old viewpoints
 * (no fields) and broken entries give empty lists instead of errors.
 */
export function readViewpointExtras(vp: unknown): ViewerExtras {
  const o = obj(vp);
  const out = emptyExtras();
  const s = obj(o?.sections);
  if (s) {
    out.sections.planes = (Array.isArray(s.planes) ? s.planes : []).map(plane).filter((p): p is ViewpointSectionPlane => !!p);
    const b = obj(s.box);
    const min = vec3(b?.min);
    const max = vec3(b?.max);
    if (min && max) {
      out.sections.box = {
        min: [Math.min(min[0], max[0]), Math.min(min[1], max[1]), Math.min(min[2], max[2])],
        max: [Math.max(min[0], max[0]), Math.max(min[1], max[1]), Math.max(min[2], max[2])],
      };
    }
  }
  if (Array.isArray(o?.measurements)) {
    out.measurements = o.measurements.map(measurement).filter((m): m is ViewpointMeasurement => !!m);
  }
  return out;
}

/** True when the extras would change nothing (no planes, box or measurements). */
export function isEmptyExtras(e: ViewerExtras): boolean {
  return !e.sections.planes.length && !e.sections.box && !e.measurements.length;
}
