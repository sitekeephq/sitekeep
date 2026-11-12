import { readFile } from "node:fs/promises";
import path from "node:path";
import type { APIRequestContext, Locator, Page } from "@playwright/test";
import { expect, test } from "../support/project-features";
import { E2E_FIXTURES, uploadProjectFile } from "../support/seed-files";

/** takeoff-plan.pdf: a 600 × 400 pt page; the 10 m reference line runs from (100, 50) to (500, 50), top-left page coordinates. */
const PAGE_W = 600;
const PAGE_H = 400;

async function seed(request: APIRequestContext, code: string) {
  const res = await request.post("/api/v1/projects", { data: { code, name: `${code} Metraj Projesi`, template: "iso19650" } });
  expect(res.ok(), await res.text()).toBe(true);
  const project = (await res.json()) as { id: string; rootFolderId: string };
  const upload = async (name: string, fixture: string, mime: string) => {
    const { fileId } = await uploadProjectFile(request, project.id, project.rootFolderId, name, await readFile(path.join(E2E_FIXTURES, fixture)), mime);
    const file = await (await request.get(`/api/v1/projects/${project.id}/files/${fileId}`)).json();
    return file.latest.id as string;
  };
  const pdf = await upload("A-101 Kat Planı.pdf", "takeoff-plan.pdf", "application/pdf");
  const dxf = await upload("A-102 Detay.dxf", "tiny.dxf", "image/vnd.dxf");
  const cost = await request.post(`/api/v1/projects/${project.id}/cost-items`, { data: { code: "SIVA", description: "İç sıva yapılması", unit: "m²", unitPrice: 200 } });
  expect(cost.ok(), await cost.text()).toBe(true);
  return { pid: project.id, pdf, dxf };
}

/** Clicks the overlay at a page point (PDF points from the top-left corner). */
async function clickAt(page: Page, overlay: Locator, x: number, y: number) {
  const box = (await overlay.boundingBox())!;
  const scale = Number(await overlay.getAttribute("data-scale"));
  expect(x).toBeLessThanOrEqual(PAGE_W);
  expect(y).toBeLessThanOrEqual(PAGE_H);
  await page.mouse.click(box.x + x * scale, box.y + y * scale);
}

test("2D take-off: calibrate a PDF page, measure areas with a deduction, lengths and counts, price, export and list", async ({ page, request }) => {
  test.setTimeout(150_000);
  const s = Date.now().toString(36).toUpperCase();
  const { pid, pdf, dxf } = await seed(request, `TKO-${s}`);

  await page.goto(`/projects/${pid}/view/${pdf}`);
  await page.getByRole("link", { name: "2B Metraj", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${pid}/takeoff/${pdf}`));
  const overlay = page.getByTestId("takeoff-overlay");
  await expect(overlay).toBeVisible({ timeout: 20_000 });
  const panel = page.getByRole("complementary", { name: "2B Metraj" });
  const options = page.locator(".takeoff-options");

  await test.step("calibrate the page from the 10 m line", async () => {
    await expect(panel.getByText("Bu sayfa ölçeklenmedi; uzunluk ve alan hesaplanmaz.")).toBeVisible();
    await page.getByRole("button", { name: "Ölçek", exact: true }).click();
    await expect(page.getByText(/Ölçüsü bilinen bir çizginin iki ucuna tıklayın/)).toBeVisible();
    await clickAt(page, overlay, 100, 50);
    await clickAt(page, overlay, 500, 50);
    const dialog = page.getByRole("dialog", { name: "Ölçek Belirle" });
    await expect(dialog.getByText(/Çizilen çizgi 400(,\d)? birim/)).toBeVisible();
    await dialog.getByRole("textbox").fill("10");
    await dialog.getByRole("button", { name: "Ölçekle" }).click();
    await expect(panel.getByText("Kalibrasyon", { exact: true })).toBeVisible();
    await expect(panel.getByText("Referans çizgi 10 m")).toBeVisible();
    // Calibrating switches to the length tool.
    await expect(page.getByRole("button", { name: "Uzunluk", exact: true })).toHaveAttribute("aria-pressed", "true");
  });

  await test.step("area with a unit price, then an opening deducted", async () => {
    await page.getByRole("button", { name: "Alan", exact: true }).click();
    await options.getByLabel("Grup").fill("İç Sıva");
    await options.getByLabel("Poz").selectOption({ label: "SIVA · İç sıva yapılması (m²)" });
    for (const [x, y] of [[100, 100], [500, 100], [500, 300]]) await clickAt(page, overlay, x, y);
    // Three corners and the pointer: a 400 × 200 pt triangle at 0.025 m/pt.
    await expect(page.locator(".takeoff-live")).toHaveText("25 m²");
    await clickAt(page, overlay, 100, 300);
    await page.getByRole("button", { name: "Bitir" }).click();
    const group = panel.locator(".takeoff-groups tr").filter({ hasText: "İç Sıva" });
    await expect(group).toContainText("50 m²");
    await expect(group).toContainText("10.000");

    await options.getByLabel("Düşülecek Alan (Boşluk)").check();
    for (const [x, y] of [[200, 150], [280, 150], [280, 230], [200, 230]]) await clickAt(page, overlay, x, y);
    await page.keyboard.press("Enter");
    await expect(group).toContainText("46 m²");
    await expect(group).toContainText("9.200");
    await expect(group).toContainText("2 ölçüm");
    await expect(panel.locator(".takeoff-items .model-item").filter({ hasText: "Düşülen" })).toContainText("-4 m²");
  });

  await test.step("length and count", async () => {
    await page.getByRole("button", { name: "Uzunluk", exact: true }).click();
    await options.getByLabel("Grup").fill("Süpürgelik");
    await options.getByLabel("Poz").selectOption("");
    await clickAt(page, overlay, 100, 320);
    await clickAt(page, overlay, 500, 320);
    await page.keyboard.press("Enter");
    await expect(panel.locator(".takeoff-groups tr").filter({ hasText: "Süpürgelik" })).toContainText("10 m");

    await page.getByRole("button", { name: "Adet", exact: true }).click();
    await options.getByLabel("Grup").fill("Priz");
    for (const x of [150, 300, 450]) await clickAt(page, overlay, x, 120);
    await expect(page.locator(".takeoff-live")).toHaveText("3 adet");
    await page.getByRole("button", { name: "Bitir" }).click();
    await expect(panel.locator(".takeoff-groups tr").filter({ hasText: "Priz" })).toContainText("3 adet");
    await expect(panel.getByRole("heading", { name: "Ölçümler (4)" })).toBeVisible();
  });

  await test.step("edit and delete a measurement", async () => {
    await panel.locator(".takeoff-items .model-item").filter({ hasText: "Süpürgelik" }).click();
    const card = panel.getByLabel("Seçili Ölçüm");
    await card.getByLabel("Açıklama").fill("Salon süpürgeliği");
    await card.getByRole("button", { name: "Kaydet" }).click();
    await expect(panel.locator(".takeoff-items .model-item").filter({ hasText: "Salon süpürgeliği" })).toBeVisible();

    await panel.locator(".takeoff-items .model-item").filter({ hasText: "Priz" }).click();
    await panel.getByLabel("Seçili Ölçüm").getByRole("button", { name: "Sil" }).click();
    const confirm = page.getByRole("dialog", { name: "Ölçüm Silinsin mi?" });
    await confirm.getByRole("button", { name: "Sil" }).click();
    await expect(panel.getByRole("heading", { name: "Ölçümler (3)" })).toBeVisible();
    await expect(panel.locator(".takeoff-groups tr").filter({ hasText: "Priz" })).toHaveCount(0);
  });

  await test.step("Excel export", async () => {
    const href = await panel.getByRole("link", { name: "Excel'e Aktar" }).getAttribute("href");
    const res = await page.request.get(href!);
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("spreadsheetml");
    expect(res.headers()["content-disposition"]).toContain("2b-metraj.xlsx");
  });

  await test.step("DXF measurement saved from the CAD viewer", async () => {
    await page.goto(`/projects/${pid}/open/${dxf}`);
    await expect(page.getByRole("button", { name: /Sığdır/ }).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("Çizim yükleniyor…")).toHaveCount(0, { timeout: 30_000 });
    await page.getByRole("button", { name: "📏 Uzunluk" }).click();
    const canvas = page.locator(".cad-canvas");
    const box = (await canvas.boundingBox())!;
    await page.mouse.click(box.x + box.width * 0.3, box.y + box.height * 0.5);
    await page.mouse.click(box.x + box.width * 0.7, box.y + box.height * 0.5);
    const results = page.locator(".cad-results");
    await results.getByRole("button", { name: "1. ölçümü metraja ekle" }).click();
    await expect(results.getByText("Metrajda")).toBeVisible();
    await expect(results.getByRole("link", { name: "2B Metrajı Aç" })).toBeVisible();
    const state = await (await request.get(`/api/v1/projects/${pid}/versions/${dxf}/takeoff`)).json();
    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toMatchObject({ kind: "length", unit: "m" });
    expect(state.items[0].quantity).toBeGreaterThan(0);
    expect(state.scales[0]).toMatchObject({ page: 1, method: "drawing_units" });
  });

  await test.step("Metraj page lists the drawings in 2D mode", async () => {
    await page.goto(`/projects/${pid}/quantities`);
    await page.getByRole("tab", { name: "2B Çizim" }).click();
    await expect(page).toHaveURL(/mode=2d/);
    const pdfRow = page.locator("tr").filter({ hasText: "A-101 Kat Planı.pdf" });
    await expect(pdfRow).toContainText("İç Sıva: 46 m²");
    await expect(pdfRow).toContainText("Süpürgelik: 10 m");
    const dxfRow = page.locator("tr").filter({ hasText: "A-102 Detay.dxf" });
    await expect(dxfRow.getByRole("link", { name: "CAD Görüntüleyicide Ölç" })).toBeVisible();
    await pdfRow.getByRole("link", { name: "Ölç", exact: true }).click();
    await expect(page.getByTestId("takeoff-overlay")).toBeVisible({ timeout: 20_000 });
    await page.screenshot({ path: "/tmp/takeoff-2b.png" });
  });
});
