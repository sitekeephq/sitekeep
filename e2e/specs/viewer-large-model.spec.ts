/**
 * #158: a 12 km line model opened blank (model and grid): Fit stood the camera ~12 km away and
 * the 1000 m far plane clipped everything. The far plane now follows the loaded models.
 * Core only: passes with and without modules.
 */
import type { Page } from "@playwright/test";
import { test, expect, runState } from "../support/fixtures";
import { uploadIfcBuffer } from "../support/seed-files";
import { generateSiteIfc } from "../support/site-ifc";

/** Share of canvas pixels that differ from the corner (background) colour. */
async function paintedShare(page: Page): Promise<number> {
  return page.locator(".viewer-container canvas").first().evaluate((el) => {
    const src = el as HTMLCanvasElement;
    const c = document.createElement("canvas");
    c.width = 200;
    c.height = Math.max(1, Math.round((200 * src.height) / src.width));
    const ctx = c.getContext("2d")!;
    ctx.drawImage(src, 0, 0, c.width, c.height);
    const { data } = ctx.getImageData(0, 0, c.width, c.height);
    const [r, g, b, a] = [data[0], data[1], data[2], data[3]];
    let differ = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (Math.abs(data[i] - r) + Math.abs(data[i + 1] - g) + Math.abs(data[i + 2] - b) + Math.abs(data[i + 3] - a) > 24) differ++;
    }
    return differ / (data.length / 4);
  });
}

test("a 12 km model is drawn after Fit", async ({ page, diagnostics }) => {
  void diagnostics;
  test.setTimeout(180_000);
  const { project } = await runState();
  const stamp = Date.now().toString(36);
  // A 12 km × 30 m deck: the site fixture with its floor slab stretched along x.
  const slab = "IFCRECTANGLEPROFILEDEF(.AREA.,'Doseme',#62,24.,16.)";
  const site = generateSiteIfc(1, 2).text;
  expect(site).toContain(slab);
  const line = site.replace(slab, "IFCRECTANGLEPROFILEDEF(.AREA.,'Doseme',#62,12000.,30.)").replace("#81=IFCEXTRUDEDAREASOLID(#80,#13,#11,0.25)", "#81=IFCEXTRUDEDAREASOLID(#80,#13,#11,2.)");
  const ifc = await uploadIfcBuffer(page.request, project.id, project.rootFolderId, `e2e-line-${stamp}.ifc`, Buffer.from(line));

  await page.goto(`/projects/${project.id}/viewer?v=${ifc.versionId}`);
  const fit = page.getByRole("button", { name: /Sığdır/ });
  await expect(fit).toBeEnabled({ timeout: 90_000 });
  await fit.click();
  await expect.poll(() => paintedShare(page), { timeout: 20_000 }).toBeGreaterThan(0.002);
});
