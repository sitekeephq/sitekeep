import { test, expect, runState } from "../support/fixtures";
import { needsModules, withInstalled, type ModuleId } from "../support/modules";

test("home lists the API-created project", async ({ page }) => {
  const { project } = await runState();
  await page.goto("/home");

  await expect(page.getByRole("heading", { name: "Projeler" })).toBeVisible();
  await expect(page.getByRole("link", { name: project.name })).toBeVisible();
  await expect(page.getByText(project.code, { exact: true })).toBeVisible();
});

test("project root redirects to its files page", async ({ page }) => {
  const { project } = await runState();
  await page.goto(`/projects/${project.id}`);

  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/files$`));
  await expect(page.getByLabel("Proje navigasyonu")).toBeVisible();
  await expect(page.getByText("Proje Dosyaları", { exact: true }).first()).toBeVisible();
});

test("top bar opens tasks and account", async ({ page }) => {
  await page.goto("/home");

  await page.getByRole("link", { name: "Görevlerim" }).click();
  await expect(page).toHaveURL(/\/tasks$/);
  await expect(page.getByRole("heading", { name: "Görevlerim", exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Y", exact: true }).click();
  await page.getByRole("menuitem", { name: "Hesap ayarları" }).click();
  await expect(page).toHaveURL(/\/account$/);
  await expect(page.getByRole("heading", { name: "Hesabım" })).toBeVisible();
});

// AGPL-3.0 §13: every user is offered the source of the version they use (About, account menu).
test("account menu opens About with the source code link and the open-source licences", async ({ page }) => {
  await page.goto("/home");

  await page.getByRole("button", { name: "Y", exact: true }).click();
  await page.getByRole("menuitem", { name: "SiteKeep Hakkında" }).click();
  await expect(page).toHaveURL(/\/about$/);
  await expect(page.getByRole("heading", { name: "SiteKeep Hakkında" })).toBeVisible();
  await expect(page.getByText(/^SiteKeep (Community|Enterprise)$/)).toBeVisible();
  const source = page.getByRole("link", { name: "Kaynak Kodunu Al" });
  await expect(source).toBeVisible();
  await expect(source).toHaveAttribute("href", /^https:\/\/github\.com\/sitekeephq\/sitekeep(\/tree\/v[\w.-]+)?$/);
  await expect(page.getByText("SiteKeep™, 7Dimensions OÜ'nün ticari markasıdır.")).toBeVisible();

  await page.getByRole("link", { name: "Açık Kaynak Lisanslarını Göster" }).click();
  await expect(page).toHaveURL(/\/about\/licences$/);
  const notices = page.getByTestId("third-party-notices");
  await expect(notices).toContainText("# Third-Party Notices");
  await expect(notices).toContainText("LibreDWG");
  await expect(notices).not.toContainText("sitekeep-ee-");
});

test("Modele Sor disables the project-wide assistant", async ({ page }) => {
  needsModules("ai"); // "Projeye sor" is the AI module's
  const { project } = await runState();
  await page.goto(`/projects/${project.id}/files`);
  const projectAsk = page.getByRole("button", { name: "Projeye sor", exact: false });
  await expect(projectAsk).toBeEnabled();

  await page.evaluate(() => window.dispatchEvent(new CustomEvent("cde:model-ask-visibility", { detail: true })));
  await expect(projectAsk).toBeDisabled();
  await expect(projectAsk).toHaveAttribute("title", /Modele Sor açıkken/);
  await page.keyboard.press("Meta+K");
  await expect(page.getByRole("dialog", { name: "Sor" })).toHaveCount(0);

  await page.evaluate(() => window.dispatchEvent(new CustomEvent("cde:model-ask-visibility", { detail: false })));
  await expect(projectAsk).toBeEnabled();
});

test("main project navigation routes render without browser or API errors", async ({ page }) => {
  const { project } = await runState();
  // `module`: the page belongs to that Enterprise module and is only there when it is installed.
  const routes: { route: string; label: string; module?: ModuleId }[] = [
    { route: "today", label: "Bugün" },
    { route: "works", label: "İşler" },
    { route: "files", label: "Dokümanlar" },
    { route: "reviews", label: "İncelemeler" },
    { route: "forms", label: "Formlar", module: "field" },
    { route: "issues", label: "Sorunlar" },
    { route: "schedule", label: "İş Programı", module: "planning" },
    { route: "locations", label: "Konumlar" },
    { route: "reports", label: "Raporlar" },
    { route: "deleted", label: "Silinenler" },
    { route: "settings", label: "Proje Ayarları" },
  ];

  for (const { route, label } of withInstalled(routes)) {
    await test.step(label, async () => {
      await page.goto(`/projects/${project.id}/${route}`);
      await expect(page.getByLabel("Konum").getByText(label, { exact: true })).toBeVisible();
      await expect(page.getByLabel("Proje navigasyonu")).toBeVisible();
    });
  }
});
