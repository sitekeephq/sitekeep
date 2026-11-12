import type { Page } from "@playwright/test";
import {
  assertInViewport,
  assertNoSidewaysScroll,
  expect,
  frameTimes,
  loadModels,
  lookAtWall,
  openViewer,
  screenOf,
  sectionStats,
  test,
  waitForSections,
  WALL,
  type Vec3,
} from "../support/fixtures";

/**
 * iPhone 13 (390 × 844, touch, coarse pointer). The tool rail is hidden ≤ 700 px; the host shows
 * the package's toolMoreItems in its "⋯ Diğer" menu (as the CDE Viewer page does).
 */
test.beforeEach(async ({ page }) => {
  await openViewer(page);
  await loadModels(page, "Duvar Modeli", "wall");
  await lookAtWall(page);
});

const more = (page: Page) => page.getByRole("button", { name: /Diğer/ });

async function choose(page: Page, label: RegExp) {
  await more(page).tap();
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  await assertInViewport(page, menu);
  await menu.getByRole("menuitem", { name: label }).or(menu.getByRole("menuitemcheckbox", { name: label })).tap();
  await expect(menu).toHaveCount(0);
}

async function tapAt(page: Page, point: Vec3) {
  const p = await screenOf(page, "wall", point);
  await page.touchscreen.tap(p.x, p.y);
  await page.waitForTimeout(200);
}

test("the rail is replaced by the ⋯ Diğer menu and nothing scrolls sideways", async ({ page }) => {
  await expect(page.getByRole("toolbar", { name: "Görüntüleme Araçları" })).toBeHidden();
  await expect(page.locator(".vt-cube")).toBeVisible();
  // The phone cube is built at 52 px (68 px on desktop).
  await expect(page.locator(".vt-cube-face").first()).toHaveCSS("width", "52px");
  await assertInViewport(page, page.locator(".vt-cube"));

  await more(page).tap();
  const menu = page.getByRole("menu");
  await expect(menu.getByRole("menuitemcheckbox", { name: /Yörünge/ })).toHaveAttribute("aria-checked", "true");
  for (const name of [/Yürüme/, /Plan/, /Kesit Kutusu/, /Kesit Düzlemi/, /Ölçü Al/, /X-Işını/]) {
    await expect(menu.getByRole("menuitemcheckbox", { name })).toBeVisible();
  }
  await expect(menu.getByRole("menuitem", { name: /Görüntü Al/ })).toBeVisible();
  // Selection-only items appear after a selection.
  await expect(menu.getByRole("menuitem", { name: /Gizle/ })).toHaveCount(0);
  await assertInViewport(page, menu);
  await assertNoSidewaysScroll(page);
});

test("tapping the wall opens its properties as a bottom sheet and enables the selection items", async ({ page }) => {
  await tapAt(page, WALL.faceCenter);
  const props = page.getByRole("complementary", { name: "Özellikler" });
  await expect(props.getByRole("heading", { name: "Duvar-01" })).toBeVisible();
  await assertInViewport(page, props);
  await assertNoSidewaysScroll(page);

  await choose(page, /Gizle/);
  await expect.poll(() => page.evaluate(() => window.__tools!.state.hidden)).toBe(true);
  await choose(page, /Tümünü Göster/);
  await expect.poll(() => page.evaluate(() => window.__tools!.state.hidden)).toBe(false);
});

test("two taps measure a length and the list shows it in the sheet", async ({ page }) => {
  await choose(page, /Ölçü Al/);
  const panel = page.locator(".vt-panel[aria-label='Ölçü']");
  await expect(panel).toBeVisible();
  await assertInViewport(page, panel);
  await tapAt(page, [0, 0.2, 3]);
  await expect(panel.getByText("İkinci noktaya dokunun.")).toBeVisible();
  await tapAt(page, [5, 0.2, 3]);
  await expect(panel.locator(".vt-value")).toHaveText([/^[45],\d\d m$/]);
  const value = await page.evaluate(() => window.__tools!.state.measurements[0]!.value!);
  expect(value).toBeGreaterThan(4.5);
  expect(value).toBeLessThanOrEqual(5.01);

  await more(page).tap();
  await expect(page.getByRole("menu").getByRole("menuitem", { name: /Ölçüler \(1\)/ })).toBeVisible();
  await page.keyboard.press("Escape");
});

test("a second tap on the first point keeps waiting for the end point", async ({ page }) => {
  await choose(page, /Ölçü Al/);
  const panel = page.locator(".vt-panel[aria-label='Ölçü']");
  await tapAt(page, WALL.faceCenter);
  await tapAt(page, WALL.faceCenter);
  await expect(panel.getByText("İkinci noktaya dokunun.")).toBeVisible();
  expect(await page.evaluate(() => window.__tools!.state.measurements)).toEqual([]);
  await tapAt(page, [5, 0.2, 3]);
  await expect(panel.locator(".vt-value")).toHaveCount(1);
});

test("the section box from the menu shows its count and the sheet can remove it", async ({ page }) => {
  await choose(page, /Kesit Kutusu/);
  await expect.poll(() => page.evaluate(() => window.__tools!.state.box)).toBe(true);
  await choose(page, /Kesitler \(1\)/);
  const panel = page.locator(".vt-panel[aria-label='Kesit']");
  await expect(panel).toBeVisible();
  await assertInViewport(page, panel);
  await panel.getByRole("button", { name: /Kutuyu Kaldır/ }).tap();
  await expect.poll(() => page.evaluate(() => window.__tools!.state.box)).toBe(false);
});

test("the section box over three disciplines stays compact and fluid on the phone", async ({ page }) => {
  // Four models + box + fills: CI's two-core software renderer needs more than the default minute.
  test.setTimeout(120_000);
  await loadModels(page, "Disiplinler", "wall,mimari,statik,mekanik");
  const idle = await frameTimes(page);
  await choose(page, /Kesit Kutusu/);
  await waitForSections(page, 6);
  const stats = await sectionStats(page);
  expect(stats.lines).toHaveLength(24);
  for (const line of stats.lines) expect(line.capacity).toBeLessThan(5_000);
  const boxed = await frameTimes(page);
  expect(boxed.avg).toBeLessThan(idle.avg * 6 + 100);
  await choose(page, /Kesitler \(1\)/);
  await assertInViewport(page, page.locator(".vt-panel[aria-label='Kesit']"));
  await assertNoSidewaysScroll(page);
});

test("walking: menu → tap the floor → the joystick moves the eye; the speed bar stays on screen", async ({ page }) => {
  await choose(page, /Yürüme/);
  await expect(page.getByRole("status")).toContainText("zemine tıklayın");
  await tapAt(page, WALL.slabFront);
  await expect(page.getByRole("status")).toContainText("Sol alttaki kolla");

  const joystick = page.getByLabel("Yürüme Kolu");
  await expect(joystick).toBeVisible();
  await assertInViewport(page, joystick);
  await assertInViewport(page, page.getByRole("status"));
  // The walk bar must not cover the joystick.
  const bar = (await page.getByRole("status").boundingBox())!;
  const stick = (await joystick.boundingBox())!;
  expect(bar.y + bar.height <= stick.y || stick.y + stick.height <= bar.y).toBe(true);

  const eye = () => page.evaluate(() => window.__viewer!.world.camera.three.position.toArray());
  const start = await eye();
  const c = { x: stick.x + stick.width / 2, y: stick.y + stick.height / 2 };
  // Pull the knob down (backwards, away from the wall).
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  await page.mouse.move(c.x, c.y + 40, { steps: 4 });
  await page.waitForTimeout(700);
  await page.mouse.up();
  const end = await eye();
  expect(Math.hypot(end[0]! - start[0]!, end[2]! - start[2]!)).toBeGreaterThan(0.3);

  await page.getByRole("button", { name: /Yürümeyi Bırak/ }).tap();
  await expect(joystick).toHaveCount(0);
  await assertNoSidewaysScroll(page);
});

test("plan from the menu lists the storey in the sheet", async ({ page }) => {
  await choose(page, /Plan/);
  const panel = page.locator(".vt-panel[aria-label='Plan']");
  await expect(panel.getByRole("radio", { name: "Zemin Kat" })).toBeVisible();
  await assertInViewport(page, panel);
  await choose(page, /Yörünge/);
  await expect(panel).toHaveCount(0);
});

test("the scan viewer fits the phone screen", async ({ page }) => {
  await page.goto("/scan.html");
  await expect(page.getByText("Katmanlar")).toBeVisible({ timeout: 45_000 });
  await expect(page.getByRole("toolbar", { name: "IoT araçları" })).toBeVisible();
  await assertNoSidewaysScroll(page);
});
