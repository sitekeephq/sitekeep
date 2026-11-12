/**
 * Downsamples the host scan binaries (OpenBIM-App /scans) into committed e2e fixtures.
 * Full files stay out of git (27–238 MB); the fixtures keep the same stride / meta.
 */
import { copyFileSync, existsSync, mkdirSync, openSync, readSync, closeSync, fstatSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const outDir = path.join(root, "e2e/fixtures/scans");
const sourceDir =
  process.env.OPENBIM_SCANS || path.resolve(root, "../OpenBIM-App/public/scans");
const iotSource =
  process.env.OPENBIM_IOT || path.resolve(root, "../OpenBIM-App/public/iot-sample.json");

const PREVIEW_POINTS = 4_000;
const SLEEPER_COUNT = 12;
const RAIL_VERTS = 6_000;

function readFloats(file, maxFloats = Infinity) {
  const fd = openSync(file, "r");
  try {
    const bytes = Math.min(fstatSync(fd).size, Number.isFinite(maxFloats) ? maxFloats * 4 : Infinity);
    const aligned = bytes - (bytes % 4);
    const buf = Buffer.alloc(aligned);
    readSync(fd, buf, 0, aligned, 0);
    return new Float32Array(buf.buffer, buf.byteOffset, aligned / 4);
  } finally {
    closeSync(fd);
  }
}

function writeFloats(file, data) {
  writeFileSync(file, Buffer.from(data.buffer, data.byteOffset, data.byteLength));
}

function pickStride(source, stride, keep) {
  const count = Math.floor(source.length / stride);
  const take = Math.min(keep, count);
  const out = new Float32Array(take * stride);
  for (let i = 0; i < take; i++) {
    const src = Math.floor((i * count) / take) * stride;
    out.set(source.subarray(src, src + stride), i * stride);
  }
  return { out, count: take, sourceCount: count };
}

function bboxOf(data, stride) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < data.length; i += stride) {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], data[i + k]);
      max[k] = Math.max(max[k], data[i + k]);
    }
  }
  return { min, max };
}

if (!existsSync(path.join(sourceDir, "preview.bin"))) {
  if (existsSync(path.join(outDir, "preview.bin"))) {
    console.log(`Scan source missing at ${sourceDir}; keeping existing fixtures.`);
    process.exit(0);
  }
  throw new Error(`Scan binaries not found at ${sourceDir}. Set OPENBIM_SCANS.`);
}

mkdirSync(outDir, { recursive: true });

const previewMeta = JSON.parse(readFileSync(path.join(sourceDir, "preview.json"), "utf8"));
const preview = pickStride(readFloats(path.join(sourceDir, "preview.bin")), 6, PREVIEW_POINTS);
writeFloats(path.join(outDir, "preview.bin"), preview.out);
writeFileSync(
  path.join(outDir, "preview.json"),
  JSON.stringify(
    {
      ...previewMeta,
      count: preview.count,
      sourceCount: preview.sourceCount,
      fixture: "downsampled",
      bbox: bboxOf(preview.out, 6),
    },
    null,
    2,
  ),
);
console.log(`preview.bin ${preview.sourceCount} → ${preview.count} points`);

const meshMeta = JSON.parse(readFileSync(path.join(sourceDir, "guzergah-mesh.json"), "utf8"));
const sleeperSrc = readFloats(path.join(sourceDir, "guzergah-sleepers.bin"));
const sleeperVerts = Math.floor(sleeperSrc.length / 6);
const vertsPer = Math.max(3, Math.floor(sleeperVerts / (meshMeta.counts?.sleepers || SLEEPER_COUNT)));
const sleeperKeep = SLEEPER_COUNT * vertsPer;
const sleepers = sleeperSrc.subarray(0, sleeperKeep * 6);
writeFloats(path.join(outDir, "guzergah-sleepers.bin"), sleepers);

const rails = pickStride(readFloats(path.join(sourceDir, "guzergah-rails.bin"), RAIL_VERTS * 6), 6, RAIL_VERTS);
writeFloats(path.join(outDir, "guzergah-rails.bin"), rails.out);

writeFileSync(
  path.join(outDir, "guzergah-mesh.json"),
  JSON.stringify(
    {
      ...meshMeta,
      fixture: "downsampled",
      counts: { sleepers: SLEEPER_COUNT, rails: 1 },
      parts: {
        sleepers: {
          ...meshMeta.parts.sleepers,
          file: "guzergah-sleepers.bin",
          vertices: sleeperKeep,
          triangles: Math.floor(sleeperKeep / 3),
          bytes: sleepers.byteLength,
          bbox: bboxOf(sleepers, 6),
        },
        rails: {
          ...meshMeta.parts.rails,
          file: "guzergah-rails.bin",
          vertices: rails.count,
          triangles: Math.floor(rails.count / 3),
          bytes: rails.out.byteLength,
          bbox: bboxOf(rails.out, 6),
        },
      },
    },
    null,
    2,
  ),
);
console.log(`sleepers ${sleeperVerts} → ${sleeperKeep} verts · rails ${rails.sourceCount} → ${rails.count} verts`);

if (existsSync(iotSource)) {
  copyFileSync(iotSource, path.join(root, "e2e/fixtures/iot-sample.json"));
  console.log("iot-sample.json copied");
}
