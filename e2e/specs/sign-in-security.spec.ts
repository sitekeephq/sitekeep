/**
 * Sign-in security (docs/features/SIGN_IN_SECURITY.md): a person turns on two-factor authentication on
 * the account page (QR code and key, first code, recovery codes), then signs in with a code and with a
 * recovery code; too many failed sign-ins lock the account (429 with Retry-After) until an
 * administrator lifts the locks. The interface is Turkish.
 */
import { createHmac, randomUUID } from "node:crypto";
import path from "node:path";
import type { APIRequestContext, Page } from "@playwright/test";
import { test, expect } from "../support/fixtures";
import { E2E_BASE_URL, signedOutState } from "../support/signed-out";

test.use({ storageState: signedOutState(E2E_BASE_URL) });

const PASSWORD = "Mavi-Kule-Yapi-71";
const ADMIN_STATE = path.resolve(__dirname, "../.auth/admin.json");

function base32Decode(text: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of text.replace(/=+$/, "")) {
    value = (value << 5) | alphabet.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** RFC 6238 code of the step `offset` steps from now (a code works once, so later sign-ins use later steps). */
function totp(secret: string, offset = 0): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000) + offset));
  const mac = createHmac("sha1", base32Decode(secret)).update(counter).digest();
  const o = mac[mac.length - 1]! & 0xf;
  const bin = ((mac[o]! & 0x7f) << 24) | (mac[o + 1]! << 16) | (mac[o + 2]! << 8) | mac[o + 3]!;
  return String(bin % 1_000_000).padStart(6, "0");
}

async function adminApi(playwright: { request: { newContext(o: object): Promise<APIRequestContext> } }) {
  return playwright.request.newContext({ baseURL: E2E_BASE_URL, storageState: ADMIN_STATE });
}

async function newUser(admin: APIRequestContext, label: string) {
  const email = `e2e-${label}-${randomUUID().slice(0, 6)}@7d-cde.localhost`;
  const res = await admin.post("/api/v1/users", { data: { email, name: `Kisi ${label}`, password: PASSWORD } });
  if (!res.ok()) throw new Error(`user creation failed (${res.status()}): ${await res.text()}`);
  return email;
}

async function signIn(page: Page, email: string, password = PASSWORD) {
  await page.goto("/login");
  await page.getByLabel("E-posta adresi").fill(email);
  await page.getByLabel("Şifre", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Giriş yap" }).click();
}

test("two-factor: set up on the account page, then sign in with a code and with a recovery code", async ({ page, playwright, allowApiFailure }) => {
  test.setTimeout(90_000);
  allowApiFailure(401, "/api/v1/auth/me");
  const admin = await adminApi(playwright);
  const email = await newUser(admin, "2fa");

  await signIn(page, email);
  await expect(page).toHaveURL(/\/home$/);

  await page.goto("/account");
  const card = page.getByTestId("two-factor-card");
  await expect(card.getByText("Kapalı", { exact: true })).toBeVisible();
  await card.getByRole("button", { name: "Aç", exact: true }).click();
  await expect(card.getByRole("img", { name: "Doğrulama uygulaması için QR kodu" })).toBeVisible();
  const secret = (await card.getByTestId("totp-secret").textContent())!.trim();
  expect(secret).toMatch(/^[A-Z2-7]{32}$/);
  await card.getByLabel("Doğrulama kodu").fill(totp(secret));
  await card.getByRole("button", { name: "Onayla ve aç" }).click();
  const codes = (await card.getByTestId("recovery-codes").locator("pre").textContent())!.split("\n").filter(Boolean);
  expect(codes).toHaveLength(10);
  await card.getByRole("button", { name: "Kaydettim" }).click();
  await expect(card.getByText("Açık", { exact: true })).toBeVisible();
  await expect(card.getByText("10 kurtarma kodu kaldı")).toBeVisible();

  // Signed out: the password alone is not enough, the code completes the sign-in.
  await page.context().clearCookies();
  await signIn(page, email);
  const step = page.getByTestId("two-factor-step");
  await expect(step.getByRole("heading", { name: "İki adımlı doğrulama" })).toBeVisible();
  await expect(page).toHaveURL(/\/login$/);
  await step.getByLabel("Doğrulama kodu").fill("000000");
  allowApiFailure(401, "/api/v1/auth/two-factor/challenge/verify");
  await step.getByRole("button", { name: "Doğrula", exact: true }).click();
  await expect(step.getByRole("alert")).toContainText("Kod doğru değil");
  await step.getByLabel("Doğrulama kodu").fill(totp(secret, 1));
  await step.getByRole("button", { name: "Doğrula", exact: true }).click();
  await expect(page).toHaveURL(/\/home$/);

  // A recovery code works once.
  await page.context().clearCookies();
  await signIn(page, email);
  await step.getByRole("button", { name: "Kurtarma kodu kullan" }).click();
  await step.getByLabel("Kurtarma kodu").fill(codes[0]!);
  await step.getByRole("button", { name: "Doğrula", exact: true }).click();
  await expect(page).toHaveURL(/\/home$/);
  await page.goto("/account");
  await expect(page.getByTestId("two-factor-card").getByText("9 kurtarma kodu kaldı")).toBeVisible();

  // The administrator sees it and can reset it (lost phone).
  const users = (await (await admin.get("/api/v1/users")).json()) as { id: string; email: string; twoFactor?: boolean }[];
  const me = users.find((u) => u.email === email)!;
  expect(me.twoFactor).toBe(true);
  expect((await admin.delete(`/api/v1/admin/users/${me.id}/two-factor`)).ok()).toBe(true);
  await admin.dispose();
});

test("too many failed sign-ins lock the account with 429 and Retry-After", async ({ page, playwright, allowApiFailure }) => {
  allowApiFailure(401, "/api/v1/auth/me");
  allowApiFailure(429, "/api/v1/auth/login");
  const admin = await adminApi(playwright);
  const email = await newUser(admin, "lock");
  try {
    for (let i = 0; i < 10; i++) {
      const res = await page.request.post("/api/v1/auth/login", { data: { email, password: "yanlis-sifre-123" } });
      expect(res.status()).toBe(401);
    }
    const locked = await page.request.post("/api/v1/auth/login", { data: { email, password: PASSWORD } });
    expect(locked.status()).toBe(429);
    expect(Number(locked.headers()["retry-after"])).toBeGreaterThan(0);

    // The right password is refused on the page too, with the wait in the message.
    await signIn(page, email);
    await expect(page.getByRole("alert")).toContainText("Çok fazla hatalı deneme");
    await expect(page).toHaveURL(/\/login$/);
  } finally {
    // Lift the locks so the shared client IP's count does not reach other specs.
    expect((await admin.post("/api/v1/admin/sign-in-security/unlock")).ok()).toBe(true);
  }
  await signIn(page, email);
  await expect(page).toHaveURL(/\/home$/);
  await admin.dispose();
});
