import type { Page } from "@playwright/test";
import { expect, loadModels, lookAtWall, openViewer, pixel, screenOf, test, WALL, type Rgba } from "../support/fixtures";

/**
 * Generic painting the CDE builds on (model comparison, 4D, clash): the colour must reach the
 * pixels of the element, not only the engine state.
 */
test.beforeEach(async ({ page }) => {
  await openViewer(page);
  await loadModels(page, "Duvar Modeli", "wall");
  await lookAtWall(page);
});

type Hue = "red" | "green" | "blue" | "orange" | "grey";

function hue([r, g, b]: Rgba): Hue {
  if (Math.max(r, g, b) - Math.min(r, g, b) < 25) return "grey";
  if (r > g && r > b) return g > b + 40 ? "orange" : "red";
  if (g > r && g > b) return "green";
  return "blue";
}

async function wallHue(page: Page) {
  const face = await screenOf(page, "wall", WALL.faceCenter);
  return hue(await pixel(page, face));
}

test("comparison paints added green and clears back to the model colours", async ({ page }) => {
  expect(await wallHue(page)).toBe("grey");
  await page.evaluate(
    (guid) =>
      window.__viewer!.showComparison({ newModelId: "wall", added: [guid], changed: [], fadeUnchanged: true, oldModelId: null, removed: [] }),
    WALL.guid,
  );
  await expect.poll(() => wallHue(page)).toBe("green");
  await page.evaluate(() => window.__viewer!.clearComparison());
  await expect.poll(() => wallHue(page)).toBe("grey");
});

test("4D colours follow the task status", async ({ page }) => {
  await page.evaluate(
    (guid) => window.__viewer!.show4D({ not_started: [], in_progress: [], complete: [], late: [guid] }, false),
    WALL.guid,
  );
  await expect.poll(() => wallHue(page)).toBe("red");
  await page.evaluate(() => window.__viewer!.clear4D());
  await expect.poll(() => wallHue(page)).toBe("grey");
});

test("a clash marks element A in red and focuses it", async ({ page }) => {
  const found = await page.evaluate(
    ([a, b]) => window.__viewer!.showClash({ a: { modelId: "wall", globalId: a }, b: { modelId: "wall", globalId: b } }),
    [WALL.guid, WALL.slabGuid] as const,
  );
  expect(found).toBe(true);
  await expect.poll(() => wallHue(page)).toBe("red");
  await page.evaluate(() => window.__viewer!.clearClash());
  await expect.poll(() => wallHue(page)).toBe("grey");
});

test("view rules colour an IFC class per file", async ({ page }) => {
  await page.evaluate(() =>
    window.__viewer!.applyRules([{ classes: ["IFCWALL"], action: "color", color: "#2e90fa" }], { wall: "file-1" }),
  );
  await expect.poll(() => wallHue(page)).toBe("blue");
  await page.evaluate(() => window.__viewer!.clearRules());
  await expect.poll(() => wallHue(page)).toBe("grey");
});

/** See-through paints draw over the opaque base in Fragments; the engine cuts it away. */
async function slabAlpha(page: Page) {
  const slab = await screenOf(page, "wall", WALL.slabFront);
  return (await pixel(page, slab))[3];
}

test("comparison fades the unchanged slab", async ({ page }) => {
  expect(await slabAlpha(page)).toBe(255);
  await page.evaluate(
    (guid) =>
      window.__viewer!.showComparison({ newModelId: "wall", added: [guid], changed: [], fadeUnchanged: true, oldModelId: null, removed: [] }),
    WALL.guid,
  );
  await expect.poll(() => slabAlpha(page), { timeout: 5_000 }).toBeLessThan(200);
  expect(await wallHue(page)).toBe("green");
  await page.evaluate(() => window.__viewer!.clearComparison());
  await expect.poll(() => slabAlpha(page)).toBe(255);
});

test("4D fades elements linked to no activity", async ({ page }) => {
  await page.evaluate(
    (guid) => window.__viewer!.show4D({ not_started: [], in_progress: [guid], complete: [], late: [] }, true),
    WALL.guid,
  );
  await expect.poll(() => slabAlpha(page), { timeout: 5_000 }).toBeLessThan(200);
  expect(await wallHue(page)).toBe("orange");
  await page.evaluate(() => window.__viewer!.clear4D());
  await expect.poll(() => slabAlpha(page)).toBe(255);
});

test("a view rule with opacity makes its class see-through", async ({ page }) => {
  await page.evaluate(() =>
    window.__viewer!.applyRules([{ classes: ["IFCSLAB"], action: "color", color: "#9aa5b1", opacity: 0.2 }], { wall: "file-1" }),
  );
  await expect.poll(() => slabAlpha(page), { timeout: 5_000 }).toBeLessThan(200);
  await page.evaluate(() => window.__viewer!.clearRules());
  await expect.poll(() => slabAlpha(page)).toBe(255);
});
