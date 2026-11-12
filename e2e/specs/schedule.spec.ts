import path from "node:path";
import { expect, runState, test } from "../support/project-features";
import { needsModules } from "../support/modules";

needsModules("planning");

test("imports a tiny CSV schedule through the empty schedule page", async ({ page }) => {
  const { project } = await runState();
  const fixture = path.resolve(__dirname, "../fixtures/tiny-schedule.csv");

  await page.goto(`/projects/${project.id}/schedule`);

  await expect(page.getByRole("combobox", { name: "İş programı" })).toHaveValue("");
  await expect(page.getByRole("button", { name: "İçe Aktar", exact: true })).toBeVisible();
  await expect(page.getByText("Bu projede henüz iş programı yok.")).toBeVisible();

  await page.getByRole("button", { name: "İçe Aktar", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "İş Programı İçe Aktar" });
  await dialog.locator('input[type="file"]').setInputFiles(fixture);

  await expect(dialog.getByText("2 faaliyet")).toBeVisible();
  await expect(dialog.getByRole("cell", { name: "Site setup", exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "İçe Aktar", exact: true }).click();

  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: "İş programı" })).toContainText("tiny-schedule");
  await expect(page.getByText("2 faaliyet", { exact: false })).toBeVisible();
  await expect(page.getByText("Site setup", { exact: true })).toBeVisible();
  await expect(page.getByText("Foundation check", { exact: true })).toBeVisible();
});
