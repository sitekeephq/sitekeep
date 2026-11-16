/**
 * DWG/DXF viewer layer panel (SiteKeep Community): every layer is listed with its state; frozen
 * and off layers are hidden when the drawing opens (as in AutoCAD) and can be turned on, locked
 * layers are shown and marked, colours are kept. Checked on the browser-parsed DXF and on the
 * server-built 2D scene. layers.dxf: DUVAR (on), DONMUS (frozen), KAPALI (off), KILITLI (locked).
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { APIRequestContext, Page } from "@playwright/test";
import { test, expect, runState } from "../support/fixtures";
import { E2E_FIXTURES, uploadProjectFile } from "../support/seed-files";

async function upload(request: APIRequestContext) {
  const { project } = await runState();
  const name = `e2e-layers-${Date.now().toString(36)}.dxf`;
  const { fileId } = await uploadProjectFile(request, project.id, project.rootFolderId, name, await readFile(path.join(E2E_FIXTURES, "layers.dxf")), "image/vnd.dxf");
  const file = await (await request.get(`/api/v1/projects/${project.id}/files/${fileId}`)).json();
  return { pid: project.id, vid: file.latest.id as string };
}

async function checkPanel(page: Page) {
  await expect(page.getByText("Çizim yükleniyor…")).toHaveCount(0, { timeout: 30_000 });
  const panel = page.locator(".cad-layers");
  await expect(page.getByRole("button", { name: "Katmanlar (4)" })).toBeVisible();
  const row = (name: string) => panel.locator(".cad-layer").filter({ hasText: name });
  await expect(row("DUVAR").getByRole("checkbox")).toBeChecked();
  await expect(row("DONMUS")).toContainText("Donmuş");
  await expect(row("DONMUS").getByRole("checkbox")).not.toBeChecked();
  await expect(row("KAPALI")).toContainText("Kapalı");
  await expect(row("KAPALI").getByRole("checkbox")).not.toBeChecked();
  await expect(row("KILITLI")).toContainText("Kilitli");
  await expect(row("KILITLI").getByRole("checkbox")).toBeChecked();
  // Colours kept: ACI 3 (green) on the frozen layer, ACI 5 (blue) on the off layer (shade corrected against the background).
  await expect(row("DONMUS").locator(".cad-swatch")).toHaveAttribute("style", /background: rgb\(0, \d+, 0\)/);
  await expect(row("KAPALI").locator(".cad-swatch")).toHaveAttribute("style", /background: rgb\(0, 0, \d+\)/);

  const toggle = panel.getByRole("button", { name: "Donmuş ve Kapalı Katmanları Göster (2)" });
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(row("DONMUS").getByRole("checkbox")).toBeChecked();
  await expect(row("KAPALI").getByRole("checkbox")).toBeChecked();
  await toggle.click();
  await expect(row("DONMUS").getByRole("checkbox")).not.toBeChecked();
  // One layer on its own.
  await row("DONMUS").getByRole("checkbox").check();
  await expect(row("KAPALI").getByRole("checkbox")).not.toBeChecked();
}

test("CAD layer panel lists frozen, off and locked layers (DXF parsed in the browser and the server-built scene)", async ({ page, request }) => {
  test.setTimeout(90_000);
  const { pid, vid } = await upload(request);

  // The server-built 2D scene, once it is ready.
  await expect
    .poll(async () => {
      const s = await (await request.get(`/api/v1/projects/${pid}/versions/${vid}/preview`)).json();
      return s.previews.find((p: { kind: string }) => p.kind === "scene")?.status;
    }, { timeout: 60_000 })
    .toBe("ready");
  const sceneLoaded = page.waitForResponse((r) => r.url().includes(`/versions/${vid}/preview/scene`));
  await page.goto(`/projects/${pid}/open/${vid}`);
  await sceneLoaded;
  await checkPanel(page);

  // The DXF parsed in the browser (the web worker): the scene is left out of the preview status.
  await page.route(`**/versions/${vid}/preview`, async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    body.previews = body.previews.filter((p: { kind: string }) => p.kind !== "scene");
    await route.fulfill({ response: res, json: body });
  });
  const dxfLoaded = page.waitForResponse((r) => r.url().includes(`/versions/${vid}/preview/dxf`));
  await page.reload();
  await dxfLoaded;
  await checkPanel(page);
});
