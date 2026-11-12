import type { APIRequestContext, APIResponse } from "@playwright/test";
import { test, expect, runState } from "../support/fixtures";

async function expectJson<T>(response: APIResponse, operation: string): Promise<T> {
  if (!response.ok()) throw new Error(`${operation} failed (${response.status()}): ${await response.text()}`);
  return (await response.json()) as T;
}

async function seedReview(request: APIRequestContext, projectId: string, rootFolderId: string, name: string) {
  const me = await expectJson<{ id: string }>(await request.get("/api/v1/auth/me"), "current-user lookup");
  const fileName = `e2e-review-${Date.now().toString(36)}.txt`;
  await expectJson(
    await request.post(`/api/v1/projects/${projectId}/folders/${rootFolderId}/files`, {
      multipart: {
        file: {
          name: fileName,
          mimeType: "text/plain",
          buffer: Buffer.from("E2E review prerequisite\n", "utf8"),
        },
      },
    }),
    "review document upload",
  );

  const contents = await expectJson<{ files: Array<{ name: string; latest: { id: string } }> }>(
    await request.get(`/api/v1/projects/${projectId}/folders/${rootFolderId}/contents`),
    "uploaded document lookup",
  );
  const versionId = contents.files.find((file) => file.name === fileName)?.latest.id;
  if (!versionId) throw new Error(`Uploaded review document ${fileName} was not listed.`);

  const workflow = await expectJson<{ id: string }>(
    await request.post(`/api/v1/projects/${projectId}/workflow-templates`, {
      data: {
        kind: "review",
        name: `${name} workflow`,
        steps: [
          {
            name: "E2E approval",
            assignees: [{ type: "user", id: me.id }],
            rule: "any",
            days: 3,
            outcomes: ["approved", "approved_with_comments", "revise_resubmit"],
          },
        ],
      },
    }),
    "review workflow seed",
  );

  return expectJson<{ id: string }>(
    await request.post(`/api/v1/projects/${projectId}/reviews`, {
      data: { name, templateId: workflow.id, versionIds: [versionId], note: "Seeded prerequisite; verified in UI." },
    }),
    "review seed",
  );
}

test("shows a seeded review in the list and exposes its current UI actions", async ({ page, request, diagnostics }) => {
  void diagnostics;
  const { project } = await runState();
  const name = `E2E Review ${Date.now().toString(36)}`;
  const review = await seedReview(request, project.id, project.rootFolderId, name);

  await page.goto(`/projects/${project.id}/reviews`);
  await expect(page.getByRole("heading", { name: "İncelemeler" })).toBeVisible();
  const row = page.getByRole("row").filter({ hasText: name });
  await expect(row).toBeVisible();
  await expect(row.getByText("Sıra Sizde", { exact: true })).toBeVisible();
  await row.click();

  await expect(page).toHaveURL(`/projects/${project.id}/reviews/${review.id}`);
  await expect(page.getByRole("heading", { name: new RegExp(name) })).toBeVisible();
  await expect(page.getByText("Sıra sizde: 1. E2E approval", { exact: true })).toBeVisible();
  await expect(page.getByRole("combobox").filter({ has: page.locator('option:text-is("Tümüne Uygula…")') })).toBeVisible();
  await expect(page.getByRole("button", { name: "Adımı Gönder" })).toBeVisible();
  await expect(page.getByRole("button", { name: "İptal Et" })).toBeVisible();
});
