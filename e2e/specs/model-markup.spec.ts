/**
 * Model markups (FP-3, docs/features/MODEL_MARKUP.md): on the IFC fixture a pin markup and a drawn
 * markup are added, survive a reload with their viewpoint, and the drawing becomes an issue.
 * Core only: passes with and without modules.
 */
import { test, expect, runState } from "../support/fixtures";
import { uploadServerIfc } from "../support/seed-files";

test("FP-3 model markups: pin and drawing on the IFC fixture, restored after reload, turned into an issue", async ({ page, diagnostics }) => {
  void diagnostics;
  test.setTimeout(180_000);
  const { project } = await runState();
  const stamp = Date.now().toString(36);
  const ifc = await uploadServerIfc(page.request, project.id, project.rootFolderId, "sample-wall.ifc", `e2e-markup-${stamp}.ifc`);

  await page.goto(`/projects/${project.id}/viewer?v=${ifc.versionId}`);
  await expect(page.getByRole("button", { name: /Sığdır/ })).toBeEnabled({ timeout: 90_000 });
  await page.getByRole("button", { name: "✎ İşaretlemeler", exact: true }).click();
  const panel = page.getByRole("region", { name: "İşaretlemeler" });
  await expect(panel.getByText("Bu modellerde henüz işaretleme yok.")).toBeVisible();

  // Pin: one click on the model.
  await panel.getByRole("button", { name: "📍 Nokta İşaretlemesi" }).click();
  await expect(page.getByText("İşaretleme için modelde bir noktaya tıklayın", { exact: false })).toBeVisible();
  await page.locator(".viewer-container canvas").first().click();
  const save = page.getByRole("dialog", { name: "İşaretleme Olarak Kaydet" });
  await expect(save).toBeVisible({ timeout: 20_000 });
  await save.getByLabel("Başlık").fill(`E2E nokta ${stamp}`);
  await save.getByRole("button", { name: "Kaydet" }).click();
  await expect(save).toHaveCount(0);
  await expect(panel.getByRole("heading", { name: new RegExp(`E2E nokta ${stamp}`) })).toBeVisible();
  await expect(page.getByRole("button", { name: `📍 E2E nokta ${stamp}` })).toBeVisible();
  await panel.getByRole("button", { name: "← Tüm İşaretlemeler" }).click();

  // Drawing: a pen stroke over the view.
  await panel.getByRole("button", { name: "✎ Görünüme Çiz" }).click();
  const overlay = page.locator("svg.mm-overlay");
  await expect(overlay).toBeVisible();
  const box = (await overlay.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.4);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(box.x + box.width * (0.3 + i * 0.04), box.y + box.height * (0.4 + (i % 2) * 0.05));
  await page.mouse.up();
  await expect(overlay.locator("polyline").first()).toBeVisible();
  await page.getByRole("toolbar", { name: "✎ Görünüme Çiz" }).getByRole("button", { name: "Kaydet" }).click();
  await expect(save).toBeVisible();
  await save.getByLabel("Başlık").fill(`E2E çizim ${stamp}`);
  await save.getByRole("radio").nth(1).check();
  await save.getByRole("button", { name: "Kaydet" }).click();
  await expect(save).toHaveCount(0);
  await expect(panel.getByRole("heading", { name: new RegExp(`E2E çizim ${stamp}`) })).toBeVisible();
  await expect(page).toHaveURL(/[?&]markup=/);
  const drawingId = new URL(page.url()).searchParams.get("markup")!;
  await expect(page.locator(`svg.mm-overlay[data-markup="${drawingId}"] polyline`).first()).toBeVisible();

  // Reload: the drawing comes back with its viewpoint, both markups are listed.
  await page.reload();
  await expect(page.locator(`svg.mm-overlay[data-markup="${drawingId}"] polyline`).first()).toBeVisible({ timeout: 90_000 });
  await expect(panel.getByRole("heading", { name: new RegExp(`E2E çizim ${stamp}`) })).toBeVisible();
  await expect(panel.locator("img.mm-snapshot")).toBeVisible();
  // Moving the view hides the drawing; "Görünümü Göster" restores it.
  const canvas = (await page.locator(".viewer-container canvas").first().boundingBox())!;
  await page.mouse.move(canvas.x + 40, canvas.y + canvas.height - 40);
  await page.mouse.wheel(0, 200);
  await expect(page.locator("svg.mm-overlay")).toHaveCount(0);
  await panel.getByRole("button", { name: "Görünümü Göster" }).click();
  await expect(page.locator(`svg.mm-overlay[data-markup="${drawingId}"] polyline`).first()).toBeVisible();
  await panel.getByRole("button", { name: "← Tüm İşaretlemeler" }).click();
  await expect(panel.getByRole("button", { name: new RegExp(`E2E nokta ${stamp}`) })).toBeVisible();
  await expect(panel.getByRole("button", { name: new RegExp(`E2E çizim ${stamp}`) })).toBeVisible();

  // Comment, then an issue from the drawing with its viewpoint.
  await panel.getByRole("button", { name: new RegExp(`E2E çizim ${stamp}`) }).click();
  await panel.getByLabel("Yorum yazın").fill("Cephe hizası kontrol edilecek.");
  await panel.getByRole("button", { name: "Gönder" }).click();
  await expect(panel.getByText("Cephe hizası kontrol edilecek.")).toBeVisible();
  await panel.getByRole("button", { name: "Sorun Oluştur" }).click();
  const issueDialog = page.getByRole("dialog", { name: "İşaretlemeden Sorun Oluştur" });
  await expect(issueDialog.getByLabel("Başlık")).toHaveValue(`E2E çizim ${stamp}`);
  await issueDialog.getByRole("button", { name: "Oluştur" }).click();
  await expect(issueDialog.getByText(/Sorun #\d+ oluşturuldu\./)).toBeVisible();
  await issueDialog.getByRole("button", { name: "Kapat" }).first().click();
  const badge = panel.getByRole("link", { name: /Sorun #\d+/ });
  await expect(badge).toBeVisible();
  const issueId = (await badge.getAttribute("href"))!.split("/").pop()!;
  const issue = await (await page.request.get(`/api/v1/projects/${project.id}/issues/${issueId}`)).json();
  expect(issue.viewpoint.fileVersionIds).toContain(ifc.versionId);
  expect(issue.viewpoint.snapshot).toMatch(/^data:image\/(jpeg|png);base64,/);
});
