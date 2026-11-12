import { readFile } from "node:fs/promises";
import path from "node:path";
import { test as base, expect, type Response } from "@playwright/test";

type AllowedFailure = { status: number; path: string | RegExp };
type Diagnostics = { errors: string[]; allowed: AllowedFailure[] };

type E2EFixtures = {
  diagnostics: Diagnostics;
  allowApiFailure(status: number, path: string | RegExp): void;
};

export type RunState = {
  project: { id: string; code: string; name: string; rootFolderId: string };
  modules: Record<string, boolean>;
};

export async function runState(): Promise<RunState> {
  const file = path.resolve(__dirname, "../.auth/run.json");
  return JSON.parse(await readFile(file, "utf8")) as RunState;
}

function allowed(response: Response, entries: AllowedFailure[]) {
  const pathname = new URL(response.url()).pathname;
  return entries.some((entry) => {
    if (entry.status !== response.status()) return false;
    return typeof entry.path === "string" ? pathname === entry.path : entry.path.test(pathname);
  });
}

/** WebKit cancels in-flight fetches on navigation; that is not an application failure. */
function isNavigationAbort(text: string) {
  return /Load request cancelled|net::ERR_ABORTED|NS_ERROR_ABORT|NSURLErrorCancelled|TypeError: Load failed/i.test(
    text,
  );
}

export const test = base.extend<E2EFixtures>({
  page: async ({ page }, use) => {
    await page.addInitScript(() => {
      try {
        localStorage.setItem("cde.productTour.v1", "done");
      } catch {
        // Tour overlay must not block existing e2e clicks.
      }
    });
    await use(page);
  },
  diagnostics: async ({ page }, use, testInfo) => {
    const diagnostics: Diagnostics = { errors: [], allowed: [] };
    page.on("pageerror", (error) => {
      const text = error.stack ?? error.message;
      if (!isNavigationAbort(text)) diagnostics.errors.push(`pageerror: ${text}`);
    });
    page.on("response", (response) => {
      const url = new URL(response.url());
      if (url.origin === new URL(testInfo.project.use.baseURL as string).origin && url.pathname.startsWith("/api/") && !response.ok()) {
        if (!allowed(response, diagnostics.allowed)) {
          diagnostics.errors.push(`API ${response.request().method()} ${url.pathname} returned ${response.status()}`);
        }
      }
    });
    page.on("requestfailed", (request) => {
      const url = new URL(request.url());
      const failure = request.failure()?.errorText ?? "unknown error";
      if (isNavigationAbort(failure)) return;
      if (url.origin === new URL(testInfo.project.use.baseURL as string).origin && url.pathname.startsWith("/api/")) {
        diagnostics.errors.push(`API ${request.method()} ${url.pathname} failed: ${failure}`);
      }
    });

    await use(diagnostics);
    if (diagnostics.errors.length && testInfo.status === testInfo.expectedStatus) {
      throw new Error(`Unexpected browser/API errors:\n${diagnostics.errors.join("\n")}`);
    }
  },
  allowApiFailure: async ({ diagnostics }, use) => {
    await use((status, failurePath) => diagnostics.allowed.push({ status, path: failurePath }));
  },
});

export { expect };
