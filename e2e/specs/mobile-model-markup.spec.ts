/**
 * Model markups on the iPhone (FP-3, docs/features/MODEL_MARKUP.md): the markups panel from "Diğer",
 * a pin placed by a tap, and opening it again from the list. Core only.
 */
import type { Page } from "@playwright/test";
import { test, expect, runState } from "../support/fixtures";
import { uploadServerIfc } from "../support/seed-files";

async function assertNoSidewaysScroll(page: Page) {
  const extra = await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth);
  expect(extra, "the page should not scroll sideways").toBeLessThanOrEqual(1);
}

test("iPhone model markups: pin by tap, list and reopen", async ({ page, diagnostics }) => {
  void diagnostics;
  test.setTimeout(150_000);
  const { project } = await runState();
  const stamp = Date.now().toString(36);
  const ifc = await uploadServerIfc(page.request, project.id, project.rootFolderId, "sample-wall.ifc", `e2e-mmarkup-${stamp}.ifc`);

  await page.goto(`/projects/${project.id}/viewer?v=${ifc.versionId}`);
  await expect(page.getByRole("button", { name: /Sığdır/ })).toBeEnabled({ timeout: 90_000 });
  await page.getByRole("button", { name: "Diğer" }).click();
  await page.getByRole("menuitemcheckbox", { name: /İşaretlemeler/ }).click();
  const panel = page.getByRole("region", { name: "İşaretlemeler" });
  await expect(panel).toBeVisible();
  await page.getByRole("button", { name: /Sığdır/ }).click();

  await panel.getByRole("button", { name: "📍 Nokta İşaretlemesi" }).click();
  await page.locator(".viewer-container canvas").first().tap();
  const save = page.getByRole("dialog", { name: "İşaretleme Olarak Kaydet" });
  await expect(save).toBeVisible({ timeout: 20_000 });
  await save.getByLabel("Başlık").fill(`Mobil nokta ${stamp}`);
  await assertNoSidewaysScroll(page);
  await save.getByRole("button", { name: "Kaydet" }).click();
  await expect(save).toHaveCount(0);
  const pin = page.getByRole("button", { name: `📍 Mobil nokta ${stamp}`, exact: true });
  await expect(pin).toBeVisible();

  await panel.getByRole("button", { name: "← Tüm İşaretlemeler" }).click();
  await panel.getByRole("button", { name: new RegExp(`Mobil nokta ${stamp}`) }).tap();
  await expect(panel.getByRole("heading", { name: new RegExp(`Mobil nokta ${stamp}`) })).toBeVisible();
  await expect(pin).toHaveClass(/active/);
  await pin.tap();
  await expect(panel.locator("img.mm-snapshot")).toBeVisible();
  await assertNoSidewaysScroll(page);
});
