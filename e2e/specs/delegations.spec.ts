// Approval delegation ("Vekâletler", issue #190; Platform module 0.4.0): a person gives a delegate for
// today in this project, sees it running, then ends it.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { test, expect } from "../support/fixtures";
import { needsModules } from "../support/modules";

function platformHasDelegations(): boolean {
  const file = path.resolve(__dirname, "../../node_modules/@sitekeephq/sitekeep-ee-platform/package.json");
  if (!existsSync(file)) return false;
  const [major, minor] = (JSON.parse(readFileSync(file, "utf8")) as { version: string }).version.split(".").map(Number);
  return major! > 0 || minor! >= 4;
}

test.describe("approval delegation", () => {
  needsModules("platform");
  test.skip(!platformHasDelegations(), "needs Platform 0.4.0 (delegations)");

  test("a person delegates to a project member for today and ends it", async ({ page, request }) => {
    const suffix = Date.now().toString(36);
    const project = (await (await request.post("/api/v1/projects", { data: { code: `VKL-${suffix}`.slice(0, 12), name: `Vekalet ${suffix}` } })).json()) as { id: string };
    const email = `vekil-${suffix}@e2e.test`;
    expect((await request.post("/api/v1/users", { data: { email, name: `Vekil ${suffix}`, password: "Sifre-1234567" } })).ok()).toBe(true);
    expect((await request.post(`/api/v1/projects/${project.id}/members`, { data: { email } })).ok()).toBe(true);

    await page.goto(`/projects/${project.id}/delegations`);
    await expect(page.getByRole("heading", { name: "Vekâletler", exact: true })).toBeVisible();
    const field = (name: string) => page.locator("label", { hasText: new RegExp(`^${name}`) });
    await field("Vekil").locator("select").selectOption({ label: `Vekil ${suffix}` });
    await field("Not").locator("input").fill("Yıllık izin");
    await page.getByRole("button", { name: "Yetkileri kontrol et" }).click();
    await expect(page.getByText(/Uyarı yok|Uyarı/).first()).toBeVisible();
    await page.getByRole("button", { name: "Kaydet" }).click();
    await expect(page.getByText(`Vekâlet kaydedildi: Vekil ${suffix}.`)).toBeVisible();

    const mine = page.locator("section", { has: page.getByRole("heading", { name: "Vekâletlerim" }) });
    const row = mine.getByRole("row", { name: new RegExp(`Vekil ${suffix}`) });
    await expect(row.getByText("Sürüyor")).toBeVisible();
    page.once("dialog", (d) => void d.accept());
    await row.getByRole("button", { name: "Sonlandır" }).click();
    await expect(row.getByText("Bitti")).toBeVisible();
  });
});
