import type { Page, Route } from "@playwright/test";
import { test, expect, runState } from "../support/fixtures";

/**
 * Proje → Forma Eşitleme. The e2e server runs without Autodesk (launch.mjs), so the first test
 * checks the real "not configured" state; the others answer the Autodesk endpoints in the browser
 * to walk Hepsini Getir (step by step, İptal) and Seçerek Getir → files. The sync and download
 * jobs themselves are covered by apps/server/test/integrations/autodesk-*.test.ts.
 */

const json = (route: Route, body: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

function connection(projectId: string) {
  return {
    id: "c-1",
    projectId,
    externalHubId: "b.hub",
    externalProjectId: "b.acc-1",
    externalProjectName: "Örnek Metro Hattı",
    authorizedEmail: "bim@7d.test",
    scopes: ["data:read"],
    enabled: true,
    intervalMinutes: 30,
    status: "ready",
    lastSyncStartedAt: null,
    lastSyncCompletedAt: "2026-11-01T08:00:00.000Z",
    nextSyncAt: "2026-11-01T08:30:00.000Z",
    lastError: null,
    counts: { issue: 17, review: 4, rfi: 2, form: 9 },
    syncKinds: ["issue", "review", "form", "rfi", "submittal", "location", "user"],
    connected: true,
    authorizedAt: "2026-11-01T07:55:00.000Z",
    createdAt: "2026-11-01T07:55:00.000Z",
  };
}

const file = (over: Record<string, unknown>) => ({
  versionNumber: 1,
  size: 2048,
  updatedAt: "2026-10-30T10:00:00Z",
  fileType: "pdf",
  downloadable: true,
  imported: null,
  ...over,
});

const KINDS = ["issue", "review", "form", "rfi", "submittal", "location", "user"];

/** A record sync: queued until Hepsini Getir, then running on its third step until İptal. */
function syncRun(state: "none" | "running" | "cancelled") {
  if (state === "none") return null;
  const steps = KINDS.map((kind, i) => ({
    kind,
    state: i < 2 ? "done" : i === 2 ? (state === "running" ? "running" : "cancelled") : state === "running" ? "waiting" : "cancelled",
    count: i < 2 ? 5 : null,
  }));
  return {
    id: "run-1",
    status: state,
    trigger: "manual",
    error: null,
    createdAt: "2026-11-01T09:00:00.000Z",
    startedAt: "2026-11-01T09:00:01.000Z",
    finishedAt: state === "cancelled" ? "2026-11-01T09:00:09.000Z" : null,
    steps,
    projectStep: state === "running" ? "waiting" : "cancelled",
    percent: 25,
  };
}

async function fakeAutodesk(page: Page, projectId: string) {
  const posted: unknown[] = [];
  const brought: unknown[] = [];
  let sync: "none" | "running" | "cancelled" = "none";
  const base = `**/api/v1/projects/${projectId}/integrations/autodesk`;
  await page.route(base, (route) => json(route, { configured: true, callbackUrl: "https://cde.test/cb", connections: [connection(projectId)] }));
  await page.route(`${base}/c-1/progress`, (route) => json(route, { run: syncRun(sync) }));
  await page.route(`${base}/c-1/records`, (route) => {
    if (route.request().method() === "POST") {
      brought.push(route.request().postDataJSON());
      sync = "running";
      return json(route, { queued: true, connection: connection(projectId) });
    }
    return json(route, KINDS.map((kind) => ({ kind, selected: true, inAcc: 3, inCde: 3 })));
  });
  await page.route(`${base}/c-1/sync/cancel`, (route) => {
    sync = "cancelled";
    return json(route, { cancelled: true });
  });
  await page.route(`${base}/c-1/docs*`, (route) => {
    const folder = new URL(route.request().url()).searchParams.get("folder");
    if (!folder) return json(route, { folderId: null, folders: [{ id: "urn:top", name: "Project Files", updatedAt: null }], files: [] });
    return json(route, {
      folderId: folder,
      folders: [],
      files: [
        file({ itemId: "i-1", versionId: "v-1", name: "Kesit_AA.pdf" }),
        file({ itemId: "i-2", versionId: "v-2", name: "Plan_01.pdf", versionNumber: 3, imported: { fileId: "f-2", versionNumber: 2 } }),
        file({ itemId: "i-3", versionId: "v-3", name: "Merkez.rvt", downloadable: false }),
      ],
    });
  });
  await page.route(`${base}/c-1/imports`, (route) => {
    posted.push(route.request().postDataJSON());
    return json(route, { queued: 1, rejected: [{ name: "Plan_01.pdf", error: "İsimlendirme standardına uymuyor." }] });
  });
  await page.route(`${base}/imports`, (route) =>
    json(
      route,
      posted.length
        ? [
            {
              id: "r-1",
              name: "Kesit_AA.pdf",
              sourcePath: "Project Files",
              versionNumber: 1,
              sizeBytes: 2048,
              targetFolderId: "x",
              targetFolderName: "01-WIP",
              status: "done",
              bytesReceived: null,
              cancellable: false,
              action: "new",
              fileId: null,
              error: null,
              requestedBy: "E2E Admin",
              createdAt: "2026-11-01T09:00:00.000Z",
              finishedAt: "2026-11-01T09:00:05.000Z",
            },
          ]
        : [],
    ),
  );
  return { posted, brought };
}

test("Forma Eşitleme says what is missing when the server has no Autodesk app", async ({ page }) => {
  const { project } = await runState();
  await page.goto(`/projects/${project.id}/forma-esitleme`);
  await expect(page.getByRole("heading", { name: "Forma Eşitleme", exact: true })).toBeVisible();
  await expect(page.getByText(/AUTODESK_CLIENT_ID ve AUTODESK_CALLBACK_URL/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Hepsini Getir", exact: true })).toHaveCount(0);
  await expect(page.getByText("Henüz bir şey getirilmedi.", { exact: true })).toBeVisible();
});

test("Hepsini Getir brings every record kind step by step and can be cancelled", async ({ page }) => {
  const { project } = await runState();
  const { brought } = await fakeAutodesk(page, project.id);
  await page.goto(`/projects/${project.id}/forma-esitleme`);
  await expect(page.getByText("Örnek Metro Hattı", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Hepsini Getir", exact: true }).click();
  await expect(page.getByText("Sürüyor", { exact: true })).toBeVisible();
  expect(brought).toEqual([{ kinds: KINDS }]);
  await expect(page.getByRole("progressbar", { name: "Kayıtlar" })).toHaveAttribute("aria-valuenow", "25");
  await expect(page.getByRole("listitem").filter({ hasText: "Sorunlar" }).getByText("5 kayıt", { exact: true })).toBeVisible();
  await expect(page.getByRole("listitem").filter({ hasText: "Formlar" }).getByText("alınıyor…", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "İptal", exact: true }).click();
  await expect(page.getByText("İptal Edildi", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "İptal", exact: true })).toHaveCount(0);
});

test("Seçerek Getir browses Autodesk Docs, queues the selected files and lists the result", async ({ page }) => {
  const { project } = await runState();
  const { posted } = await fakeAutodesk(page, project.id);
  await page.goto(`/projects/${project.id}/forma-esitleme`);
  await expect(page.getByText("Örnek Metro Hattı", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Seçerek Getir", exact: true }).click();
  const pick = page.getByRole("dialog", { name: "Seçerek Getir" });
  await expect(pick.getByText("ACC'de 3 · CDE'de 3", { exact: true }).first()).toBeVisible();
  await pick.getByRole("button", { name: "Autodesk Docs'tan Dosya Seç", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Autodesk'ten Getir" });
  await dialog.getByText("Project Files", { exact: true }).click();
  await expect(dialog.getByText("Kesit_AA.pdf", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Yeni sürüm var (CDE'de v2)", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("checkbox", { name: "Merkez.rvt" })).toBeDisabled();

  await dialog.getByRole("checkbox", { name: "Kesit_AA.pdf" }).check();
  await dialog.getByRole("checkbox", { name: "Plan_01.pdf" }).check();
  await expect(dialog.getByText("2 dosya seçildi", { exact: true })).toBeVisible();
  // Into a writable subfolder of the project.
  const subfolder = dialog.getByRole("combobox", { name: "Alt klasör seç…" });
  await subfolder.selectOption({ index: 1 });
  const submit = dialog.getByRole("button", { name: "2 Dosyayı Getir", exact: true });
  await expect(submit).toBeEnabled();
  await submit.click();

  await expect(dialog.getByText(/1 dosya kuyruğa alındı/)).toBeVisible();
  await expect(dialog.getByText("İsimlendirme standardına uymuyor.", { exact: false })).toBeVisible();
  expect(posted).toHaveLength(1);
  expect(posted[0]).toMatchObject({
    files: [
      { itemId: "i-1", versionId: "v-1", name: "Kesit_AA.pdf", path: "Project Files" },
      { itemId: "i-2", versionId: "v-2", versionNumber: 3, name: "Plan_01.pdf" },
    ],
  });
  await dialog.locator(".dialog-actions").getByRole("button", { name: "Kapat", exact: true }).click();

  const row = page.getByRole("row").filter({ hasText: "Kesit_AA.pdf" });
  await expect(row.getByText("Yeni", { exact: true })).toBeVisible();
  await expect(row.getByText("01-WIP", { exact: true })).toBeVisible();
});
