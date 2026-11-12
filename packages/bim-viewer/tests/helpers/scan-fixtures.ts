// @ts-nocheck
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export function fixtureBytes(rel: string): Uint8Array {
  return new Uint8Array(readFileSync(path.join(root, rel)));
}

export function fixtureText(rel: string): string {
  return readFileSync(path.join(root, rel), "utf8");
}

/** Serves the downsampled Balıkesir LAS / güzergah / IoT fixtures. */
export function stubScanFetch() {
  const files: Record<string, string> = {
    "preview.json": "e2e/fixtures/scans/preview.json",
    "preview.bin": "e2e/fixtures/scans/preview.bin",
    "guzergah-mesh.json": "e2e/fixtures/scans/guzergah-mesh.json",
    "guzergah-sleepers.bin": "e2e/fixtures/scans/guzergah-sleepers.bin",
    "guzergah-rails.bin": "e2e/fixtures/scans/guzergah-rails.bin",
    "iot-sample.json": "e2e/fixtures/iot-sample.json",
  };
  return async (input: RequestInfo | URL) => {
    const url = String(input);
    const key = Object.keys(files).find((name) => url.endsWith(name));
    if (!key) return new Response(null, { status: 404 });
    if (key.endsWith(".json")) {
      return new Response(fixtureText(files[key]), { headers: { "Content-Type": "application/json" } });
    }
    return new Response(fixtureBytes(files[key]));
  };
}
