/** The web-ifc side of parameter changes on synthetic IFC4 and IFC2X3 models (read back with web-ifc). */
import { beforeAll, describe, expect, it } from "vitest";
import type * as WebIFC from "web-ifc";
import { applyParamChanges, type ParamWorkerItem } from "../../src/jobs/param-change-worker.js";
import { D1, ELEMENTS, W1, W2, W3, ifcApi, paramIfc, readModel } from "./param-change-fixtures.js";

let api: WebIFC.IfcAPI;

beforeAll(async () => {
  api = await ifcApi();
});

function run(schema: "IFC4" | "IFC2X3", items: Omit<ParamWorkerItem, "key">[]) {
  const before = new TextEncoder().encode(paramIfc(schema));
  const m = api.OpenModel(before);
  const outcomes = applyParamChanges(
    api,
    m,
    items.map((i, k) => ({ key: `k${k}`, ...i })),
  );
  const after = api.SaveModel(m);
  api.CloseModel(m);
  return { outcomes, before: readModel(api, before), after: readModel(api, after), text: new TextDecoder().decode(after) };
}

const item = (globalId: string, pset: string, property: string, value: ParamWorkerItem["value"], extra: Partial<ParamWorkerItem> = {}) =>
  ({ globalId, pset, property, value, valueType: "text", target: "instance", ...extra }) as Omit<ParamWorkerItem, "key">;

describe.each(["IFC4", "IFC2X3"] as const)("parameter change worker (%s)", (schema) => {
  it("changes an instance property, keeps GlobalIds, placements and geometry", () => {
    const r = run(schema, [item(W1, "Pset_WallCommon", "FireRating", "EI60")]);
    expect(r.outcomes).toEqual([{ key: "k0", status: "ok", message: "Değer güncellendi." }]);
    expect(r.after.props.get(W1)!.get("Pset_WallCommon.FireRating")).toEqual({ value: "EI60", from: "instance" });
    expect(r.after.props.get(W2)!.get("Pset_WallCommon.FireRating")!.value).toBe("EI30");
    // Same elements, same express ids, same placement and representation references.
    expect([...r.after.elements.keys()].sort()).toEqual([...ELEMENTS].sort());
    expect(r.after.elements).toEqual(r.before.elements);
    expect(r.text).toContain(`FILE_SCHEMA(('${schema}'))`);
  });

  it("adds a missing property to an existing set and a missing set to an element", () => {
    const r = run(schema, [
      item(W1, "Pset_WallCommon", "Combustible", false, { valueType: "boolean" }),
      item(D1, "Pset_DoorCommon", "FireRating", "EI30"),
      item(D1, "Pset_DoorCommon", "SelfClosing", "evet", { valueType: "boolean" }),
    ]);
    expect(r.outcomes.map((o) => o.status)).toEqual(["ok", "ok", "ok"]);
    expect(r.outcomes[0]!.message).toBe("Özellik eklendi.");
    expect(r.outcomes[1]!.message).toBe("Özellik seti ve özellik eklendi.");
    expect(r.after.props.get(W1)!.get("Pset_WallCommon.Combustible")!.value).toBe(false);
    expect(r.after.props.get(W1)!.get("Pset_WallCommon.FireRating")!.value).toBe("EI30");
    expect(r.after.props.get(D1)!.get("Pset_DoorCommon.FireRating")).toEqual({ value: "EI30", from: "instance" });
    expect(r.after.props.get(D1)!.get("Pset_DoorCommon.SelfClosing")!.value).toBe(true);
    // One new set + relation for the door (both properties in it).
    expect(r.text.match(/IFCPROPERTYSET\([^;]*'Pset_DoorCommon'/g)).toHaveLength(1);
    expect(r.after.elements).toEqual(r.before.elements);
  });

  it("copies a shared set before changing one of its elements", () => {
    const r = run(schema, [item(W2, "Pset_WallCommon", "FireRating", "EI90")]);
    expect(r.outcomes[0]).toMatchObject({ status: "ok" });
    expect(r.outcomes[0]!.message).toContain("Paylaşılan özellik seti");
    expect(r.after.props.get(W2)!.get("Pset_WallCommon.FireRating")!.value).toBe("EI90");
    expect(r.after.props.get(W3)!.get("Pset_WallCommon.FireRating")!.value).toBe("EI30");
    // Both elements of the shared set changed alike: edited in place, no copy.
    const both = run(schema, [item(W2, "Pset_WallCommon", "FireRating", "EI120"), item(W3, "pset_wallcommon", "firerating", "EI120")]);
    expect(both.outcomes.every((o) => o.status === "ok" && !o.message.includes("Paylaşılan"))).toBe(true);
    expect(both.after.props.get(W3)!.get("Pset_WallCommon.FireRating")!.value).toBe("EI120");
    expect(r.text.match(/IFCPROPERTYSET\(/g)).toHaveLength(5);
    expect(both.text.match(/IFCPROPERTYSET\(/g)).toHaveLength(4);
  });

  it("overrides a type value on the element (default) or changes the type", () => {
    const inst = run(schema, [item(W1, "Pset_WallCommon", "AcousticRating", "R50")]);
    expect(inst.outcomes[0]!.message).toBe("Tip değeri elemanda geçersiz kılındı.");
    expect(inst.after.props.get(W1)!.get("Pset_WallCommon.AcousticRating")).toEqual({ value: "R50", from: "instance" });
    expect(inst.after.props.get(W2)!.get("Pset_WallCommon.AcousticRating")).toEqual({ value: "R40", from: "type" });
    expect(inst.after.typeProps.get("0PcType000000000000001")!.get("Pset_WallCommon.AcousticRating")).toBe("R40");

    const type = run(schema, [item(W1, "Pset_WallCommon", "AcousticRating", "R55", { target: "type" })]);
    expect(type.outcomes[0]!.message).toBe("Tipte değiştirildi (3 eleman etkilenir).");
    for (const w of [W1, W2, W3]) expect(type.after.props.get(w)!.get("Pset_WallCommon.AcousticRating")).toEqual({ value: "R55", from: "type" });
    expect(type.after.elements).toEqual(type.before.elements);
  });

  it("refuses quantities, wrong value types and unknown elements per item", () => {
    const r = run(schema, [
      item(W1, "Qto_WallBaseQuantities", "NetSideArea", 20, { valueType: "number" }),
      item(W1, "Pset_WallCommon", "IsExternal", "belki"),
      item("0PcNone000000000000001", "Pset_WallCommon", "FireRating", "EI60"),
      item(W1, "Pset_WallCommon", "FireRating", "EI60"),
    ]);
    expect(r.outcomes.map((o) => o.status)).toEqual(["failed", "failed", "failed", "ok"]);
    expect(r.outcomes[0]!.message).toContain("Miktarlar");
    expect(r.outcomes[1]!.message).toContain("evet/hayır");
    expect(r.outcomes[2]!.message).toContain("bulunamadı");
    expect(r.after.props.get(W1)!.get("Pset_WallCommon.IsExternal")!.value).toBe(true);
  });
});
