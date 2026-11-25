import { test, expect } from "../support/fixtures";

test("a person turns a workflow e-mail type off on the account page and it stays off after a reload", async ({ page }) => {
  await page.goto("/account");
  const card = page.getByTestId("email-notifications");
  await expect(card.getByRole("heading", { name: "E-posta bildirimleri" })).toBeVisible();

  const overdue = card.getByLabel("Termin geçti");
  await expect(overdue).toHaveValue("inherit");
  const saved = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/v1/me/prefs" && r.request().method() === "PATCH");
  await overdue.selectOption("off");
  expect((await saved).ok()).toBe(true);
  await expect(card.getByText("Kaydedildi.")).toBeVisible();

  await page.reload();
  const again = page.getByTestId("email-notifications").getByLabel("Termin geçti");
  await expect(again).toHaveValue("off");

  // Back to the project default so the shared admin account stays as it was.
  await again.selectOption("inherit");
  await expect(page.getByText("Kaydedildi.")).toBeVisible();
});
