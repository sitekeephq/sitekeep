import { expect, loadModels, openViewer, test } from "../support/fixtures";

test.beforeEach(async ({ page }) => {
  await openViewer(page);
});

test("federated IFC fragments share one frame and the section box covers both", async ({ page }) => {
  await loadModels(page, "Federasyon", "arch,mep");
  const frame = await page.evaluate(async () => {
    const viewer = window.__viewer!;
    // The same IFC world point must land on the same scene point in both models after align().
    const a = (await viewer.ifcToScene([1, 2, 3], "arch"))!;
    const m = (await viewer.ifcToScene([1, 2, 3], "mep"))!;
    return { gap: a.distanceTo(m), offset: await viewer.frameOffset() };
  });
  expect(frame.gap).toBeLessThan(1e-6);

  await page.getByRole("button", { name: "Kesit", exact: true }).click();
  await page.getByRole("button", { name: /Kesit Kutusu/ }).click();
  await expect(page.getByRole("button", { name: /Kutuyu Kaldır/ })).toBeVisible();

  const box = await page.evaluate(() => {
    const tools = window.__tools!;
    const union = tools.sections.modelBox();
    return {
      faces: tools.sections.planes.filter((plane) => plane.kind === "box").length,
      box: tools.sections.state().box,
      union: { min: union.min.toArray(), max: union.max.toArray() },
      models: window.__viewer!.loadedIds.map((id) => {
        const b = window.__viewer!.fragments.list.get(id)!.box;
        return { min: b.min.toArray(), max: b.max.toArray() };
      }),
    };
  });
  expect(box.faces).toBe(6);
  expect(box.box).not.toBeNull();
  // The box is the union of both models: every model box lies inside it.
  for (const model of box.models) {
    for (let i = 0; i < 3; i++) {
      expect(box.box!.min[i]!).toBeLessThanOrEqual(model.min[i]! + 1e-3);
      expect(box.box!.max[i]!).toBeGreaterThanOrEqual(model.max[i]! - 1e-3);
    }
  }

  await page.getByRole("button", { name: /Kutuyu Kaldır/ }).click();
  await expect(page.getByRole("button", { name: /Kesit Kutusu/ })).toBeVisible();
  expect(await page.evaluate(() => window.__tools!.sections.planes.length)).toBe(0);
});

test("loading the same set twice keeps one copy of each model", async ({ page }) => {
  await loadModels(page, "Duvar Modeli", "wall");
  await loadModels(page, "Duvar Modeli", "wall");
  expect(await page.evaluate(() => window.__viewer!.fragments.list.size)).toBe(1);
});

test("a missing fragment URL is rejected with the HTTP status", async ({ page, diagnostics }) => {
  diagnostics.allow(/status of 404/);
  const message = await page.evaluate(async () => {
    try {
      await window.__viewer!.load("missing", "/__missing__/no-such-model.frag");
      return "loaded";
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  });
  expect(message).toBe("Model yüklenemedi (HTTP 404)");
  expect(await page.evaluate(() => window.__viewer!.loadedIds)).toEqual([]);
});

test("a file that is not a fragment is rejected and leaves the viewer usable", async ({ page, diagnostics }) => {
  diagnostics.allow(/Malformed fragments data/);
  const outcome = await page.evaluate(async () => {
    const viewer = window.__viewer!;
    const timeout = new Promise<string>((resolve) => setTimeout(() => resolve("timeout"), 15_000));
    const load = viewer.load("broken", "/playground.css").then(
      () => "loaded",
      (error: unknown) => (error instanceof Error ? error.message : `not an Error: ${String(error)}`),
    );
    return Promise.race([load, timeout]);
  });
  expect(outcome).toBe("Model okunamadı: Fragments: Malformed fragments data!");
  expect(await page.evaluate(() => window.__viewer!.loadedIds)).toEqual([]);
  await loadModels(page, "Duvar Modeli", "wall");
});

test("the playground shows a load error to the user", async ({ page, diagnostics }) => {
  diagnostics.allow(/Malformed fragments data/);
  await page.route("**/models/sample-wall.frag", (route) => route.fulfill({ status: 200, body: "bozuk" }));
  await page.getByRole("button", { name: "Duvar Modeli" }).click();
  await expect(page.getByRole("alert")).toHaveText("Model okunamadı: Fragments: Malformed fragments data!");
  await expect(page.getByRole("button", { name: "Duvar Modeli" })).toBeEnabled();
});
