/**
 * Invitations of people without an account (docs/features/INVITATIONS.md): the set-up wizard invites
 * a new address, the inviter gets the link (no SMTP in e2e), the person accepts it signed out, sets a
 * name and password and sees the project; people imported from a CSV file with a per-row preview;
 * invite, resend and revoke on the project members screen. The interface is Turkish (admin profile).
 */
import { randomUUID } from "node:crypto";
import type { Browser, Page } from "@playwright/test";
import { test, expect } from "../support/fixtures";
import { E2E_BASE_URL, signedOutState } from "../support/signed-out";

async function ok<T>(response: { ok(): boolean; status(): number; text(): Promise<string>; json(): Promise<T> }, action: string): Promise<T> {
  if (!response.ok()) throw new Error(`${action} failed (${response.status()}): ${await response.text()}`);
  return response.json();
}

async function openWizardAtPeople(page: Page, name: string, code: string) {
  await page.goto("/home");
  await page.getByRole("button", { name: "Yeni proje" }).click();
  const dialog = page.getByRole("dialog", { name: "Yeni Proje" });
  await dialog.getByTestId("new-project-wizard").click();
  const next = () => dialog.getByRole("button", { name: "İleri", exact: true }).click();
  await dialog.getByRole("radio", { name: /Türkçe/ }).check();
  await next();
  await dialog.locator('[data-template="iso19650-temel"]').click();
  await next();
  await dialog.getByLabel("Proje adı").fill(name);
  await dialog.getByLabel("Proje kodu").fill(code);
  await next();
  await next();
  await expect(dialog.getByRole("heading", { name: /Adım 5 \/ 11/ })).toBeVisible();
  return { dialog, next };
}

/** Opens the link in a signed-out browser, accepts with a name and password; returns the new page. */
async function accept(browser: Browser, link: string, name: string) {
  const context = await browser.newContext({ storageState: signedOutState(E2E_BASE_URL) });
  const page = await context.newPage();
  await page.goto(link);
  const card = page.getByTestId("accept-invitation");
  await expect(card.getByRole("heading", { name: "Daveti Kabul Edin" })).toBeVisible();
  await card.getByLabel("Adınız").fill(name);
  await card.getByLabel("Şifre", { exact: true }).fill("Davetli-Sifre-2026");
  await card.getByLabel("Şifre Tekrar").fill("Davetli-Sifre-2026");
  await card.getByRole("button", { name: "Kabul Et ve Giriş Yap" }).click();
  await expect(page).toHaveURL(/\/home$/);
  return { page, context };
}

test("wizard: a new address is invited, the link is accepted and the person sees the project", async ({ page, browser, request }) => {
  test.setTimeout(120_000);
  const s = randomUUID().slice(0, 6).toUpperCase();
  const projectName = `Davet Projesi ${s}`;
  const email = `davetli-${s.toLowerCase()}@example.com`;
  const { dialog, next } = await openWizardAtPeople(page, projectName, `DV${s}`);

  await expect(dialog.getByRole("checkbox", { name: "Hesabı Olmayan Kişileri Davet Et" })).toBeChecked();
  await dialog.getByLabel("E-posta Adresleri").fill(email);
  await dialog.getByRole("button", { name: "Ekle", exact: true }).click();
  const row = dialog.locator(`[data-email="${email}"]`);
  await expect(row).toContainText("Hesap yok: davet edilecek");
  await row.getByLabel(`${email} adı`).fill("Deniz Davetli");
  for (let step = 6; step <= 11; step++) await next();

  // Summary: the dry run says the address will be invited.
  await expect(dialog.getByText("Her şey uygun. Proje oluşturulabilir.")).toBeVisible();
  await expect(dialog.getByTestId("setup-people-check").locator(`[data-email="${email}"]`)).toHaveAttribute("data-status", "invite");
  await dialog.getByRole("button", { name: "Projeyi Oluştur" }).click();

  // Report: invited, with the link to hand over (no e-mail server in e2e).
  const report = dialog.getByTestId("setup-report");
  const person = report.locator(`li[data-email="${email}"]`);
  await expect(person).toHaveAttribute("data-status", "invited");
  await expect(person).toContainText("E-posta sunucusu ayarlı değil");
  const link = await person.getByRole("textbox").inputValue();
  expect(link).toMatch(/\/invite#7dcde_invite_/);

  const projects = await ok<{ id: string; name: string }[]>(await request.get("/api/v1/projects"), "projects");
  const pid = projects.find((p) => p.name === projectName)!.id;
  const members = await ok<{ email: string; pending?: boolean }[]>(await request.get(`/api/v1/projects/${pid}/members`), "members");
  expect(members.find((m) => m.email === email)?.pending).toBe(true);

  // The person accepts signed out and lands on their projects.
  const accepted = await accept(browser, link, "Deniz Davetli");
  await expect(accepted.page.getByText(projectName).first()).toBeVisible();
  // The link is spent.
  const again = await accepted.context.newPage();
  await again.goto(link);
  await expect(again.getByTestId("accept-invitation")).toContainText("zaten kabul edildi");
  await accepted.context.close();

  const after = await ok<{ email: string; pending?: boolean }[]>(await request.get(`/api/v1/projects/${pid}/members`), "members");
  expect(after.find((m) => m.email === email)?.pending).toBeFalsy();
});

test("wizard: people imported from a CSV file with a per-row preview", async ({ page, request }) => {
  const s = randomUUID().slice(0, 6).toUpperCase();
  const existing = `csv-var-${s.toLowerCase()}@7d-cde.localhost`;
  await ok(await request.post("/api/v1/users", { data: { email: existing, name: `CSV Var ${s}`, password: "Csv-Kullanici-2026" } }), "user");
  const fresh = `csv-yeni-${s.toLowerCase()}@example.com`;
  const { dialog } = await openWizardAtPeople(page, `CSV Projesi ${s}`, `CS${s}`);

  const csv = [`E-posta;Ad Soyad;Firma`, `${existing};CSV Var;`, `${fresh};Yeni Kişi;`, `bozuk-adres;Bozuk;`, `${fresh};Tekrar;`, `info@example.com;Ortak;`].join("\n");
  await dialog.getByLabel("Kişi dosyası (CSV ya da Excel)").setInputFiles({ name: "kisiler.csv", mimeType: "text/csv", buffer: Buffer.from(csv, "utf8") });
  const preview = dialog.getByTestId("setup-import-preview");
  await expect(preview).toContainText("kisiler.csv: 5 satır, 2 eklenebilir.");
  await expect(preview.locator('tr[data-line="2"]')).toHaveAttribute("data-outcome", "added");
  await expect(preview.locator('tr[data-line="3"]')).toHaveAttribute("data-outcome", "invite");
  await expect(preview.locator('tr[data-line="4"]')).toContainText("e-posta adresi değil");
  await expect(preview.locator('tr[data-line="5"]')).toContainText("iki kez");
  await expect(preview.locator('tr[data-line="6"]')).toHaveAttribute("data-outcome", "group_address");
  await preview.getByRole("button", { name: "2 Kişiyi Ekle" }).click();

  await expect(dialog.getByTestId("setup-import-preview")).toHaveCount(0);
  await expect(dialog.locator(`tr[data-email="${existing}"]`)).toContainText(`CSV Var ${s}`);
  await expect(dialog.locator(`tr[data-email="${fresh}"]`).getByLabel(`${fresh} adı`)).toHaveValue("Yeni Kişi");
  await expect(dialog.locator('tr[data-email="bozuk-adres"]')).toHaveCount(0);
});

test("members screen: invite, send again, revoke; an existing account is added at once", async ({ page, browser, request }) => {
  test.setTimeout(90_000);
  const s = randomUUID().slice(0, 6).toUpperCase();
  const project = await ok<{ id: string }>(await request.post("/api/v1/projects", { data: { code: `UY${s}`, name: `Üye Daveti ${s}` } }), "project");
  const existing = `uye-var-${s.toLowerCase()}@7d-cde.localhost`;
  await ok(await request.post("/api/v1/users", { data: { email: existing, name: `Üye Var ${s}`, password: "Uye-Kullanici-2026" } }), "user");
  await page.goto(`/projects/${project.id}/settings?sekme=uyeler`);
  const section = page.getByTestId("member-invitations");
  await expect(section.getByRole("heading", { name: "E-postayla Davet Et" })).toBeVisible();
  await expect(section).toContainText("E-posta sunucusu ayarlı değil");

  const invite = async (email: string) => {
    await section.getByLabel("Davet edilecek e-posta adresi").fill(email);
    await section.getByRole("button", { name: "Davet Et", exact: true }).click();
  };

  // An existing account is added, no invitation.
  await invite(existing);
  await expect(section.getByRole("status")).toContainText("hesabı var; projeye eklendi");

  // A new address: invitation with a link, listed as open; the member list shows it as invited.
  const fresh = `uye-yeni-${s.toLowerCase()}@example.com`;
  await invite(fresh);
  await expect(section.getByRole("status")).toContainText(`${fresh} davet edildi`);
  const firstLink = await section.getByTestId("invitation-link").getByRole("textbox").inputValue();
  const list = section.getByTestId("invitation-list");
  await expect(list.locator(`tr[data-email="${fresh}"]`)).toHaveAttribute("data-status", "open");
  await expect(page.locator("tr", { hasText: fresh }).filter({ hasText: "Davetli" }).first()).toBeVisible();

  // Send again: a new link, the first one stops working.
  await list.locator(`tr[data-email="${fresh}"]`).getByRole("button", { name: "Yeniden Gönder" }).click();
  await expect(section.getByRole("status")).toContainText("önceki bağlantı artık çalışmaz");
  const secondLink = await section.getByTestId("invitation-link").getByRole("textbox").inputValue();
  expect(secondLink).not.toBe(firstLink);

  // Revoke another invitation.
  const other = `uye-geri-${s.toLowerCase()}@example.com`;
  await invite(other);
  await expect(list.locator(`tr[data-email="${other}"]`)).toHaveAttribute("data-status", "open");
  await list.locator(`tr[data-email="${other}"]`).getByRole("button", { name: "Geri Çek" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Geri Çek" }).click();
  await expect(list.locator(`tr[data-email="${other}"]`)).toHaveAttribute("data-status", "revoked");

  // The first link is refused, the second accepted.
  const context = await browser.newContext({ storageState: signedOutState(E2E_BASE_URL) });
  const stale = await context.newPage();
  await stale.goto(firstLink);
  await expect(stale.getByTestId("accept-invitation")).toContainText("geçerli değil");
  await context.close();
  const accepted = await accept(browser, secondLink, "Yeni Üye");
  await expect(accepted.page.getByText(`Üye Daveti ${s}`).first()).toBeVisible();
  await accepted.context.close();

  await page.reload();
  await expect(page.getByTestId("invitation-list").locator(`tr[data-email="${fresh}"]`)).toHaveAttribute("data-status", "accepted");
  const audit = await ok<{ action: string }[]>(await request.get(`/api/v1/projects/${project.id}/activity`), "activity");
  const actions = audit.map((a) => a.action);
  for (const action of ["invitation.created", "invitation.resent", "invitation.revoked", "invitation.accepted"]) expect(actions).toContain(action);
});
