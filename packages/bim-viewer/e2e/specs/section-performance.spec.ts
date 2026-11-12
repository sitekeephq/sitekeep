import type { Page } from "@playwright/test";
import { expect, frameTimes, loadModels, openViewer, sectionStats, test, waitForSections, type SectionStats } from "../support/fixtures";

/**
 * Section box over several discipline models (Mimari / Statik / Mekanik), with "Kesit Dolgusu"
 * on as by default. ClipEdges builds every cut line from Fragments' fixed 600 000-float section
 * buffer: undone, each line drew 100 000 fat-line instances (18 lines here: ~1,8 M a frame,
 * 78 ms frames on an Apple M3, ~9 s in CI's software renderer). The viewer compacts the cut
 * meshes before each frame (src/tools/section-meshes.ts).
 */
const DISCIPLINES = "mimari,statik,mekanik";
/** Far above any real cut of the fixtures (largest ~1 000 segments), far below 100 000. */
const MAX_SEGMENTS = 5_000;
/**
 * Slowest acceptable frame. CI renders in software on two cores: ~0,6 s there with the box (the
 * same frame takes ~9 s unfixed), 8 ms on an Apple M3.
 */
const MAX_FRAME_MS = 3_000;

test.beforeEach(async ({ page }) => {
  await openViewer(page);
  await loadModels(page, "Disiplinler", DISCIPLINES);
});

function expectCompact(stats: SectionStats) {
  expect(stats.lines.length).toBeGreaterThan(0);
  for (const line of stats.lines) {
    expect(line.instances).toBeLessThanOrEqual(line.capacity);
    expect(line.capacity).toBeLessThan(MAX_SEGMENTS);
  }
  for (const fill of stats.fills) expect(fill.positions).toBeLessThan(MAX_SEGMENTS * 2);
}

async function openBox(page: Page) {
  await page.getByRole("button", { name: "Kesit", exact: true }).click();
  await page.getByRole("button", { name: /Kesit Kutusu/ }).click();
  await expect(page.getByRole("button", { name: /Kutuyu Kaldır/ })).toBeVisible();
  await waitForSections(page, 6);
}

test("the section box over three disciplines draws only the real cut segments", async ({ page }) => {
  await openBox(page);
  const stats = await sectionStats(page);
  expect(stats.lines).toHaveLength(18);
  expectCompact(stats);
  // The building is cut: there are real lines and filled cut faces.
  expect(stats.lines.reduce((sum, line) => sum + line.instances, 0)).toBeGreaterThan(100);
  expect(stats.fills.some((fill) => fill.indices > 0)).toBe(true);
});

test("frames with the section box and fills stay close to frames without it", async ({ page }) => {
  const idle = await frameTimes(page);
  await openBox(page);
  const boxed = await frameTimes(page);
  // Generous for CI's software renderer (there: ~25 ms idle, ~75 ms boxed; ~9 000 ms unfixed).
  expect(boxed.avg, `idle ${idle.avg.toFixed(0)} ms, boxed ${boxed.avg.toFixed(0)} ms`).toBeLessThan(idle.avg * 6 + 100);
  expect(boxed.max).toBeLessThan(MAX_FRAME_MS);
});

test("orbiting with the section box stays fluid", async ({ page }) => {
  await openBox(page);
  const frames = frameTimes(page, 12);
  await page.mouse.move(640, 620);
  await page.mouse.down();
  await page.mouse.move(820, 560, { steps: 8 });
  await page.mouse.up();
  // The average: on CI's software renderer single frames spike while tiles stream in.
  const { avg } = await frames;
  expect(avg).toBeLessThan(MAX_FRAME_MS);
  expectCompact(await sectionStats(page));
});

test("the cut recomputed after a face drag is compact too", async ({ page }) => {
  await openBox(page);
  const before = await sectionStats(page);
  const topBefore = await page.evaluate(() => window.__tools!.sections.state().box!.max[1]!);
  // The end of a gizmo drag: move the top face down 4 m and fire the drag-end events (ClipStyler
  // then recomputes that face for every model, SectionTool syncs the box).
  await page.evaluate(() => {
    const sections = window.__tools!.sections as unknown as {
      clipper: { list: Map<string, unknown>; onAfterDrag: { trigger(): void } };
      entries: Map<string, { kind: string; axis?: string; side?: string }>;
    };
    const [id] = [...sections.entries].find(([, e]) => e.kind === "box" && e.axis === "y" && e.side === "max")!;
    const plane = sections.clipper.list.get(id) as {
      normal: import("three").Vector3;
      helper: { position: import("three").Vector3 };
      setFromNormalAndCoplanarPoint(n: import("three").Vector3, p: import("three").Vector3): void;
      onDraggingEnded: { trigger(): void };
    };
    const point = plane.helper.position.clone();
    point.y -= 4;
    plane.setFromNormalAndCoplanarPoint(plane.normal.clone(), point);
    plane.onDraggingEnded.trigger();
    sections.clipper.onAfterDrag.trigger();
  });
  await expect.poll(async () => JSON.stringify((await sectionStats(page)).lines)).not.toBe(JSON.stringify(before.lines));
  expectCompact(await sectionStats(page));
  expect(await page.evaluate(() => window.__tools!.sections.state().box!.max[1]!)).toBeCloseTo(topBefore - 4, 3);
});

test("switching Kesit Dolgusu off and on rebuilds compact fills", async ({ page }) => {
  await openBox(page);
  const panel = page.locator(".vt-panel[aria-label='Kesit']");
  await panel.getByRole("checkbox", { name: "Kesit Dolgusu" }).uncheck();
  await panel.getByRole("checkbox", { name: "Kesit Dolgusu" }).check();
  await waitForSections(page, 6);
  expectCompact(await sectionStats(page));
});

test("a free section plane and the Plan cut are compact as well", async ({ page }) => {
  await page.evaluate(() => window.__tools!.sections.addPlane([10, 5, -6], [1, 0, 0]));
  await waitForSections(page, 1);
  expectCompact(await sectionStats(page));
  await page.evaluate(() => window.__tools!.sections.clear());

  await page.keyboard.press("3");
  const plan = page.locator(".vt-panel[aria-label='Plan']");
  await plan.getByRole("radio", { name: "Kat 2" }).check();
  await expect.poll(() => page.evaluate(() => window.__tools!.sections.hasPlanCut)).toBe(true);
  await waitForSections(page, 1);
  expectCompact(await sectionStats(page));
});

test("fills draw triangles and removing the box removes its cut meshes", async ({ page }) => {
  const triangles = () => page.evaluate(() => (window.__viewer!.world.renderer!.three as import("three").WebGLRenderer).info.render.triangles);
  await openBox(page);
  await frameTimes(page, 3);
  const withFills = await triangles();
  const panel = page.locator(".vt-panel[aria-label='Kesit']");
  await panel.getByRole("checkbox", { name: "Kesit Dolgusu" }).uncheck();
  await frameTimes(page, 3);
  expect(withFills).toBeGreaterThan(await triangles());

  await page.getByRole("button", { name: /Kutuyu Kaldır/ }).click();
  await expect.poll(async () => (await sectionStats(page)).lines.length).toBe(0);
});

test("selecting while the section box is on settles (no forced-update fence hang)", async ({ page }) => {
  await openBox(page);
  // Highlighter.updateColors used to await Fragments' forced update, which with section planes
  // could wait until the camera moved; on CI about every second selection hung.
  for (let i = 0; i < 3; i++) {
    const outcome = await page.evaluate(async (n) => {
      const viewer = window.__viewer!;
      const model = viewer.fragments.list.get("mimari")!;
      const ids = await model.getLocalIds();
      const select = viewer.highlighter.highlightByID("select", { mimari: new Set([ids[n + 1]!]) }, true, false).then(() => "settled");
      const timeout = new Promise<string>((resolve) => setTimeout(() => resolve("hung"), 8_000));
      return Promise.race([select, timeout]);
    }, i);
    expect(outcome).toBe("settled");
  }
  await expect(page.getByRole("complementary", { name: "Özellikler" })).toBeVisible();
});

test("changing the box or opening a viewpoint with a box reuses the faces (no shader recompiles)", async ({ page }) => {
  await page.evaluate(() => {
    const proto = WebGL2RenderingContext.prototype as unknown as { linkProgram(...args: unknown[]): void };
    const link = proto.linkProgram;
    (window as unknown as { __links: number }).__links = 0;
    proto.linkProgram = function (...args: unknown[]) {
      (window as unknown as { __links: number }).__links++;
      return link.apply(this, args);
    };
  });
  await openBox(page);
  const faces = await page.evaluate(() => window.__tools!.sections.planes.map((p) => p.id));
  const links = () => page.evaluate(() => (window as unknown as { __links: number }).__links);
  await frameTimes(page, 5);
  const before = await links();

  await page.evaluate(() => {
    const sections = window.__tools!.sections;
    const box = sections.box!.clone();
    box.max.y -= 1.5;
    sections.setBox(box);
  });
  await waitForSections(page, 6);
  const viewpoint = await page.evaluate(() => window.__viewer!.viewpoint());
  await page.evaluate((vp) => {
    const box = vp.sections!.box!;
    return window.__viewer!.applyViewpoint({ ...vp, sections: { planes: [], box: { min: box.min, max: [box.max[0]!, box.max[1]! - 1, box.max[2]!] } } });
  }, JSON.parse(JSON.stringify(viewpoint)));
  await waitForSections(page, 6);
  await frameTimes(page, 5);

  expect(await page.evaluate(() => window.__tools!.sections.planes.map((p) => p.id))).toEqual(faces);
  expect(await links()).toBe(before);
  expectCompact(await sectionStats(page));
});
