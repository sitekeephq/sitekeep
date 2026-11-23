/**
 * New-version notice (docs/features/PRIVACY.md → Update Check): the one-time card on Yönetim → Sistem Durumu offers the daily
 * check; "Aç" turns it on and asks at once; the notice and the top-bar badge appear; "Güncellemeleri denetle"
 * asks again. The e2e server runs as release 1.0.1 and asks a stand-in for GitHub (this spec, on E2E_PORT + 1;
 * e2e/support/launch.mjs).
 */
import { createServer, type Server } from "node:http";
import { test, expect } from "../support/fixtures";

const port = Number(process.env.E2E_PORT ?? 18080) + 1;
let release = "v1.0.2";
const asked: { method: string; url: string; cookie: string | undefined }[] = [];
let github: Server;

test.beforeAll(async () => {
  github = createServer((req, res) => {
    asked.push({ method: req.method ?? "", url: req.url ?? "", cookie: req.headers.cookie });
    res.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({ tag_name: release, html_url: `https://github.com/sitekeephq/sitekeep/releases/tag/${release}`, published_at: "2026-11-20T10:00:00Z", draft: false, prerelease: false }),
    );
  });
  await new Promise<void>((r) => github.listen(port, "127.0.0.1", () => r()));
});

test.afterAll(async () => {
  await new Promise((r) => github.close(r));
});

test("card → turn on → notice and badge; the check button asks again", async ({ page }) => {
  await page.goto("/administration?tab=status");
  await expect(page.getByRole("heading", { name: "Yeni sürümler otomatik denetlensin mi?" })).toBeVisible();
  await expect(page.getByText("kurulumunuz hakkında hiçbir şey gönderilmez").first()).toBeVisible();
  // Off by default: the page load alone asked nobody.
  expect(asked).toHaveLength(0);
  await expect(page.getByTestId("update-available")).toHaveCount(0);

  await page.getByRole("button", { name: "Aç", exact: true }).click();
  const notice = page.getByTestId("update-available");
  await expect(notice.getByRole("heading", { name: "SiteKeep 1.0.2 yayında — sizde 1.0.1 var" })).toBeVisible();
  await expect(notice.getByRole("link", { name: "Sürüm notları" })).toHaveAttribute("href", "https://github.com/sitekeephq/sitekeep/releases/tag/v1.0.2");
  await expect(notice).toContainText("sudo sitekeep upgrade");
  await expect(notice).toContainText("docker compose pull && docker compose up -d");
  await expect(page.getByRole("heading", { name: "Yeni sürümler otomatik denetlensin mi?" })).toHaveCount(0);
  await expect(page.getByRole("checkbox", { name: "Yeni sürümleri günde bir kez denetle" })).toBeChecked();
  expect(asked).toHaveLength(1);
  expect(asked[0]).toMatchObject({ method: "GET", url: "/repos/sitekeephq/sitekeep/releases/latest", cookie: undefined });

  // The top-bar badge (administrators): dismissed per version, it stays away after a reload.
  const badge = page.locator(".topbar-update");
  await expect(badge.getByRole("link", { name: "Güncelleme var: 1.0.2" })).toBeVisible();
  await badge.getByRole("button", { name: "Güncelleme uyarısını kapat" }).click();
  await expect(badge).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId("update-available")).toBeVisible();
  await expect(page.locator(".topbar-update")).toHaveCount(0);

  // A newer release is picked up by the button, and the badge comes back for the new version.
  release = "v1.0.3";
  await page.getByRole("button", { name: "Güncellemeleri denetle" }).click();
  await expect(page.getByTestId("update-available").getByRole("heading", { name: "SiteKeep 1.0.3 yayında — sizde 1.0.1 var" })).toBeVisible();
  await expect(page.locator(".topbar-update").getByRole("link", { name: "Güncelleme var: 1.0.3" })).toBeVisible();
  expect(asked).toHaveLength(2);

  // Turned off again: the button still works (an explicit action), nothing asks on its own.
  await page.getByRole("checkbox", { name: "Yeni sürümleri günde bir kez denetle" }).click();
  await expect(page.getByRole("checkbox", { name: "Yeni sürümleri günde bir kez denetle" })).not.toBeChecked();
  expect(asked).toHaveLength(2);

  // Leave nothing behind for the specs that follow: GitHub now says 1.0.1 (the running version), so no update is known.
  release = "v1.0.1";
  await page.getByRole("button", { name: "Güncellemeleri denetle" }).click();
  await expect(page.getByTestId("update-available")).toHaveCount(0);
  await expect(page.locator(".topbar-update")).toHaveCount(0);
  expect(asked).toHaveLength(3);
});
