/**
 * Document search on a phone (issue #191): the "Ara ve Süz" panel takes the full width, runs a
 * search and closes on its own; the results are cards and nothing scrolls sideways.
 */
import type { Page } from "@playwright/test";
import { test, expect, runState } from "../support/fixtures";

async function assertNoSidewaysScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}

test("iPhone search panel is full width and shows results as cards", async ({ page, diagnostics }) => {
  void diagnostics;
  const { project } = await runState();
  const tag = `mz${Date.now().toString(36)}`;
  const res = await page.request.post(`/api/v1/projects/${project.id}/folders/${project.rootFolderId}/files`, {
    multipart: { file: { name: `mobil-${tag}.txt`, mimeType: "text/plain", buffer: Buffer.from(`mobil arama ${tag}`, "utf8") } },
  });
  expect(res.ok(), await res.text()).toBe(true);

  await page.goto(`/projects/${project.id}/files`);
  await page.getByRole("button", { name: "Ara ve Süz" }).click();
  const panel = page.getByTestId("search-panel");
  await expect(panel).toBeVisible();
  const box = await panel.boundingBox();
  const width = page.viewportSize()!.width;
  expect(box!.width).toBeGreaterThanOrEqual(width - 1);
  await assertNoSidewaysScroll(page);

  await panel.getByRole("radio", { name: "Tüm Klasörler" }).check();
  await panel.getByRole("searchbox", { name: "Arama metni" }).fill(tag);
  await panel.getByRole("button", { name: "Ara", exact: true }).click();
  await expect(panel).toHaveCount(0);
  const results = page.getByTestId("search-results");
  await expect(results.getByTestId("search-count")).toHaveText("1 dosya");
  await expect(results.getByText(`mobil-${tag}.txt`)).toBeVisible();
  await expect(results.getByTestId("match-name")).toBeVisible();
  await assertNoSidewaysScroll(page);
});
