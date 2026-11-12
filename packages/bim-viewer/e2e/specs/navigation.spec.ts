import type { Page } from "@playwright/test";
import { cameraState, distance, expect, loadModels, lookAtWall, openViewer, screenOf, test, WALL, type Vec3 } from "../support/fixtures";

test.beforeEach(async ({ page }) => {
  await openViewer(page);
  await loadModels(page, "Duvar Modeli", "wall");
  await lookAtWall(page);
});

/** While walking the controls are off; the eye is the three.js camera itself. */
function eye(page: Page): Promise<Vec3> {
  return page.evaluate(() => window.__viewer!.world.camera.three.position.toArray() as [number, number, number]);
}

const nav = (page: Page) => page.evaluate(() => window.__tools!.state.nav);

test("1 / 2 / 3 switch Yörünge, Yürüme and Plan; the rail follows", async ({ page }) => {
  const rail = page.getByRole("toolbar", { name: "Görüntüleme Araçları" });
  await page.keyboard.press("3");
  await expect(rail.getByRole("radio", { name: /Plan/ })).toBeChecked();
  await page.keyboard.press("2");
  await expect(rail.getByRole("radio", { name: /Yürüme/ })).toBeChecked();
  await expect(page.getByRole("status")).toContainText("zemine tıklayın");
  await page.keyboard.press("Escape");
  await expect(rail.getByRole("radio", { name: /Yörünge/ })).toBeChecked();
  await expect(page.getByRole("status")).toHaveCount(0);
});

test("Plan lists the IFC storey, looks straight down orthographically and cuts above it", async ({ page }) => {
  await page.getByRole("radio", { name: /Plan/ }).click();
  const panel = page.locator(".vt-panel[aria-label='Plan']");
  await expect(panel.getByRole("radio", { name: "Zemin Kat" })).toBeVisible();
  await expect(panel.getByText("+0,00 m")).toBeVisible();
  await expect.poll(async () => (await cameraState(page)).projection).toBe("orthographic");

  await panel.getByRole("radio", { name: "Zemin Kat" }).check();
  await expect.poll(() => page.evaluate(() => window.__tools!.sections.hasPlanCut)).toBe(true);
  const cam = await cameraState(page);
  // Looking down: the eye is straight above the target.
  const height = cam.position[1] - cam.target[1];
  expect(Math.hypot(cam.position[0] - cam.target[0], cam.position[2] - cam.target[2]) / height).toBeLessThan(1e-3);
  expect(cam.position[1]).toBeGreaterThan(cam.target[1]);

  await panel.getByRole("radio", { name: "Tüm Model" }).check();
  await expect.poll(() => page.evaluate(() => window.__tools!.sections.hasPlanCut)).toBe(false);
  await page.keyboard.press("1");
  await expect(panel).toHaveCount(0);
  await expect.poll(async () => (await cameraState(page)).projection).toBe("perspective");
});

test("double click on the slab drops in at eye height and W A S D walk", async ({ page }) => {
  const slab = await screenOf(page, "wall", WALL.slabFront);
  await page.mouse.dblclick(slab.x, slab.y);
  await expect.poll(() => nav(page)).toBe("walk");
  await expect(page.getByRole("status")).toContainText("W A S D");
  await expect(page.getByRole("slider", { name: "Yürüme Hızı" })).toBeVisible();

  // Eye 1,70 m above the slab top (IFC z = 0).
  const floor = await page.evaluate(async () => (await window.__viewer!.ifcToScene([3, 2.5, 0], "wall"))!.y);
  await expect.poll(async () => (await eye(page))[1] - floor).toBeCloseTo(1.7, 1);

  const start = await eye(page);
  await page.keyboard.down("s");
  await page.waitForTimeout(600);
  await page.keyboard.up("s");
  const moved = await eye(page);
  expect(distance(start, moved)).toBeGreaterThan(0.3);

  await page.getByRole("button", { name: /Yürümeyi Bırak/ }).click();
  await expect.poll(() => nav(page)).toBe("orbit");
});

test("W A S D still walk after the speed slider was used", async ({ page }) => {
  const slab = await screenOf(page, "wall", WALL.slabFront);
  await page.mouse.dblclick(slab.x, slab.y);
  await expect.poll(() => nav(page)).toBe("walk");
  const slider = page.getByRole("slider", { name: "Yürüme Hızı" });
  await slider.fill("3");
  await expect(slider).toBeFocused();
  expect(await page.evaluate(() => window.__tools!.state.walkSpeed)).toBe(3);

  const start = await eye(page);
  await page.keyboard.down("s");
  await page.waitForTimeout(500);
  await page.keyboard.up("s");
  expect(distance(start, await eye(page))).toBeGreaterThan(0.5);
  await page.keyboard.press("Escape");
  await expect.poll(() => nav(page)).toBe("orbit");
});

test("walking does not pass through the wall", async ({ page }) => {
  const slab = await screenOf(page, "wall", WALL.slabFront);
  await page.mouse.dblclick(slab.x, slab.y);
  await expect.poll(() => nav(page)).toBe("walk");
  // Facing the wall: hold W long enough to cross it at 1,4 m/s without collision.
  await page.keyboard.down("w");
  await page.waitForTimeout(3_000);
  await page.keyboard.up("w");
  const wallFace = await page.evaluate(async () => (await window.__viewer!.ifcToScene([2.5, 0.2, 1.5], "wall"))!.z);
  const [, , z] = await eye(page);
  // The slab side of the wall is towards the camera (larger scene z = smaller IFC y… see WALL_VIEW).
  const facing = await page.evaluate(async () => (await window.__viewer!.ifcToScene([2.5, 2.5, 1.5], "wall"))!.z);
  expect(Math.sign(z - wallFace)).toBe(Math.sign(facing - wallFace));
});

test("F fits the model after the camera was moved away", async ({ page }) => {
  await page.evaluate(() => window.__viewer!.world.camera.controls.setLookAt(400, 300, 400, 0, 0, 0, false));
  const far = await cameraState(page);
  await page.keyboard.press("f");
  await expect.poll(async () => distance((await cameraState(page)).position, far.position)).toBeGreaterThan(100);
});

test("view cube faces turn the camera", async ({ page }) => {
  await page.locator(".vt-cube-face", { hasText: "Üst" }).click({ force: true });
  await expect
    .poll(async () => {
      const c = await cameraState(page);
      return Math.hypot(c.position[0] - c.target[0], c.position[2] - c.target[2]) < 0.05 && c.position[1] > c.target[1];
    })
    .toBe(true);
});
