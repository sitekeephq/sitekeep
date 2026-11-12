import { expect, runState, test as base } from "./fixtures";

type SeededIssue = {
  id: string;
  number: number;
  title: string;
};

type ProjectFeatureFixtures = {
  browserHealth: void;
  seededIssue: SeededIssue;
};

export const test = base.extend<ProjectFeatureFixtures>({
  browserHealth: [
    async ({ diagnostics }, use) => {
      await use();
      void diagnostics;
    },
    { auto: true },
  ],
  seededIssue: async ({ request }, use) => {
    const { project } = await runState();
    const title = "E2E BCF export issue";
    const response = await request.post(`/api/v1/projects/${project.id}/issues`, {
      data: { title, priority: "normal" },
    });
    if (!response.ok()) {
      throw new Error(`Issue seed failed (${response.status()}): ${await response.text()}`);
    }
    await use((await response.json()) as SeededIssue);
  },
});

export { expect, runState };
