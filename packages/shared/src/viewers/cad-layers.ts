/**
 * Layer states of a DXF drawing (frozen, off, locked) for the CAD viewer's layer panel.
 *
 * dxf-viewer drops the entities of frozen layers while building the scene and leaves the layer
 * out of its list, and it draws "off" layers (negative colour number) as if they were on. The
 * viewer instead builds every layer (see `unfreezeLayers`) and hides frozen and off layers when
 * the drawing opens, as AutoCAD does; the panel lists them with their state so they can be
 * turned on. Pure TS: used by the server's scene worker and the browser's DXF worker.
 * Tests: packages/shared/test/cad-layers.test.ts.
 */

export interface CadLayerState {
  /** Flag 1 of the LAYER record (code 70): frozen in all viewports. */
  frozen: boolean;
  /** Negative colour number (code 62): the layer is turned off. */
  off: boolean;
  /** Flag 4 of the LAYER record: locked (shown, only editing is prevented). */
  locked: boolean;
}

/** Hidden when the drawing opens: frozen or off. */
export const layerHiddenByDefault = (s: Partial<CadLayerState> | undefined): boolean => !!s && (!!s.frozen || !!s.off);

/**
 * Reads the LAYER table of a DXF text. Only the TABLES section is scanned (it comes before the
 * blocks and entities), so this costs next to nothing on large drawings. Layers without any
 * state are left out of the result.
 */
export function dxfLayerStates(text: string): Map<string, CadLayerState> {
  const out = new Map<string, CadLayerState>();
  let at = 0;
  const line = (): string | null => {
    if (at >= text.length) return null;
    let end = text.indexOf("\n", at);
    if (end < 0) end = text.length;
    const s = text.slice(at, end > at && text[end - 1] === "\r" ? end - 1 : end);
    at = end + 1;
    return s;
  };
  let inLayerTable = false;
  /** The next code 2 names a section ("0 SECTION") or a table ("0 TABLE"). */
  let naming: "section" | "table" | null = null;
  let rec: { name: string | null; flags: number; color: number } | null = null;
  const flush = () => {
    if (rec?.name != null) {
      const s = { frozen: (rec.flags & 1) !== 0, off: rec.color < 0, locked: (rec.flags & 4) !== 0 };
      if (s.frozen || s.off || s.locked) out.set(rec.name, s);
    }
    rec = null;
  };
  for (;;) {
    const code = line()?.trim() ?? null;
    if (code === null) break;
    const raw = line();
    if (raw === null) break;
    if (code === "0") {
      if (inLayerTable) flush();
      naming = raw === "SECTION" ? "section" : raw === "TABLE" ? "table" : null;
      if (raw === "LAYER" && inLayerTable) rec = { name: null, flags: 0, color: 7 };
      else if (raw === "ENDTAB" && inLayerTable) break;
      continue;
    }
    if (code === "2" && naming) {
      // The layer table, or a section after TABLES (no layer table in this drawing).
      if (naming === "table" && raw === "LAYER") inLayerTable = true;
      else if (naming === "section" && raw !== "HEADER" && raw !== "CLASSES" && raw !== "TABLES") break;
      naming = null;
      continue;
    }
    if (!rec) continue;
    if (code === "2") rec.name = raw;
    else if (code === "70") rec.flags = Number.parseInt(raw, 10) || 0;
    else if (code === "62") rec.color = Number.parseInt(raw, 10) || 0;
  }
  return out;
}

/**
 * Clears the frozen flag of every layer of a drawing parsed by dxf-viewer's DxfParser, so that
 * DxfScene builds their entities and lists them (the viewer hides them itself).
 */
export function unfreezeLayers(dxf: { tables?: { layer?: { layers?: Record<string, { frozen?: boolean }> } } }): void {
  for (const l of Object.values(dxf.tables?.layer?.layers ?? {})) l.frozen = false;
}

/** Adds the states to a built scene's layer list (dxf-viewer's `scene.layers`). */
export function withLayerStates<L extends { name: string }>(layers: L[], states: Map<string, CadLayerState>): (L & Partial<CadLayerState>)[] {
  return layers.map((l) => {
    const s = states.get(l.name);
    return s ? { ...l, ...s } : l;
  });
}
