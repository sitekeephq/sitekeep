import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app/build-app.js";
import { hashPassword } from "../../src/core/security/auth.js";
import { openDb, type DbHandle } from "../../src/db/index.js";
import {
  externalDocuments,
  externalDocumentSources,
  projects,
  users,
} from "../../src/db/schema.js";
import { JobQueue } from "../../src/jobs/queue.js";
import { LocalStorage } from "../../src/core/platform/storage.js";

describe("external documents", () => {
  let handle: DbHandle;
  let app: FastifyInstance;
  let dataDir: string;
  let cookie: string;
  let projectId: string;
  let sourceId: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(path.join(os.tmpdir(), "7dcde-external-"));
    handle = await openDb("memory://");
    const storage = new LocalStorage(path.join(dataDir, "storage"));
    app = await buildApp({ db: handle.db, storage, jobs: new JobQueue(handle.db, storage) });
    const [user] = await handle.db
      .insert(users)
      .values({
        email: "admin@external.test",
        name: "Admin",
        passwordHash: await hashPassword("Sifre-1234567"),
        isAdmin: true,
      })
      .returning();
    const [project] = await handle.db
      .insert(projects)
      .values({ code: "EXT", name: "External test", createdBy: user!.id })
      .returning();
    projectId = project!.id;
    const [source] = await handle.db
      .insert(externalDocumentSources)
      .values({
        projectId,
        provider: "autodesk",
        externalHubId: "hub-1",
        externalProjectId: "aps-project-1",
        name: "Autodesk Test",
        syncedAt: new Date("2026-10-13T12:00:00Z"),
      })
      .returning();
    sourceId = source!.id;
    await handle.db.insert(externalDocuments).values([
      { sourceId, externalId: "folder-1", parentExternalId: null, kind: "folder", name: "Project Files", path: "Project Files" },
      { sourceId, externalId: "file-1", parentExternalId: "folder-1", kind: "file", name: "plan.pdf", path: "Project Files/plan.pdf", versionNumber: 3 },
    ]);
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "admin@external.test", password: "Sifre-1234567" },
    });
    cookie = `cde_session=${login.cookies.find((item) => item.name === "cde_session")!.value}`;
  });

  afterAll(async () => {
    await app.close();
    await handle.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("lists sources and browses their read-only hierarchy", async () => {
    const sources = await app.inject({
      url: `/api/v1/projects/${projectId}/external-documents/sources`,
      headers: { cookie },
    });
    expect(sources.statusCode).toBe(200);
    expect(sources.json()).toMatchObject([
      { id: sourceId, provider: "autodesk", counts: { folders: 1, files: 1 } },
    ]);

    const root = await app.inject({
      url: `/api/v1/projects/${projectId}/external-documents/sources/${sourceId}/contents`,
      headers: { cookie },
    });
    expect(root.statusCode).toBe(200);
    expect(root.json().entries).toMatchObject([{ externalId: "folder-1", kind: "folder" }]);

    const contents = await app.inject({
      url: `/api/v1/projects/${projectId}/external-documents/sources/${sourceId}/contents?parentId=folder-1`,
      headers: { cookie },
    });
    expect(contents.statusCode).toBe(200);
    expect(contents.json()).toMatchObject({
      current: { externalId: "folder-1" },
      entries: [{ externalId: "file-1", kind: "file", versionNumber: 3 }],
    });
  });
});
