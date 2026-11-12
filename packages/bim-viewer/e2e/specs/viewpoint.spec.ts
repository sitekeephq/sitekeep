import { distance, expect, loadModels, lookAtWall, openViewer, screenOf, test, WALL } from "../support/fixtures";

/**
 * The CDE contract: an issue / model-set view saves engine.viewpoint() and opens it later with
 * applyViewpoint() — camera, selection, sections and measurements come back after a reload.
 */
test("a saved viewpoint restores camera, selection, section box and measurement after reload", async ({ page }) => {
  await openViewer(page);
  await loadModels(page, "Duvar Modeli", "wall");
  await lookAtWall(page);

  const face = await screenOf(page, "wall", WALL.faceCenter);
  await page.mouse.click(face.x, face.y);
  await expect(page.getByRole("complementary", { name: "Özellikler" })).toBeVisible();
  await page.keyboard.press("b");
  await expect.poll(() => page.evaluate(() => window.__tools!.state.box)).toBe(true);
  await page.evaluate(() =>
    window.__tools!.measure.apply([{ kind: "length", points: [[0, 3, 0], [5, 3, 0]], value: 5 }]),
  );

  const saved = await page.evaluate(() => window.__viewer!.viewpoint());
  expect(saved.selection).toEqual([WALL.guid]);
  expect(saved.fileVersionIds).toEqual(["wall"]);
  expect(saved.snapshot).toMatch(/^data:image\/(png|jpeg);base64,/);
  expect(saved.sections?.box).toBeTruthy();
  expect(saved.measurements).toEqual([expect.objectContaining({ kind: "length", value: 5 })]);
  // Must survive a JSON round trip (it is stored by the server).
  const stored = JSON.parse(JSON.stringify(saved));

  await page.reload();
  await expect(page.getByTestId("viewer-ready")).toBeVisible({ timeout: 45_000 });
  await loadModels(page, "Duvar Modeli", "wall");
  await page.evaluate((vp) => window.__viewer!.applyViewpoint(vp), stored);

  const restored = await page.evaluate(async () => ({
    camera: window.__viewer!.cameraState(),
    selection: await window.__viewer!.selectedGuids(),
    box: window.__tools!.sections.state().box,
    measurements: await window.__tools!.measure.state(),
  }));
  expect(distance(restored.camera.position, stored.camera.position)).toBeLessThan(1e-3);
  expect(distance(restored.camera.target, stored.camera.target)).toBeLessThan(1e-3);
  expect(restored.selection).toEqual([{ modelId: "wall", guids: [WALL.guid] }]);
  expect(restored.box).toEqual(stored.sections.box);
  expect(restored.measurements).toEqual([expect.objectContaining({ kind: "length", value: 5 })]);
  await expect(page.getByRole("button", { name: "Kesit", exact: true })).toHaveClass(/active/);
});

test("a viewpoint without sections clears the current ones", async ({ page }) => {
  await openViewer(page);
  await loadModels(page, "Duvar Modeli", "wall");
  const plain = await page.evaluate(() => window.__viewer!.viewpoint());
  expect(plain.sections).toBeUndefined();

  await page.keyboard.press("b");
  await expect.poll(() => page.evaluate(() => window.__tools!.state.box)).toBe(true);
  await page.evaluate((vp) => window.__viewer!.applyViewpoint(vp), plain);
  await expect.poll(() => page.evaluate(() => window.__tools!.state.box)).toBe(false);
});

test("BCF colouring and lines from a viewpoint are drawn and cleared", async ({ page }) => {
  await openViewer(page);
  await loadModels(page, "Duvar Modeli", "wall");
  const counts = await page.evaluate(async (guid) => {
    const viewer = window.__viewer!;
    const vp = await viewer.viewpoint();
    await viewer.applyViewpoint({
      ...vp,
      coloring: [{ color: "ffd92d20", guids: [guid] }],
      lines: [[[0, 0, 0], [5, 0, 3]]],
    });
    const lines = (viewer as unknown as { bcfLines: { children: unknown[] } }).bcfLines.children.length;
    await viewer.applyViewpoint(vp);
    const cleared = (viewer as unknown as { bcfLines: { children: unknown[] } }).bcfLines.children.length;
    return { lines, cleared };
  }, WALL.guid);
  expect(counts.lines).toBeGreaterThan(0);
  expect(counts.cleared).toBe(0);
});
