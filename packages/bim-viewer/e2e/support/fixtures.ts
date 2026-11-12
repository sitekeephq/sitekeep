import { test as base, expect, type Page } from "@playwright/test";

type Diagnostics = { errors: string[]; allow(pattern: RegExp): void };

/** Console noise that is not a viewer failure: GPU driver notes, React/Vite banners. */
const IGNORED_CONSOLE = [
  /GL Driver Message/i,
  /GPU stall due to ReadPixels/i,
  /Download the React DevTools/i,
  /\[vite\]/i,
];

/**
 * Like the CDE harness: page errors, console errors and failed same-origin requests fail the
 * test unless a spec allows them. WebGL context loss is always a failure (leaked engines).
 */
export const test = base.extend<{ diagnostics: Diagnostics }>({
  diagnostics: [
    async ({ page }, use, testInfo) => {
      const allowed: RegExp[] = [];
      const errors: string[] = [];
      const record = (text: string) => {
        if (IGNORED_CONSOLE.some((re) => re.test(text))) return;
        if (allowed.some((re) => re.test(text))) return;
        errors.push(text);
      };
      page.on("pageerror", (error) => record(`pageerror: ${error.stack ?? error.message}`));
      page.on("console", (message) => {
        const text = message.text();
        if (/too many active webgl contexts|context lost/i.test(text)) errors.push(`webgl: ${text}`);
        else if (message.type() === "error") record(`console.error: ${text}`);
      });
      page.on("requestfailed", (request) => {
        const url = new URL(request.url());
        if (url.origin !== new URL(testInfo.project.use.baseURL as string).origin) return;
        const failure = request.failure()?.errorText ?? "unknown";
        if (/ERR_ABORTED|cancelled/i.test(failure)) return;
        record(`request ${url.pathname} failed: ${failure}`);
      });
      await use({ errors, allow: (pattern) => allowed.push(pattern) });
      if (errors.length && testInfo.status === testInfo.expectedStatus) {
        throw new Error(`Unexpected browser errors:\n${errors.join("\n")}`);
      }
    },
    { auto: true },
  ],
});

export { expect };

export type Vec3 = [number, number, number];
export type Rgba = [number, number, number, number];

/** Points on the fixture models (IFC metres, Z up); see e2e/fixtures/ifc/sample-wall.ifc. */
export const WALL = {
  guid: "3vB2YO$MX4xv5uCqZZG05x",
  slabGuid: "1pPHnf7cXCpPsNEnQf8_6B",
  /** Face of the 5 × 0.2 × 3 m wall towards the slab (IFC y = 0.2). */
  faceCenter: [2.5, 0.2, 1.5] as Vec3,
  faceLeft: [0.4, 0.2, 1.5] as Vec3,
  faceRight: [4.6, 0.2, 1.5] as Vec3,
  /** Top of the slab in front of the wall (slab spans x 0…6, y 0…4, z −0.25…0). */
  slabFront: [3, 2.5, 0] as Vec3,
};

/** Camera looking at the wall's front face from the slab side, in IFC coordinates. */
export const WALL_VIEW = { eye: [2.5, 9, 4] as Vec3, target: [2.5, 0, 1.2] as Vec3 };

export async function openViewer(page: Page, query = "") {
  await page.goto(`/${query}`);
  await expect(page.getByTestId("viewer-ready")).toBeVisible({ timeout: 45_000 });
}

/** Loads a model set through the playground buttons, as a user would. */
export async function loadModels(page: Page, set: "Duvar Modeli" | "Federasyon" | "Disiplinler", ids: string) {
  await page.getByRole("button", { name: set }).click();
  await expect(page.getByTestId("loaded-models")).toHaveText(ids, { timeout: 45_000 });
  await expect(page.getByRole("button", { name: set })).toBeEnabled();
}

/** Puts the camera on WALL_VIEW without a transition, so screen positions are deterministic. */
export async function lookAtWall(page: Page) {
  await page.evaluate(async ({ eye, target }) => {
    const viewer = window.__viewer!;
    const e = (await viewer.ifcToScene(eye, "wall"))!;
    const t = (await viewer.ifcToScene(target, "wall"))!;
    await viewer.world.camera.controls.setLookAt(e.x, e.y, e.z, t.x, t.y, t.z, false);
    viewer.fragments.core.update(true);
  }, WALL_VIEW);
}

export async function screenOf(page: Page, modelId: string, point: Vec3) {
  const p = await page.evaluate(([id, pt]) => window.__pg!.screenOf(id, pt), [modelId, point] as const);
  if (!p) throw new Error(`no screen position for ${modelId}`);
  return p;
}

export function pixel(page: Page, at: { x: number; y: number }): Promise<Rgba> {
  return page.evaluate(({ x, y }) => window.__pg!.pixel(x, y), at);
}

/** The scene has no background: empty canvas pixels are transparent (only the grid shows). */
export function isBackground([, , , a]: Rgba) {
  return a < 250;
}

export async function cameraState(page: Page) {
  return page.evaluate(() => window.__viewer!.cameraState());
}

export function distance(a: Vec3, b: Vec3) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

export interface SectionStats {
  /** Cut lines (LineSegments2): drawn instances and the instances their buffer holds. */
  lines: { instances: number; capacity: number }[];
  /** Cut fills: vertex positions held and indices drawn. */
  fills: { positions: number; indices: number }[];
}

/** What the ClipEdges of the current section planes hold and draw. */
export function sectionStats(page: Page): Promise<SectionStats> {
  return page.evaluate(() => {
    const edges = (window.__tools!.sections as unknown as { edges: Map<string, { three: import("three").Object3D }> }).edges;
    const stats: SectionStats = { lines: [], fills: [] };
    for (const e of edges.values()) {
      e.three.traverse((o) => {
        const object = o as import("three").Mesh & { isLineSegments2?: boolean };
        const geometry = object.geometry as import("three").BufferGeometry & { instanceCount?: number };
        if (object.isLineSegments2) {
          const start = geometry.attributes.instanceStart;
          if (start) stats.lines.push({ instances: geometry.instanceCount!, capacity: start.count });
        } else if (object.isMesh && geometry.index) {
          stats.fills.push({ positions: geometry.attributes.position!.count, indices: geometry.index.count });
        }
      });
    }
    return stats;
  });
}

/** Waits until every section plane has its cut line for every loaded model, and a frame drew them. */
export async function waitForSections(page: Page, planes: number) {
  const models = await page.evaluate(() => window.__viewer!.loadedIds.length);
  await expect.poll(async () => (await sectionStats(page)).lines.length, { timeout: 30_000 }).toBe(planes * models);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

/** Average and slowest of the next frames (requestAnimationFrame intervals, first two skipped). */
export function frameTimes(page: Page, frames = 30): Promise<{ avg: number; max: number }> {
  return page.evaluate(
    (n) =>
      new Promise((resolve) => {
        const times: number[] = [];
        let last = performance.now();
        const step = (now: number) => {
          times.push(now - last);
          last = now;
          if (times.length < n + 2) return requestAnimationFrame(step);
          const kept = times.slice(2);
          resolve({ avg: kept.reduce((a, b) => a + b, 0) / kept.length, max: Math.max(...kept) });
        };
        requestAnimationFrame(step);
      }),
    frames,
  );
}

/** The page never scrolls sideways (phone layouts). */
export async function assertNoSidewaysScroll(page: Page) {
  const extra = await page.evaluate(
    () => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth,
  );
  expect(extra, "the page should not scroll sideways").toBeLessThanOrEqual(1);
}

/** The element lies fully inside the viewport. */
export async function assertInViewport(page: Page, locator: ReturnType<Page["locator"]>) {
  const box = await locator.boundingBox();
  const size = page.viewportSize()!;
  expect(box, "element should be rendered").not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(size.width + 1);
  expect(box!.y + box!.height).toBeLessThanOrEqual(size.height + 1);
}
