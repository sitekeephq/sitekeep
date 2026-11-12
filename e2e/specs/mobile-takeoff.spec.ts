import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";
import { E2E_FIXTURES, uploadProjectFile } from "../support/seed-files";

async function assertNoSidewaysScroll(page: Page) {
  const extra = await page.evaluate(
    () => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth,
  );
  expect(extra, "the page should not scroll sideways").toBeLessThanOrEqual(1);
}

/** Taps the overlay at a page point of takeoff-plan.pdf (PDF points from the top-left corner). */
async function tapAt(page: Page, overlay: Locator, x: number, y: number) {
  const box = (await overlay.boundingBox())!;
  const scale = Number(await overlay.getAttribute("data-scale"));
  await page.touchscreen.tap(box.x + x * scale, box.y + y * scale);
}

test("iPhone 2D take-off: calibrate and measure by touch, totals in the bottom sheet, drawings as cards", async ({ page, request, diagnostics }) => {
  void diagnostics;
  test.setTimeout(120_000);
  const s = Date.now().toString(36).toUpperCase();
  const res = await request.post("/api/v1/projects", { data: { code: `TKM-${s}`, name: `TKM-${s} Metraj Projesi`, template: "iso19650" } });
  expect(res.ok(), await res.text()).toBe(true);
  const project = (await res.json()) as { id: string; rootFolderId: string };
  const { fileId } = await uploadProjectFile(request, project.id, project.rootFolderId, "A-101 Kat Planı.pdf", await readFile(path.join(E2E_FIXTURES, "takeoff-plan.pdf")), "application/pdf");
  const vid = (await (await request.get(`/api/v1/projects/${project.id}/files/${fileId}`)).json()).latest.id as string;

  await page.goto(`/projects/${project.id}/takeoff/${vid}`);
  const overlay = page.getByTestId("takeoff-overlay");
  await expect(overlay).toBeVisible({ timeout: 20_000 });
  await assertNoSidewaysScroll(page);
  // The side panel is a bottom sheet on a phone.
  await expect(page.getByRole("complementary", { name: "2B Metraj" })).toBeHidden();

  await page.getByRole("button", { name: "Ölçek", exact: true }).click();
  await tapAt(page, overlay, 100, 50);
  await tapAt(page, overlay, 500, 50);
  const dialog = page.getByRole("dialog", { name: "Ölçek Belirle" });
  await dialog.getByRole("textbox").fill("10");
  await dialog.getByRole("button", { name: "Ölçekle" }).click();
  await expect(dialog).toBeHidden();

  await page.getByRole("button", { name: "Alan", exact: true }).click();
  await page.locator(".takeoff-options").getByLabel("Grup").fill("Döşeme");
  for (const [x, y] of [[100, 100], [500, 100], [500, 300], [100, 300]]) await tapAt(page, overlay, x, y);
  await expect(page.locator(".takeoff-live")).toHaveText("50 m²");
  await page.getByRole("button", { name: "Bitir" }).click();
  await assertNoSidewaysScroll(page);

  await page.getByRole("button", { name: "Metraj (1)" }).click();
  const sheet = page.getByRole("complementary", { name: "2B Metraj" });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByText("Referans çizgi 10 m")).toBeVisible();
  await expect(sheet.locator(".takeoff-groups tr").filter({ hasText: "Döşeme" })).toContainText("50 m²");
  await assertNoSidewaysScroll(page);
  await sheet.getByRole("button", { name: "Tamam" }).click();
  await expect(sheet).toBeHidden();

  await page.goto(`/projects/${project.id}/quantities?mode=2d`);
  const row = page.locator("tr").filter({ hasText: "A-101 Kat Planı.pdf" });
  await expect(row).toContainText("Döşeme: 50 m²", { timeout: 20_000 });
  const before = await row.locator('td[data-label="Metraj"]').evaluate((el) => getComputedStyle(el, "::before").content);
  expect(before).toContain("Metraj");
  await assertNoSidewaysScroll(page);
});
