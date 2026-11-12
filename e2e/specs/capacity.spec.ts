import { test, expect, runState } from "../support/fixtures";

/** Yönetim → Sistem Durumu → Kapasite (docs/onprem/capacity.md), sample test engine. */
test("capacity card runs a quick check and a load test with live charts and a report", async ({ page }) => {
  const { project } = await runState();
  await page.goto(`/projects/${project.id}/sistem-durumu`);
  const card = page.getByTestId("capacity-card");
  await expect(card.getByRole("heading", { name: "Kapasite", exact: true })).toBeVisible();
  await expect(card.getByRole("cell", { name: "Kapasite testi", exact: true })).toBeVisible();

  await card.getByRole("button", { name: "Kapasite Rehberi" }).click();
  const guide = page.getByRole("dialog", { name: "Kapasite Rehberi" });
  await expect(guide.getByTestId("capacity-tiers").getByRole("row")).toHaveCount(6);
  await expect(guide.getByText("Orta", { exact: true })).toBeVisible();
  await guide.getByRole("button", { name: "Kapat" }).click();

  await card.getByRole("button", { name: "Canlı Test Et" }).click();
  const dialog = page.getByRole("dialog", { name: "Canlı Test Et" });
  await dialog.getByRole("button", { name: "Testi Başlat" }).click();
  const run = dialog.getByTestId("capacity-run");
  await expect(run.getByText("Tamamlandı", { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(run.getByText("IFC dönüşümü")).toBeVisible();
  await expect(run.getByRole("link", { name: "Raporu İndir" })).toBeVisible();

  await dialog.getByRole("button", { name: "Yeni Test" }).click();
  await dialog.getByText("Tam Yük Testi", { exact: true }).click();
  const start = dialog.getByRole("button", { name: "Testi Başlat" });
  await expect(start).toBeDisabled();
  await dialog.getByLabel("Mesai Dışındayım").check();
  await start.click();
  await expect(dialog.getByTestId("capacity-charts").getByRole("img", { name: "Yanıt süresi (p95) grafiği" })).toBeVisible();
  await expect(run.getByText("Sınıra Ulaşıldı", { exact: true })).toBeVisible({ timeout: 60_000 });
  await expect(run.getByText(/eşzamanlı · ~\d+ kayıtlı kullanıcı/)).toBeVisible();

  const download = page.waitForEvent("download");
  await run.getByRole("link", { name: "Raporu İndir" }).click();
  expect((await download).suggestedFilename()).toMatch(/^7d-kapasite-\d{4}-\d{2}-\d{2}\.html$/);

  await dialog.getByRole("button", { name: "Kapat" }).click();
  await expect(card.getByText(/Son test .* Tam Yük Testi/)).toBeVisible();
});
