import type { Locator, Page } from "@playwright/test";
import { test, expect, runState } from "../support/fixtures";

async function openAdminTab(page: Page, label: string, apiPath: string, rendered: Locator) {
  const response = page.waitForResponse(
    (candidate) => new URL(candidate.url()).pathname === apiPath && candidate.request().method() === "GET",
  );
  await page.getByRole("button", { name: label, exact: true }).click();
  expect((await response).ok(), `${label} data should load`).toBe(true);
  await expect(rendered).toBeVisible();
}

async function openSettingsTab(
  page: Page,
  projectId: string,
  key: string,
  label: string,
  apiPath: RegExp,
  rendered: Locator,
) {
  const response = page.waitForResponse(
    (candidate) => apiPath.test(new URL(candidate.url()).pathname) && candidate.request().method() === "GET",
  );
  await page.goto(`/projects/${projectId}/settings?sekme=${key}`);
  expect((await response).ok(), `${label} data should load`).toBe(true);
  await expect(page.getByRole("tab", { name: label, exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(rendered).toBeVisible();
}

test("administration tabs render their local settings without external configuration", async ({ page }) => {
  await page.goto("/administration");
  await expect(page.getByRole("heading", { name: "Yönetim", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Kullanıcılar", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "İzinli Alan Adı", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Firmalar", exact: true })).toBeVisible();

  await openAdminTab(
    page,
    "Yapay Zekâ ve MCP",
    "/api/v1/admin/settings",
    page.getByRole("heading", { name: "Yapay Zekâ Modu", exact: true }),
  );
  await expect(page.getByText("MCP Bağlantı Bilgileri", { exact: false })).toBeVisible();

  await openAdminTab(
    page,
    "Office Entegrasyonu",
    "/api/v1/admin/office",
    page.getByRole("heading", { name: "Tarayıcıda Düzenleme (WOPI)", exact: true }),
  );

  await openAdminTab(
    page,
    "OAuth Uygulamaları",
    "/api/v1/admin/oauth-clients",
    page.getByRole("heading", { name: "OAuth Uygulamaları", exact: true }),
  );

  await openAdminTab(
    page,
    "Gizlilik Merkezi",
    "/api/v1/admin/privacy",
    page.getByRole("heading", { name: "Tüm Dış Bağlantıları Kapat", exact: true }),
  );

  await openAdminTab(
    page,
    "Sistem Durumu",
    "/api/v1/admin/status",
    page.getByRole("heading", { name: "Otomatik Yedek", exact: true }),
  );

  await openAdminTab(
    page,
    "Forma Eşitleme",
    "/api/v1/admin/forma-sync",
    page.getByRole("heading", { name: "Dosya Eşlemeleri", exact: true }),
  );
});

test("project administration tabs route and render", async ({ page }) => {
  const { project } = await runState();
  const projectApi = `/api/v1/projects/${project.id}`;

  await openSettingsTab(
    page,
    project.id,
    "yapay-zeka",
    "Yapay Zekâ",
    new RegExp(`^${projectApi}/ai$`),
    page.getByRole("heading", { name: "Kendi API Anahtarlarım", exact: true }),
  );
  await openSettingsTab(
    page,
    project.id,
    "uyeler",
    "Üyeler",
    new RegExp(`^${projectApi}/members$`),
    page.getByRole("heading", { name: "Üye Ekle", exact: true }),
  );
  await openSettingsTab(
    page,
    project.id,
    "roller",
    "Roller",
    new RegExp(`^${projectApi}/roles$`),
    page.getByRole("button", { name: "+ Rol", exact: true }),
  );
  await openSettingsTab(
    page,
    project.id,
    "moduller",
    "Modüller",
    new RegExp(`^${projectApi}/modules$`),
    page.getByText("Dokümanlar her zaman açıktır.", { exact: false }),
  );
  await openSettingsTab(
    page,
    project.id,
    "isimlendirme",
    "İsimlendirme Standartları",
    new RegExp(`^${projectApi}/naming-standards$`),
    page.getByRole("button", { name: "+ Standart", exact: true }),
  );
  await openSettingsTab(
    page,
    project.id,
    "is-akislari",
    "İş Akışları",
    new RegExp(`^${projectApi}/workflow-templates$`),
    page.getByRole("button", { name: "+ Şablon", exact: true }),
  );
  await openSettingsTab(
    page,
    project.id,
    "is-tipleri",
    "İş Tipleri",
    new RegExp(`^${projectApi}/work-types$`),
    page.getByRole("heading", { name: "İş Tipleri", exact: true }),
  );
  await openSettingsTab(
    page,
    project.id,
    "oznitelikler",
    "Öznitelikler",
    new RegExp(`^${projectApi}/attribute-definitions$`),
    page.getByRole("button", { name: "+ Öznitelik", exact: true }),
  );
  await openSettingsTab(
    page,
    project.id,
    "aktivite",
    "Aktivite Kaydı",
    new RegExp(`^${projectApi}/activity$`),
    page.getByRole("columnheader", { name: "İşlem", exact: true }),
  );
  await openSettingsTab(
    page,
    project.id,
    "sistem-durumu",
    "Sistem Durumu",
    /^\/api\/v1\/admin\/status$/,
    page.getByRole("heading", { name: "Otomatik Yedek", exact: true }),
  );
  // Autodesk is not a settings tab any more: the old address opens Proje → Forma Eşitleme.
  await page.goto(`/projects/${project.id}/settings?sekme=forma-esitleme`);
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/forma-esitleme$`));
  await expect(page.getByRole("heading", { name: "ACC Projesi", exact: true })).toBeVisible();
});

test("a validated personal Claude key is masked and can be removed", async ({ page }) => {
  const { project } = await runState();
  await page.route("**/api/v1/me/ai-credentials/anthropic", async (route) => {
    const body = route.request().postDataJSON() as { apiKey?: string | null; model?: string };
    const saved = body.apiKey !== null;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        providers: [
          {
            id: "anthropic",
            name: "Claude API",
            hasApiKey: saved,
            maskedKey: saved ? "••••••••••••cret" : null,
            model: body.model ?? "claude-haiku-5-5",
            models: [
              { id: "claude-haiku-5-5", label: "Claude Haiku 5.5" },
              { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
              { id: "claude-opus-5-5", label: "Claude Opus 5.5" },
            ],
          },
          { id: "cursor", name: "Cursor", hasApiKey: false, maskedKey: null, model: "auto", models: [{ id: "auto", label: "Cursor Auto" }] },
        ],
        test: saved ? { ok: true, model: "claude-haiku-5-5", reply: "Hazırım", latencyMs: 12 } : null,
      }),
    });
  });
  await page.goto(`/projects/${project.id}/settings?sekme=yapay-zeka`);
  const claude = page.getByText("Claude API", { exact: true }).locator("..").locator("..");
  const input = claude.getByLabel("API Anahtarı");

  const saved = page.waitForResponse(
    (response) => new URL(response.url()).pathname.endsWith("/api/v1/me/ai-credentials/anthropic") && response.request().method() === "PATCH",
  );
  await input.fill("sk-ant-e2e-secret");
  await claude.getByRole("button", { name: "Kaydet", exact: true }).click();
  expect((await saved).ok()).toBe(true);
  await expect(claude.getByText("Anahtar Kayıtlı", { exact: true })).toBeVisible();
  await expect(claude.getByText(/Bağlantı başarılı; anahtar kaydedildi/)).toBeVisible();
  await expect(claude.getByText("••••••••••••cret", { exact: true })).toBeVisible();
  await expect(input).toHaveValue("");

  const removed = page.waitForResponse(
    (response) => new URL(response.url()).pathname.endsWith("/api/v1/me/ai-credentials/anthropic") && response.request().method() === "PATCH",
  );
  await claude.getByRole("button", { name: "Anahtarı Sil", exact: true }).click();
  expect((await removed).ok()).toBe(true);
  await expect(claude.getByText("Anahtar Yok", { exact: true })).toBeVisible();
});

test("account renders API access, connected apps, and password sections", async ({ page }) => {
  await page.goto("/account");

  await expect(page.getByRole("heading", { name: "Hesabım", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "API Erişim Anahtarları", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Bağlı Uygulamalar", exact: true })).toBeVisible();
  const passwordCard = page.getByRole("heading", { name: "Şifre Değiştir", exact: true }).locator("..");
  await expect(passwordCard).toBeVisible();
  await expect(passwordCard.getByRole("button", { name: "Değiştir", exact: true })).toBeVisible();
});
