/** Tiny ASCII DXF drawings for the DWG version comparison tests (FP-1). */

export interface FixtureLayer {
  name: string;
  color?: number;
  flags?: number;
  linetype?: string;
}

export interface FixtureEntity {
  type: string;
  handle?: string;
  layer?: string;
  /** Further group codes in order ([code, value]). */
  codes?: [number, string | number][];
  /** Sub-entities (VERTEX, ATTRIB, SEQEND). */
  subs?: FixtureEntity[];
}

export interface FixtureDrawing {
  layers?: FixtureLayer[];
  blocks?: { name: string; entities: FixtureEntity[] }[];
  entities: FixtureEntity[];
}

function entity(e: FixtureEntity, out: (string | number)[]) {
  out.push(0, e.type);
  if (e.handle) out.push(5, e.handle);
  out.push(330, "1F", 100, "AcDbEntity", 8, e.layer ?? "0");
  for (const [c, v] of e.codes ?? []) out.push(c, v);
  for (const s of e.subs ?? []) entity(s, out);
}

/** An R2000 ASCII DXF with a LAYER table, BLOCKS and ENTITIES. */
export function dxf(d: FixtureDrawing): string {
  const out: (string | number)[] = [0, "SECTION", 2, "HEADER", 9, "$ACADVER", 1, "AC1015", 0, "ENDSEC"];
  out.push(0, "SECTION", 2, "TABLES", 0, "TABLE", 2, "LAYER", 70, (d.layers ?? []).length);
  for (const l of d.layers ?? []) out.push(0, "LAYER", 5, `L${l.name}`, 2, l.name, 70, l.flags ?? 0, 62, l.color ?? 7, 6, l.linetype ?? "CONTINUOUS");
  out.push(0, "ENDTAB", 0, "ENDSEC");
  out.push(0, "SECTION", 2, "BLOCKS");
  for (const b of d.blocks ?? []) {
    out.push(0, "BLOCK", 5, `B${b.name}`, 8, "0", 2, b.name, 70, 0, 10, 0, 20, 0, 30, 0, 3, b.name);
    for (const e of b.entities) entity(e, out);
    out.push(0, "ENDBLK", 5, `E${b.name}`, 8, "0");
  }
  out.push(0, "ENDSEC", 0, "SECTION", 2, "ENTITIES");
  for (const e of d.entities) entity(e, out);
  out.push(0, "ENDSEC", 0, "SECTION", 2, "OBJECTS", 0, "DICTIONARY", 5, "C", 0, "ENDSEC", 0, "EOF");
  const lines: string[] = [];
  for (let i = 0; i < out.length; i += 2) lines.push(String(out[i]).padStart(3, " "), String(out[i + 1]));
  return lines.join("\r\n") + "\r\n";
}

export const line = (handle: string | undefined, layer: string, x1: number, y1: number, x2: number, y2: number, extra: [number, string | number][] = []): FixtureEntity => ({
  type: "LINE",
  handle,
  layer,
  codes: [...extra, [10, x1], [20, y1], [30, 0], [11, x2], [21, y2], [31, 0]],
});

export const text = (handle: string | undefined, layer: string, value: string, x = 0, y = 0): FixtureEntity => ({
  type: "TEXT",
  handle,
  layer,
  codes: [[10, x], [20, y], [30, 0], [40, 2.5], [1, value]],
});
