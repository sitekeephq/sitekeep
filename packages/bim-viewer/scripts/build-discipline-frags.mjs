/**
 * Builds three discipline models of one 8-storey building (Mimari, Statik, Mekanik) as IFC4 in
 * memory and converts them to Fragments for the multi-discipline section e2e. Same IfcImporter +
 * web-ifc path as build-test-frags.mjs; the storey grid follows the CDE e2e site generator.
 * Round pipes give the section many curved cut segments, like real MEP models.
 */
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { IfcImporter } from "@thatopen/fragments";
import { writeFixtureStamp } from "./fixture-stamp.mjs";

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "..");
const wasmDir = path.dirname(require.resolve("web-ifc")) + path.sep;
const outDir = path.join(root, "e2e/fixtures/frags");

const STOREYS = 8;
const STOREY_HEIGHT = 3.5;
const CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$";

function gid(n, salt) {
  let x = n * 7919 + salt * 104729 + 1;
  let out = "";
  for (let i = 0; i < 22; i++) {
    out = CHARS[x % CHARS.length] + out;
    x = Math.floor(x / CHARS.length) + 17 + i;
  }
  return out;
}

/** Profiles (2D, centred) and extrusions shared by the elements: IFC entity text by key. */
const SHAPES = {
  wall: "IFCRECTANGLEPROFILEDEF(.AREA.,'Duvar',#62,4.,0.2)|3.",
  slab: "IFCRECTANGLEPROFILEDEF(.AREA.,'Doseme',#62,32.,12.)|0.25",
  column: "IFCRECTANGLEPROFILEDEF(.AREA.,'Kolon',#62,0.5,0.5)|3.25",
  beamX: "IFCRECTANGLEPROFILEDEF(.AREA.,'KirisX',#62,0.3,0.5)|4.",
  pipe: "IFCCIRCLEPROFILEDEF(.AREA.,'Boru',#62,0.08)|4.",
  duct: "IFCRECTANGLEPROFILEDEF(.AREA.,'Kanal',#62,0.6,0.4)|4.",
};

function element(kind) {
  return { wall: "IFCWALL", slab: "IFCSLAB", column: "IFCCOLUMN", beamX: "IFCBEAM", pipe: "IFCPIPESEGMENT", duct: "IFCDUCTSEGMENT" }[kind];
}

/** Elements per storey: [shape, x, y, z (above the storey), extrusion direction]. */
function storeyElements(discipline) {
  const items = [];
  if (discipline === "mimari") {
    items.push(["slab", 16, 6, -0.25, "#11"]);
    for (let i = 0; i < 8; i++) items.push(["wall", i * 4 + 2, 0.1, 0, "#11"], ["wall", i * 4 + 2, 11.9, 0, "#11"]);
    for (let i = 0; i < 6; i++) items.push(["wall", i * 5 + 4, 6, 0, "#11"]);
  } else if (discipline === "statik") {
    for (let i = 0; i <= 8; i++) for (const y of [0.5, 6, 11.5]) items.push(["column", i * 4, y, 0, "#11"]);
    // Beams along x at the top of the storey (extruded along IFC x).
    for (let i = 0; i < 8; i++) for (const y of [0.5, 6, 11.5]) items.push(["beamX", i * 4, y, 3.0, "#12"]);
  } else {
    for (let i = 0; i < 8; i++) {
      for (const y of [3, 3.4, 3.8, 8.2, 8.6]) items.push(["pipe", i * 4, y, 2.7, "#12"]);
      items.push(["duct", i * 4, 9.5, 2.6, "#12"]);
    }
  }
  return items;
}

function buildIfc(discipline, salt) {
  let next = 200;
  const id = () => next++;
  const lines = [];
  const shapeIds = {};
  for (const [key, def] of Object.entries(SHAPES)) {
    const [profile, depth] = def.split("|");
    const prof = id();
    const solids = {};
    for (const dir of ["#11", "#12"]) {
      const solid = id();
      const rep = id();
      const pds = id();
      // Along IFC x the profile is placed in the yz plane: #19 rotates it there.
      lines.push(`#${solid}=IFCEXTRUDEDAREASOLID(#${prof},${dir === "#11" ? "#13" : "#19"},#11,${depth});`);
      lines.push(`#${rep}=IFCSHAPEREPRESENTATION(#15,'Body','SweptSolid',(#${solid}));`);
      lines.push(`#${pds}=IFCPRODUCTDEFINITIONSHAPE($,$,(#${rep}));`);
      solids[dir] = pds;
    }
    lines.unshift(`#${prof}=${profile};`);
    shapeIds[key] = solids;
  }

  const storeyIds = [];
  for (let s = 0; s < STOREYS; s++) {
    const elev = s * STOREY_HEIGHT;
    const pt = id();
    const axis = id();
    const place = id();
    const storey = id();
    storeyIds.push(storey);
    lines.push(`#${pt}=IFCCARTESIANPOINT((0.,0.,${elev.toFixed(2)}));`);
    lines.push(`#${axis}=IFCAXIS2PLACEMENT3D(#${pt},#11,#12);`);
    lines.push(`#${place}=IFCLOCALPLACEMENT(#42,#${axis});`);
    lines.push(`#${storey}=IFCBUILDINGSTOREY('${gid(storey, salt)}',#5,'Kat ${s + 1}',$,$,#${place},$,$,.ELEMENT.,${elev.toFixed(2)});`);
    const contents = [];
    storeyElements(discipline).forEach(([shape, x, y, z, dir], n) => {
      const ept = id();
      const eaxis = id();
      const eplace = id();
      const el = id();
      lines.push(`#${ept}=IFCCARTESIANPOINT((${x.toFixed(2)},${y.toFixed(2)},${z.toFixed(2)}));`);
      lines.push(`#${eaxis}=IFCAXIS2PLACEMENT3D(#${ept},#11,#12);`);
      lines.push(`#${eplace}=IFCLOCALPLACEMENT(#${place},#${eaxis});`);
      lines.push(`#${el}=${element(shape)}('${gid(el, salt)}',#5,'${shape}-${s + 1}-${n + 1}',$,$,#${eplace},#${shapeIds[shape][dir]},$,$);`);
      contents.push(el);
    });
    const rel = id();
    lines.push(`#${rel}=IFCRELCONTAINEDINSPATIALSTRUCTURE('${gid(rel, salt)}',#5,$,$,(${contents.map((n) => `#${n}`).join(",")}),#${storey});`);
  }
  const agg = id();
  lines.push(`#${agg}=IFCRELAGGREGATES('${gid(agg, salt)}',#5,$,$,#43,(${storeyIds.map((n) => `#${n}`).join(",")}));`);

  return `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [ReferenceView]'),'2;1');
FILE_NAME('disc-${discipline}.ifc','2026-10-24T00:00:00',('7Dimensions'),('7Dimensions'),'','7d bim-viewer e2e','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPERSON($,'Test',$,$,$,$,$,$);
#2=IFCORGANIZATION($,'7Dimensions',$,$,$);
#3=IFCPERSONANDORGANIZATION(#1,#2,$);
#4=IFCAPPLICATION(#2,'0.1','7d bim-viewer fixture','7DBV');
#5=IFCOWNERHISTORY(#3,#4,$,.ADDED.,$,$,$,1760000000);
#10=IFCCARTESIANPOINT((0.,0.,0.));
#11=IFCDIRECTION((0.,0.,1.));
#12=IFCDIRECTION((1.,0.,0.));
#13=IFCAXIS2PLACEMENT3D(#10,#11,#12);
#14=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#13,$);
#15=IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,#14,$,.MODEL_VIEW.,$);
#16=IFCDIRECTION((0.,1.,0.));
#17=IFCDIRECTION((0.,0.,1.));
#19=IFCAXIS2PLACEMENT3D(#10,#12,#16);
#20=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#21=IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.);
#22=IFCSIUNIT(*,.VOLUMEUNIT.,$,.CUBIC_METRE.);
#23=IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.);
#24=IFCUNITASSIGNMENT((#20,#21,#22,#23));
#30=IFCPROJECT('${gid(30, salt)}',#5,'E2E Disiplin ${discipline}',$,$,$,$,(#14),#24);
#40=IFCLOCALPLACEMENT($,#13);
#41=IFCSITE('${gid(41, salt)}',#5,'Saha',$,$,#40,$,$,.ELEMENT.,$,$,$,$,$);
#42=IFCLOCALPLACEMENT(#40,#13);
#43=IFCBUILDING('${gid(43, salt)}',#5,'Bina',$,$,#42,$,$,.ELEMENT.,$,$,$);
#50=IFCRELAGGREGATES('${gid(50, salt)}',#5,$,$,#30,(#41));
#51=IFCRELAGGREGATES('${gid(51, salt)}',#5,$,$,#41,(#43));
#60=IFCCARTESIANPOINT((0.,0.));
#61=IFCDIRECTION((1.,0.));
#62=IFCAXIS2PLACEMENT2D(#60,#61);
${lines.join("\n")}
ENDSEC;
END-ISO-10303-21;
`;
}

mkdirSync(outDir, { recursive: true });
for (const [salt, discipline] of ["mimari", "statik", "mekanik"].entries()) {
  const importer = new IfcImporter();
  importer.wasm = { path: wasmDir, absolute: true };
  const bytes = await importer.process({ bytes: new TextEncoder().encode(buildIfc(discipline, salt + 1)), raw: false });
  const dest = path.join(outDir, `disc-${discipline}.frag`);
  writeFileSync(dest, bytes);
  console.log(`disc-${discipline} → ${path.relative(root, dest)} (${bytes.byteLength} bytes)`);
}
writeFixtureStamp(outDir);
