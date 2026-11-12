// The shared BIM viewer copies its version-matched Fragments worker. This host script only owns
// the pdf.js data files (CMaps, standard fonts, wasm decoders, ICC profiles).
// The pdf.js worker itself is bundled by Vite (`pdf.worker.min.mjs?url`).
import "@7dimensions-project/bim-viewer/copy-assets";
import { cpSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const pdfjsDir = path.dirname(require.resolve("pdfjs-dist/package.json"));
for (const dir of ["cmaps", "standard_fonts", "wasm", "iccs"]) {
  cpSync(path.join(pdfjsDir, dir), path.resolve("public", "pdfjs", dir), { recursive: true });
}
console.log(`pdf.js data -> ${path.resolve("public", "pdfjs")}`);
