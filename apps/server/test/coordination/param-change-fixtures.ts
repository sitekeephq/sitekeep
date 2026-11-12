/**
 * Small synthetic IFC models for the parameter change tests (IFC4 and IFC2X3). Never a client model.
 *
 *   Zemin Kat: W1 (own Pset_WallCommon: FireRating EI30, IsExternal true; CDE_Bilgi."Kontrol Durumu";
 *              Qto_WallBaseQuantities.NetSideArea), D1 (no property sets at all)
 *   Kat 1:     W2 and W3 share one Pset_WallCommon (FireRating EI30) through one relation
 *   Type "Duvar 20" (W1, W2, W3): Pset_WallCommon.AcousticRating R40 (type-level value)
 */
import * as WebIFC from "web-ifc";
import { wasmDir } from "../../src/jobs/queue.js";

export const W1 = "0PcWall000000000000001";
export const W2 = "0PcWall000000000000002";
export const W3 = "0PcWall000000000000003";
export const D1 = "0PcDoor000000000000001";
export const ELEMENTS = [W1, W2, W3, D1];

export function paramIfc(schema: "IFC4" | "IFC2X3" = "IFC4"): string {
  const four = schema === "IFC4";
  const wall = (id: number, guid: string, name: string, place: number) =>
    four ? `#${id}=IFCWALL('${guid}',#5,'${name}',$,$,#${place},#66,$,.STANDARD.);` : `#${id}=IFCWALL('${guid}',#5,'${name}',$,$,#${place},#66,$);`;
  const door = (id: number, guid: string, place: number) =>
    four ? `#${id}=IFCDOOR('${guid}',#5,'Kapi-01',$,$,#${place},#66,$,2.1,0.9,.DOOR.,$,$);` : `#${id}=IFCDOOR('${guid}',#5,'Kapi-01',$,$,#${place},#66,$,2.1,0.9);`;
  const area = (name: string, v: string) => (four ? `IFCQUANTITYAREA('${name}',$,$,${v},$)` : `IFCQUANTITYAREA('${name}',$,$,${v})`);
  return [
    "ISO-10303-21;",
    "HEADER;",
    "FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');",
    `FILE_NAME('param.ifc','2026-10-11T10:00:00',('7Dimensions'),('7Dimensions'),'','7d-cde test fixture','');`,
    `FILE_SCHEMA(('${schema}'));`,
    "ENDSEC;",
    "DATA;",
    "#1=IFCPERSON($,'Test',$,$,$,$,$,$);",
    "#2=IFCORGANIZATION($,'7Dimensions',$,$,$);",
    "#3=IFCPERSONANDORGANIZATION(#1,#2,$);",
    "#4=IFCAPPLICATION(#2,'0.1','7d-cde fixture','7DCDE');",
    "#5=IFCOWNERHISTORY(#3,#4,$,.ADDED.,$,$,$,1760000000);",
    "#10=IFCCARTESIANPOINT((0.,0.,0.));",
    "#11=IFCDIRECTION((0.,0.,1.));",
    "#12=IFCDIRECTION((1.,0.,0.));",
    "#13=IFCAXIS2PLACEMENT3D(#10,#11,#12);",
    "#14=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#13,$);",
    "#15=IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,#14,$,.MODEL_VIEW.,$);",
    "#20=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);",
    "#21=IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.);",
    "#24=IFCUNITASSIGNMENT((#20,#21));",
    "#30=IFCPROJECT('0PcProj000000000000001',#5,'Parametre Projesi',$,$,$,$,(#14),#24);",
    "#40=IFCLOCALPLACEMENT($,#13);",
    "#41=IFCSITE('0PcSite000000000000001',#5,'Saha',$,$,#40,$,$,.ELEMENT.,$,$,$,$,$);",
    "#42=IFCLOCALPLACEMENT(#40,#13);",
    "#43=IFCBUILDING('0PcBina000000000000001',#5,'Bina',$,$,#42,$,$,.ELEMENT.,$,$,$);",
    "#44=IFCLOCALPLACEMENT(#42,#13);",
    "#45=IFCBUILDINGSTOREY('0PcKat0000000000000000',#5,'Zemin Kat',$,$,#44,$,$,.ELEMENT.,0.);",
    "#46=IFCCARTESIANPOINT((0.,0.,3.5));",
    "#47=IFCAXIS2PLACEMENT3D(#46,#11,#12);",
    "#48=IFCLOCALPLACEMENT(#42,#47);",
    "#49=IFCBUILDINGSTOREY('0PcKat0000000000000001',#5,'Kat 1',$,$,#48,$,$,.ELEMENT.,3.5);",
    "#50=IFCRELAGGREGATES('0PcAgg0000000000000001',#5,$,$,#30,(#41));",
    "#51=IFCRELAGGREGATES('0PcAgg0000000000000002',#5,$,$,#41,(#43));",
    "#52=IFCRELAGGREGATES('0PcAgg0000000000000003',#5,$,$,#43,(#45,#49));",
    "#60=IFCCARTESIANPOINT((0.,0.));",
    "#61=IFCDIRECTION((1.,0.));",
    "#62=IFCAXIS2PLACEMENT2D(#60,#61);",
    "#63=IFCRECTANGLEPROFILEDEF(.AREA.,'Kutu',#62,1.,0.2);",
    "#64=IFCEXTRUDEDAREASOLID(#63,#13,#11,2.);",
    "#65=IFCSHAPEREPRESENTATION(#15,'Body','SweptSolid',(#64));",
    "#66=IFCPRODUCTDEFINITIONSHAPE($,$,(#65));",
    "#100=IFCLOCALPLACEMENT(#44,#13);",
    wall(101, W1, "Duvar-01", 100),
    "#110=IFCLOCALPLACEMENT(#48,#13);",
    wall(111, W2, "Duvar-02", 110),
    "#120=IFCLOCALPLACEMENT(#48,#13);",
    wall(121, W3, "Duvar-03", 120),
    "#130=IFCLOCALPLACEMENT(#44,#13);",
    door(131, D1, 130),
    // W1: own set.
    "#200=IFCPROPERTYSINGLEVALUE('FireRating',$,IFCLABEL('EI30'),$);",
    "#201=IFCPROPERTYSINGLEVALUE('IsExternal',$,IFCBOOLEAN(.T.),$);",
    "#202=IFCPROPERTYSET('0PcPset000000000000W01',#5,'Pset_WallCommon',$,(#200,#201));",
    "#203=IFCRELDEFINESBYPROPERTIES('0PcRel0000000000000W01',#5,$,$,(#101),#202);",
    "#204=IFCPROPERTYSINGLEVALUE('Kontrol Durumu',$,IFCLABEL('A\\X2\\00E70131\\X0\\k'),$);",
    "#205=IFCPROPERTYSET('0PcPset000000000000C01',#5,'CDE_Bilgi',$,(#204));",
    "#206=IFCRELDEFINESBYPROPERTIES('0PcRel0000000000000C01',#5,$,$,(#101),#205);",
    `#207=${area("NetSideArea", "15.")};`,
    "#208=IFCELEMENTQUANTITY('0PcQto0000000000000W01',#5,'Qto_WallBaseQuantities',$,$,(#207));",
    "#209=IFCRELDEFINESBYPROPERTIES('0PcRel0000000000000Q01',#5,$,$,(#101),#208);",
    // W2 + W3: one shared set.
    "#210=IFCPROPERTYSINGLEVALUE('FireRating',$,IFCLABEL('EI30'),$);",
    "#211=IFCPROPERTYSET('0PcPset000000000000W02',#5,'Pset_WallCommon',$,(#210));",
    "#212=IFCRELDEFINESBYPROPERTIES('0PcRel0000000000000W02',#5,$,$,(#111,#121),#211);",
    // Type-level value.
    "#300=IFCPROPERTYSINGLEVALUE('AcousticRating',$,IFCLABEL('R40'),$);",
    "#301=IFCPROPERTYSET('0PcPset000000000000T01',#5,'Pset_WallCommon',$,(#300));",
    "#302=IFCWALLTYPE('0PcType000000000000001',#5,'Duvar 20',$,$,(#301),$,$,$,.STANDARD.);",
    "#303=IFCRELDEFINESBYTYPE('0PcRel0000000000000T01',#5,$,$,(#101,#111,#121),#302);",
    "#900=IFCRELCONTAINEDINSPATIALSTRUCTURE('0PcRel0000000000000S01',#5,$,$,(#101,#131),#45);",
    "#901=IFCRELCONTAINEDINSPATIALSTRUCTURE('0PcRel0000000000000S02',#5,$,$,(#111,#121),#49);",
    "ENDSEC;",
    "END-ISO-10303-21;",
    "",
  ].join("\n");
}

export async function ifcApi(): Promise<WebIFC.IfcAPI> {
  const api = new WebIFC.IfcAPI();
  api.SetWasmPath(wasmDir(), true);
  await api.Init();
  return api;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Line = any;

const ref = (v: unknown): number | null => (v && typeof v === "object" && (v as { type?: number }).type === 5 ? ((v as { value: number }).value ?? null) : null);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : v ? [v] : []);
const val = (p: Line): unknown => {
  const n = p?.NominalValue ?? list(p?.EnumerationValues)[0];
  if (!n) return null;
  return "_representationValue" in n ? n._representationValue : n.value;
};

export interface ModelRead {
  elements: Map<string, { id: number; cls: string; placement: number | null; representation: number | null }>;
  /** GlobalId → "Pset.Prop" → { value, from: instance | type } (instance values override type values). */
  props: Map<string, Map<string, { value: unknown; from: "instance" | "type" }>>;
  /** Type GlobalId → "Pset.Prop" → value. */
  typeProps: Map<string, Map<string, unknown>>;
}

/** Reads elements and their property values the IFC way (rels + type), independent of the CDE index. */
export function readModel(api: WebIFC.IfcAPI, bytes: Uint8Array): ModelRead {
  const m = api.OpenModel(bytes);
  const elements: ModelRead["elements"] = new Map();
  const byId = new Map<number, string>();
  for (const t of api.GetAllTypesOfModel(m)) {
    if (!api.IsIfcElement(t.typeID)) continue;
    const ids = api.GetLineIDsWithType(m, t.typeID);
    for (let i = 0; i < ids.size(); i++) {
      const l = api.GetLine(m, ids.get(i));
      if (!l?.GlobalId?.value || /OPENING|SITE|BUILDING$|BUILDINGSTOREY|SPACE/.test(t.typeName.toUpperCase())) continue;
      elements.set(l.GlobalId.value, { id: l.expressID, cls: t.typeName, placement: ref(l.ObjectPlacement), representation: ref(l.Representation) });
      byId.set(l.expressID, l.GlobalId.value);
    }
  }
  const setValues = (psetId: number): [string, unknown][] => {
    const ps = api.GetLine(m, psetId);
    if (api.GetLineType(m, psetId) !== WebIFC.IFCPROPERTYSET) return [];
    return list(ps.HasProperties).map((h) => {
      const p = api.GetLine(m, ref(h)!);
      return [`${ps.Name.value}.${p.Name.value}`, val(p)] as [string, unknown];
    });
  };
  const props: ModelRead["props"] = new Map([...elements.keys()].map((g) => [g, new Map()]));
  const typeProps: ModelRead["typeProps"] = new Map();
  const typeRels = api.GetLineIDsWithType(m, WebIFC.IFCRELDEFINESBYTYPE);
  for (let i = 0; i < typeRels.size(); i++) {
    const r = api.GetLine(m, typeRels.get(i));
    const t = api.GetLine(m, ref(r.RelatingType)!);
    const tv = new Map<string, unknown>();
    for (const s of list(t.HasPropertySets)) for (const [k, v] of setValues(ref(s)!)) tv.set(k, v);
    typeProps.set(t.GlobalId.value, tv);
    for (const o of list(r.RelatedObjects)) {
      const g = byId.get(ref(o)!);
      if (g) for (const [k, v] of tv) props.get(g)!.set(k, { value: v, from: "type" });
    }
  }
  const rels = api.GetLineIDsWithType(m, WebIFC.IFCRELDEFINESBYPROPERTIES);
  for (let i = 0; i < rels.size(); i++) {
    const r = api.GetLine(m, rels.get(i));
    const vals = setValues(ref(r.RelatingPropertyDefinition)!);
    for (const o of list(r.RelatedObjects)) {
      const g = byId.get(ref(o)!);
      if (g) for (const [k, v] of vals) props.get(g)!.set(k, { value: v, from: "instance" });
    }
  }
  api.CloseModel(m);
  return { elements, props, typeProps };
}
