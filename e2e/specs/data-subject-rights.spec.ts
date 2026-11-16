/**
 * Data subject rights and retention (docs/features/DATA_SUBJECT_RIGHTS.md, issue #85): an
 * administrator corrects a user's e-mail, exports their personal data (ZIP built in the job queue)
 * and anonymises the account in two steps; Privacy Centre → Retention saves the recycle bin and
 * audit log periods and offers the disposal record CSV.
 */
import type { Page } from "@playwright/test";
import { test, expect } from "../support/fixtures";

const userRow = (page: Page, name: string | RegExp) => page.getByRole("row").filter({ has: page.getByText(name, { exact: true }) });

test("an administrator corrects the e-mail, exports the data and anonymises a user", async ({ page }) => {
  const s = Date.now().toString(36);
  const name = `KVKK Kişi ${s}`;
  const email = `kvkk-${s}@e2e.test`;
  const created = await page.request.post("/api/v1/users", { data: { email, name, password: "Veri-Sorumlusu-Test-2026" } });
  expect(created.ok()).toBe(true);
  const { id } = (await created.json()) as { id: string };

  await page.goto("/administration");
  await userRow(page, name).getByRole("button", { name: "Kişisel Veriler", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: `Kişisel veriler: ${name}` });
  await expect(dialog).toBeVisible();

  // P1-3: correct the address.
  const newEmail = `kvkk-yeni-${s}@e2e.test`;
  await dialog.getByRole("button", { name: "E-postayı Değiştir", exact: true }).click();
  const ask = page.getByRole("dialog", { name: "E-postayı Değiştir" });
  await ask.getByRole("textbox").fill(newEmail);
  const changed = page.waitForResponse((r) => new URL(r.url()).pathname === `/api/v1/admin/users/${id}/email`);
  await ask.getByRole("button", { name: "Kaydet", exact: true }).click();
  expect((await changed).ok()).toBe(true);
  await expect(dialog.getByText("E-posta adresi değişti.", { exact: false })).toBeVisible();
  await expect(dialog.getByText(newEmail, { exact: true })).toBeVisible();

  // P1-1: export, prepared in the background, then downloadable.
  const queued = page.waitForResponse((r) => new URL(r.url()).pathname === `/api/v1/admin/users/${id}/data-exports` && r.request().method() === "POST");
  await dialog.getByRole("button", { name: "Dışa Aktarmayı Hazırla", exact: true }).click();
  expect((await queued).ok()).toBe(true);
  const download = dialog.getByRole("link", { name: "İndir", exact: true });
  await expect(download).toBeVisible({ timeout: 30_000 });
  const href = await download.getAttribute("href");
  const zip = await page.request.get(href!);
  expect(zip.ok()).toBe(true);
  expect(zip.headers()["content-type"]).toContain("application/zip");
  expect((await zip.body()).subarray(0, 2).toString()).toBe("PK");

  // P1-2: two steps, the second one is the address typed by hand.
  await dialog.getByRole("button", { name: "Kullanıcıyı Anonimleştir", exact: true }).click();
  await page.getByRole("button", { name: "Devam Et", exact: true }).click();
  const typed = page.getByRole("dialog", { name: "Kullanıcıyı Anonimleştir" }).getByRole("textbox");
  await typed.fill(newEmail);
  const anonymised = page.waitForResponse((r) => new URL(r.url()).pathname === `/api/v1/admin/users/${id}/anonymise`);
  await page.getByRole("button", { name: "Anonimleştir", exact: true }).click();
  expect((await anonymised).ok()).toBe(true);
  // The pseudonym is in the installation's language (CDE_DEFAULT_LANGUAGE).
  const pseudonym = new RegExp(`^(Deleted user|Silinmiş kullanıcı) #${id.slice(0, 8)}`);
  const row = userRow(page, pseudonym);
  await expect(row).toBeVisible();
  await expect(row.getByText("Anonimleştirildi", { exact: true })).toBeVisible();
  await expect(row.getByRole("button", { name: "Kişisel Veriler", exact: true })).toHaveCount(0);
  await expect(page.getByText(name, { exact: true })).toHaveCount(0);
});

test("Privacy Centre → Retention saves the periods and offers the disposal record", async ({ page }) => {
  await page.goto("/administration");
  await page.getByRole("button", { name: "Gizlilik Merkezi", exact: true }).click();
  await page.getByRole("button", { name: "Saklama", exact: true }).click();
  const trash = page.getByLabel("Çöp kutusu: kalıcı olarak sil");
  const auditLog = page.getByLabel("Denetim kaydı: sakla");
  await expect(trash).toHaveValue("");
  await expect(auditLog).toHaveValue("");
  try {
    await trash.selectOption("90");
    await auditLog.selectOption("10");
    const saved = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/v1/admin/privacy/settings" && r.request().method() === "PUT");
    await page.getByRole("button", { name: "Kaydet", exact: true }).click();
    const res = await saved;
    expect(res.ok()).toBe(true);
    expect(((await res.json()) as { settings: unknown }).settings).toMatchObject({ trashPurgeDays: 90, auditLogRetentionYears: 10 });
    await expect(page.getByText("Kaydedildi.")).toBeVisible();
  } finally {
    expect((await page.request.put("/api/v1/admin/privacy/settings", { data: { trashPurgeDays: null, auditLogRetentionYears: null } })).ok()).toBe(true);
  }
  const csv = page.getByRole("link", { name: "CSV İndir", exact: true });
  const res = await page.request.get((await csv.getAttribute("href"))!);
  expect(res.ok()).toBe(true);
  expect(await res.text()).toContain("Kategori");
});
