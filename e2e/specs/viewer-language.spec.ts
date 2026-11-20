/**
 * #158: the model viewer's tool rail, panels and view cube follow the interface language
 * (@sitekeephq/bim-viewer setViewerLanguage). Core only: passes with and without modules.
 */
import type { Browser, BrowserContext } from "@playwright/test";
import { test, expect, runState } from "../support/fixtures";
import { uploadServerIfc } from "../support/seed-files";

async function englishContext(browser: Browser, baseURL: string, storageState: string): Promise<BrowserContext> {
  const context = await browser.newContext({ baseURL, storageState });
  await context.addInitScript(() => {
    try {
      localStorage.setItem("cde.productTour.v1", "done");
      localStorage.setItem("cde.language", "en");
    } catch {
      // Storage may be unavailable; the spec then fails visibly.
    }
  });
  return context;
}

test("model viewer tools in English", async ({ browser, baseURL, request }, testInfo) => {
  test.setTimeout(180_000);
  if (!baseURL) throw new Error("E2E baseURL is not configured.");
  const { project } = await runState();
  const stamp = Date.now().toString(36);
  const ifc = await uploadServerIfc(request, project.id, project.rootFolderId, "sample-wall.ifc", `e2e-viewer-en-${stamp}.ifc`);

  // The profile language wins over the browser's choice on load; the shared admin works in Turkish.
  // Workers run one at a time (playwright.config.ts), so the profile is switched for this test only.
  const before = ((await (await request.get("/api/v1/me/prefs")).json()) as { language?: string | null }).language ?? null;
  expect((await request.patch("/api/v1/me/prefs", { data: { language: "en" } })).ok()).toBe(true);
  const context = await englishContext(browser, baseURL, testInfo.project.use.storageState as string);
  const page = await context.newPage();
  try {
    await page.goto(`/projects/${project.id}/viewer?v=${ifc.versionId}`);
    const rail = page.getByRole("toolbar", { name: "Viewing Tools" });
    await expect(rail).toBeVisible({ timeout: 90_000 });
    for (const name of ["Orbit", "Walk", "Plan"]) await expect(rail.getByRole("radio", { name })).toBeVisible();
    for (const name of ["Section", "Measure", "Visibility", "X-Ray", "Screenshot", "Shortcuts"]) {
      await expect(rail.getByRole("button", { name })).toBeVisible();
    }
    await expect(rail).not.toContainText(/Yörünge|Kesit|Ölçü|Görünürlük/);

    await rail.getByRole("button", { name: "Measure" }).click();
    const measure = page.getByLabel("Measure", { exact: true }).filter({ has: page.getByRole("radiogroup") });
    await expect(measure.getByRole("radio", { name: "Length" })).toBeVisible();
    await expect(measure.getByText("No measurements yet.", { exact: false })).toBeVisible();

    await rail.getByRole("button", { name: "Shortcuts" }).click();
    await expect(page.getByRole("note", { name: "Shortcuts" }).getByText("Orbit · Walk · Plan")).toBeVisible();

    await expect(page.locator(".vt-cube-host").getByText("Front", { exact: true })).toBeAttached();
  } finally {
    await context.close();
    await request.patch("/api/v1/me/prefs", { data: { language: before ?? "tr" } });
  }
});
