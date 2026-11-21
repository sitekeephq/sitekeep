/**
 * Colours for elements that web-ifc leaves unstyled (apps/server/src/jobs/ifc-worker.ts). Pure:
 * reads the IFC through a small line reader, so it is unit-tested here and runs in the worker.
 *
 * web-ifc colours an element from an IfcStyledItem on its geometry, or from the material linked
 * to the element itself (single material, layer set, constituent set). Anything else comes back
 * white, which the viewer shows as flat grey. Revit models converted by rvt-rs are mostly like
 * that (#168): their colours live on materials of family types, not on the geometry. For an
 * element with no colour of its own:
 *   1. the colour of its material, or of its type's material (IfcRelDefinesByType), through layer,
 *      constituent and profile sets and material lists;
 *   2. failing that, a colour for its IFC class (walls, slabs, glazing, furniture...).
 */

/** RGBA, 0..1. */
export type Rgba = [number, number, number, number];

/** What the resolver needs from an opened IFC model. */
export interface IfcLineReader {
  /** Express ids of all lines of an entity, by upper-case IFC name ("IFCRELASSOCIATESMATERIAL"). */
  idsOfType(name: string): number[];
  /** The line (web-ifc GetLine, not flattened): references are `{ value: id }`. */
  line(id: number): Record<string, unknown> | null;
  /** Upper-case IFC entity name of a line ("IFCWALL"). */
  typeName(id: number): string;
}

/** Colour per IFC class (and its standard case / type), for elements without any colour. */
const CLASS_COLOURS: [string[], Rgba][] = [
  [["IFCWALL", "IFCWALLSTANDARDCASE", "IFCWALLELEMENTEDCASE"], [0.86, 0.84, 0.8, 1]],
  [["IFCSLAB", "IFCSLABSTANDARDCASE", "IFCSLABELEMENTEDCASE"], [0.74, 0.74, 0.72, 1]],
  [["IFCROOF"], [0.62, 0.36, 0.3, 1]],
  [["IFCCOVERING"], [0.9, 0.88, 0.83, 1]],
  [["IFCCOLUMN", "IFCCOLUMNSTANDARDCASE", "IFCBEAM", "IFCBEAMSTANDARDCASE", "IFCMEMBER", "IFCMEMBERSTANDARDCASE"], [0.68, 0.69, 0.71, 1]],
  [["IFCFOOTING", "IFCPILE"], [0.64, 0.64, 0.62, 1]],
  [["IFCSTAIR", "IFCSTAIRFLIGHT", "IFCRAMP", "IFCRAMPFLIGHT"], [0.76, 0.73, 0.67, 1]],
  [["IFCRAILING"], [0.42, 0.43, 0.45, 1]],
  [["IFCWINDOW", "IFCWINDOWSTANDARDCASE", "IFCCURTAINWALL", "IFCPLATE", "IFCPLATESTANDARDCASE"], [0.6, 0.77, 0.88, 0.45]],
  [["IFCDOOR", "IFCDOORSTANDARDCASE"], [0.6, 0.46, 0.32, 1]],
  [["IFCFURNISHINGELEMENT", "IFCFURNITURE", "IFCSYSTEMFURNITUREELEMENT"], [0.73, 0.57, 0.4, 1]],
  [
    [
      "IFCFLOWSEGMENT",
      "IFCFLOWFITTING",
      "IFCFLOWTERMINAL",
      "IFCPIPESEGMENT",
      "IFCPIPEFITTING",
      "IFCDUCTSEGMENT",
      "IFCDUCTFITTING",
      "IFCAIRTERMINAL",
      "IFCCABLECARRIERSEGMENT",
      "IFCCABLECARRIERFITTING",
      "IFCCABLESEGMENT",
    ],
    [0.36, 0.56, 0.76, 1],
  ],
  [["IFCTRANSPORTELEMENT"], [0.55, 0.57, 0.6, 1]],
  [["IFCGEOGRAPHICELEMENT"], [0.55, 0.68, 0.45, 1]],
  [["IFCBUILDINGELEMENTPROXY"], [0.8, 0.78, 0.74, 1]],
];

const CLASS_COLOUR = new Map(CLASS_COLOURS.flatMap(([names, colour]) => names.map((n) => [n, colour] as const)));

export function classColour(ifcClass: string): Rgba | null {
  return CLASS_COLOUR.get(ifcClass.toUpperCase()) ?? null;
}

/** web-ifc's colour for geometry it found no style for. */
export function isUnstyledColour(c: { x: number; y: number; z: number; w: number }): boolean {
  return c.x === 1 && c.y === 1 && c.z === 1 && c.w === 1;
}

const ref = (v: unknown): number | null => {
  if (v && typeof v === "object" && "value" in v && typeof (v as { value: unknown }).value === "number") return (v as { value: number }).value;
  return typeof v === "number" ? v : null;
};
const refs = (v: unknown): number[] => (Array.isArray(v) ? v.map(ref).filter((x): x is number => x !== null) : []);
/** A number, or web-ifc's measure object (`{ value }`, or `{ _representationValue }` for reals). */
const num = (v: unknown): number | null => {
  let x = v;
  if (v && typeof v === "object") {
    const o = v as { value?: unknown; _representationValue?: unknown };
    x = typeof o.value === "number" ? o.value : o._representationValue;
  }
  return typeof x === "number" && Number.isFinite(x) ? x : null;
};

/**
 * Builds the resolver for one model: `colourOf(elementId)` gives the material colour, else the
 * class colour, else null. Maps are built once; lookups are cached.
 */
export function elementColours(reader: IfcLineReader): { colourOf(elementId: number): Rgba | null; materialColourOf(elementId: number): Rgba | null } {
  // element or type → material select
  const materialOf = new Map<number, number>();
  for (const rel of reader.idsOfType("IFCRELASSOCIATESMATERIAL")) {
    const line = reader.line(rel);
    const material = ref(line?.RelatingMaterial);
    if (material === null) continue;
    for (const o of refs(line?.RelatedObjects)) if (!materialOf.has(o)) materialOf.set(o, material);
  }
  const typeOf = new Map<number, number>();
  for (const rel of reader.idsOfType("IFCRELDEFINESBYTYPE")) {
    const line = reader.line(rel);
    const type = ref(line?.RelatingType);
    if (type === null) continue;
    for (const o of refs(line?.RelatedObjects)) typeOf.set(o, type);
  }
  // IfcMaterial → its styled representations
  const representationsOf = new Map<number, number[]>();
  for (const id of reader.idsOfType("IFCMATERIALDEFINITIONREPRESENTATION")) {
    const line = reader.line(id);
    const material = ref(line?.RepresentedMaterial);
    if (material === null) continue;
    representationsOf.set(material, [...(representationsOf.get(material) ?? []), ...refs(line?.Representations)]);
  }

  const styleCache = new Map<number, Rgba | null>();
  function styleColour(id: number, depth = 0): Rgba | null {
    if (styleCache.has(id)) return styleCache.get(id)!;
    styleCache.set(id, null);
    let out: Rgba | null = null;
    const line = reader.line(id);
    const name = line ? reader.typeName(id) : "";
    if (depth > 6 || !line) out = null;
    else if (name === "IFCSURFACESTYLE" || name === "IFCPRESENTATIONSTYLEASSIGNMENT" || name === "IFCSTYLEDITEM") {
      for (const s of refs(line.Styles)) if ((out = styleColour(s, depth + 1))) break;
    } else if (name === "IFCSURFACESTYLESHADING" || name === "IFCSURFACESTYLERENDERING") {
      const colour = reader.line(ref(line.SurfaceColour) ?? -1);
      const r = num(colour?.Red);
      const g = num(colour?.Green);
      const b = num(colour?.Blue);
      const t = num(line.Transparency) ?? 0;
      if (r !== null && g !== null && b !== null) out = [r, g, b, Math.min(1, Math.max(0.1, 1 - t))];
    }
    styleCache.set(id, out);
    return out;
  }

  const materialCache = new Map<number, Rgba | null>();
  function materialColour(id: number, depth = 0): Rgba | null {
    if (materialCache.has(id)) return materialCache.get(id)!;
    materialCache.set(id, null);
    let out: Rgba | null = null;
    const line = reader.line(id);
    if (line && depth <= 6) {
      const name = reader.typeName(id);
      let next: number[] = [];
      if (name === "IFCMATERIAL") {
        for (const rep of representationsOf.get(id) ?? []) {
          for (const item of refs(reader.line(rep)?.Items)) if ((out = styleColour(item))) break;
          if (out) break;
        }
      } else if (name === "IFCMATERIALLAYERSETUSAGE") next = [ref(line.ForLayerSet) ?? -1];
      else if (name === "IFCMATERIALLAYERSET") next = refs(line.MaterialLayers);
      else if (name === "IFCMATERIALPROFILESETUSAGE" || name === "IFCMATERIALPROFILESETUSAGETAPERING") next = [ref(line.ForProfileSet) ?? -1];
      else if (name === "IFCMATERIALPROFILESET") next = refs(line.MaterialProfiles);
      else if (name === "IFCMATERIALCONSTITUENTSET") next = refs(line.MaterialConstituents);
      else if (name === "IFCMATERIALLAYER" || name === "IFCMATERIALPROFILE" || name === "IFCMATERIALCONSTITUENT") next = [ref(line.Material) ?? -1];
      else if (name === "IFCMATERIALLIST") next = refs(line.Materials);
      for (const n of next) if (n >= 0 && (out = materialColour(n, depth + 1))) break;
    }
    materialCache.set(id, out);
    return out;
  }

  function materialColourOf(elementId: number): Rgba | null {
    const own = materialOf.get(elementId);
    const fromOwn = own === undefined ? null : materialColour(own);
    if (fromOwn) return fromOwn;
    const type = typeOf.get(elementId);
    const typeMaterial = type === undefined ? undefined : materialOf.get(type);
    return typeMaterial === undefined ? null : materialColour(typeMaterial);
  }

  return {
    materialColourOf,
    colourOf(elementId) {
      return materialColourOf(elementId) ?? (reader.line(elementId) ? classColour(reader.typeName(elementId)) : null);
    },
  };
}
