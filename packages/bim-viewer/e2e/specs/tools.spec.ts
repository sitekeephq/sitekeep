import type { Page } from "@playwright/test";
import { expect, loadModels, lookAtWall, openViewer, screenOf, test, WALL, type Vec3 } from "../support/fixtures";

test.beforeEach(async ({ page }) => {
  await openViewer(page);
  await loadModels(page, "Duvar Modeli", "wall");
  await lookAtWall(page);
});

/** Hover first, like a user: the measurement snaps to what is under the cursor before the click. */
async function clickAt(page: Page, point: Vec3) {
  const p = await screenOf(page, "wall", point);
  await page.mouse.move(p.x - 4, p.y);
  await page.mouse.move(p.x, p.y, { steps: 4 });
  await page.waitForTimeout(250);
  await page.mouse.click(p.x, p.y);
  await page.waitForTimeout(150);
}

/** Clicks made so far by the measurement being drawn (That Open keeps them in `_temp`). */
function drawnClicks(page: Page, kind: "area" | "angle") {
  return page.evaluate((k) => {
    const measure = window.__tools!.measure as unknown as {
      area: { _temp: { area: { points: Iterable<unknown> } }; list: { size: number } };
      angle: { _temp: { clickCount: number }; list: { size: number } };
    };
    return k === "area" ? [...measure.area._temp.area.points].length : measure.angle._temp.clickCount + measure.angle.list.size * 3;
  }, kind);
}

/**
 * Like clickAt, but checks that the tool took the click: on a slow (software-rendered) CI the
 * snap pick under the cursor can still be pending, and that click places nothing.
 */
async function clickCounted(page: Page, point: Vec3, kind: "area" | "angle") {
  const before = await drawnClicks(page, kind);
  for (let attempt = 0; attempt < 3; attempt++) {
    await clickAt(page, point);
    try {
      await expect.poll(() => drawnClicks(page, kind), { timeout: 2_000 }).toBe(before + 1);
      return;
    } catch {
      // Not taken: hover again and repeat the click.
    }
  }
  throw new Error(`${kind} click at ${point.join(", ")} was not taken`);
}

// Points 0,4–0,5 m inside the wall face; the measurement tools snap them to the edges and corners
// (exact corners sit on the silhouette, where the pick can miss the face).
const LEFT: Vec3 = [0.4, 0.2, 1.5];
const RIGHT: Vec3 = [4.6, 0.2, 1.5];
const BOTTOM_LEFT: Vec3 = [0.5, 0.2, 0.5];
const BOTTOM_RIGHT: Vec3 = [4.5, 0.2, 0.5];
const TOP_RIGHT: Vec3 = [4.5, 0.2, 2.5];
const TOP_LEFT: Vec3 = [0.5, 0.2, 2.5];

test("K and a double click on the wall place a section plane that can be switched off and deleted", async ({ page }) => {
  await page.keyboard.press("k");
  await expect(page.getByRole("status")).toContainText("çift tıklayın");
  const panel = page.locator(".vt-panel[aria-label='Kesit']");
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("button", { name: /Kesit Düzlemi/ })).toHaveAttribute("aria-pressed", "true");

  const face = await screenOf(page, "wall", WALL.faceCenter);
  await page.mouse.dblclick(face.x, face.y);
  const plane = panel.getByRole("checkbox", { name: "Düzlem 1" });
  await expect(plane).toBeChecked();
  // The plane is the wall face: normal along IFC y, i.e. the scene z axis.
  const saved = await page.evaluate(() => window.__tools!.sections.state().planes);
  expect(saved).toHaveLength(1);
  expect(Math.abs(saved[0]!.normal[2]!)).toBeCloseTo(1, 3);

  await plane.uncheck();
  expect(await page.evaluate(() => window.__tools!.sections.planes[0]?.enabled)).toBe(false);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("status")).toHaveCount(0);
  await panel.getByRole("button", { name: "Düzlemi sil" }).click();
  await expect(plane).toHaveCount(0);
});

test("B toggles a section box around the model, and around the selection when there is one", async ({ page }) => {
  await page.keyboard.press("b");
  await expect.poll(() => page.evaluate(() => window.__tools!.state.box)).toBe(true);
  const whole = await page.evaluate(() => window.__tools!.sections.state().box!);
  await page.keyboard.press("b");
  await expect.poll(() => page.evaluate(() => window.__tools!.state.box)).toBe(false);

  const face = await screenOf(page, "wall", WALL.faceCenter);
  await page.mouse.click(face.x, face.y);
  await expect(page.getByRole("complementary", { name: "Özellikler" })).toBeVisible();
  await page.keyboard.press("b");
  await expect.poll(() => page.evaluate(() => window.__tools!.state.box)).toBe(true);
  const around = await page.evaluate(() => window.__tools!.sections.state().box!);
  // Wall only (5 × 3 m plus 25 cm margin), smaller than wall + slab.
  const size = (b: { min: number[]; max: number[] }) => b.max.map((v, i) => v - b.min[i]!);
  expect(size(around)[0]).toBeCloseTo(5.5, 1);
  expect(size(around)[1]).toBeCloseTo(3.5, 1);
  expect(size(whole)[1]).toBeGreaterThan(size(around)[1]! - 0.6);
  expect(size(whole)[2]).toBeGreaterThan(size(around)[2]!);
});

test("M measures the 5,00 m wall length (snapped to its edges) and the list can delete it", async ({ page }) => {
  await page.keyboard.press("m");
  const panel = page.locator(".vt-panel[aria-label='Ölçü']");
  await expect(panel.getByRole("radio", { name: "Uzunluk" })).toBeChecked();
  await expect(page.getByRole("status")).toContainText("İki noktaya tıklayın");
  await clickAt(page, LEFT);
  await clickAt(page, RIGHT);
  await expect(panel.locator(".vt-value")).toHaveText(["5,00 m"]);

  await panel.getByRole("button", { name: "Ölçüyü sil" }).click();
  await expect(panel.getByText("Henüz ölçü yok")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(panel.getByRole("radio", { name: "Uzunluk" })).not.toBeChecked();
});

test("two clicks on one point do not leave a 0,00 m measurement", async ({ page }) => {
  await page.keyboard.press("m");
  const panel = page.locator(".vt-panel[aria-label='Ölçü']");
  const face = await screenOf(page, "wall", WALL.faceCenter);
  // No hover in between: both clicks land on the same snapped point.
  await page.mouse.click(face.x, face.y);
  await page.mouse.click(face.x, face.y);
  await page.waitForTimeout(500);
  await expect(panel.getByText("Henüz ölçü yok")).toBeVisible();
  expect(await page.evaluate(() => window.__tools!.state.measurements)).toEqual([]);
  // The tool keeps working afterwards (Esc drops a point left pending by the second click).
  await page.keyboard.press("Escape");
  await page.keyboard.press("m");
  await clickAt(page, LEFT);
  await clickAt(page, RIGHT);
  await expect(panel.locator(".vt-value")).toHaveText(["5,00 m"]);
});

test("area closes with Enter and angle takes three clicks", async ({ page }) => {
  await page.getByRole("button", { name: "Ölçü", exact: true }).click();
  const panel = page.locator(".vt-panel[aria-label='Ölçü']");
  await panel.getByRole("radio", { name: "Alan" }).click();
  for (const p of [BOTTOM_LEFT, BOTTOM_RIGHT, TOP_RIGHT, TOP_LEFT]) await clickCounted(page, p, "area");
  await page.keyboard.press("Enter");
  await expect(panel.locator(".vt-value")).toHaveText(["15,00 m²"]);

  await panel.getByRole("radio", { name: "Açı" }).click();
  for (const p of [BOTTOM_LEFT, BOTTOM_RIGHT, TOP_RIGHT]) await clickCounted(page, p, "angle");
  await expect(panel.locator(".vt-value")).toHaveText(["15,00 m²", "90,00°"]);
  await panel.getByRole("button", { name: "Tümünü Sil" }).click();
  await expect(panel.locator(".vt-value")).toHaveCount(0);
});

test("? opens the shortcut help, Esc closes it", async ({ page }) => {
  await page.keyboard.press("?");
  const help = page.getByRole("note", { name: "Kısayollar" });
  await expect(help).toBeVisible();
  await expect(help.getByRole("row", { name: /Kesit/ }).first()).toBeVisible();
  await expect(help.getByText("7D BIM Viewer playground.")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(help).toHaveCount(0);
});

test("G downloads a PNG of the current view", async ({ page }) => {
  const download = page.waitForEvent("download");
  await page.keyboard.press("g");
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^model-\d{8}-\d{4}\.png$/);
  const path = await file.path();
  const { readFile } = await import("node:fs/promises");
  const bytes = await readFile(path);
  expect(bytes.subarray(1, 4).toString()).toBe("PNG");
  expect(bytes.byteLength).toBeGreaterThan(2_000);
});

test("shortcuts do not fire while typing in a field", async ({ page }) => {
  await page.evaluate(() => {
    const input = document.createElement("input");
    input.setAttribute("aria-label", "Arama");
    document.body.appendChild(input);
  });
  await page.getByRole("textbox", { name: "Arama" }).fill("mkb");
  expect(await page.evaluate(() => window.__tools!.state)).toMatchObject({ measureTool: null, sectionPlacing: false, box: false });
});
