import { test, expect, runState } from "../support/fixtures";
import { ADMIN_EMAIL, ADMIN_PASSWORD } from "../support/global-setup";

/**
 * Interface languages (docs/architecture/i18n.md): English by default, the top bar menu switches,
 * the choice survives a reload and follows the user's profile. The other specs run in Turkish.
 */
test.use({ storageState: { cookies: [], origins: [] } });

test("English by default, switches to Turkish from the top bar and remembers it", async ({ page, allowApiFailure }) => {
  allowApiFailure(401, "/api/v1/auth/me");
  const { project } = await runState();

  await page.goto("/login");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.getByRole("heading", { name: "Sign In to Your Account" })).toBeVisible();
  await page.getByPlaceholder("first.last@company.com").fill(ADMIN_EMAIL);
  await page.getByPlaceholder("Enter your password").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Sign In", exact: true }).click();

  // The admin's profile says Turkish (global setup): it wins after sign-in.
  await expect(page.locator("html")).toHaveAttribute("lang", "tr");

  await page.goto(`/projects/${project.id}/files`);
  const menu = page.getByRole("button", { name: /^Dil: Türkçe$/ });
  await menu.click();
  await page.getByRole("menuitemradio", { name: /English/ }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.getByRole("link", { name: "My Tasks" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Language: English" })).toBeVisible();

  await page.reload();
  await expect(page.getByRole("link", { name: "My Tasks" })).toBeVisible();

  // Back to Turkish for the specs that follow (same admin profile).
  await page.getByRole("button", { name: "Language: English" }).click();
  await page.getByRole("menuitemradio", { name: /Türkçe/ }).click();
  await expect(page.getByRole("link", { name: "Görevlerim" })).toBeVisible();
  const prefs = await page.evaluate(async () => (await fetch("/api/v1/me/prefs")).json());
  expect(prefs.language).toBe("tr");
});
