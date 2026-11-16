/**
 * Version comparison of models and drawings (FP-1, SiteKeep Community): two IFC versions compared per
 * GlobalId on the comparison page (classes, storeys, the filtered list of changed elements, links to
 * the 3D viewer's colours, the Excel export) and two DXF versions compared per layer.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test, expect, runState } from "../support/fixtures";
import { E2E_FIXTURES, uploadProjectFile, uploadServerIfc } from "../support/seed-files";

test("compares two IFC versions: changed elements by class and storey, links to the 3D viewer", async ({ page, request }) => {
  test.setTimeout(120_000);
  const { project } = await runState();
  const name = `e2e-fp1-${Date.now().toString(36)}.ifc`;
  const v1 = await uploadServerIfc(request, project.id, project.rootFolderId, "model-query.ifc", name);
  const v2 = await uploadServerIfc(request, project.id, project.rootFolderId, "model-query-v2.ifc", name);
  expect(v2.fileId).toBe(v1.fileId);

  await page.goto(`/projects/${project.id}/compare?from=${v1.versionId}&to=${v2.versionId}`);
  await expect(page.getByRole("heading", { name: "Farklar (3)" })).toBeVisible({ timeout: 60_000 });
  await expect(page.locator(".doccmp-side")).toContainText("Elemanlar: 1 eklendi, 1 silindi, 1 değişti, 5 aynı.");
  await expect(page.getByRole("heading", { name: "Sınıfa Göre" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Kata Göre" })).toBeVisible();

  const list = page.locator(".vdiff-list");
  await expect(list).toContainText("0MqDoor000000000000001");
  await expect(list).toContainText("0MqColumn0000000000001");
  await expect(list).toContainText("0MqWall000000000000002");

  // Only the changed elements: the door whose fire rating changed.
  await page.getByRole("combobox", { name: "Değişiklik" }).selectOption("changed");
  await expect(page.getByRole("heading", { name: "Farklar (1)" })).toBeVisible();
  await expect(list).toContainText("Pset_DoorCommon.FireRating");
  await expect(list.locator("del")).toHaveText("EI30");
  await expect(list.locator("ins")).toHaveText("EI60");
  const show = list.getByRole("link", { name: "Göster" });
  await expect(show).toHaveAttribute("href", new RegExp(`/viewer\\?v=${v2.versionId}&cmp=${v1.versionId}%2C${v2.versionId}&select=0MqDoor000000000000001`));
  await expect(page.getByRole("link", { name: "Modelde Göster" })).toHaveAttribute("href", new RegExp(`cmp=${v1.versionId}`));
  await expect(page.getByRole("link", { name: "⬇ Excel" })).toHaveAttribute("href", /\/export\?kind=changed&format=xlsx$/);

  // A search narrows the list; clearing the filters brings every difference back.
  await page.getByRole("combobox", { name: "Değişiklik" }).selectOption("");
  await page.getByRole("searchbox", { name: "Ad, kimlik ya da değer ara" }).fill("Kolon");
  await expect(page.getByRole("heading", { name: "Farklar (1)" })).toBeVisible();
  await expect(list).toContainText("0MqColumn0000000000001");
  await page.getByRole("button", { name: "Filtreleri Temizle" }).click();
  await expect(page.getByRole("heading", { name: "Farklar (3)" })).toBeVisible();
});

test("compares two DXF versions per layer", async ({ page, request }) => {
  test.setTimeout(90_000);
  const { project } = await runState();
  const name = `e2e-fp1-${Date.now().toString(36)}.dxf`;
  const v1Data = await readFile(path.join(E2E_FIXTURES, "tiny.dxf"));
  const v2Data = Buffer.from(
    v1Data
      .toString("latin1")
      .replace("E2E DXF", "E2E DXF REV B")
      .replace(/(\r?\n)\s*0(\r?\n)ENDSEC(\r?\n)\s*0(\r?\n)EOF/, "$1  0$2LINE$1  8$2YENI$1 10$20$1 20$25$1 11$220$1 21$25$1  0$2ENDSEC$1  0$2EOF"),
    "latin1",
  );
  const { fileId } = await uploadProjectFile(request, project.id, project.rootFolderId, name, v1Data, "image/vnd.dxf");
  await uploadProjectFile(request, project.id, project.rootFolderId, name, v2Data, "image/vnd.dxf");
  const file = await (await request.get(`/api/v1/projects/${project.id}/files/${fileId}`)).json();
  const version = (n: number) => file.versions.find((v: { version: number }) => v.version === n).id as string;

  await page.goto(`/projects/${project.id}/compare?from=${version(1)}&to=${version(2)}`);
  await expect(page.getByRole("heading", { name: "Farklar (2)" })).toBeVisible({ timeout: 60_000 });
  await expect(page.locator(".doccmp-side")).toContainText("Nesneler: 1 eklendi, 0 silindi, 1 değişti, 1 aynı.");
  await expect(page.getByRole("heading", { name: "Katmanlar" })).toBeVisible();
  const layers = page.locator(".vdiff-table").first();
  await expect(layers.getByRole("row").filter({ hasText: "YENI" })).toContainText("Eklendi");
  const list = page.locator(".vdiff-list");
  await expect(list).toContainText("E2E DXF REV B");
  await page.getByRole("combobox", { name: "Ne Değişti" }).selectOption("text");
  await expect(page.getByRole("heading", { name: "Farklar (1)" })).toBeVisible();
  await expect(list.locator("ins")).toHaveText("E2E DXF REV B");
  await expect(list.getByRole("link", { name: "Katmanı Göster" })).toHaveAttribute("href", /\/open\/[^?]+\?layer=YAZI$/);
});
