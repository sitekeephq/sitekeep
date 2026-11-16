/**
 * ISO19650-2 5.1.7(c) / -1 12.2-12.5 state transition (docs/features/CDE_STATES.md "Transitions"): a WIP
 * document goes to Shared through review; a direct upload into Published is refused when the project
 * enforces the rules. ISO19650-1 12.5 supersession (ISO-12): an archived copy and the publication that
 * replaced it link to each other in the file drawer. Core only: passes with and without modules. Uses
 * its own project, so switching enforcement on does not touch the other specs.
 */
import type { APIRequestContext, APIResponse } from "@playwright/test";
import { test, expect } from "../support/fixtures";

async function json<T>(response: APIResponse, what: string): Promise<T> {
  if (!response.ok()) throw new Error(`${what} failed (${response.status()}): ${await response.text()}`);
  return (await response.json()) as T;
}

async function enforcedProject(request: APIRequestContext) {
  const suffix = Date.now().toString(36).toUpperCase();
  const project = await json<{ id: string; rootFolderId: string }>(
    await request.post("/api/v1/projects", { data: { code: `TRN-${suffix}`, name: `Transitions ${suffix}`, template: "iso19650" } }),
    "project creation",
  );
  const contents = await json<{ folders: { id: string; state: string | null }[] }>(
    await request.get(`/api/v1/projects/${project.id}/folders/${project.rootFolderId}/contents`),
    "root contents",
  );
  const folder = (state: string) => contents.folders.find((f) => f.state === state)!.id;
  // Enforced with an empty table: the ISO 19650 default (upload into WIP; WIP → Shared → Published through review).
  await json(await request.put(`/api/v1/projects/${project.id}/cde/settings`, { data: { enforceTransitions: true } }), "enforcement");
  const me = await json<{ id: string }>(await request.get("/api/v1/auth/me"), "current user");
  await json(
    await request.post(`/api/v1/projects/${project.id}/workflow-templates`, {
      data: {
        kind: "review",
        name: "E2E team check",
        steps: [{ name: "Check", assignees: [{ type: "user", id: me.id }], rule: "any", days: 3, outcomes: ["approved", "rejected"] }],
      },
    }),
    "workflow",
  );
  return { project, wip: folder("wip"), shared: folder("shared"), published: folder("published") };
}

test("ISO19650-2 5.1.7(c) / -1 12.2-12.5 state transition: a WIP file goes to Shared through review; a direct upload into Published is refused", async ({
  page,
  allowApiFailure,
}) => {
  const { project, wip, shared, published } = await enforcedProject(page.request);
  const name = `TRN-${Date.now().toString(36)}.txt`;
  await json(
    await page.request.post(`/api/v1/projects/${project.id}/folders/${wip}/files`, {
      multipart: { file: { name, mimeType: "text/plain", buffer: Buffer.from("ISO 19650 transition") } },
    }),
    "WIP upload",
  );

  // Send to Shared from the documents list: the dialog shows the transition and the proposed revision.
  await page.goto(`/projects/${project.id}/files/${wip}`);
  await page.getByRole("checkbox", { name: `${name} seç` }).check();
  await page.getByTestId("cde-send").click();
  const dialog = page.getByRole("dialog", { name: "Paylaşılana Gönder" });
  const transition = dialog.getByTestId("review-transition");
  await expect(transition).toContainText("Çalışma → Paylaşılan");
  await expect(transition.getByTestId("proposed-revision")).toContainText("P01.01 → P01");
  await transition.getByLabel("Kopyaların uygunluk kodu").selectOption("S2");
  await dialog.getByRole("button", { name: "Başlat" }).click();
  await expect(page).toHaveURL(/\/reviews\//);
  const reviewId = page.url().split("/reviews/")[1]!.split(/[?#]/)[0]!;

  // Approve; the approved copy arrives in Shared with the chosen suitability and P01.
  const review = await json<{ files: { id: string }[] }>(await page.request.get(`/api/v1/projects/${project.id}/reviews/${reviewId}`), "review");
  await json(
    await page.request.post(`/api/v1/projects/${project.id}/reviews/${reviewId}/submit`, {
      data: { files: review.files.map((f) => ({ reviewFileId: f.id, outcome: "approved" })) },
    }),
    "approval",
  );
  await page.goto(`/projects/${project.id}/files/${shared}`);
  const row = page.getByRole("row").filter({ hasText: name });
  await expect(row.getByTestId("code-suitability")).toHaveText("S2");
  await expect(row.getByTestId("code-revision")).toHaveText("P01");

  // A direct upload into Published is refused: the folder is gated and the server says how documents arrive.
  allowApiFailure(403, `/api/v1/projects/${project.id}/folders/${published}/files`);
  const refused = await page.request.post(`/api/v1/projects/${project.id}/folders/${published}/files`, {
    multipart: { file: { name: `direct-${name}`, mimeType: "text/plain", buffer: Buffer.from("direct") } },
  });
  expect(refused.status()).toBe(403);
  expect(((await refused.json()) as { message: string }).message).toMatch(/Yayınlanan durumuna doğrudan dosya yazılamaz/);
  await page.goto(`/projects/${project.id}/files/${published}`);
  await expect(page.locator(".docs-toolbar .badge.warn")).toBeVisible();
});

test("ISO19650-1 12.5 supersession: the archived copy links to the publication that replaced it, and back", async ({ page }) => {
  test.setTimeout(90_000);
  const { project, wip, shared, published } = await enforcedProject(page.request);
  const pid = project.id;
  const contents = await json<{ folders: { id: string; state: string | null }[] }>(
    await page.request.get(`/api/v1/projects/${pid}/folders/${project.rootFolderId}/contents`),
    "root contents",
  );
  const archived = contents.folders.find((f) => f.state === "archived")!.id;
  await json(await page.request.put(`/api/v1/projects/${pid}/cde/settings`, { data: { enforceTransitions: true, archiveFolderId: archived } }), "archive folder");
  const templates = await json<{ id: string; name: string }[]>(await page.request.get(`/api/v1/projects/${pid}/workflow-templates`), "workflows");
  const templateId = templates.find((t) => t.name === "E2E team check")!.id;
  const name = `SUP-${Date.now().toString(36)}.txt`;
  const fileIn = async (folderId: string) => {
    const c = await json<{ files: { id: string; name: string }[] }>(await page.request.get(`/api/v1/projects/${pid}/folders/${folderId}/contents`), "contents");
    return c.files.find((f) => f.name === name)!.id;
  };
  const latestVersion = async (fileId: string) =>
    (await json<{ latest: { id: string } }>(await page.request.get(`/api/v1/projects/${pid}/files/${fileId}`), "file")).latest.id;
  const approve = async (versionId: string, targetFolderId: string, targetSuitability: string) => {
    const r = await json<{ id: string; files: { id: string }[] }>(
      await page.request.post(`/api/v1/projects/${pid}/reviews`, {
        data: { templateId, versionIds: [versionId], targetFolderId, name: `R ${Math.random()}`, targetSuitability },
      }),
      "review",
    );
    await json(
      await page.request.post(`/api/v1/projects/${pid}/reviews/${r.id}/submit`, {
        data: { files: r.files.map((f) => ({ reviewFileId: f.id, outcome: "approved" })) },
      }),
      "approval",
    );
  };
  // Two revisions published (C01, then C02): the second archives the first.
  for (const [i, suitability] of [
    [1, "A1"],
    [2, "A2"],
  ] as const) {
    await json(
      await page.request.post(`/api/v1/projects/${pid}/folders/${wip}/files`, {
        multipart: { file: { name, mimeType: "text/plain", buffer: Buffer.from(`revision ${i}`) } },
      }),
      "WIP upload",
    );
    await approve(await latestVersion(await fileIn(wip)), shared, "S2");
    await approve(await latestVersion(await fileIn(shared)), published, suitability);
  }
  const pubId = await fileIn(published);
  const arcId = await fileIn(archived);

  // The publication: "Yerini aldığı" links to the archive copy.
  await page.goto(`/projects/${pid}/files/${published}?file=${pubId}`);
  const drawer = page.locator("aside.drawer");
  const supersedes = drawer.getByTestId("supersession-supersedes");
  await expect(supersedes).toContainText("Yerini aldığı:");
  await expect(supersedes.getByRole("link", { name: `${name} V1 · C01` })).toBeVisible();
  await supersedes.getByRole("link").click();
  await expect(page).toHaveURL(new RegExp(`/files/${archived}\\?file=${arcId}`));

  // The archive copy: superseded, and "Yerini alan" links back to the publication.
  await expect(drawer.getByTestId("cde-status")).toHaveText("Yenisi Yayınlandı");
  const by = drawer.getByTestId("supersession-supersededBy");
  await expect(by).toContainText("Yerini alan:");
  await expect(by.getByRole("link", { name: `${name} V2 · C02` })).toBeVisible();
  // The file's audit history names the publication as well.
  const history = drawer.locator("details.file-audit-history");
  await history.getByText("Denetim Geçmişi", { exact: true }).click();
  await expect(history.getByText(`yerini alan: ${name} V2 · C02`)).toBeVisible();
  await by.getByRole("link").click();
  await expect(page).toHaveURL(new RegExp(`/files/${published}\\?file=${pubId}`));
  await expect(drawer.getByTestId("supersession-supersedes")).toBeVisible();
});
