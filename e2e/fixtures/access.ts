import { randomUUID } from "node:crypto";
import type { APIRequestContext, BrowserContext, Page, Response } from "@playwright/test";
import { test as base, expect, runState } from "../support/fixtures";

type AllowedFailure = { status: number; path: string | RegExp };

type AccessFixtures = {
  memberContext: BrowserContext;
  memberPage: Page;
  memberRequest: APIRequestContext;
  allowMemberApiFailure(status: number, path: string | RegExp): void;
};

function isAllowed(response: Response, allowed: AllowedFailure[]) {
  const pathname = new URL(response.url()).pathname;
  return allowed.some(
    (entry) =>
      entry.status === response.status() &&
      (typeof entry.path === "string" ? pathname === entry.path : entry.path.test(pathname)),
  );
}

async function requireOk(response: { ok(): boolean; status(): number; text(): Promise<string> }, action: string) {
  if (!response.ok()) throw new Error(`${action} failed (${response.status()}): ${await response.text()}`);
}

export const test = base.extend<AccessFixtures>({
  memberContext: async ({ browser, request, baseURL }, use) => {
    if (!baseURL) throw new Error("E2E baseURL is not configured.");
    const { project } = await runState();
    const suffix = randomUUID().slice(0, 8);
    const email = `e2e-member-${suffix}@7d-cde.localhost`;
    const password = `Member-Only!${suffix}#2026`;

    const user = await request.post("/api/v1/users", {
      data: { email, name: `E2E Member ${suffix}`, password, isAdmin: false },
    });
    await requireOk(user, "Non-admin user seeding");

    const membership = await request.post(`/api/v1/projects/${project.id}/members`, {
      data: { email, isProjectAdmin: false },
    });
    await requireOk(membership, "Project membership seeding");

    const context = await browser.newContext({ baseURL });
    // Same as the admin fixture: the first-run product tour must not take over the page.
    await context.addInitScript(() => {
      try {
        localStorage.setItem("cde.productTour.v1", "done");
        // Turkish interface, as the specs select by Turkish names (e2e/support/global-setup.ts).
        if (!localStorage.getItem("cde.language")) localStorage.setItem("cde.language", "tr");
      } catch {
        // Storage may be unavailable; the tour then shows and the spec fails visibly.
      }
    });
    const login = await context.request.post("/api/v1/auth/login", { data: { email, password } });
    await requireOk(login, "Non-admin login");

    await use(context);
    await context.close();
  },

  memberPage: async ({ memberContext, baseURL }, use, testInfo) => {
    if (!baseURL) throw new Error("E2E baseURL is not configured.");
    const origin = new URL(baseURL).origin;
    const errors: string[] = [];
    const allowed: AllowedFailure[] = [];
    const page = await memberContext.newPage();

    page.on("pageerror", (error) => errors.push(`pageerror: ${error.stack ?? error.message}`));
    page.on("response", (response) => {
      const url = new URL(response.url());
      if (url.origin === origin && url.pathname.startsWith("/api/") && !response.ok() && !isAllowed(response, allowed)) {
        errors.push(`API ${response.request().method()} ${url.pathname} returned ${response.status()}`);
      }
    });
    page.on("requestfailed", (request) => {
      const url = new URL(request.url());
      if (url.origin === origin && url.pathname.startsWith("/api/")) {
        errors.push(`API ${request.method()} ${url.pathname} failed: ${request.failure()?.errorText ?? "unknown error"}`);
      }
    });

    (page as Page & { __allowedApiFailures?: AllowedFailure[] }).__allowedApiFailures = allowed;
    await use(page);
    if (errors.length && testInfo.status === testInfo.expectedStatus) {
      throw new Error(`Unexpected member browser/API errors:\n${errors.join("\n")}`);
    }
  },

  memberRequest: async ({ memberContext }, use) => {
    await use(memberContext.request);
  },

  allowMemberApiFailure: async ({ memberPage }, use) => {
    const allowed = (memberPage as Page & { __allowedApiFailures?: AllowedFailure[] }).__allowedApiFailures;
    if (!allowed) throw new Error("Member diagnostics were not initialized.");
    await use((status, path) => allowed.push({ status, path }));
  },
});

export { expect, runState };
