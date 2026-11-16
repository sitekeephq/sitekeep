/**
 * Drawing sheets: title-block template and OCR (docs/features/SHEETS.md). A scanned sheet (an
 * image-only PDF made here from rendered text) is read by OCR and flagged for checking; a project
 * administrator draws the title-block template on a sheet the automatic reader gets wrong, tries
 * it, saves it and reads the drawings again. Core only: passes with and without modules.
 */
import path from "node:path";
import { createCanvas, GlobalFonts } from "@napi-rs/canvas";
import { PDFDocument, StandardFonts } from "pdf-lib";
import type { Page } from "@playwright/test";
import { test, expect } from "../support/fixtures";

type Put = (text: string, x: number, y: number, size?: number) => void;

/** A title block the automatic reader does not know, and a decoy sheet number at the top left. */
function customBlock(put: Put): void {
  put("PAFTA NO: WRONG-1", 80, 700, 9);
  put("DWG REF", 870, 200, 6);
  put("M-501", 870, 186, 10);
  put("ISSUE", 1060, 200, 6);
  put("C02", 1060, 186, 10);
  put("CONTENT", 870, 150, 6);
  put("BOILER ROOM", 870, 136, 10);
}

async function textSheet(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([1190, 842]);
  customBlock((text, x, y, size = 8) => page.drawText(text, { x, y, size, font }));
  return Buffer.from(await doc.save());
}

/** An A3 scan: the title block drawn into a 150 dpi image, no text layer. */
async function scannedSheet(): Promise<Buffer> {
  GlobalFonts.registerFromPath(path.resolve(__dirname, "../../apps/server/assets/fonts/LiberationSans-Regular.ttf"), "E2EScan");
  const scale = 150 / 72;
  const canvas = createCanvas(Math.round(1190 * scale), Math.round(842 * scale));
  const g = canvas.getContext("2d");
  g.fillStyle = "#ffffff";
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.fillStyle = "#000000";
  const put: Put = (text, x, y, size = 8) => {
    g.font = `${size * scale}px E2EScan`;
    g.fillText(text, x * scale, (842 - y) * scale);
  };
  put("PAFTA ADI", 860, 196, 6);
  put("KESIT A-A", 860, 184, 10);
  put("PAFTA NO: A-401", 1040, 140, 7);
  put("REV", 1000, 100, 6);
  put("P03", 1000, 88, 10);
  const doc = await PDFDocument.create();
  const image = await doc.embedPng(canvas.toBuffer("image/png"));
  doc.addPage([1190, 842]).drawImage(image, { x: 0, y: 0, width: 1190, height: 842 });
  return Buffer.from(await doc.save());
}

/** Drags a rectangle given in page-relative coordinates, mapped through an element showing `shown`. */
async function drag(page: Page, el: { x: number; y: number; width: number; height: number }, shown: { x0: number; y0: number; x1: number; y1: number }, box: { x0: number; y0: number; x1: number; y1: number }) {
  const px = (x: number) => el.x + ((x - shown.x0) / (shown.x1 - shown.x0)) * el.width;
  const py = (y: number) => el.y + ((y - shown.y0) / (shown.y1 - shown.y0)) * el.height;
  await page.mouse.move(px(box.x0), py(box.y0));
  await page.mouse.down();
  await page.mouse.move((px(box.x0) + px(box.x1)) / 2, (py(box.y0) + py(box.y1)) / 2, { steps: 4 });
  await page.mouse.move(px(box.x1), py(box.y1), { steps: 4 });
  await page.mouse.up();
}

test("sheets: a scanned sheet is read by OCR; a drawn title-block template reads the right values", async ({ page }) => {
  test.setTimeout(180_000);
  const run = Date.now().toString(36).toUpperCase();
  const created = await page.request.post("/api/v1/projects", { data: { code: `OCR-${run}`, name: `Paftalar OCR ${run}`, template: "empty" } });
  expect(created.ok(), await created.text()).toBe(true);
  const project = (await created.json()) as { id: string; rootFolderId: string };
  const api = `/api/v1/projects/${project.id}`;
  const folder = await page.request.post(`${api}/folders`, { data: { parentId: project.rootFolderId, name: "Paftalar" } });
  const folderId = ((await folder.json()) as { id: string }).id;
  expect((await page.request.patch(`${api}/folders/${folderId}`, { data: { state: "shared" } })).ok()).toBe(true);
  for (const [name, buffer] of [
    ["Kazan Dairesi.pdf", await textSheet()],
    ["Tarama.pdf", await scannedSheet()],
  ] as const) {
    const up = await page.request.post(`${api}/folders/${folderId}/files`, { multipart: { file: { name, mimeType: "application/pdf", buffer } } });
    expect(up.ok(), await up.text()).toBe(true);
  }
  type Sheet = { id: string; number: string; title: string | null; revision: string | null; readBy: string | null };
  const sheets = async () => ((await (await page.request.get(`${api}/sheets`)).json()) as { sheets: Sheet[] }).sheets;
  await expect.poll(async () => (await sheets()).map((s) => s.number).sort(), { timeout: 90_000 }).toEqual(["A-401", "WRONG-1"]);

  // The scanned sheet: values read by OCR, marked for checking.
  await page.goto(`/projects/${project.id}/sheets`);
  const grid = page.getByTestId("sheets-grid");
  const scanCard = grid.getByTestId("sheet-card").filter({ hasText: "A-401" });
  await expect(scanCard).toContainText(/KES[Iİ]T A-A/);
  await expect(scanCard.getByTestId("sheet-ocr-badge")).toContainText("OCR ile okundu");
  await scanCard.getByRole("link").click();
  const drawer = page.getByRole("dialog");
  await expect(drawer.getByTestId("sheet-read-by")).toContainText("taranmış sayfa (OCR)");
  await expect(drawer.getByTestId("sheet-ocr-badge")).toBeVisible();
  await drawer.getByRole("button", { name: "Kapat" }).click();

  // The other sheet: the automatic reader takes the decoy number. Draw the template on it.
  await grid.getByTestId("sheet-card").filter({ hasText: "WRONG-1" }).getByRole("link").click();
  await page.getByRole("dialog").getByTestId("sheet-template").click();
  const editor = page.getByRole("dialog", { name: "Antet Şablonu" });
  const area = editor.getByTestId("titleblock-area");
  await expect(area.locator("img")).toBeVisible({ timeout: 30_000 });
  await expect(area.locator("img")).toHaveJSProperty("complete", true);
  const region = { x0: 0.7, y0: 0.66, x1: 0.995, y1: 0.995 };
  await drag(page, (await area.boundingBox())!, { x0: 0, y0: 0, x1: 1, y1: 1 }, region);
  // Zoomed to the drawn title block; the field rules.
  await editor.getByTestId("titleblock-label-number").fill("DWG REF");
  await editor.getByTestId("titleblock-label-revision").fill("ISSUE");
  await editor.getByTestId("titleblock-tool-title").click();
  const regionBox = (await editor.getByTestId("titleblock-region").boundingBox())!;
  await drag(page, regionBox, region, { x0: 0.72, y0: 0.826, x1: 0.99, y1: 0.85 });
  await editor.getByTestId("titleblock-test").click();
  const preview = editor.getByTestId("titleblock-preview");
  await expect(preview).toContainText("M-501");
  await expect(preview).toContainText("BOILER ROOM");
  await expect(preview).toContainText("C02");
  await editor.getByTestId("titleblock-save-read").click();
  await expect(page.getByRole("status")).toContainText("Antet şablonu kaydedildi");

  // Read again with the template: the right number, title and revision.
  await expect.poll(async () => (await sheets()).map((s) => s.number).sort(), { timeout: 90_000 }).toEqual(["A-401", "M-501"]);
  await page.reload();
  const card = page.getByTestId("sheets-grid").getByTestId("sheet-card").filter({ hasText: "M-501" });
  await expect(card).toContainText("BOILER ROOM");
  await expect(card).toContainText("C02");
  // The settings show the template.
  const settings = (await (await page.request.get(`${api}/sheet-settings`)).json()) as { titleBlock: { landscape: { fields: { key: string }[] } } };
  expect(settings.titleBlock.landscape.fields.map((f) => f.key)).toEqual(["number", "title", "revision"]);
});
