import path from "node:path";
import type { Page } from "@playwright/test";
import { E2E_BASE_URL, signedOutState } from "../support/signed-out";
import { test, expect, runState } from "../support/fixtures";
import { moduleInstalled, needsModules, withInstalled, type ModuleId } from "../support/modules";

/**
 * Project menu labels (hamburger `.sidenav-current`) for each route. `module`: the page belongs to that
 * Enterprise module and is only there when it is installed.
 */
const ROUTES: { route: string; label: string; module?: ModuleId }[] = [
  { route: "today", label: "Bugün" },
  { route: "works", label: "İşler" },
  { route: "files", label: "Dokümanlar" },
  { route: "reviews", label: "İncelemeler" },
  { route: "forms", label: "Formlar", module: "field" },
  { route: "viewer", label: "Model Görüntüleyici" },
  { route: "coordination", label: "Koordinasyon" },
  { route: "issues", label: "Sorunlar" },
  { route: "param-changes", label: "Parametre Değişiklikleri", module: "coordinate" },
  { route: "schedule", label: "İş Programı", module: "planning" },
  { route: "contracts", label: "Sözleşme ve Hakediş", module: "cost" },
  { route: "quantities", label: "Metraj", module: "cost" },
  { route: "quantities?mode=2d", label: "Metraj", module: "cost" },
  { route: "quantities?mode=approvals", label: "Metraj", module: "cost" },
  { route: "locations", label: "Konumlar" },
  { route: "reports", label: "Raporlar" },
  { route: "spec", label: "Şartname Analizi", module: "manage" },
  { route: "deleted", label: "Silinenler" },
  { route: "settings", label: "Proje Ayarları" },
];

async function assertNoSidewaysScroll(page: Page) {
  const extra = await page.evaluate(
    () => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth,
  );
  expect(extra, "the page should not scroll sideways").toBeLessThanOrEqual(1);
}

async function assertNotUnderProjectBar(page: Page, locator: ReturnType<Page["locator"]>, closest: string) {
  await expect(locator).toBeVisible();
  const box = await locator.boundingBox();
  expect(box, `${closest} should have a box`).toBeTruthy();
  const hit = await page.evaluate(
    ({ x, y, sel }) => document.elementFromPoint(x, y)?.closest(sel) != null,
    { x: box!.x + box!.width / 2, y: box!.y + 6, sel: closest },
  );
  expect(hit, `${closest} should not sit under the project bar`).toBe(true);
}

async function openAndCloseDialog(page: Page, title: string) {
  const dialog = page.getByRole("dialog", { name: title });
  await expect(dialog).toBeVisible();
  await assertNoSidewaysScroll(page);
  await dialog.getByRole("button", { name: "Kapat" }).click();
  await expect(dialog).toBeHidden();
}

test("iPhone project pages keep the hamburger tappable and do not scroll sideways", async ({ page, diagnostics }) => {
  void diagnostics;
  test.setTimeout(90_000);
  const { project } = await runState();

  for (const { route, label } of withInstalled(ROUTES)) {
    await test.step(label, async () => {
      await page.goto(`/projects/${project.id}/${route}`);
      const menu = page.getByRole("button", { name: "Proje menüsü" });
      await expect(menu).toBeVisible();
      await expect(menu).toBeEnabled();
      await expect(page.locator(".sidenav-current")).toHaveText(label);
      if (route === "contracts") {
        await expect(page.getByRole("heading", { name: "Sözleşme ve Hakediş Yönetimi" })).toBeVisible();
      }
      if (route.startsWith("quantities")) {
        await expect(page.getByRole("heading", { name: "Metraj", exact: true })).toBeVisible();
        await expect(page.getByRole("tab", { name: route.endsWith("2d") ? "2B Çizim" : route.endsWith("approvals") ? "Onaylar" : "3B Model" })).toHaveAttribute("aria-selected", "true");
      }
      await assertNoSidewaysScroll(page);
    });
  }
});

test("iPhone hamburger, ask panel and create dialogs stay clickable", async ({ page, diagnostics }) => {
  void diagnostics;
  test.setTimeout(60_000);
  const { project } = await runState();
  const base = `/projects/${project.id}`;

  await page.goto(`${base}/today`);
  // iPhone 11 Safari chrome often leaves innerHeight under 760px; group titles must stay visible.
  await page.setViewportSize({ width: 414, height: 700 });
  const search = page.getByRole("searchbox", { name: "Ara" });
  await search.click();
  await expect(page.locator("#project-nav-drawer")).toBeHidden();
  await expect(page.locator(".menu-search")).toHaveCount(0);
  await search.fill("Bugün");
  await expect(page.getByRole("option", { name: /Bugün/ })).toBeVisible();
  await expect(page.locator("#project-nav-drawer")).toBeHidden();
  await page.keyboard.press("Escape");
  await search.blur();

  await page.getByRole("button", { name: "Proje menüsü" }).click();
  await expect(page.locator(".sidenav-title", { hasText: "Çalışma" })).toBeVisible();
  await expect(page.locator(".sidenav-title", { hasText: "Model ve Koordinasyon" })).toBeVisible();
  await expect(page.locator(".sidenav-title", { hasText: "Planlama ve Analiz" })).toBeVisible();
  await expect(page.locator(".sidenav-title", { hasText: "Yönetim" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Proje Ayarları" })).toBeVisible();
  // Autodesk is on its own page now, not a settings tab (Forma Eşitleme is the Connect module's).
  if (moduleInstalled("connect")) await expect(page.getByRole("link", { name: "Forma Eşitleme" })).toBeVisible();
  await page.getByRole("link", { name: "Proje Ayarları" }).click();
  await expect(page).toHaveURL(new RegExp(`${base}/settings`));
  // The project's Yapay Zekâ tab and "Projeye sor" are the AI module's.
  if (moduleInstalled("ai")) await expect(page.getByRole("tab", { name: "Yapay Zekâ" })).toBeVisible();

  await page.goto(`${base}/today`);
  if (moduleInstalled("ai")) {
    await page.getByRole("button", { name: "Projeye sor" }).click();
    await openAndCloseDialog(page, "Sor");
  }

  await page.getByRole("button", { name: "+ Yeni" }).click();
  await openAndCloseDialog(page, "Ne Yapmak İstiyorsunuz?");

  await page.goto(`${base}/works`);
  await expect(page.getByRole("combobox", { name: "Görünümler" })).toBeVisible();
  await page.getByRole("button", { name: "+ Yeni" }).click();
  await openAndCloseDialog(page, "Ne Yapmak İstiyorsunuz?");

  await page.goto(`${base}/files`);
  await page.getByRole("button", { name: "Diğer" }).click();
  await page.getByRole("menuitem", { name: "Yeni Klasör" }).click();
  await openAndCloseDialog(page, "Yeni Klasör");

  await page.goto(`${base}/locations`);
  await page.getByRole("button", { name: "+ Konum" }).click();
  await openAndCloseDialog(page, "Yeni Konum");

  if (moduleInstalled("planning")) {
    await page.goto(`${base}/schedule`);
    await page.getByRole("button", { name: "İçe Aktar" }).click();
    await openAndCloseDialog(page, "İş Programı İçe Aktar");
  }

  await page.goto(`${base}/coordination`);
  await page.getByRole("button", { name: "+ Yeni Model Seti" }).click();
  await openAndCloseDialog(page, "Yeni Model Seti");

  // Dashboards from templates are the Platform module's (report builder).
  if (moduleInstalled("platform")) {
    await page.goto(`${base}/reports`);
    await page.getByRole("button", { name: "Diğer" }).click();
    await page.getByRole("menuitem", { name: "Şablondan" }).click();
    await openAndCloseDialog(page, "Şablondan Panel Oluştur");
  }

  await page.goto(`${base}/issues`);
  await page.getByRole("button", { name: "Diğer" }).click();
  await expect(page.getByRole("menuitem", { name: "Rapor" })).toBeVisible();
  await page.keyboard.press("Escape");
});

test("iPhone home and account fit; login form stays submittable", async ({ page, diagnostics }) => {
  void diagnostics;
  const { project } = await runState();

  await page.goto("/home");
  await expect(page.getByRole("heading", { name: "Projeler" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Yeni proje" })).toBeEnabled();
  await expect(page.getByRole("link", { name: project.name })).toBeVisible();
  await assertNoSidewaysScroll(page);
  await page.getByRole("button", { name: "Yeni proje" }).click();
  await openAndCloseDialog(page, "Yeni Proje");

  await page.goto(`/projects/${project.id}/viewer`);
  await page.locator(".topbar-switcher").click();
  await assertNotUnderProjectBar(page, page.locator(".menu-heading", { hasText: "Projeler" }), ".menu");
  await assertNoSidewaysScroll(page);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: /Bildirimler/ }).click();
  await assertNotUnderProjectBar(page, page.locator(".bell-menu strong"), ".bell-menu");
  await page.getByRole("button", { name: /Bildirimler/ }).click();
  await page.getByRole("button", { name: "Y", exact: true }).click();
  await assertNotUnderProjectBar(page, page.locator(".menu-profile"), ".menu-profile");
  // The top bar has no room for the tour button on phones; the account menu offers it.
  await expect(page.getByRole("button", { name: "Sanal tur" })).toBeHidden();
  await expect(page.getByRole("menuitem", { name: "Sanal tur" })).toBeVisible();
  await page.getByRole("menuitem", { name: "Hesap ayarları" }).click();
  await expect(page).toHaveURL(/\/account$/);
  await expect(page.getByRole("heading", { name: "Hesabım" })).toBeVisible();
  await assertNoSidewaysScroll(page);
});

test("iPhone schedule import draws Gantt bars", async ({ page, diagnostics }) => {
  needsModules("planning");
  void diagnostics;
  const { project } = await runState();
  const fixture = path.resolve(__dirname, "../fixtures/tiny-schedule.csv");

  await page.goto(`/projects/${project.id}/schedule`);
  await page.getByRole("button", { name: "İçe Aktar", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "İş Programı İçe Aktar" });
  await dialog.locator('input[type="file"]').setInputFiles(fixture);
  await expect(dialog.getByText("2 faaliyet")).toBeVisible();
  await expect(dialog.getByText("Site setup")).toBeVisible();
  await assertNoSidewaysScroll(page);
  await dialog.getByRole("button", { name: "İçe Aktar", exact: true }).click();
  await expect(dialog).toHaveCount(0);

  await expect(page.getByRole("combobox", { name: "İş programı" })).toContainText("tiny-schedule");
  await expect(page.locator(".gantt")).toBeVisible();
  await expect(page.locator(".g-bar")).toHaveCount(2);
  await expect(page.locator(".g-item title").filter({ hasText: "Site setup" })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "İşlemler" })).toBeVisible();
  await assertNoSidewaysScroll(page);
});

test("iPhone time–distance view and location wizard fit the screen", async ({ page, diagnostics }) => {
  needsModules("planning");
  void diagnostics;
  const { project } = await runState();

  await page.goto(`/projects/${project.id}/schedule?v=td`);
  await expect(page.getByRole("button", { name: "Zaman–Mesafe" })).toBeVisible();
  await expect(page.getByTestId("time-distance")).toBeVisible();
  await assertNoSidewaysScroll(page);
  await page.getByRole("button", { name: /^Konum Ata/ }).click();
  const dialog = page.getByRole("dialog", { name: "Konum Atama Sihirbazı" });
  await expect(dialog.getByRole("button", { name: "Km Tablosu Yükle" })).toBeVisible();
  await assertNoSidewaysScroll(page);
  await dialog.getByRole("button", { name: "Kapat", exact: true }).last().click();
  await expect(dialog).toHaveCount(0);
});

test("iPhone schedule resources dialog and histogram fit the screen", async ({ page, diagnostics }) => {
  needsModules("planning");
  void diagnostics;
  const { project } = await runState();
  const code = `M${Date.now() % 100_000}`;

  await page.goto(`/projects/${project.id}/schedule`);
  await page.getByRole("button", { name: "Filtre" }).click();
  await page.getByRole("menuitem", { name: "Kaynaklar" }).click();
  const dialog = page.getByRole("dialog", { name: "Kaynaklar" });
  await expect(dialog.getByRole("button", { name: "Kaynak Kütüphanesi" })).toBeVisible();
  await assertNoSidewaysScroll(page);

  await dialog.getByRole("button", { name: "+ Kaynak" }).click();
  await dialog.getByLabel("Kaynak Kodu").fill(code);
  await dialog.getByLabel("Kaynak Adı").fill("Ray döşeme ekibi");
  await dialog.getByLabel("Birim", { exact: true }).fill("kişi");
  await dialog.getByLabel("Günlük Kapasite (boşsa sınırsız)").fill("12");
  await dialog.getByRole("button", { name: "Kaydet" }).click();
  await expect(dialog.getByText(code, { exact: true })).toBeVisible();
  await assertNoSidewaysScroll(page);

  await dialog.getByRole("button", { name: "Histogram", exact: true }).click();
  await expect(dialog.getByLabel("Kaynak", { exact: true })).toBeVisible();
  await assertNoSidewaysScroll(page);
  await dialog.getByRole("button", { name: "Kapat" }).click();
  await expect(dialog).toHaveCount(0);
});

test("iPhone schedule translations dialog fits the screen", async ({ page, diagnostics }) => {
  needsModules("planning");
  void diagnostics;
  const { project } = await runState();

  await page.goto(`/projects/${project.id}/schedule`);
  await page.getByRole("button", { name: "İşlemler" }).click();
  await page.getByRole("menuitem", { name: "Çeviriler" }).click();
  const dialog = page.getByRole("dialog", { name: "Faaliyet Adı Çevirileri" });
  await expect(dialog.getByRole("combobox", { name: "Dil" })).toHaveValue("en");
  await expect(dialog.getByRole("button", { name: "Şablonu İndir" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Yapay Zekâ ile Çevir" })).toBeVisible();
  await expect(dialog.getByTestId("translations-table")).toBeVisible();
  await assertNoSidewaysScroll(page);
  await dialog.getByLabel("Eksik").check();
  await assertNoSidewaysScroll(page);
  await dialog.getByRole("button", { name: "Kapat", exact: true }).last().click();
  await expect(dialog).toHaveCount(0);
});

test("iPhone schedule checks and duration basis dialogs fit the screen", async ({ page, diagnostics }) => {
  needsModules("planning");
  void diagnostics;
  const { project } = await runState();

  await page.goto(`/projects/${project.id}/schedule`);
  await page.getByRole("button", { name: "İşlemler" }).click();
  await page.getByRole("menuitem", { name: "Program Kontrolü" }).click();
  const checks = page.getByRole("dialog", { name: "Program Kontrolü" });
  await expect(checks.getByLabel("Önem")).toBeVisible();
  await expect(checks.getByRole("button", { name: "Excel'e Aktar" })).toBeVisible();
  await expect(checks.getByTestId("checks-list")).toBeVisible();
  await assertNoSidewaysScroll(page);
  await checks.getByRole("button", { name: /Süre Dayanağı Eksik/ }).click();
  await assertNoSidewaysScroll(page);
  await checks.getByRole("button", { name: "Kapat", exact: true }).last().click();
  await expect(checks).toHaveCount(0);

  await page.getByRole("button", { name: "İşlemler" }).click();
  await page.getByRole("menuitem", { name: "Süre Dayanağı" }).click();
  const basis = page.getByRole("dialog", { name: "Süre Dayanağı" });
  await expect(basis.getByRole("button", { name: "Şablonu İndir" })).toBeVisible();
  await expect(basis.getByTestId("basis-table")).toBeVisible();
  await assertNoSidewaysScroll(page);
  await basis.getByLabel("Eksik").check();
  await assertNoSidewaysScroll(page);
  await basis.getByRole("button", { name: "Kapat", exact: true }).last().click();
  await expect(basis).toHaveCount(0);
});

test("iPhone schedule activity codes and payments dialogs fit the screen", async ({ page, diagnostics }) => {
  needsModules("planning");
  void diagnostics;
  const { project } = await runState();

  await page.goto(`/projects/${project.id}/schedule`);
  await page.getByRole("button", { name: "İşlemler" }).click();
  await page.getByRole("menuitem", { name: "Faaliyet Kodları" }).click();
  const codes = page.getByRole("dialog", { name: "Faaliyet Kodları" });
  await expect(codes.getByRole("button", { name: "+ Kod Türü" })).toBeVisible();
  await assertNoSidewaysScroll(page);
  await codes.getByRole("button", { name: "Kapat", exact: true }).last().click();
  await expect(codes).toHaveCount(0);

  await page.getByRole("button", { name: "İşlemler" }).click();
  await page.getByRole("menuitem", { name: "Ödeme Çizelgesi" }).click();
  const pay = page.getByRole("dialog", { name: "Ödeme Çizelgesi" });
  await expect(pay.getByRole("button", { name: "Şablonu İndir" })).toBeVisible();
  await assertNoSidewaysScroll(page);
  await pay.getByRole("button", { name: "+ Ödeme Kalemi" }).click();
  await pay.getByLabel("Kalem Kodu", { exact: true }).fill("M-1");
  await pay.getByLabel("Tutar", { exact: true }).fill("1000");
  await assertNoSidewaysScroll(page);
  await pay.getByRole("button", { name: "Kaydet", exact: true }).click();
  await expect(pay.getByText("Kaydedildi.")).toBeVisible();
  await expect(pay.getByRole("cell", { name: "M-1" })).toBeVisible();
  for (const tab of ["Nakit Akışı", "İzlenebilirlik"]) {
    await pay.getByRole("button", { name: tab, exact: true }).click();
    await assertNoSidewaysScroll(page);
  }
  await pay.getByRole("button", { name: "Kapat", exact: true }).last().click();
  await expect(pay).toHaveCount(0);
});

test("iPhone schedule KPI dashboard and monthly report fit the screen", async ({ page, diagnostics }) => {
  needsModules("planning");
  void diagnostics;
  const { project } = await runState();

  await page.goto(`/projects/${project.id}/schedule?v=kpi`);
  const view = page.getByTestId("kpi-view");
  await expect(view.getByRole("heading", { name: "KPI Panosu" })).toBeVisible();
  await expect(view.getByTestId("kpi-spi")).toBeVisible();
  await assertNoSidewaysScroll(page);
  await view.getByRole("button", { name: "Bildirim Ekle" }).click();
  const delay = page.getByRole("dialog", { name: "Yeni Gecikme Bildirimi" });
  await delay.getByLabel("Açıklama").fill("Erişim gecikti");
  await assertNoSidewaysScroll(page);
  await delay.getByRole("button", { name: "Kaydet", exact: true }).click();
  await expect(delay).toHaveCount(0);
  await expect(view.getByText("Erişim gecikti").first()).toBeVisible();
  await assertNoSidewaysScroll(page);
  await view.getByRole("button", { name: "Aylık Rapor" }).click();
  const dlg = page.getByRole("dialog", { name: "Aylık Rapor" });
  await expect(dlg.getByRole("button", { name: "Rapor Oluştur" })).toBeVisible();
  await assertNoSidewaysScroll(page);
  await dlg.getByRole("button", { name: "Kapat", exact: true }).last().click();
  await expect(dlg).toHaveCount(0);
});

test("iPhone document upload, delete and restore stay tappable", async ({ page, diagnostics }) => {
  void diagnostics;
  const { project } = await runState();
  const fileName = "critical-path.txt";
  const fixture = path.resolve(__dirname, "../fixtures/critical-path.txt");

  await page.goto(`/projects/${project.id}/files`);
  await page.locator(".docs-toolbar input[type=file]").setInputFiles(fixture);
  const upload = page.getByRole("dialog", { name: /Yükle/ });
  await expect(upload).toBeVisible();
  await expect(upload.getByRole("button", { name: "1 Dosyayı Yükle" })).toBeEnabled();
  await assertNoSidewaysScroll(page);
  await upload.getByRole("button", { name: "1 Dosyayı Yükle" }).click();
  await expect(upload.getByText(/Yüklendi · V\d+/)).toBeVisible();
  await upload.locator(".dialog-actions").getByRole("button", { name: "Kapat" }).click();

  await expect(page.getByText(fileName, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Diğer" }).click();
  await page.getByRole("menuitemcheckbox", { name: "Seç" }).click();
  await page.getByRole("checkbox", { name: `${fileName} seç` }).check();
  await page.getByRole("button", { name: "Sil (1)" }).click();
  await page.getByRole("dialog", { name: "Dosyaları sil" }).getByRole("button", { name: "1 dosyayı sil" }).click();
  await expect(page.getByText(fileName, { exact: true })).toHaveCount(0);

  await page.goto(`/projects/${project.id}/deleted`);
  const deletedRow = page.getByRole("row").filter({ hasText: fileName });
  await expect(deletedRow).toBeVisible();
  await deletedRow.getByRole("button", { name: "Geri Yükle" }).click();
  await expect(page.getByRole("row").filter({ hasText: fileName })).toHaveCount(0);
  await assertNoSidewaysScroll(page);

  await page.goto(`/projects/${project.id}/files`);
  await expect(page.getByText(fileName, { exact: true })).toBeVisible();
});

test("iPhone model viewer opens the models sheet on an empty canvas", async ({ page, diagnostics }) => {
  void diagnostics;
  const { project } = await runState();

  await page.goto(`/projects/${project.id}/viewer`);
  await expect(page.getByText("Modeller düğmesinden bir veya birden fazla model seçin.")).toBeVisible();
  await expect(page.locator(".viewer-container")).toBeVisible();
  await page.getByRole("button", { name: /Modeller/ }).click();
  const sheet = page.getByRole("complementary", { name: "Modeller" });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole("button", { name: "Tamam" })).toBeVisible();
  const empty = sheet.getByText("Görüntülenebilir IFC dosyası yok. Dokümanlar'dan IFC yükleyin.");
  const listed = sheet.locator(".model-item");
  await expect(empty.or(listed.first())).toBeVisible();
  await assertNoSidewaysScroll(page);
  await sheet.getByRole("button", { name: "Tamam" }).click();
  await expect(sheet).toBeHidden();
});

test("iPhone administration tabs stay tappable", async ({ page, diagnostics }) => {
  void diagnostics;
  await page.goto("/home");
  await page.getByRole("button", { name: "Y", exact: true }).click();
  await page.getByRole("menuitem", { name: "Sistem yönetimi" }).click();
  await expect(page).toHaveURL(/\/administration/);
  await expect(page.getByRole("heading", { name: "Yönetim", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Kullanıcılar", exact: true })).toBeVisible();
  await assertNoSidewaysScroll(page);

  // `module`: the tab belongs to that Enterprise module and is only there when it is installed.
  const tabs: { label: string; heading: string; module?: ModuleId }[] = [
    { label: "Yapay Zekâ ve MCP", heading: "Yapay Zekâ Modu", module: "ai" },
    { label: "Office Entegrasyonu", heading: "Tarayıcıda Düzenleme (WOPI)" },
    { label: "OAuth Uygulamaları", heading: "OAuth Uygulamaları" },
    { label: "Gizlilik Merkezi", heading: "Tüm Dış Bağlantıları Kapat" },
    { label: "Kullanıcılar ve Firmalar", heading: "Kullanıcılar" },
  ];
  for (const { label, heading } of withInstalled(tabs)) {
    await page.getByRole("button", { name: label, exact: true }).click();
    await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
    await assertNoSidewaysScroll(page);
  }
});

test.describe("iPhone login", () => {
  test.use({ storageState: signedOutState(E2E_BASE_URL) });

  test("login controls stay visible", async ({ page, allowApiFailure, diagnostics }) => {
    void diagnostics;
    allowApiFailure(401, "/api/v1/auth/me");
    await page.goto("/login");
    await expect(page.getByRole("heading", { name: "Hesabınıza giriş yapın" })).toBeVisible();
    await expect(page.getByLabel("E-posta adresi")).toBeVisible();
    await expect(page.locator("#password")).toBeVisible();
    await expect(page.getByRole("button", { name: "Giriş yap" })).toBeEnabled();
    await assertNoSidewaysScroll(page);
  });
});
