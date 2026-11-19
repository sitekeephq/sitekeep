/**
 * Revit models (docs/features/MODEL_FORMATS.md, Connect "Revit models"): an uploaded .rvt is converted to IFC on
 * the server and opens in the model viewer; the file panel says what it was converted from and offers the
 * converted IFC for download; model queries read its elements.
 *
 * Needs Connect, the real converter and a Revit file, so it runs only on demand:
 *   SITEKEEP_RVT_IFC_PATH=<rvt-ifc> RVT_SAMPLE=<file.rvt> npm run e2e -- --project=chromium revit-model
 * (CI has no Revit file: skipped there.)
 */
import { readFile } from "node:fs/promises";
import { test, expect, runState } from "../support/fixtures";
import { needsModules } from "../support/modules";
import { uploadProjectFile, waitForIfcReady } from "../support/seed-files";

const SAMPLE = process.env.RVT_SAMPLE;

test.describe("Revit models", () => {
  needsModules("connect");
  test.skip(!SAMPLE || !process.env.SITEKEEP_RVT_IFC_PATH, "needs RVT_SAMPLE and SITEKEEP_RVT_IFC_PATH");

  test("an uploaded .rvt opens in the model viewer, says where it came from and answers model queries", async ({ page, diagnostics }, info) => {
    void diagnostics;
    test.setTimeout(240_000);
    const { project } = await runState();
    const name = `e2e-revit-${Date.now().toString(36)}.rvt`;
    const { fileId } = await uploadProjectFile(page.request, project.id, project.rootFolderId, name, await readFile(SAMPLE!), "application/octet-stream");
    const file = await waitForIfcReady(page.request, project.id, fileId);
    expect(file.latest.ifcSummary.elementCount).toBeGreaterThan(0);
    expect(file.latest.ifcSummary.source).toMatchObject({ format: "rvt", tool: expect.stringMatching(/^rvt-rs \d/), sourceVersion: expect.stringMatching(/^20\d\d$/) });

    // Model viewer.
    await page.goto(`/projects/${project.id}/viewer?v=${file.latest.id}`);
    await expect(page.getByRole("button", { name: /Sığdır/ })).toBeEnabled({ timeout: 120_000 });
    await page.getByRole("button", { name: /Sığdır/ }).click();
    await page.waitForTimeout(1500);
    await page.screenshot({ path: info.outputPath("revit-viewer.png") });

    // File panel: model icon in the list, "converted from RVT 20xx" in the panel.
    await page.goto(`/projects/${project.id}/files/${project.rootFolderId}?file=${fileId}`);
    const note = page.getByTestId("model-source");
    await expect(note).toBeVisible({ timeout: 30_000 });
    await expect(note).toContainText(`RVT ${file.latest.ifcSummary.source.sourceVersion} dosyasından otomatik dönüştürüldü`);
    // Parameter changes write the IFC file itself: not offered for a converted model.
    await expect(page.getByRole("button", { name: /Parametre Değişiklikleri/ })).toHaveCount(0);
    // The converted IFC is kept: "IFC İndir" downloads it (an IFC file, named after the .rvt).
    const ifcLink = page.getByTestId("ifc-download");
    await expect(ifcLink).toBeVisible();
    const [download] = await Promise.all([page.waitForEvent("download"), ifcLink.click()]);
    expect(download.suggestedFilename()).toBe(name.replace(/\.rvt$/, ".ifc"));
    // The administrator can convert it again.
    await expect(page.getByRole("button", { name: /Yeniden Dönüştür/ })).toBeVisible();
    await page.screenshot({ path: info.outputPath("revit-file-panel.png") });

    // Element index: walls of the converted model.
    const q = await page.request.post(`/api/v1/projects/${project.id}/versions/${file.latest.id}/model-query`, { data: { query: { classes: ["IfcWall"] } } });
    expect(q.status(), await q.text()).toBe(200);
    expect((await q.json()).count).toBeGreaterThan(0);

    // A second version (RVT_SAMPLE_V2, else the same file again) is converted too and compares with the first.
    await uploadProjectFile(page.request, project.id, project.rootFolderId, name, await readFile(process.env.RVT_SAMPLE_V2 || SAMPLE!), "application/octet-stream");
    await expect.poll(async () => (await (await page.request.get(`/api/v1/projects/${project.id}/files/${fileId}`)).json()).latest.id, { timeout: 30_000 }).not.toBe(file.latest.id);
    const second = await waitForIfcReady(page.request, project.id, fileId);
    const diff = await page.request.post(`/api/v1/projects/${project.id}/versions/${second.latest.id}/model-query`, {
      data: { query: { change: ["added", "changed", "removed"] }, compareFrom: file.latest.id },
    });
    expect(diff.status(), await diff.text()).toBe(200);
    expect(typeof (await diff.json()).count).toBe("number");
  });
});
