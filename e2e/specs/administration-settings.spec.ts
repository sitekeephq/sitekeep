import type { Locator, Page } from "@playwright/test";
import { test, expect, runState } from "../support/fixtures";
import { moduleInstalled, needsModules, withInstalled, type ModuleId } from "../support/modules";

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

/** Yönetim tabs; `module`: the tab belongs to that Enterprise module and is only there when it is installed. */
const ADMIN_TABS: { label: string; apiPath: string; rendered: (page: Page) => Locator; also?: (page: Page) => Locator; module?: ModuleId }[] = [
  {
    label: "Yapay Zekâ ve MCP",
    apiPath: "/api/v1/admin/settings",
    rendered: (page) => page.getByRole("heading", { name: "Yapay Zekâ Modu", exact: true }),
    also: (page) => page.getByText("MCP Bağlantı Bilgileri", { exact: false }),
    module: "ai",
  },
  {
    label: "Office Entegrasyonu",
    apiPath: "/api/v1/admin/office",
    rendered: (page) => page.getByRole("heading", { name: "Tarayıcıda Düzenleme (WOPI)", exact: true }),
  },
  {
    label: "OAuth Uygulamaları",
    apiPath: "/api/v1/admin/oauth-clients",
    rendered: (page) => page.getByRole("heading", { name: "OAuth Uygulamaları", exact: true }),
  },
  {
    label: "Gizlilik Merkezi",
    apiPath: "/api/v1/admin/privacy",
    rendered: (page) => page.getByRole("heading", { name: "Tüm Dış Bağlantıları Kapat", exact: true }),
  },
  {
    label: "Sistem Durumu",
    apiPath: "/api/v1/admin/status",
    rendered: (page) => page.getByRole("heading", { name: "Otomatik Yedek", exact: true }),
  },
  {
    label: "Forma Eşitleme",
    apiPath: "/api/v1/admin/forma-sync",
    rendered: (page) => page.getByRole("heading", { name: "Dosya Eşlemeleri", exact: true }),
    module: "connect",
  },
];

test("administration tabs render their local settings without external configuration", async ({ page }) => {
  await page.goto("/administration");
  await expect(page.getByRole("heading", { name: "Yönetim", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Kullanıcılar", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "İzinli Alan Adı", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Firmalar", exact: true })).toBeVisible();

  for (const tab of withInstalled(ADMIN_TABS)) {
    await openAdminTab(page, tab.label, tab.apiPath, tab.rendered(page));
    if (tab.also) await expect(tab.also(page)).toBeVisible();
  }
});

/** Proje Ayarları tabs; `module`: the tab belongs to that Enterprise module and is only there when it is installed. */
const SETTINGS_TABS: { key: string; label: string; api: string; rendered: (page: Page) => Locator; module?: ModuleId }[] = [
  { key: "yapay-zeka", label: "Yapay Zekâ", api: "/ai", rendered: (page) => page.getByRole("heading", { name: "Kendi API Anahtarlarım", exact: true }), module: "ai" },
  { key: "uyeler", label: "Üyeler", api: "/members", rendered: (page) => page.getByRole("heading", { name: "Üye Ekle", exact: true }) },
  { key: "roller", label: "Roller", api: "/roles", rendered: (page) => page.getByRole("button", { name: "+ Rol", exact: true }) },
  { key: "moduller", label: "Modüller", api: "/modules", rendered: (page) => page.getByText("Dokümanlar her zaman açıktır.", { exact: false }) },
  { key: "isimlendirme", label: "İsimlendirme Standartları", api: "/naming-standards", rendered: (page) => page.getByRole("button", { name: "+ Standart", exact: true }) },
  { key: "is-akislari", label: "İş Akışları", api: "/workflow-templates", rendered: (page) => page.getByRole("button", { name: "+ Şablon", exact: true }) },
  { key: "is-tipleri", label: "İş Tipleri", api: "/work-types", rendered: (page) => page.getByRole("heading", { name: "İş Tipleri", exact: true }) },
  { key: "oznitelikler", label: "Öznitelikler", api: "/attribute-definitions", rendered: (page) => page.getByRole("button", { name: "+ Öznitelik", exact: true }) },
  { key: "aktivite", label: "Aktivite Kaydı", api: "/activity", rendered: (page) => page.getByRole("columnheader", { name: "İşlem", exact: true }) },
];

test("project administration tabs route and render", async ({ page }) => {
  const { project } = await runState();
  const projectApi = `/api/v1/projects/${project.id}`;

  for (const tab of withInstalled(SETTINGS_TABS)) {
    await openSettingsTab(page, project.id, tab.key, tab.label, new RegExp(`^${projectApi}${tab.api}$`), tab.rendered(page));
  }
  await openSettingsTab(
    page,
    project.id,
    "sistem-durumu",
    "Sistem Durumu",
    /^\/api\/v1\/admin\/status$/,
    page.getByRole("heading", { name: "Otomatik Yedek", exact: true }),
  );
  // Autodesk is not a settings tab any more: the old address opens Proje → Forma Eşitleme (Connect module).
  if (moduleInstalled("connect")) {
    await page.goto(`/projects/${project.id}/settings?sekme=forma-esitleme`);
    await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/forma-esitleme$`));
    await expect(page.getByRole("heading", { name: "ACC Projesi", exact: true })).toBeVisible();
  }
});

test("a validated personal Claude key is masked and can be removed", async ({ page }) => {
  needsModules("ai");
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
