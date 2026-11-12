import { expect, runState, test } from "../support/project-features";
import { uploadServerIfc } from "../support/seed-files";
import { needsModules } from "../support/modules";

needsModules("cost");

test("metraj deducts openings measured from the IFC geometry and shows the model's own value next to it", async ({ page, request }) => {
  test.setTimeout(120_000);
  const { project } = await runState();
  const v = await uploadServerIfc(request, project.id, project.rootFolderId, "openings.ifc", `e2e-bosluk-${Date.now().toString(36)}.ifc`);

  await page.goto(`/projects/${project.id}/quantities?v=${v.versionId}`);
  await expect(page.getByRole("heading", { name: "Metraj", exact: true })).toBeVisible();

  const note = page.getByTestId("qty-openings");
  await expect(note).toHaveAttribute("data-source", "geometry");
  await expect(note).toContainText("Boşluklar model geometrisinden ölçülüp düşüldü: 3 elemanda 5 boşluk, 5,473 m².");
  await expect(note).toContainText("2 elemanda modelin kendi brüt − net farkı ölçülen boşluktan farklı");
  await expect(note).toContainText("1 boşluğun geometrisi ölçülemedi ve düşülmedi.");

  const table = page.locator("table.qty-table");
  const row = (label: string) => table.locator("tbody > tr").filter({ has: page.getByRole("button", { name: new RegExp(`${label}$`) }) });

  await test.step("wall totals: openings deducted, mm lengths in metres", async () => {
    const walls = row("Duvar · Zemin Kat");
    await expect(walls.locator('td[data-label="Brüt Alan (m²)"]')).toHaveText("31,283");
    await expect(walls.locator('td[data-label="Boşluk (m²)"]')).toHaveText("3,973");
    await expect(walls.locator('td[data-label="Net Alan (m²)"]')).toHaveText("27,31");
    await expect(walls.locator('td[data-label="Uzunluk (m)"]')).toHaveText("7");
  });

  await test.step("wall elements: opening count, fillings, model value and geometric sources", async () => {
    await row("Duvar · Zemin Kat").getByRole("button").click();
    const detail = table.locator("tr.pc-detail");
    const a = detail.locator("tbody > tr").filter({ has: page.getByRole("link", { name: "Duvar-A" }) });
    const cell = a.locator(".qty-opening-cell");
    await expect(cell).toContainText("3,69");
    await expect(cell).toContainText("2 Boşluk");
    await expect(cell).toContainText("Model: 0 m²");
    await expect(cell).toHaveAttribute("title", "Dolgu: Kapi-A, Pencere-A");
    await expect(a).toContainText("11,31");
    await expect(a).toContainText("Brüt − Geometrik Boşluk");
    const b = detail.locator("tbody > tr").filter({ has: page.getByRole("link", { name: "Duvar-B" }) });
    await expect(b).toContainText("Net + Geometrik Boşluk");
    await expect(b.locator(".qty-opening-cell")).toContainText("1 Boşluk");
    await expect(detail.locator("tbody > tr").filter({ has: page.getByRole("link", { name: "Duvar-C" }) }).locator(".qty-opening-cell")).toHaveCount(0);
    await row("Duvar · Zemin Kat").getByRole("button").click();
  });

  await test.step("slab: an opening that could not be measured is flagged", async () => {
    await row("Döşeme · Zemin Kat").getByRole("button").click();
    const slab = table.locator("tr.pc-detail tbody > tr").filter({ has: page.getByRole("link", { name: "Doseme-A" }) });
    await expect(slab.locator(".qty-opening-cell")).toContainText("1,5");
    await expect(slab.locator(".qty-opening-cell")).toContainText("1 Ölçülemedi");
    await expect(slab.locator(".qty-opening-cell")).toContainText("Model: 1 m²");
    await expect(slab).toContainText("23,5");
  });
});
