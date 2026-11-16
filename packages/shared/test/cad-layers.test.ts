import { describe, expect, it } from "vitest";
import { dxfLayerStates, layerHiddenByDefault, unfreezeLayers, withLayerStates } from "../src/index.js";

const dxf = (...pairs: (string | number)[]) => pairs.map(String).join("\n");

describe("CAD layer states", () => {
  it("reads frozen, off and locked layers from the LAYER table", () => {
    const text = dxf(
      0, "SECTION", 2, "HEADER", 9, "$CLAYER", 8, "A-DUVAR", 0, "ENDSEC",
      0, "SECTION", 2, "TABLES",
      // A linetype named like a table or a section is no table or section.
      0, "TABLE", 2, "LTYPE", 0, "LTYPE", 2, "ENTITIES", 70, 1, 0, "ENDTAB",
      0, "TABLE", 2, "LAYER", 70, 4,
      0, "LAYER", 2, "A-DUVAR", 70, 0, 62, 1,
      0, "LAYER", 2, "A-DONMUS", 70, 1, 62, 3,
      0, "LAYER", 2, "A-KAPALI KILITLI", 70, 4, 62, -2,
      0, "LAYER", 2, "A-HEPSI", 70, 5, 62, -7,
      0, "ENDTAB",
      0, "TABLE", 2, "STYLE", 0, "STYLE", 2, "X", 70, 1, 0, "ENDTAB",
      0, "ENDSEC", 0, "SECTION", 2, "ENTITIES", 0, "ENDSEC", 0, "EOF",
    );
    expect(Object.fromEntries(dxfLayerStates(text))).toEqual({
      "A-DONMUS": { frozen: true, off: false, locked: false },
      "A-KAPALI KILITLI": { frozen: false, off: true, locked: true },
      "A-HEPSI": { frozen: true, off: true, locked: true },
    });
    // CRLF line ends.
    expect(dxfLayerStates(text.replace(/\n/g, "\r\n")).get("A-DONMUS")).toEqual({ frozen: true, off: false, locked: false });
  });

  it("returns nothing without a layer table", () => {
    expect(dxfLayerStates(dxf(0, "SECTION", 2, "ENTITIES", 0, "LAYER", 2, "X", 70, 1, 0, "ENDSEC", 0, "EOF")).size).toBe(0);
    expect(dxfLayerStates("").size).toBe(0);
  });

  it("unfreezes parsed layers and adds the states to the scene's layer list", () => {
    const parsed = { tables: { layer: { layers: { A: { frozen: true }, B: { frozen: false } } } } };
    unfreezeLayers(parsed);
    expect(parsed.tables.layer.layers.A.frozen).toBe(false);
    unfreezeLayers({});
    const states = new Map([["A", { frozen: true, off: false, locked: false }]]);
    expect(withLayerStates([{ name: "A", color: 1 }, { name: "B", color: 2 }], states)).toEqual([
      { name: "A", color: 1, frozen: true, off: false, locked: false },
      { name: "B", color: 2 },
    ]);
    expect(layerHiddenByDefault(states.get("A"))).toBe(true);
    expect(layerHiddenByDefault({ off: true })).toBe(true);
    expect(layerHiddenByDefault({ locked: true })).toBe(false);
    expect(layerHiddenByDefault(undefined)).toBe(false);
  });
});
