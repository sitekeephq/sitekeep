import { expect, isBackground, loadModels, lookAtWall, openViewer, pixel, screenOf, test, WALL, type Rgba } from "../support/fixtures";

test.beforeEach(async ({ page }) => {
  await openViewer(page);
  await loadModels(page, "Duvar Modeli", "wall");
  await lookAtWall(page);
});

async function selectWall(page: import("@playwright/test").Page) {
  const face = await screenOf(page, "wall", WALL.faceCenter);
  await page.mouse.click(face.x, face.y);
  const props = page.getByRole("complementary", { name: "Özellikler" });
  await expect(props).toBeVisible();
  return { face, props };
}

test("clicking the wall shows its IFC class, storey, GlobalId and property sets", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const { props } = await selectWall(page);
  await expect(props.getByRole("heading", { name: "Duvar-01" })).toBeVisible();
  await expect(props.getByText("IFCWALL", { exact: true }).first()).toBeVisible();
  await expect(props.locator("dd").filter({ hasText: "Zemin Kat" })).toBeVisible();
  await expect(props.getByText(WALL.guid)).toBeVisible();
  await expect(props.getByRole("heading", { name: "Pset_WallCommon" })).toBeVisible();
  await expect(props.getByRole("row", { name: /YanginDayanimi\s*REI60/ })).toBeVisible();

  await props.getByRole("button", { name: "GlobalId'yi kopyala" }).click();
  await expect(props.getByRole("status")).toHaveText("Kopyalandı.");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(WALL.guid);

  expect(await page.evaluate(async () => window.__viewer!.selectedGuids())).toEqual([{ modelId: "wall", guids: [WALL.guid] }]);
});

test("closing the panel clears the selection", async ({ page }) => {
  const { props } = await selectWall(page);
  await props.getByRole("button", { name: "Seçimi kaldır" }).click();
  await expect(props).toHaveCount(0);
  expect(await page.evaluate(async () => window.__viewer!.selectedGuids())).toEqual([]);
});

test("hide, show all, isolate and X-ray change what is drawn", async ({ page }) => {
  const { face } = await selectWall(page);
  const slab = await screenOf(page, "wall", WALL.slabFront);
  const drawnWall = await pixel(page, face);
  expect(isBackground(drawnWall)).toBe(false);

  await page.keyboard.press("h");
  await expect.poll(async () => same(await pixel(page, face), drawnWall)).toBe(false);
  await page.getByRole("button", { name: "Görünürlük", exact: true }).click();
  const panel = page.locator(".vt-panel[aria-label='Görünürlük']");
  await expect(panel.getByRole("button", { name: /Tümünü Göster/ })).toBeEnabled();
  await panel.getByRole("button", { name: /Tümünü Göster/ }).click();
  await expect.poll(async () => isBackground(await pixel(page, face))).toBe(false);
  await expect(panel.getByRole("button", { name: /Tümünü Göster/ })).toBeDisabled();

  // Isolate the wall: the slab in front of it disappears.
  await selectWall(page);
  await page.keyboard.press("i");
  await expect.poll(async () => isBackground(await pixel(page, slab))).toBe(true);
  await page.keyboard.press("u");
  await expect.poll(async () => isBackground(await pixel(page, slab))).toBe(false);

});

test("X-ray makes the unselected slab see-through", async ({ page }) => {
  // Fragments draws highlights over the opaque base; ViewerEngine cuts the base under them
  // (src/core/overlay-groups.ts), otherwise the 12 % material changed nothing on screen.
  const { face } = await selectWall(page);
  const slab = await screenOf(page, "wall", WALL.slabFront);
  const solidSlab = await pixel(page, slab);
  expect(solidSlab[3]).toBe(255);
  await page.getByRole("button", { name: "X-Işını", exact: true }).click();
  await expect(page.getByRole("button", { name: "X-Işını", exact: true })).toHaveAttribute("aria-pressed", "true");
  // The slab lets the empty canvas through; the selected wall stays opaque.
  await expect.poll(async () => (await pixel(page, slab))[3], { timeout: 5_000 }).toBeLessThan(200);
  expect((await pixel(page, face))[3]).toBe(255);

  await page.keyboard.press("x");
  await expect.poll(async () => same(await pixel(page, slab), solidSlab)).toBe(true);
});

test("X-ray without a selection makes the whole model see-through", async ({ page }) => {
  const face = await screenOf(page, "wall", WALL.faceCenter);
  await page.keyboard.press("x");
  await expect.poll(async () => (await pixel(page, face))[3], { timeout: 5_000 }).toBeLessThan(250);
  await page.keyboard.press("x");
  await expect.poll(async () => (await pixel(page, face))[3]).toBe(255);
});

test("the selection volume uses the selected wall (5 × 0,2 × 3 m)", async ({ page }) => {
  await selectWall(page);
  await page.getByRole("button", { name: "Ölçü", exact: true }).click();
  const panel = page.locator(".vt-panel[aria-label='Ölçü']");
  await panel.getByRole("button", { name: "Hacim" }).click();
  await expect(panel.locator(".vt-value").first()).toHaveText(/^3,00 m³$/, { timeout: 15_000 });
});

function same(a: Rgba, b: Rgba) {
  return a.every((v, i) => Math.abs(v - b[i]!) <= 3);
}
