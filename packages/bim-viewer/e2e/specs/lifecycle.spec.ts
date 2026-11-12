import { expect, loadModels, openViewer, test } from "../support/fixtures";

/**
 * Hosts mount and unmount the viewer on every route change. Chrome keeps at most 16 WebGL
 * contexts: an engine that is not disposed shows up as "Too many active WebGL contexts" (the
 * diagnostics fixture fails on it) well before 20 remounts.
 */
test("twenty remounts dispose every engine and the last one still loads a model", async ({ page }) => {
  test.setTimeout(120_000);
  await openViewer(page);
  for (let i = 0; i < 20; i++) {
    await page.getByRole("button", { name: "Yeniden Kur" }).click();
    await expect(page.getByTestId("viewer-ready")).toBeVisible({ timeout: 30_000 });
  }
  await expect(page.locator("canvas")).toHaveCount(1);
  await loadModels(page, "Duvar Modeli", "wall");
  await expect(page.getByRole("toolbar", { name: "Görüntüleme Araçları" })).toBeVisible();
});

test("remounting with a model loaded drops the old tools and their keyboard shortcuts", async ({ page }) => {
  await openViewer(page);
  await loadModels(page, "Duvar Modeli", "wall");
  await page.getByRole("button", { name: "Yeniden Kur" }).click();
  await expect(page.getByTestId("loaded-models")).toHaveText("model yok");
  await expect(page.getByRole("toolbar", { name: "Görüntüleme Araçları" })).toHaveCount(0);
  // A leaked ViewerTools would still react to "?" on window.
  await page.keyboard.press("?");
  await expect(page.getByRole("note", { name: "Kısayollar" })).toHaveCount(0);
});

test("an extension is activated with the engine and cleaned up when the viewer goes away", async ({ page }) => {
  await openViewer(page, "?ext=1");
  await expect(page.locator(".seven-dimensions-viewer")).toHaveAttribute("data-pg-extension", "on");
  expect(await page.evaluate(() => window.__pg!.extensionLog)).toEqual(["activate"]);

  await page.getByRole("button", { name: "Yeniden Kur" }).click();
  await expect(page.getByTestId("viewer-ready")).toBeVisible();
  await expect(page.locator(".seven-dimensions-viewer")).toHaveAttribute("data-pg-extension", "on");
  expect(await page.evaluate(() => window.__pg!.extensionLog)).toEqual(["activate", "cleanup", "activate"]);
});
