/**
 * Builds a still-small IFC4 "site" (many storeys and walls) at test time so e2e can exercise
 * conversion and the viewer without committing a multi-megabyte fixture.
 */
const CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$";

function gid(n: number): string {
  let x = n + 1;
  let out = "";
  for (let i = 0; i < 22; i++) {
    out = CHARS[x % CHARS.length]! + out;
    x = Math.floor(x / CHARS.length) + 17 + i;
  }
  return out;
}

export function generateSiteIfc(storeys = 12, wallsPerStorey = 16): { text: string; walls: number; storeys: number } {
  let next = 200;
  const id = () => next++;
  const lines: string[] = [];
  const storeyIds: number[] = [];
  const wallCount = storeys * wallsPerStorey;

  for (let s = 0; s < storeys; s++) {
    const elev = s * 3.5;
    const pt = id();
    const axis = id();
    const place = id();
    const storey = id();
    storeyIds.push(storey);
    lines.push(`#${pt}=IFCCARTESIANPOINT((0.,0.,${elev.toFixed(1)}));`);
    lines.push(`#${axis}=IFCAXIS2PLACEMENT3D(#${pt},#11,#12);`);
    lines.push(`#${place}=IFCLOCALPLACEMENT(#42,#${axis});`);
    lines.push(
      `#${storey}=IFCBUILDINGSTOREY('${gid(storey)}',#5,'Kat ${s + 1}',$,$,#${place},$,$,.ELEMENT.,${elev.toFixed(1)});`,
    );

    const contents: number[] = [];
    const slabPt = id();
    const slabAxis = id();
    const slabPlace = id();
    const slab = id();
    lines.push(`#${slabPt}=IFCCARTESIANPOINT((12.,8.,${(elev - 0.25).toFixed(2)}));`);
    lines.push(`#${slabAxis}=IFCAXIS2PLACEMENT3D(#${slabPt},#11,#12);`);
    lines.push(`#${slabPlace}=IFCLOCALPLACEMENT(#${place},#${slabAxis});`);
    lines.push(`#${slab}=IFCSLAB('${gid(slab)}',#5,'Doseme-${String(s + 1).padStart(2, "0")}',$,$,#${slabPlace},#83,$,.FLOOR.);`);
    contents.push(slab);

    for (let w = 0; w < wallsPerStorey; w++) {
      const x = (w % 8) * 4 + 2;
      const y = Math.floor(w / 8) * 6 + 0.1;
      const wpt = id();
      const waxis = id();
      const wplace = id();
      const wall = id();
      lines.push(`#${wpt}=IFCCARTESIANPOINT((${x}.,${y}.,0.));`);
      lines.push(`#${waxis}=IFCAXIS2PLACEMENT3D(#${wpt},#11,#12);`);
      lines.push(`#${wplace}=IFCLOCALPLACEMENT(#${place},#${waxis});`);
      lines.push(
        `#${wall}=IFCWALL('${gid(wall)}',#5,'Duvar-${String(s + 1).padStart(2, "0")}-${String(w + 1).padStart(2, "0")}',$,$,#${wplace},#66,$,.STANDARD.);`,
      );
      contents.push(wall);
    }

    const rel = id();
    lines.push(
      `#${rel}=IFCRELCONTAINEDINSPATIALSTRUCTURE('${gid(rel)}',#5,$,$,(${contents.map((n) => `#${n}`).join(",")}),#${storey});`,
    );
  }

  const agg = id();
  lines.push(
    `#${agg}=IFCRELAGGREGATES('${gid(agg)}',#5,$,$,#43,(${storeyIds.map((n) => `#${n}`).join(",")}));`,
  );

  const text = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [ReferenceView]'),'2;1');
FILE_NAME('e2e-site.ifc','2026-10-19T00:00:00',('7Dimensions'),('7Dimensions'),'','7d-cde e2e site','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPERSON($,'Test',$,$,$,$,$,$);
#2=IFCORGANIZATION($,'7Dimensions',$,$,$);
#3=IFCPERSONANDORGANIZATION(#1,#2,$);
#4=IFCAPPLICATION(#2,'0.1','7d-cde fixture','7DCDE');
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
#30=IFCPROJECT('0YvctVUKr0kugbFTf53O9L',#5,'E2E Saha',$,$,$,$,(#14),#24);
#40=IFCLOCALPLACEMENT($,#13);
#41=IFCSITE('2g8CxpnGT3qhwr_2jLPk4D',#5,'Saha',$,$,#40,$,$,.ELEMENT.,$,$,$,$,$);
#42=IFCLOCALPLACEMENT(#40,#13);
#43=IFCBUILDING('1Kyqr2Tj56YRCMzDQCYyD1',#5,'Bina',$,$,#42,$,$,.ELEMENT.,$,$,$);
#50=IFCRELAGGREGATES('0Ss5nzgSb0MPHE7W2lq7kz',#5,$,$,#30,(#41));
#51=IFCRELAGGREGATES('2lxM5Lz1L8Qe$oZ8Ihvmsz',#5,$,$,#41,(#43));
#60=IFCCARTESIANPOINT((0.,0.));
#61=IFCDIRECTION((1.,0.));
#62=IFCAXIS2PLACEMENT2D(#60,#61);
#63=IFCRECTANGLEPROFILEDEF(.AREA.,'Duvar',#62,5.,0.2);
#64=IFCEXTRUDEDAREASOLID(#63,#13,#11,3.);
#65=IFCSHAPEREPRESENTATION(#15,'Body','SweptSolid',(#64));
#66=IFCPRODUCTDEFINITIONSHAPE($,$,(#65));
#80=IFCRECTANGLEPROFILEDEF(.AREA.,'Doseme',#62,24.,16.);
#81=IFCEXTRUDEDAREASOLID(#80,#13,#11,0.25);
#82=IFCSHAPEREPRESENTATION(#15,'Body','SweptSolid',(#81));
#83=IFCPRODUCTDEFINITIONSHAPE($,$,(#82));
${lines.join("\n")}
ENDSEC;
END-ISO-10303-21;
`;
  return { text, walls: wallCount, storeys };
}
