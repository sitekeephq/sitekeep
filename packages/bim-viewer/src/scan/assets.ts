/** Public URL prefix for guzergah mesh + LAS preview assets (host copies under `public/`). */
let scanAssetBase = "/scans";

export function configureScanAssets(basePath = "/scans") {
  scanAssetBase = basePath.replace(/\/$/, "") || "/scans";
}

export function scanAssetUrl(relativePath: string) {
  const path = relativePath.replace(/^\//, "");
  return `${scanAssetBase}/${path}`;
}
