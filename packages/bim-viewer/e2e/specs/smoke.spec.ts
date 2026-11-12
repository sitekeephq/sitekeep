import { expect, loadModels, openViewer, pixel, screenOf, test, WALL, isBackground } from "../support/fixtures";

test("viewer boots without a model and shows the rail once one is loaded", async ({ page }) => {
  await openViewer(page);
  await expect(page.locator(".seven-dimensions-viewer")).toBeVisible();
  await expect(page.locator("canvas")).toHaveCount(1);
  await expect(page.getByTestId("loaded-models")).toHaveText("model yok");
  // Like the CDE page: no tool rail before a model is there.
  await expect(page.getByRole("toolbar", { name: "Görüntüleme Araçları" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Sığdır" })).toBeDisabled();

  await loadModels(page, "Duvar Modeli", "wall");
  const rail = page.getByRole("toolbar", { name: "Görüntüleme Araçları" });
  await expect(rail).toBeVisible();
  await expect(rail.getByRole("radio", { name: /Yörünge/ })).toBeChecked();
  for (const name of ["Kesit", "Ölçü", "Görünürlük", "X-Işını", "Görüntü Al", "Kısayollar"]) {
    await expect(rail.getByRole("button", { name })).toBeVisible();
  }
  await expect(page.getByRole("group", { name: "Görünüm küpü" }).or(page.locator(".vt-cube"))).toBeVisible();
  await expect(page.getByTestId("viewer-error")).toHaveCount(0);
});

test("the loaded wall is actually drawn on the canvas", async ({ page }) => {
  await openViewer(page);
  await loadModels(page, "Duvar Modeli", "wall");
  // After "Sığdır" the wall is in view: its face is opaque, the corner of the canvas is empty.
  const face = await screenOf(page, "wall", WALL.faceCenter);
  await expect.poll(async () => isBackground(await pixel(page, face))).toBe(false);
  expect(isBackground(await pixel(page, { x: 3, y: 3 }))).toBe(true);
});
