/**
 * Document search panel (docs/features/DOCUMENT_SEARCH.md, issue #191): the "Ara ve Süz" panel with
 * scope, content and filters, the query language, highlighted results with match badges, saving a
 * search, sharing it as project administrator, the "Kayıtlı Aramalar" node and recent searches.
 */
import { test, expect, runState } from "../support/fixtures";

test("searches with the panel, saves and shares the search, runs it from the folder tree", async ({ page, diagnostics }) => {
  void diagnostics;
  const { project, modules } = await runState();
  const tag = `zx${Date.now().toString(36)}`;
  const api = page.request;
  for (const [name, text] of [
    [`e2e-arama-${tag}-tunel.txt`, `Tünel kazı raporu ${tag} istasyon`],
    [`e2e-arama-${tag}-taslak.txt`, `Taslak not ${tag}`],
  ]) {
    const res = await api.post(`/api/v1/projects/${project.id}/folders/${project.rootFolderId}/files`, {
      multipart: { file: { name, mimeType: "text/plain", buffer: Buffer.from(text, "utf8") } },
    });
    expect(res.ok(), await res.text()).toBe(true);
  }
  // Text is read by a background job: wait until the content is searchable.
  await expect
    .poll(async () => ((await (await api.get(`/api/v1/projects/${project.id}/search?q=kaz%C4%B1+${tag}`)).json()) as { total: number }).total, {
      timeout: 30_000,
    })
    .toBe(1);

  await page.goto(`/projects/${project.id}/files`);
  await page.getByTestId("search-panel-toggle").click();
  const panel = page.getByTestId("search-panel");
  await expect(panel).toBeVisible();
  await panel.getByRole("radio", { name: "Tüm Klasörler" }).check();
  await expect(panel.getByRole("checkbox", { name: "İçerikte de Ara" })).toBeChecked();
  await panel.getByRole("searchbox", { name: "Arama metni" }).fill(`${tag} NOT taslak`);
  await expect(panel.getByTestId("search-parsed")).toContainText(`${tag} AND NOT taslak`);
  await panel.getByTestId("filter-ext").getByRole("button", { name: ".pdf" }).click();
  await panel.getByRole("button", { name: "Ara", exact: true }).click();

  const results = page.getByTestId("search-results");
  await expect(results.getByTestId("search-count")).toHaveText("0 dosya");
  // Back in the panel: the type filter off again.
  await results.getByTestId("search-edit").click();
  await panel.getByTestId("filter-ext").getByRole("button", { name: ".pdf" }).click();
  await panel.getByRole("button", { name: "Ara", exact: true }).click();
  await expect(results.getByTestId("search-count")).toHaveText("1 dosya");
  const hit = results.getByTestId("search-hit");
  await expect(hit).toHaveCount(1);
  await expect(hit).toContainText(`e2e-arama-${tag}-tunel.txt`);
  await expect(hit.getByTestId("match-name")).toBeVisible();
  await expect(hit.getByTestId("match-content")).toBeVisible();
  await expect(hit.locator(".search-snippet mark").first()).toHaveText(tag);
  await expect(hit.locator(".search-snippet")).toContainText("Tünel kazı raporu");

  // Sorting is offered; by name keeps the one hit.
  await results.getByTestId("search-sort").selectOption("name");
  await expect(results.getByTestId("search-hit")).toHaveCount(1);

  // Bulk actions on the selected hits: ZIP, review and a transmittal with the files linked.
  await hit.getByRole("checkbox").check();
  await expect(page.getByRole("button", { name: "ZIP (1)" })).toBeVisible();
  if (modules.transmittals) {
    await page.getByTestId("search-transmittal").click();
    const dialog = page.getByRole("dialog", { name: "Yeni Gönderim Formu" });
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  }
  await hit.getByRole("checkbox").uncheck();

  // Save the search; it shows in the Saved Searches tab and in the folder tree.
  await results.getByTestId("search-edit").click();
  await panel.getByRole("button", { name: "Aramayı Kaydet" }).click();
  await panel.getByRole("textbox", { name: "Aramanın adı" }).fill(`Tüneller ${tag}`);
  await panel.getByRole("button", { name: "Kaydet", exact: true }).click();
  await expect(panel.getByRole("tab", { name: /Kayıtlı Aramalar/ })).toHaveAttribute("aria-selected", "true");
  const savedItem = panel.locator(".search-panel-saved li").filter({ hasText: `Tüneller ${tag}` });
  await expect(savedItem).toBeVisible();

  // The project administrator shares it with the whole project.
  await savedItem.getByRole("button", { name: "Paylaş" }).click();
  const share = page.getByRole("dialog", { name: `"Tüneller ${tag}" aramasını paylaş` });
  await share.getByTestId("share-project").check();
  await share.getByRole("button", { name: "Kaydet" }).click();
  await expect(savedItem.getByText("Paylaşıldı")).toBeVisible();
  await panel.getByRole("button", { name: "Kapat" }).first().click();

  await results.getByRole("button", { name: "Aramayı Kapat" }).click();
  await expect(results).toHaveCount(0);
  const tree = page.getByTestId("saved-search-tree");
  await tree.getByText(`Tüneller ${tag}`).click();
  await expect(page.getByTestId("search-results").getByTestId("search-hit")).toHaveCount(1);

  // Recent searches remember it.
  await page.getByTestId("search-panel-toggle").click();
  await expect(panel.locator(".search-panel-recent").filter({ hasText: `${tag} NOT taslak` }).first()).toBeVisible();

  const list = (await (await api.get(`/api/v1/projects/${project.id}/saved-searches`)).json()) as { id: string; name: string }[];
  for (const s of list.filter((x) => x.name.includes(tag))) await api.delete(`/api/v1/projects/${project.id}/saved-searches/${s.id}`);
});
