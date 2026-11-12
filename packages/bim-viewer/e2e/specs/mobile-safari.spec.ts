import { assertNoSidewaysScroll, expect, loadModels, openViewer, test } from "../support/fixtures";

/** WebKit iPhone smoke (CI, or E2E_SAFARI=1): WebGL boots, a model loads, the menu works. */
test("Safari loads the wall and opens the ⋯ Diğer menu", async ({ page }) => {
  await openViewer(page);
  await expect(page.locator("canvas")).toHaveCount(1);
  await loadModels(page, "Duvar Modeli", "wall");
  await page.getByRole("button", { name: /Diğer/ }).tap();
  await expect(page.getByRole("menu").getByRole("menuitemcheckbox", { name: /Yörünge/ })).toBeVisible();
  await assertNoSidewaysScroll(page);
});
