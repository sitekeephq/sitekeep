import { test, expect, runState } from "../fixtures/access";

test("a regular project member cannot access system or project administration", async ({
  memberPage,
  allowMemberApiFailure,
}) => {
  const { project } = await runState();

  await memberPage.goto("/administration");
  await expect(memberPage).toHaveURL(/\/home$/);
  await expect(memberPage.getByRole("heading", { name: "Yönetim", exact: true })).toHaveCount(0);
  await expect(memberPage.getByRole("heading", { name: "Projeler", exact: true })).toBeVisible();

  await memberPage.goto(`/projects/${project.id}/settings?sekme=uyeler`);
  await expect(memberPage.getByRole("heading", { name: "Proje Ayarları", exact: true })).toBeVisible();
  await expect(memberPage.getByRole("tab", { name: "Konumlar", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(memberPage.getByRole("tab", { name: "Üyeler", exact: true })).toHaveCount(0);
  await expect(memberPage.getByRole("tab", { name: "Roller", exact: true })).toHaveCount(0);
  await expect(memberPage.getByRole("tab", { name: "Modüller", exact: true })).toHaveCount(0);

  const modulesPath = `/api/v1/projects/${project.id}/modules`;
  allowMemberApiFailure(403, modulesPath);
  const status = await memberPage.evaluate(async ({ path, modules }) => {
    const response = await fetch(path, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ modules }),
    });
    return response.status;
  }, { path: modulesPath, modules: { reports: false } });
  expect(status).toBe(403);
});
