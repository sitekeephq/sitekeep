/**
 * A cladding shell of small panels in front of a structural plate. The panels are separate
 * elements (under 2 m), which is what Fragments drops to wires when the camera is far: the
 * red plate then reads through the facade and disappears again on zoom. Same importer as
 * the other fixture scripts.
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

/** Front face, no gaps: 0.75 m × 0.05 m × 0.6 m panels. The plate sits behind them, inset. */
const PANEL_W = 0.75;
const PANEL_T = 0.05;
const PANEL_H = 0.6;
const COLS = 8;
const ROWS = 10;

function header(name, salt) {
  return `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [ReferenceView]'),'2;1');
FILE_NAME('${name}.ifc','2026-10-31T00:00:00',('7Dimensions'),('7Dimensions'),'','7d bim-viewer e2e','');
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
#20=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#21=IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.);
#22=IFCSIUNIT(*,.VOLUMEUNIT.,$,.CUBIC_METRE.);
#23=IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.);
#24=IFCUNITASSIGNMENT((#20,#21,#22,#23));
#30=IFCPROJECT('${gid(30, salt)}',#5,'${name}',$,$,$,$,(#14),#24);
#40=IFCLOCALPLACEMENT($,#13);
#41=IFCSITE('${gid(41, salt)}',#5,'Saha',$,$,#40,$,$,.ELEMENT.,$,$,$,$,$);
#42=IFCLOCALPLACEMENT(#40,#13);
#43=IFCBUILDING('${gid(43, salt)}',#5,'Bina',$,$,#42,$,$,.ELEMENT.,$,$,$);
#50=IFCRELAGGREGATES('${gid(50, salt)}',#5,$,$,#30,(#41));
#51=IFCRELAGGREGATES('${gid(51, salt)}',#5,$,$,#41,(#43));
#60=IFCCARTESIANPOINT((0.,0.));
#61=IFCDIRECTION((1.,0.));
#62=IFCAXIS2PLACEMENT2D(#60,#61);
#70=IFCCARTESIANPOINT((0.,0.,0.));
#71=IFCAXIS2PLACEMENT3D(#70,#11,#12);
#72=IFCLOCALPLACEMENT(#42,#71);
#73=IFCBUILDINGSTOREY('${gid(73, salt)}',#5,'Kat 1',$,$,#72,$,$,.ELEMENT.,0.);
`;
}

function place(lines, id, x, y, z) {
  const pt = id();
  const axis = id();
  const placement = id();
  lines.push(`#${pt}=IFCCARTESIANPOINT((${x.toFixed(4)},${y.toFixed(4)},${z.toFixed(4)}));`);
  lines.push(`#${axis}=IFCAXIS2PLACEMENT3D(#${pt},#11,#12);`);
  lines.push(`#${placement}=IFCLOCALPLACEMENT(#72,#${axis});`);
  return placement;
}

function shape(lines, id, name, xDim, yDim, depth) {
  const prof = id();
  const solid = id();
  const rep = id();
  const pds = id();
  lines.push(`#${prof}=IFCRECTANGLEPROFILEDEF(.AREA.,'${name}',#62,${xDim},${yDim});`);
  lines.push(`#${solid}=IFCEXTRUDEDAREASOLID(#${prof},#13,#11,${depth});`);
  lines.push(`#${rep}=IFCSHAPEREPRESENTATION(#15,'Body','SweptSolid',(#${solid}));`);
  lines.push(`#${pds}=IFCPRODUCTDEFINITIONSHAPE($,$,(#${rep}));`);
  return pds;
}

function facadeIfc() {
  const lines = [];
  let next = 200;
  const id = () => next++;
  const panel = shape(lines, id, "Panel", PANEL_W, PANEL_T, PANEL_H);
  const ids = [];
  let n = 0;
  for (let col = 0; col < COLS; col++) {
    for (let row = 0; row < ROWS; row++) {
      const placement = place(lines, id, col * PANEL_W + PANEL_W / 2, PANEL_T / 2, row * PANEL_H);
      const el = id();
      lines.push(`#${el}=IFCWALL('${gid(el, 4)}',#5,'panel-${n}',$,$,#${placement},#${panel},$,$);`);
      ids.push(el);
      n += 1;
    }
  }
  const rel = id();
  const agg = id();
  lines.push(`#${rel}=IFCRELCONTAINEDINSPATIALSTRUCTURE('${gid(rel, 4)}',#5,$,$,(${ids.map((n) => `#${n}`).join(",")}),#73);`);
  lines.push(`#${agg}=IFCRELAGGREGATES('${gid(agg, 4)}',#5,$,$,#43,(#73));`);
  return `${header("shell-facade", 4)}${lines.join("\n")}\nENDSEC;\nEND-ISO-10303-21;\n`;
}

function frameIfc() {
  const lines = [];
  let next = 200;
  const id = () => next++;
  // Inset so a straight-on view hits the facade first and the plate never sticks past it.
  const plate = shape(lines, id, "Perde", 5.4, 0.2, 5.4);
  const placement = place(lines, id, 3, 0.35, 0.3);
  const el = id();
  lines.push(`#${el}=IFCWALL('${gid(el, 5)}',#5,'perde',$,$,#${placement},#${plate},$,$);`);
  const rel = id();
  const agg = id();
  lines.push(`#${rel}=IFCRELCONTAINEDINSPATIALSTRUCTURE('${gid(rel, 5)}',#5,$,$,(#${el}),#73);`);
  lines.push(`#${agg}=IFCRELAGGREGATES('${gid(agg, 5)}',#5,$,$,#43,(#73));`);
  return `${header("shell-frame", 5)}${lines.join("\n")}\nENDSEC;\nEND-ISO-10303-21;\n`;
}

mkdirSync(outDir, { recursive: true });
for (const [name, ifc] of [
  ["shell-facade", facadeIfc()],
  ["shell-frame", frameIfc()],
]) {
  const importer = new IfcImporter();
  importer.wasm = { path: wasmDir, absolute: true };
  const bytes = await importer.process({ bytes: new TextEncoder().encode(ifc), raw: false });
  const dest = path.join(outDir, `${name}.frag`);
  writeFileSync(dest, bytes);
  console.log(`${name} → ${path.relative(root, dest)} (${bytes.byteLength} bytes)`);
}
writeFixtureStamp(outDir);
