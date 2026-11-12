import type { APIRequestContext, APIResponse } from "@playwright/test";
import { test, expect, runState } from "../support/fixtures";
import { needsModules } from "../support/modules";

needsModules("field");

async function expectJson<T>(response: APIResponse, operation: string): Promise<T> {
  if (!response.ok()) throw new Error(`${operation} failed (${response.status()}): ${await response.text()}`);
  return (await response.json()) as T;
}

async function seedTemplate(request: APIRequestContext, projectId: string, name: string) {
  return expectJson<{ id: string }>(
    await request.post(`/api/v1/projects/${projectId}/form-templates`, {
      data: {
        code: `E2E${Date.now().toString(36).toUpperCase()}`,
        name,
        schema: {
          sections: [
            {
              id: "details",
              title: "Kontrol Bilgileri",
              items: [{ id: "note", type: "text", label: "Saha notu", required: true }],
            },
          ],
        },
      },
    }),
    "form template seed",
  );
}

test("creates, fills, saves, and reloads a form through the UI", async ({ page, request, diagnostics }) => {
  void diagnostics;
  const { project } = await runState();
  const templateName = `E2E Basic Form ${Date.now().toString(36)}`;
  const value = `Persisted field value ${Date.now().toString(36)}`;
  const template = await seedTemplate(request, project.id, templateName);

  await page.goto(`/projects/${project.id}/forms`);
  await expect(page.getByRole("button", { name: "Formlar", exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Şablonlar" }).click();
  // The template card; "Benzer Şablonlar" may list the name too (earlier runs' similar templates).
  await expect(page.locator(".grid-cards .card").getByText(templateName, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Formlar", exact: true }).click();

  await page.getByRole("button", { name: "+ Yeni Form" }).click();
  const dialog = page.getByRole("dialog", { name: "Yeni Form" });
  await dialog.locator("select").first().selectOption(template.id);
  await dialog.getByRole("button", { name: "Oluştur" }).click();

  await expect(page.getByRole("heading", { name: templateName })).toBeVisible();
  const field = page.locator(".form-item").filter({ hasText: "Saha notu" }).locator("input");
  await field.fill(value);
  await page.getByRole("button", { name: "Kaydet", exact: true }).click();
  await expect(page.getByText("Kaydedildi.", { exact: true })).toBeVisible();

  await page.reload();
  await expect(page.getByRole("heading", { name: templateName })).toBeVisible();
  await expect(page.locator(".form-item").filter({ hasText: "Saha notu" }).locator("input")).toHaveValue(value);
});
