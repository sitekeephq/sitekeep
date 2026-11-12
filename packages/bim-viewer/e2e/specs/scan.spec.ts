import { expect, test } from "../support/fixtures";

test("ScanViewer mounts WebGL and loads LAS + güzergah", async ({ page }) => {
  // No IoT API configured: straight to the bundled sample, no request to a guessed port.
  const iotRequests: string[] = [];
  page.on("request", (request) => {
    if (/\/(sensors|channels|samples)$/.test(new URL(request.url()).pathname)) iotRequests.push(request.url());
  });

  await page.goto("/scan.html");
  await expect(page.getByTestId("scan-shell")).toBeVisible();
  await expect(page.locator("canvas")).toHaveCount(1);
  await expect(page.getByText("Sahne hazırlanıyor")).toBeVisible();

  await expect(page.getByText("Katmanlar")).toBeVisible({ timeout: 45_000 });
  await expect(page.getByText("Sahne hazırlanıyor")).toHaveCount(0);
  await expect(page.getByRole("toolbar", { name: "IoT araçları" })).toBeVisible();
  await expect(page.getByText(/Balıkesir Susurluk · LAS \+ Güzergah/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Reset" })).toBeVisible();

  await page.getByRole("button", { name: /LAS/ }).click();
  await page.getByRole("button", { name: "Liste" }).click();
  await expect(page.getByText("IoT Sensors")).toBeVisible();
  await expect(page.getByText("281+000.00")).toBeVisible();

  await expect(page.getByTestId("viewer-error")).toHaveCount(0);
  expect(iotRequests).toEqual([]);
});
