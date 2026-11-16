/** Version comparison of two IFC versions on the iPhone (FP-1, SiteKeep Community). */
import { test, expect, runState } from "../support/fixtures";
import { uploadServerIfc } from "../support/seed-files";

test("iPhone compares two IFC versions without sideways scroll", async ({ page, request }) => {
  test.setTimeout(120_000);
  const { project } = await runState();
  const name = `e2e-fp1-m-${Date.now().toString(36)}.ifc`;
  const v1 = await uploadServerIfc(request, project.id, project.rootFolderId, "model-query.ifc", name);
  const v2 = await uploadServerIfc(request, project.id, project.rootFolderId, "model-query-v2.ifc", name);

  await page.goto(`/projects/${project.id}/compare?from=${v1.versionId}&to=${v2.versionId}`);
  await expect(page.getByRole("heading", { name: "Farklar (3)" })).toBeVisible({ timeout: 60_000 });
  await page.getByRole("button", { name: /Değişen/ }).first().click();
  await expect(page.getByRole("heading", { name: "Farklar (1)" })).toBeVisible();
  await expect(page.locator(".vdiff-list")).toContainText("0MqDoor000000000000001");
  const extra = await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth);
  expect(extra, "the page should not scroll sideways").toBeLessThanOrEqual(1);
});
