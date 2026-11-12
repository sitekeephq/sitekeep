/**
 * Storey list for the "Plan" view: sorting, turning IFC elevations into scene heights and the
 * height of the horizontal cut (everything above it is clipped away).
 */

export interface StoreyInfo {
  name: string;
  /** IfcBuildingStorey.Elevation in IFC length units (often mm), null when the model has none. */
  elevation: number | null;
  /** Elements in the storey (server index), when known. */
  count?: number;
}

const collator = new Intl.Collator("tr-TR", { numeric: true, sensitivity: "base" });

/**
 * Bottom to top: by elevation, storeys without one at the end, ties by name ("Kat 2" before
 * "Kat 10"). The same name with the same elevation is listed once.
 */
export function sortStoreys<T extends StoreyInfo>(list: readonly T[]): T[] {
  const seen = new Set<string>();
  const unique = list.filter((s) => {
    const key = `${s.name}|${s.elevation ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return unique.sort((a, b) => {
    if (a.elevation === null || b.elevation === null) {
      if (a.elevation === b.elevation) return collator.compare(a.name, b.name);
      return a.elevation === null ? 1 : -1;
    }
    return a.elevation - b.elevation || collator.compare(a.name, b.name);
  });
}

/** How IFC elevations map to scene heights: sceneY = offsetY + elevation × scale. */
export interface StoreyFit {
  scale: number;
  offsetY: number;
}

/**
 * IFC elevations are in the project's length unit (metres or millimetres, sometimes absolute
 * heights above sea level), the scene is in metres and shifted to the origin. Picks the unit and
 * offset that put every storey inside the model's height range (with a margin): metres before
 * millimetres, the import offset before none.
 */
export function fitStoreyScale(elevations: readonly number[], frame: { offsetY: number; minY: number; maxY: number }, margin = 2): StoreyFit {
  const candidates: StoreyFit[] = [];
  for (const offsetY of [frame.offsetY, 0]) for (const scale of [1, 0.001, 0.01]) candidates.push({ scale, offsetY });
  if (!elevations.length) return candidates[0]!;
  const lo = frame.minY - margin;
  const hi = frame.maxY + margin;
  const modelSpan = Math.max(frame.maxY - frame.minY, 0.01);
  const elevSpan = Math.max(...elevations) - Math.min(...elevations);
  // A too small unit can also fit inside the model (cm read as mm squeezes every storey into the
  // bottom metre), so among the candidates that fit best, the one whose storeys span the model's
  // height best wins; candidate order breaks ties (metres, then mm, then cm).
  const spanMiss = (c: StoreyFit) => (elevations.length < 2 || elevSpan === 0 ? 0 : Math.abs(Math.log((elevSpan * c.scale) / modelSpan)));
  let best = candidates[0]!;
  let bestInside = -1;
  let bestMiss = Infinity;
  for (const c of candidates) {
    const inside = elevations.filter((e) => {
      const y = c.offsetY + e * c.scale;
      return y >= lo && y <= hi;
    }).length;
    const miss = spanMiss(c);
    if (inside > bestInside || (inside === bestInside && miss < bestMiss - 1e-9)) {
      best = c;
      bestInside = inside;
      bestMiss = miss;
    }
  }
  return best;
}

/** Scene heights of the storeys (null where the elevation is unknown). */
export function storeyLevels(storeys: readonly StoreyInfo[], fit: StoreyFit): (number | null)[] {
  return storeys.map((s) => (s.elevation === null ? null : fit.offsetY + s.elevation * fit.scale));
}

/** Plan cut height above the storey level (m), like a floor plan's cut. */
export const PLAN_CUT_HEIGHT = 1.2;

/**
 * Scene height of the plan cut of storey `index`: the cut height above its level, but below the
 * next storey's level so that storey's slab is not shown. Null without a level.
 */
export function planCutY(levels: readonly (number | null)[], index: number, cutHeight = PLAN_CUT_HEIGHT): number | null {
  const level = levels[index];
  if (level === null || level === undefined) return null;
  const next = levels.slice(index + 1).find((l): l is number => l !== null && l > level + 0.1);
  const cut = level + cutHeight;
  return next === undefined ? cut : Math.min(cut, next - 0.05);
}

/** The storey a scene height is in (the highest level at or below it, a little tolerance); 0 when below all. */
export function storeyIndexAt(levels: readonly (number | null)[], y: number, tolerance = 0.3): number {
  let found = 0;
  let foundLevel = -Infinity;
  levels.forEach((l, i) => {
    if (l !== null && l <= y + tolerance && l >= foundLevel) {
      found = i;
      foundLevel = l;
    }
  });
  return found;
}
