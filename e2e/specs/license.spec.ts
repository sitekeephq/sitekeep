import { createPrivateKey, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test, expect } from "../support/fixtures";

/** A development licence (kid "dev", accepted outside production) for this installation. */
function devLicence(installation: string): string {
  const key = createPrivateKey(readFileSync(path.join(__dirname, "../../apps/server/test/fixtures/license/dev-private.pem")));
  const now = Date.now();
  const payload = {
    lid: "LIC-E2E-0001",
    customer: { id: "e2e", name: "Poyraz İnşaat" },
    installation,
    edition: "enterprise",
    seats: 25,
    modules: ["cost", "planning"],
    issuedAt: new Date(now).toISOString(),
    validFrom: new Date(now - 86_400_000).toISOString(),
    validUntil: new Date(now + 200 * 86_400_000).toISOString(),
    supportUntil: new Date(now + 365 * 86_400_000).toISOString(),
    graceDays: 30,
    online: "off",
    hardware: [],
    notes: null,
  };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = sign(null, Buffer.from(encoded, "utf8"), key).toString("base64url");
  return JSON.stringify({ format: "sitekeep-license", version: 1, kid: "dev", payload: encoded, signature });
}

test("Yönetim → Lisans shows the installation, installs a licence and removes it", async ({ page }) => {
  await page.goto("/administration?tab=license");
  await expect(page.getByRole("heading", { name: "Lisans", exact: true })).toBeVisible();
  await expect(page.getByText("Lisans Yok", { exact: true })).toBeVisible();
  const installation = (await page.getByTestId("installation-id").textContent())!.trim();
  expect(installation).toMatch(/^inst_/);

  await page.getByLabel("Lisans dosyası").setInputFiles({ name: "license.json", mimeType: "application/json", buffer: Buffer.from(devLicence(installation)) });
  await expect(page.getByRole("status")).toHaveText("Lisans yüklendi.");
  await expect(page.getByText("Geçerli", { exact: true })).toBeVisible();
  await expect(page.getByText("LIC-E2E-0001")).toBeVisible();
  await expect(page.getByText("Cost, Planning")).toBeVisible();
  await expect(page.getByText(/\/ 25 etkin kullanıcı/)).toBeVisible();

  // Another installation's licence is refused with the reason.
  await page.getByLabel("Lisans dosyası").setInputFiles({ name: "other.json", mimeType: "application/json", buffer: Buffer.from(devLicence("inst_baska")) });
  await expect(page.getByRole("status")).toHaveText("Bu lisans başka bir kuruluma ait. Lisans isterken bu kurulumun kimliğini gönderin.");

  await page.getByRole("button", { name: "Lisansı Kaldır", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Lisansı Kaldır", exact: true }).click();
  await expect(page.getByText("Lisans Yok", { exact: true })).toBeVisible();
});
