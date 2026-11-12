import { afterEach, describe, expect, it, vi } from "vitest";
import { extractTrackPath, loadGuzergahMesh } from "../src/scan/layers/ifcMesh";
import { loadLasPreview } from "../src/scan/layers/pointCloud";
import { configureScanAssets } from "../src/scan/assets";
import { stubScanFetch } from "./helpers/scan-fixtures";

afterEach(() => {
  vi.unstubAllGlobals();
  configureScanAssets();
});

describe("real Balıkesir scan fixtures", () => {
  it("loads the downsampled LAS preview from host binaries", async () => {
    vi.stubGlobal("fetch", vi.fn(stubScanFetch()));
    const points = await loadLasPreview();
    expect(points).toBeTruthy();
    expect(points!.name).toBe("las-preview");
    const count = (points!.geometry.getAttribute("position") as { count: number }).count;
    expect(count).toBe(4_000);
    expect(String(points!.userData.lasMeta.source)).toMatch(/BALIKESIR_SUSURLUK/);
    expect(points!.geometry.boundingBox?.isEmpty()).toBe(false);
  });

  it("loads the downsampled güzergah sleepers and rails", async () => {
    vi.stubGlobal("fetch", vi.fn(stubScanFetch()));
    const group = await loadGuzergahMesh();
    expect(group?.name).toBe("guzergah-mesh");
    expect(group?.userData.ifcMeta.source).toBe("guzergah_2.ifc");
    expect(group?.userData.ifcMeta.counts.sleepers).toBe(12);
    expect(group?.getObjectByName("guzergah-sleepers")).toBeTruthy();
    expect(group?.getObjectByName("guzergah-rails")).toBeTruthy();
    const path = extractTrackPath(group!);
    expect(path.length).toBeGreaterThanOrEqual(8);
  });
});
