/**
 * Security log, security alerts and the auditor (docs/features/SECURITY_LOG.md): a new system
 * administrator raises an alert card on the Administration page, "Olayı Göster" opens the security
 * log at that row, "Görüldü" removes the card, the log filters by type and downloads as CSV; an
 * auditor reads the security log, every project's log and the Privacy Centre and changes nothing.
 * The interface is Turkish. Core only.
 */
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { APIRequestContext, Page } from "@playwright/test";
import { test, expect, runState } from "../support/fixtures";
import { E2E_BASE_URL, signedOutState } from "../support/signed-out";

const PASSWORD = "Mavi-Kule-Yapi-71";
const ADMIN_STATE = path.resolve(__dirname, "../.auth/admin.json");

async function adminApi(playwright: { request: { newContext(o: object): Promise<APIRequestContext> } }) {
  return playwright.request.newContext({ baseURL: E2E_BASE_URL, storageState: ADMIN_STATE });
}

async function newUser(admin: APIRequestContext, label: string, roles: { isAdmin?: boolean; isAuditor?: boolean }) {
  const email = `e2e-${label}-${randomUUID().slice(0, 6)}@7d-cde.localhost`;
  const name = `Kisi ${label} ${randomUUID().slice(0, 4)}`;
  const res = await admin.post("/api/v1/users", { data: { email, name, password: PASSWORD, ...roles } });
  if (!res.ok()) throw new Error(`user creation failed (${res.status()}): ${await res.text()}`);
  return { email, name, id: ((await res.json()) as { id: string }).id };
}

async function signIn(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("E-posta adresi").fill(email);
  await page.getByLabel("Şifre", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Giriş yap" }).click();
  await expect(page).toHaveURL(/\/home$/);
}

test("a new system administrator raises an alert card; the security log shows the event, filters and downloads as CSV", async ({ page, playwright }) => {
  const admin = await adminApi(playwright);
  const user = await newUser(admin, "yonetici", { isAdmin: true });
  // Not left behind as an administrator for other specs.
  await admin.patch(`/api/v1/users/${user.id}`, { data: { isAdmin: false } });

  await page.goto("/administration");
  const card = page.getByTestId("security-alerts").locator(".security-alert").filter({ hasText: `Kişi: ${user.name}` });
  await expect(card.getByText("Yeni Sistem Yöneticisi", { exact: true })).toBeVisible();
  await expect(card.getByText("Bir kullanıcıya sistem yöneticisi yetkisi verildi.")).toBeVisible();

  // "Olayı Göster": the security log at the row that raised it.
  await card.getByRole("button", { name: "Olayı Göster", exact: true }).click();
  const log = page.getByTestId("security-log");
  await expect(log.getByText(/Yalnız \d+ numaralı kayıt\./)).toBeVisible();
  await expect(log.getByRole("row").filter({ hasText: "Kullanıcı oluşturuldu" })).toHaveCount(1);
  await log.getByRole("button", { name: "Tümünü Göster", exact: true }).click();

  // Acknowledged: the card goes, the history keeps it.
  await card.getByRole("button", { name: "Görüldü", exact: true }).click();
  await expect(card).toHaveCount(0);
  const history = page.getByTestId("security-alert-history");
  await expect(history.getByRole("row").filter({ hasText: user.name }).filter({ hasText: "Yeni Sistem Yöneticisi" }).first()).toContainText("Görüldü");

  // Type filter: permission and role changes include the administrator flag.
  const filtered = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/v1/admin/security-log" && new URL(r.url()).searchParams.get("type") === "permissions");
  await log.getByLabel("Tür", { exact: true }).selectOption("permissions");
  expect((await filtered).ok()).toBe(true);
  await expect(log.getByRole("row").filter({ hasText: "Kullanıcı değişti" }).first()).toBeVisible();

  const download = page.waitForEvent("download");
  await log.getByRole("link", { name: "CSV İndir", exact: true }).click();
  const csv = await download;
  expect(csv.suggestedFilename()).toMatch(/^security-log-\d{4}-\d{2}-\d{2}\.csv$/);
  const text = await readFile((await csv.path())!, "utf8");
  expect(text.replace(/^﻿/, "").split("\r\n")[0]).toContain("IP Adresi");
  expect(text).toContain("user.updated");
  expect(text).not.toContain("file.uploaded");

  // The settings of the alerts are on the sign-in security tab.
  await page.getByRole("button", { name: "Giriş Güvenliği", exact: true }).click();
  const settings = page.getByTestId("security-alert-settings");
  await expect(settings.getByLabel("Hesap Başına Başarısız Giriş")).toHaveValue("10");
  await expect(settings.getByLabel("Yeni Sistem Yöneticisi")).toBeChecked();
  await admin.dispose();
});

test.describe("auditor", () => {
  test.use({ storageState: signedOutState(E2E_BASE_URL) });

  test("reads the security log, every project's audit log and the Privacy Centre, and changes nothing", async ({ page, playwright, allowApiFailure }) => {
    allowApiFailure(401, "/api/v1/auth/me");
    allowApiFailure(403, "/api/v1/admin/privacy/kill-switch");
    const { project } = await runState();
    const admin = await adminApi(playwright);
    const fileName = `e2e-denetci-${Date.now().toString(36)}.txt`;
    const upload = await admin.post(`/api/v1/projects/${project.id}/folders/${project.rootFolderId}/files`, {
      multipart: { file: { name: fileName, mimeType: "text/plain", buffer: Buffer.from("auditor\n", "utf8") } },
    });
    expect(upload.ok(), await upload.text()).toBe(true);
    const auditor = await newUser(admin, "denetci", { isAuditor: true });
    await signIn(page, auditor.email);

    await page.locator("button.topbar-account").click();
    await page.getByRole("menuitem", { name: "Sistem yönetimi" }).click();
    await expect(page).toHaveURL(/\/administration$/);
    await expect(page.getByText(/Denetçi olarak oturum açtınız/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Güvenlik Kaydı", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Gizlilik Merkezi", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Kullanıcılar ve Firmalar", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Giriş Güvenliği", exact: true })).toHaveCount(0);

    // The security log with its own sign-in, and the chain check.
    const log = page.getByTestId("security-log");
    await expect(log.getByRole("row").filter({ hasText: auditor.name }).filter({ hasText: "Giriş yaptı" }).first()).toBeVisible();
    const chain = page.getByTestId("audit-chain");
    await chain.getByRole("button", { name: "Zinciri Denetle", exact: true }).click();
    await expect(chain.getByText(/^Sağlam: \d+ kayıt denetlendi$/)).toBeVisible();

    // Every project's audit log, without being a member.
    await log.getByRole("button", { name: "Tüm Olaylar", exact: true }).click();
    const projectLog = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/v1/admin/audit" && new URL(r.url()).searchParams.get("projectId") === project.id);
    await log.getByLabel("Proje", { exact: true }).selectOption(project.id);
    expect((await projectLog).ok()).toBe(true);
    await expect(log.getByRole("row").filter({ hasText: fileName }).filter({ hasText: "Dosya yüklendi" })).toHaveCount(1);
    expect((await page.request.get(`/api/v1/projects/${project.id}`)).status()).toBe(404);

    // The Privacy Centre, read-only.
    await page.getByRole("button", { name: "Gizlilik Merkezi", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Tüm Dış Bağlantıları Kapat" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Tüm Dış Bağlantıları Kapat" })).toHaveCount(0);
    const sections = page.getByTestId("privacy-sections");
    await expect(sections).toHaveAttribute("disabled", "");
    await expect(sections.getByRole("button").first()).toBeDisabled();
    expect((await page.request.put("/api/v1/admin/privacy/kill-switch", { data: { on: true } })).status()).toBe(403);
    await admin.dispose();
  });
});
