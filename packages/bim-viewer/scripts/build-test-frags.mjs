/**
 * Converts the tiny CDE IFC fixtures into Fragments for playground / e2e.
 * Same IfcImporter + web-ifc path the CDE ifc-worker uses.
 */
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { IfcImporter } from "@thatopen/fragments";
import { writeFixtureStamp } from "./fixture-stamp.mjs";

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "..");
const wasmDir = path.dirname(require.resolve("web-ifc")) + path.sep;
const ifcDir = path.join(root, "e2e/fixtures/ifc");
const outDir = path.join(root, "e2e/fixtures/frags");

const files = ["sample-wall.ifc", "coord-arch.ifc", "coord-mep.ifc"];

async function convert(name) {
  const importer = new IfcImporter();
  importer.wasm = { path: wasmDir, absolute: true };
  const bytes = await importer.process({
    bytes: new Uint8Array(readFileSync(path.join(ifcDir, name))),
    raw: false,
  });
  const dest = path.join(outDir, name.replace(/\.ifc$/i, ".frag"));
  writeFileSync(dest, bytes);
  console.log(`${name} → ${path.relative(root, dest)} (${bytes.byteLength} bytes)`);
}

mkdirSync(outDir, { recursive: true });
for (const name of files) await convert(name);
writeFixtureStamp(outDir);
