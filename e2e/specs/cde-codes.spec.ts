/**
 * ISO19650-2 5.1.7(b) / UK NA suitability: suitability and revision codes per version
 * (docs/features/CDE_STATES.md "Codes"). Core only: passes with and without modules.
 */
import { test, expect, runState } from "../support/fixtures";

async function wipFolder(request: import("@playwright/test").APIRequestContext) {
  const { project } = await runState();
  const res = await request.get(`/api/v1/projects/${project.id}/folders/${project.rootFolderId}/contents`);
  expect(res.ok()).toBe(true);
  const contents = (await res.json()) as { folders: { id: string; state: string | null }[] };
  return { project, wipId: contents.folders.find((f) => f.state === "wip")!.id };
}

test("ISO19650-2 5.1.7(b) / UK NA suitability: an upload with codes shows the chips", async ({ page }) => {
  const { project, wipId } = await wipFolder(page.request);
  const name = `codes-${Date.now().toString(36)}.txt`;
  await page.goto(`/projects/${project.id}/files/${wipId}`);

  await page.locator(".docs-toolbar input[type=file]").setInputFiles({ name, mimeType: "text/plain", buffer: Buffer.from("ISO 19650 codes") });
  const upload = page.getByRole("dialog", { name: /Yükle/ });
  const codes = upload.getByTestId("upload-codes");
  await expect(codes).toBeVisible();
  // WIP: S0 and the first revision are proposed.
  await expect(codes.getByLabel("Uygunluk")).toHaveValue("S0");
  await expect(codes.getByLabel("Revizyon")).toHaveValue("P01.01");
  await codes.getByLabel("Revizyon").fill("p1.2");
  await upload.getByRole("button", { name: "1 Dosyayı Yükle" }).click();
  await expect(upload.getByText(/Yüklendi · V1/)).toBeVisible();
  await upload.locator(".dialog-actions").getByRole("button", { name: "Kapat" }).click();

  const row = page.getByRole("row").filter({ hasText: name });
  await expect(row.getByTestId("code-suitability")).toHaveText("S0");
  await expect(row.getByTestId("code-revision")).toHaveText("P01.02");
});

test("ISO19650-2 5.1.7(b) / UK NA suitability: a code that does not fit the state is a warning, refused when the project enforces the rules", async ({ page, allowApiFailure }) => {
  const { project, wipId } = await wipFolder(page.request);
  allowApiFailure(400, `/api/v1/projects/${project.id}/folders/${wipId}/files`);
  const settings = `/api/v1/projects/${project.id}/cde/settings`;
  const setEnforce = async (on: boolean) => expect((await page.request.put(settings, { data: { enforceTransitions: on } })).ok()).toBe(true);

  // Not enforced (existing projects, D-8): stored with a warning.
  const warnName = `codes-warn-${Date.now().toString(36)}.txt`;
  await page.goto(`/projects/${project.id}/files/${wipId}`);
  await page.locator(".docs-toolbar input[type=file]").setInputFiles({ name: warnName, mimeType: "text/plain", buffer: Buffer.from("warned code") });
  let upload = page.getByRole("dialog", { name: /Yükle/ });
  let codes = upload.getByTestId("upload-codes");
  await codes.getByLabel("Uygunluk").fill("S2");
  await expect(codes.getByTestId("upload-codes-warning")).toContainText("S2 Çalışma durumunda kullanılamaz");
  await upload.getByRole("button", { name: "1 Dosyayı Yükle" }).click();
  await expect(upload.getByTestId("upload-code-warning")).toContainText("S2 uygunluk kodu Çalışma durumunda kullanılamaz");
  await upload.locator(".dialog-actions").getByRole("button", { name: "Kapat" }).click();
  await expect(page.getByRole("row").filter({ hasText: warnName }).getByTestId("code-suitability")).toHaveText("S2");

  // Enforced: refused in the dialog and by the server.
  await setEnforce(true);
  try {
    const name = `codes-bad-${Date.now().toString(36)}.txt`;
    await page.reload();
    await page.locator(".docs-toolbar input[type=file]").setInputFiles({ name, mimeType: "text/plain", buffer: Buffer.from("wrong code") });
    upload = page.getByRole("dialog", { name: /Yükle/ });
    codes = upload.getByTestId("upload-codes");
    await codes.getByLabel("Uygunluk").fill("S2");
    await expect(codes.getByTestId("upload-codes-error")).toContainText("S2 Çalışma durumunda kullanılamaz");
    await expect(upload.getByRole("button", { name: "1 Dosyayı Yükle" })).toBeDisabled();
    await upload.locator(".dialog-actions").getByRole("button", { name: "Vazgeç" }).click();

    const res = await page.request.post(`/api/v1/projects/${project.id}/folders/${wipId}/files`, {
      multipart: { suitabilityCode: "S2", file: { name, mimeType: "text/plain", buffer: Buffer.from("wrong code") } },
    });
    expect(res.status()).toBe(400);
    const body = (await res.json()) as { results: { ok: boolean; errors: string[] }[] };
    expect(body.results[0]!.errors.join(" ")).toMatch(/S2 uygunluk kodu Çalışma durumunda kullanılamaz/);
    await page.reload();
    await expect(page.getByText(name, { exact: true })).toHaveCount(0);
  } finally {
    await setEnforce(false);
  }
});

test("ISO19650-2 5.1.7(b) / letter revisions: switching a Forma project to letter revisions and applying them to existing files", async ({ page }) => {
  // Its own project: the scheme switch does not touch the other specs.
  const suffix = Date.now().toString(36).toUpperCase();
  const created = await page.request.post("/api/v1/projects", { data: { code: `LTR-${suffix}`, name: `Letters ${suffix}`, template: "iso19650" } });
  expect(created.ok()).toBe(true);
  const project = (await created.json()) as { id: string; rootFolderId: string };
  const contents = (await (await page.request.get(`/api/v1/projects/${project.id}/folders/${project.rootFolderId}/contents`)).json()) as {
    folders: { id: string; state: string | null }[];
  };
  const wipId = contents.folders.find((f) => f.state === "wip")!.id;
  // A file as Forma / ACC delivers it: REVİZYON and STATUS attributes, no codes under the ISO scheme.
  const name = `forma-${suffix.toLowerCase()}.txt`;
  const upload = await page.request.post(`/api/v1/projects/${project.id}/folders/${wipId}/files`, {
    multipart: { attributes: JSON.stringify({ REVİZYON: "B", STATUS: "Approved" }), file: { name, mimeType: "text/plain", buffer: Buffer.from("Forma file") } },
  });
  expect(upload.ok()).toBe(true);

  await page.goto(`/projects/${project.id}/settings?sekme=cde`);
  const codes = page.getByTestId("cde-codes-settings");
  await expect(codes.getByTestId("cde-codes-unmapped")).toContainText("Approved");
  // Apply is offered for the saved scheme only.
  await codes.getByLabel("Kod Düzeni").selectOption("letter_rev");
  await expect(codes.getByTestId("cde-codes-apply")).toBeDisabled();
  await expect(codes).toContainText("A, B … Z, ardından AA, AB");
  await codes.getByRole("button", { name: "Düzeni Kaydet" }).click();
  await expect(codes.getByText("Kaydedildi.")).toBeVisible();
  await codes.getByTestId("cde-codes-apply").click();
  await expect(codes.getByText("1 versiyona kod verildi; 1 değer dönüştürülemedi.")).toBeVisible();
  // The revision letter was converted; the STATUS value that is not a suitability code stays listed.
  const unmapped = codes.getByTestId("cde-codes-unmapped");
  await expect(unmapped).toContainText("Approved");
  await expect(unmapped.getByRole("cell", { name: "B", exact: true })).toHaveCount(0);

  await page.goto(`/projects/${project.id}/files/${wipId}`);
  await expect(page.getByRole("row").filter({ hasText: name }).getByTestId("code-revision")).toHaveText("B");
});
