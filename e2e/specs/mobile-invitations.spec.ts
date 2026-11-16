/**
 * Invitations on an iPhone (docs/features/INVITATIONS.md): the members screen with an open invitation
 * and the accept page fit the screen without sideways scrolling, and accepting works.
 */
import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import { test, expect } from "../support/fixtures";
import { E2E_BASE_URL, signedOutState } from "../support/signed-out";

async function assertNoSidewaysScroll(page: Page) {
  const extra = await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth);
  expect(extra, "the page should not scroll sideways").toBeLessThanOrEqual(1);
}

test("iPhone: members screen invitations and the accept page fit the screen", async ({ page, browser, request }) => {
  test.setTimeout(90_000);
  const s = randomUUID().slice(0, 6).toUpperCase();
  const created = await request.post("/api/v1/projects", { data: { code: `MI${s}`, name: `Mobil Davet ${s}` } });
  expect(created.ok()).toBe(true);
  const project = (await created.json()) as { id: string };
  const email = `mobil-${s.toLowerCase()}@example.com`;

  await page.goto(`/projects/${project.id}/settings?sekme=uyeler`);
  const section = page.getByTestId("member-invitations");
  await section.getByLabel("Davet edilecek e-posta adresi").fill(email);
  await section.getByRole("button", { name: "Davet Et", exact: true }).click();
  await expect(section.getByTestId("invitation-list").locator(`tr[data-email="${email}"]`)).toBeVisible();
  const link = await section.getByTestId("invitation-link").getByRole("textbox").inputValue();
  await assertNoSidewaysScroll(page);

  const { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch } = test.info().project.use;
  const context = await browser.newContext({
    baseURL: E2E_BASE_URL,
    viewport,
    userAgent,
    deviceScaleFactor,
    isMobile,
    hasTouch,
    storageState: signedOutState(E2E_BASE_URL),
  });
  const phone = await context.newPage();
  await phone.goto(link);
  const card = phone.getByTestId("accept-invitation");
  await expect(card.getByRole("heading", { name: "Daveti Kabul Edin" })).toBeVisible();
  await assertNoSidewaysScroll(phone);
  await card.getByLabel("Adınız").fill("Mobil Davetli");
  await card.getByLabel("Şifre", { exact: true }).fill("Mobil-Davet-2026");
  await card.getByLabel("Şifre Tekrar").fill("Mobil-Davet-2026");
  await card.getByRole("button", { name: "Kabul Et ve Giriş Yap" }).click();
  await expect(phone).toHaveURL(/\/home$/);
  await expect(phone.getByText(`Mobil Davet ${s}`).first()).toBeVisible();
  await context.close();
});
