import path from "node:path";
import { test, expect, runState } from "../support/fixtures";

test("creates a document folder and edits its description", async ({ page }) => {
  const { project } = await runState();
  const folderName = `E2E Folder ${Date.now().toString(36)}`;
  const description = "Created and described through the browser";
  await page.goto(`/projects/${project.id}/files`);

  await page.getByRole("button", { name: "Diğer" }).click();
  await page.getByRole("menuitem", { name: "Yeni Klasör" }).click();
  await page.getByRole("dialog", { name: "Yeni Klasör" }).locator("input").fill(folderName);
  await page.getByRole("dialog", { name: "Yeni Klasör" }).getByRole("button", { name: "Oluştur" }).click();

  let row = page.getByRole("row").filter({ hasText: folderName });
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "Açıklamayı düzenle" }).click();
  await row.getByLabel("Açıklama").fill(description);
  await row.getByLabel("Açıklama").press("Enter");

  row = page.getByRole("row").filter({ hasText: folderName });
  await expect(row).toContainText(description);
});

test("uploads, deletes, and restores a tiny text document", async ({ page }) => {
  const { project } = await runState();
  const fileName = "critical-path.txt";
  const fixture = path.resolve(__dirname, "../fixtures/critical-path.txt");
  await page.goto(`/projects/${project.id}/files`);

  await page.locator(".docs-toolbar input[type=file]").setInputFiles(fixture);
  const upload = page.getByRole("dialog", { name: /Yükle/ });
  await expect(upload).toBeVisible();
  await upload.getByRole("button", { name: "1 Dosyayı Yükle" }).click();
  await expect(upload.getByText(/Yüklendi · V1/)).toBeVisible();
  await upload.locator(".dialog-actions").getByRole("button", { name: "Kapat" }).click();

  await expect(page.getByText(fileName, { exact: true })).toBeVisible();
  await page.getByRole("checkbox", { name: `${fileName} seç` }).check();
  await page.getByRole("button", { name: "Sil (1)" }).click();
  await page.getByRole("dialog", { name: "Dosyaları sil" }).getByRole("button", { name: "1 dosyayı sil" }).click();
  await expect(page.getByText(fileName, { exact: true })).toHaveCount(0);

  await page.goto(`/projects/${project.id}/deleted`);
  const deletedRow = page.getByRole("row").filter({ hasText: fileName });
  await expect(deletedRow).toBeVisible();
  await deletedRow.getByRole("button", { name: "Geri Yükle" }).click();
  await expect(page.getByRole("row").filter({ hasText: fileName })).toHaveCount(0);

  await page.goto(`/projects/${project.id}/files`);
  await expect(page.getByText(fileName, { exact: true })).toBeVisible();
});

test("ISO19650-2 5.1.7(a) unique container id: a duplicate code is refused per file when enforced, a warning otherwise", async ({ page, allowApiFailure }) => {
  allowApiFailure(400, /\/folders\/[^/]+\/files$/);
  const suffix = Date.now().toString(36).toUpperCase();
  const api = page.request;
  const json = async <T>(r: Awaited<ReturnType<typeof api.post>>): Promise<T> => {
    expect(r.ok(), await r.text()).toBeTruthy();
    return (await r.json()) as T;
  };
  // Its own project: the refusals are opt-in per project (D-8).
  const project = await json<{ id: string; rootFolderId: string }>(
    await api.post("/api/v1/projects", { data: { code: `C${suffix}`.slice(0, 10), name: `E2E Codes ${suffix}`, template: "empty" } }),
  );
  const folder = async (name: string) =>
    (await json<{ id: string }>(await api.post(`/api/v1/projects/${project.id}/folders`, { data: { parentId: project.rootFolderId, name } }))).id;
  const one = await folder("One");
  const two = await folder("Two");
  const three = await folder("Three");
  const std = await json<{ id: string }>(
    await api.post(`/api/v1/projects/${project.id}/naming-standards`, {
      data: {
        name: "E2E",
        delimiter: "-",
        fields: [
          { name: "Proje", type: "list", values: [{ code: "E2E" }] },
          { name: "Numara", type: "number", digits: 4 },
        ],
      },
    }),
  );
  await json(await api.patch(`/api/v1/projects/${project.id}/folders/${project.rootFolderId}`, { data: { namingStandardId: std.id } }));
  await json(await api.put(`/api/v1/projects/${project.id}/cde/settings`, { data: { enforceTransitions: true } }));
  const name = "E2E-0001.txt";
  await json(
    await api.post(`/api/v1/projects/${project.id}/folders/${one}/files`, {
      multipart: { file: { name, mimeType: "text/plain", buffer: Buffer.from("first") } },
    }),
  );

  const uploadInto = async (folderId: string) => {
    await page.goto(`/projects/${project.id}/files/${folderId}`);
    await page.locator(".docs-toolbar input[type=file]").setInputFiles({ name, mimeType: "text/plain", buffer: Buffer.from("again") });
    const upload = page.getByRole("dialog", { name: /Yükle/ });
    await expect(upload).toBeVisible();
    await upload.getByRole("button", { name: "1 Dosyayı Yükle" }).click();
    return upload;
  };

  const refused = await uploadInto(two);
  const note = refused.getByTestId("upload-code-conflict");
  await expect(note).toBeVisible();
  await expect(note).toContainText("E2E-0001");
  await expect(note).toContainText(`One / ${name}`);

  await json(await api.put(`/api/v1/projects/${project.id}/cde/settings`, { data: { enforceTransitions: false } }));
  const stored = await uploadInto(three);
  await expect(stored.getByText(/Yüklendi · V1/)).toBeVisible();
  const warning = stored.getByTestId("upload-code-warning");
  await expect(warning).toBeVisible();
  await expect(warning).toContainText(`One / ${name}`);
});
