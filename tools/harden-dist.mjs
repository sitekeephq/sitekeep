/**
 * Release hardening of the compiled server packages (Dockerfile, on-prem bundle): every .js is
 * minified in place (comments out, whitespace out, local names shortened) and source maps and
 * type declarations are removed. Files stay where they are, because workers, migrations and
 * assets are loaded by path. Readability drops; this is not encryption (docs/onprem/installation-bundle.md).
 *
 *   node tools/harden-dist.mjs apps/server/dist packages/shared/dist …
 */
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { transform } from "esbuild";

const roots = process.argv.slice(2);
if (!roots.length) {
  console.error("usage: node tools/harden-dist.mjs <dist dir>…");
  process.exit(2);
}

let minified = 0;
let removed = 0;
for (const root of roots) {
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath, entry.name);
    if (/\.(map|d\.ts|d\.mts)$/.test(entry.name)) {
      await rm(file);
      removed++;
    } else if (/\.m?js$/.test(entry.name)) {
      const code = await readFile(file, "utf8");
      const out = await transform(code, {
        loader: "js",
        format: "esm",
        target: "node22",
        minify: true,
        // Class and function names stay: errors, logs and instanceof checks read them.
        keepNames: true,
        legalComments: "none",
      });
      await writeFile(file, out.code);
      minified++;
    }
  }
}
console.log(`harden-dist: ${minified} files minified, ${removed} maps/declarations removed`);
