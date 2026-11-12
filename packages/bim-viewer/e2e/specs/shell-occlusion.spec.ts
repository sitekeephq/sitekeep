import { expect, openViewer, test, type Rgba } from "../support/fixtures";

/**
 * Small cladding panels in front of a red structural plate. Zooming out used to
 * delete those panels (and, closer in, draw them as wires), so the plate showed
 * through the facade and disappeared again on zoom in. The wheel's farthest
 * pull is 300 m. Samples are panel centres on the outer face.
 */
const PANELS: [number, number, number][] = [
  [1.125, 0, 1.5],
  [3, 0, 3],
  [4.875, 0, 4.5],
];
/** Out to the wheel limit, then back in, then out again. */
const ZOOM = [300, 180, 80, 30, 10, 30, 80, 180, 300];

function isRed([r, g, b, a]: Rgba) {
  return a > 240 && r > 120 && r > g + 40 && r > b + 40;
}

async function zoomTo(page: import("@playwright/test").Page, distance: number) {
  const actual = await page.evaluate(async (away) => {
    const viewer = window.__viewer!;
    await viewer.world.camera.controls.dollyTo(away, false);
    await viewer.fragments.core.update(true);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return viewer.world.camera.controls.distance;
  }, distance);
  expect(actual, `dolly to ${distance} m`).toBeGreaterThan(distance - 1);
  expect(actual).toBeLessThan(distance + 1);
  return actual;
}

async function panelColours(page: import("@playwright/test").Page): Promise<Rgba[]> {
  return page.evaluate(async (points) => {
    const colours: Rgba[] = [];
    for (const point of points) {
      const at = await window.__pg!.screenOf("kabuk", point);
      const pixel = at ? await window.__pg!.pixel(at.x, at.y) : null;
      colours.push(pixel ? [pixel[0], pixel[1], pixel[2], pixel[3]] : [0, 0, 0, 0]);
    }
    return colours;
  }, PANELS);
}

async function expectShell(page: import("@playwright/test").Page, distance: number) {
  const colours = await panelColours(page);
  for (const colour of colours) {
    expect(isRed(colour), `${distance} m panel read ${colour.join(",")}`).toBe(false);
  }
}

test("zooming in and back out keeps the red frame behind the cladding", async ({ page }) => {
  test.setTimeout(120_000);
  await openViewer(page);
  await page.evaluate(async () => {
    const viewer = window.__viewer!;
    await viewer.load("kabuk", "/models/shell-facade.frag");
    await viewer.align("kabuk");
    await viewer.load("karkas", "/models/shell-frame.frag");
    await viewer.align("karkas");
    await viewer.applyRules(
      [{ classes: ["IFCWALL"], action: "color", color: "#d92d20", fileIds: ["karkas"] }],
      { kabuk: "kabuk", karkas: "karkas" },
    );
    const eye = (await viewer.ifcToScene([3, -80, 3], "kabuk"))!;
    const target = (await viewer.ifcToScene([3, 0, 3], "kabuk"))!;
    await viewer.world.camera.controls.setLookAt(eye.x, eye.y, eye.z, target.x, target.y, target.z, false);
    await viewer.fragments.core.update(true);
  });

  const quality = await page.evaluate(() => window.__viewer!.fragments.list.get("kabuk")!.graphicsQuality);
  expect(quality).toBeCloseTo(4 / 3);

  for (const distance of ZOOM) {
    await zoomTo(page, distance);
    await expectShell(page, distance);
  }

  // The wheel itself, not only dollyTo: in, then back out.
  const closer = await page.evaluate(async () => {
    const viewer = window.__viewer!;
    await viewer.world.camera.controls.dolly(40, false);
    await viewer.fragments.core.update(true);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return viewer.world.camera.controls.distance;
  });
  expect(closer).toBeGreaterThan(250);
  expect(closer).toBeLessThan(270);
  await expectShell(page, closer);
  const back = await page.evaluate(async () => {
    const viewer = window.__viewer!;
    await viewer.world.camera.controls.dolly(-40, false);
    await viewer.fragments.core.update(true);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return viewer.world.camera.controls.distance;
  });
  expect(back).toBeGreaterThan(290);
  expect(back).toBeLessThan(310);
  await expectShell(page, back);

  // Default distance culling at the wheel limit is the bug: the plate shows through.
  await page.evaluate(async () => {
    const viewer = window.__viewer!;
    for (const id of ["kabuk", "karkas"]) {
      const model = viewer.fragments.list.get(id)!;
      model.graphicsQuality = 0;
      await model.setLodMode(0);
    }
    await viewer.fragments.core.update(true);
  });
  await zoomTo(page, 180);
  await zoomTo(page, 300);
  const wires = await panelColours(page);
  expect(wires.filter(isRed).length, `default lod at 300 m ${JSON.stringify(wires)}`).toBeGreaterThan(0);
});
