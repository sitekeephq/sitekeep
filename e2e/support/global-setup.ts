import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { request, type FullConfig } from "@playwright/test";

export const ADMIN_EMAIL = "e2e-admin@7d-cde.localhost";
export const ADMIN_PASSWORD = "E2e-Only!7D-CDE#2026";

/**
 * The specs select elements by their Turkish names, so the browser runs the Turkish interface
 * (docs/architecture/i18n.md §6). e2e/specs/language.spec.ts covers the English default.
 */
export const E2E_LANGUAGE = { name: "cde.language", value: "tr" };

/** Signed out, Turkish interface: for the login specs (`test.use({ storageState: signedOutTurkish })`). */
export function signedOutState(baseURL: string) {
  return { cookies: [], origins: [{ origin: baseURL, localStorage: [E2E_LANGUAGE] }] };
}

export default async function globalSetup(config: FullConfig) {
  const baseURL = config.projects[0]?.use.baseURL;
  if (typeof baseURL !== "string") throw new Error("E2E baseURL is not configured.");

  const authDir = path.resolve(__dirname, "../.auth");
  await mkdir(authDir, { recursive: true });
  const context = await request.newContext({ baseURL });

  try {
    const login = await context.post("/api/v1/auth/login", {
      data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    if (!login.ok()) throw new Error(`E2E login failed (${login.status()}): ${await login.text()}`);

    const suffix = Date.now().toString(36).toUpperCase();
    const projectResponse = await context.post("/api/v1/projects", {
      data: {
        code: `E2E-${suffix}`,
        name: `E2E Critical Path ${suffix}`,
        description: "Playwright isolated test project",
        template: "iso19650",
      },
    });
    if (!projectResponse.ok()) {
      throw new Error(`E2E project creation failed (${projectResponse.status()}): ${await projectResponse.text()}`);
    }

    const project = (await projectResponse.json()) as {
      id: string;
      code: string;
      name: string;
      rootFolderId: string;
    };
    const prefs = await context.patch("/api/v1/me/prefs", { data: { language: E2E_LANGUAGE.value } });
    if (!prefs.ok()) throw new Error(`E2E language preference failed (${prefs.status()}).`);

    const modulesResponse = await context.get(`/api/v1/projects/${project.id}/modules`);
    if (!modulesResponse.ok()) throw new Error(`E2E module lookup failed (${modulesResponse.status()}).`);

    const statePath = path.join(authDir, "admin.json");
    await context.storageState({ path: statePath });
    const state = JSON.parse(await readFile(statePath, "utf8")) as { cookies: unknown[]; origins: unknown[] };
    state.origins = [{ origin: new URL(baseURL).origin, localStorage: [E2E_LANGUAGE] }];
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await writeFile(
      path.join(authDir, "run.json"),
      `${JSON.stringify({ project, modules: await modulesResponse.json() }, null, 2)}\n`,
      "utf8",
    );
  } finally {
    await context.dispose();
  }
}
