/**
 * Drawing sheets (FP-2, docs/features/SHEETS.md): a multi-page PDF uploaded into a Shared folder
 * becomes sheets, a set is created from them and published, and the sheet list is exported.
 * Core only: passes with and without modules.
 */
import { PDFDocument, StandardFonts } from "pdf-lib";
import { test, expect, runState } from "../support/fixtures";

/** A3 sheets with a title block (Helvetica: WinAnsi letters only). */
async function drawingSet(pages: { no: string; title: string; rev: string }[]): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const p of pages) {
    const page = doc.addPage([1190, 842]);
    const put = (text: string, x: number, y: number, size = 8) => page.drawText(text, { x, y, size, font });
    put(p.title, 80, 780, 18);
    put("DISIPLIN", 860, 230, 6);
    put("MIMARI", 860, 218, 9);
    put("PAFTA ADI", 860, 196, 6);
    put(p.title, 860, 184, 10);
    put(`PAFTA NO: ${p.no}`, 1040, 140, 7);
    put("REV", 1000, 100, 6);
    put(p.rev, 1000, 88, 10);
  }
  return Buffer.from(await doc.save());
}

test("FP-2 sheets: upload a multi-page PDF, create and publish a set, export the sheet list", async ({ page }) => {
  test.setTimeout(120_000);
  const { project } = await runState();
  const api = `/api/v1/projects/${project.id}`;
  const run = Date.now().toString(36).toUpperCase();
  const numbers = [`${run}-A-101`, `${run}-A-102`, `${run}-A-103`];

  // A Shared folder (scanned for sheets by default) and a three-sheet PDF in it.
  const folder = await page.request.post(`${api}/folders`, { data: { parentId: project.rootFolderId, name: `Paftalar ${run}` } });
  expect(folder.ok()).toBe(true);
  const folderId = ((await folder.json()) as { id: string }).id;
  expect((await page.request.patch(`${api}/folders/${folderId}`, { data: { state: "shared" } })).ok()).toBe(true);
  const pdf = await drawingSet([
    { no: numbers[0]!, title: "ZEMIN KAT PLANI", rev: "P01" },
    { no: numbers[1]!, title: "BIRINCI KAT PLANI", rev: "P01" },
    { no: numbers[2]!, title: "CATI PLANI", rev: "P02" },
  ]);
  const up = await page.request.post(`${api}/folders/${folderId}/files`, {
    multipart: { file: { name: `Mimari Set ${run}.pdf`, mimeType: "application/pdf", buffer: pdf } },
  });
  expect(up.ok(), await up.text()).toBe(true);

  // The sheets appear (extracted in the background).
  await expect
    .poll(async () => ((await (await page.request.get(`${api}/sheets?q=${run}`)).json()) as { total: number }).total, { timeout: 60_000 })
    .toBe(3);
  await page.goto(`/projects/${project.id}/sheets`);
  await expect(page.getByRole("heading", { name: "Paftalar", level: 1 })).toBeVisible();
  await page.getByLabel("Numara, ad ya da dosya ara").fill(run);
  const grid = page.getByTestId("sheets-grid");
  await expect(grid.getByTestId("sheet-card")).toHaveCount(3);
  await expect(grid.getByTestId("sheet-card").first()).toContainText(numbers[0]!);
  await expect(grid.getByTestId("sheet-card").first()).toContainText("P01");
  // Thumbnails are rendered from the PDF page.
  await expect(grid.getByTestId("sheet-thumb").first().locator("img")).toBeVisible({ timeout: 30_000 });

  // List view.
  await page.getByRole("tab", { name: "Liste" }).click();
  await expect(page.getByTestId("sheets-table").getByRole("row")).toHaveCount(4);
  await expect(page.getByTestId("sheets-table")).toContainText("CATI PLANI");

  // The sheet opens in the PDF viewer at its page.
  await page.getByTestId("sheets-table").getByRole("link", { name: numbers[1]! }).click();
  const drawer = page.getByRole("dialog");
  await expect(drawer).toContainText("BIRINCI KAT PLANI");
  await expect(drawer.getByTestId("sheet-open-viewer")).toHaveAttribute("href", /\/view\/[0-9a-f-]+\?page=2$/);
  await drawer.getByRole("button", { name: "Kapat" }).click();

  // A set from the selection.
  const setName = `İhale Seti ${run}`;
  await page.getByText("Tümünü Seç").click();
  await expect(page.getByTestId("sheets-selection")).toContainText("3 pafta seçildi");
  await page.getByRole("button", { name: "Seçimden Yeni Set" }).click();
  const ask = page.getByRole("dialog", { name: "Yeni Set" });
  await ask.getByRole("textbox").fill(setName);
  await ask.getByRole("button", { name: "Oluştur" }).click();
  const head = page.getByTestId("sheet-set-head");
  await expect(head).toContainText(setName);
  await expect(head).toContainText("3 pafta");

  // Publish issue 01.
  await head.getByTestId("sheet-set-publish").click();
  const publish = page.getByRole("dialog", { name: `Seti Yayınla: ${setName}` });
  await publish.getByRole("textbox").fill("İhale için");
  await publish.getByTestId("sheet-set-publish-confirm").click();
  await expect(page.getByRole("status")).toContainText("yayın 01 yayınlandı");
  await expect(head).toContainText("Yayın 01");

  // Export the sheet list: the links download the "pafta listesi".
  const csvHref = await page.getByTestId("sheets-export-csv").getAttribute("href");
  const csv = await page.request.get(csvHref!);
  expect(csv.ok()).toBe(true);
  const text = (await csv.text()).replace(/^﻿/, "");
  expect(text.split("\r\n")[0]).toContain("Pafta No");
  for (const n of numbers) expect(text).toContain(n);
  const xlsx = await page.request.get(`${api}/sheet-sets/${new URL(page.url()).searchParams.get("set")}/export?format=xlsx&issue=1`);
  expect(xlsx.ok()).toBe(true);
  expect(xlsx.headers()["content-type"]).toContain("spreadsheetml");
  const zip = await page.request.get(`${api}/sheet-sets/${new URL(page.url()).searchParams.get("set")}/zip?issue=1`);
  expect(zip.headers()["content-type"]).toBe("application/zip");
});
