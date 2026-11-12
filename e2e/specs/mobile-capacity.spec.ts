import { test, expect, runState } from "../support/fixtures";

/** Kapasite on a phone: the card, the guide table as cards and the test dialog fit the screen. */
test("capacity card and guide read on a phone", async ({ page }) => {
  const { project } = await runState();
  await page.goto(`/projects/${project.id}/sistem-durumu`);
  const card = page.getByTestId("capacity-card");
  await expect(card.getByRole("heading", { name: "Kapasite", exact: true })).toBeVisible();
  await card.getByRole("button", { name: "Kapasite Rehberi" }).click();
  await expect(page.getByRole("dialog", { name: "Kapasite Rehberi" }).getByText("Kurumsal", { exact: true })).toBeVisible();
  const extra = await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth);
  expect(extra, "the page should not scroll sideways").toBeLessThanOrEqual(1);
  await page.getByRole("dialog", { name: "Kapasite Rehberi" }).getByRole("button", { name: "Kapat" }).click();

  await card.getByRole("button", { name: "Canlı Test Et" }).click();
  const dialog = page.getByRole("dialog", { name: "Canlı Test Et" });
  await dialog.getByRole("button", { name: "Testi Başlat" }).click();
  await expect(dialog.getByTestId("capacity-run").getByText("Tamamlandı", { exact: true })).toBeVisible({ timeout: 30_000 });
});
