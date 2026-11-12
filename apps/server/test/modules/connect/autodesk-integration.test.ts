import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../../../src/app/build-app.js";
import { JobQueue } from "../../../src/jobs/queue.js";
import { LocalStorage } from "../../../src/core/platform/storage.js";
import { hashPassword } from "../../../src/core/security/auth.js";
import { openDb, type DbHandle } from "../../../src/db/index.js";
import { issues, locations, projectMembers, projects, users } from "../../../src/db/schema.js";
import { autodeskConnections, integrationSyncRuns, externalEntities, externalEntityLinks } from "@7dimensions-project/sitekeep-ee-connect/internal/schema-tables.js";
import { projectAutodeskEntities } from "@7dimensions-project/sitekeep-ee-connect/internal/autodesk/projection.js";
import { startAutodeskScheduler } from "@7dimensions-project/sitekeep-ee-connect/internal/autodesk/sync.js";
import { AutodeskApiError, AutodeskClient } from "@7dimensions-project/sitekeep-ee-connect/internal/autodesk/client.js";
import { appAccessToken, validAccessToken, type OAuthState } from "@7dimensions-project/sitekeep-ee-connect/internal/autodesk/oauth.js";
import { listHubProjects } from "@7dimensions-project/sitekeep-ee-connect/internal/autodesk/documents.js";
import { fetchAutodeskResources } from "@7dimensions-project/sitekeep-ee-connect/internal/autodesk/adapters.js";
import { decryptSecret, encryptSecret } from "../../../src/core/platform/secrets.js";

describe("Autodesk integration", () => {
  let handle: DbHandle;

  beforeEach(async () => {
    handle = await openDb("memory://");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await handle.close();
  });

  it("encrypts refresh tokens at rest", () => {
    const key = Buffer.alloc(32, 7);
    const encrypted = encryptSecret(key, "refresh-token");
    expect(encrypted).not.toContain("refresh-token");
    expect(decryptSecret(key, encrypted)).toBe("refresh-token");
  });

  it("projects source identities idempotently", async () => {
    const [admin] = await handle.db
      .insert(users)
      .values({
        email: "admin@autodesk.test",
        name: "Admin",
        passwordHash: await hashPassword("Sifre-1234567"),
        isAdmin: true,
      })
      .returning();
    const [project] = await handle.db
      .insert(projects)
      .values({ code: "ACC", name: "ACC test", createdBy: admin!.id })
      .returning();
    await handle.db.insert(projectMembers).values({ projectId: project!.id, userId: admin!.id, isProjectAdmin: true });
    const [connection] = await handle.db
      .insert(autodeskConnections)
      .values({
        projectId: project!.id,
        clientId: "client",
        externalProjectId: "b.acc-project",
        createdBy: admin!.id,
      })
      .returning();
    await handle.db.insert(externalEntities).values([
      {
        connectionId: connection!.id,
        kind: "issue",
        externalId: "issue-1",
        displayName: "Çakışma",
        payload: { id: "issue-1", title: "Çakışma", status: "open", priority: "high" },
        contentHash: "a",
      },
      {
        connectionId: connection!.id,
        kind: "location",
        externalId: "location-1",
        displayName: "İstasyon",
        payload: { id: "location-1", name: "İstasyon", type: "Building" },
        contentHash: "b",
      },
    ]);

    await projectAutodeskEntities(handle.db, connection!);
    await projectAutodeskEntities(handle.db, connection!);

    expect(await handle.db.select().from(issues).where(eq(issues.projectId, project!.id))).toHaveLength(1);
    expect(await handle.db.select().from(locations).where(eq(locations.projectId, project!.id))).toHaveLength(1);
    const links = await handle.db
      .select()
      .from(externalEntityLinks)
      .where(and(eq(externalEntityLinks.connectionId, connection!.id), eq(externalEntityLinks.externalId, "issue-1")));
    expect(links).toHaveLength(1);
  });

  it("follows offset pagination and retries a rate-limited page", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("rate limited", { status: 429, headers: { "retry-after": "0.001" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ results: [{ id: "1" }, { id: "2" }], pagination: { hasMore: true } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ results: [{ id: "3" }], pagination: { hasMore: false } })));

    const rows = await new AutodeskClient("access").offsetCollection("/construction/issues/v1/projects/p/issues", { limit: 2 });
    expect(rows.map((row) => row.id)).toEqual(["1", "2", "3"]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[1]![0])).toContain("offset=0");
    expect(String(fetchMock.mock.calls[2]![0])).toContain("offset=2");
  });

  it("refreshes an expired access token and stores the rotated secrets", async () => {
    const key = Buffer.alloc(32, 9);
    const [admin] = await handle.db
      .insert(users)
      .values({
        email: "refresh@autodesk.test",
        name: "Refresh Admin",
        passwordHash: await hashPassword("Sifre-1234567"),
        isAdmin: true,
      })
      .returning();
    const [project] = await handle.db
      .insert(projects)
      .values({ code: "REF", name: "Refresh test", createdBy: admin!.id })
      .returning();
    const [connection] = await handle.db
      .insert(autodeskConnections)
      .values({
        projectId: project!.id,
        clientId: "client",
        externalProjectId: "b.refresh",
        accessTokenEnc: encryptSecret(key, "expired"),
        refreshTokenEnc: encryptSecret(key, "refresh-old"),
        tokenExpiresAt: new Date(0),
        createdBy: admin!.id,
      })
      .returning();
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          access_token: "access-new",
          refresh_token: "refresh-new",
          expires_in: 3600,
          scope: "data:read",
          token_type: "Bearer",
        }),
        { status: 200 },
      ),
    );

    expect(await validAccessToken(handle.db, key, connection!.id)).toBe("access-new");
    const [stored] = await handle.db
      .select()
      .from(autodeskConnections)
      .where(eq(autodeskConnections.id, connection!.id));
    expect(decryptSecret(key, stored!.refreshTokenEnc!)).toBe("refresh-new");
    expect(stored!.scopes).toEqual(["data:read"]);
  });

  it("authenticates token requests with the client secret of a confidential APS app", async () => {
    const key = Buffer.alloc(32, 8);
    const { connection } = await connectionFixture("SEC");
    await handle.db
      .update(autodeskConnections)
      .set({ refreshTokenEnc: encryptSecret(key, "refresh-old"), tokenExpiresAt: new Date(0) })
      .where(eq(autodeskConnections.id, connection.id));
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => new Response(JSON.stringify({ access_token: "a", refresh_token: "r", expires_in: 3600, scope: "data:read" })));

    await validAccessToken(handle.db, key, connection.id, "s3cret");
    const headers = fetchMock.mock.calls[0]![1]!.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Basic ${Buffer.from("client:s3cret").toString("base64")}`);
    expect(new URLSearchParams(String(fetchMock.mock.calls[0]![1]!.body)).has("client_id")).toBe(false);

    await handle.db.update(autodeskConnections).set({ tokenExpiresAt: new Date(0) }).where(eq(autodeskConnections.id, connection.id));
    await validAccessToken(handle.db, key, connection.id);
    expect((fetchMock.mock.calls[1]![1]!.headers as Record<string, string>).authorization).toBeUndefined();
    expect(new URLSearchParams(String(fetchMock.mock.calls[1]![1]!.body)).get("client_id")).toBe("client");
  });

  it("gets the app token only for a confidential APS app and reuses it until it expires", async () => {
    expect(await appAccessToken({ clientId: "public", callbackUrl: "https://cde.test/cb" })).toBeNull();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => new Response(JSON.stringify({ access_token: "app", expires_in: 3600, scope: "data:read" })));
    const config = { clientId: "catalog-app", callbackUrl: "https://cde.test/cb", clientSecret: "s3cret" };
    expect(await appAccessToken(config)).toBe("app");
    expect(await appAccessToken(config)).toBe("app");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![1]!.body)).toContain("grant_type=client_credentials");
  });

  it("lists the hubs the app reaches with all their projects, sorted by name", async () => {
    const json = (body: unknown) => new Response(JSON.stringify(body));
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/project/v1/hubs")) return json({ data: [{ id: "b.h2", attributes: { name: "Zeta " } }, { id: "b.h1", attributes: { name: "7Dimensions" } }] });
      if (url.includes("/hubs/b.h1/projects") && !url.includes("page%5Boffset%5D"))
        return json({ data: [{ id: "b.p2", attributes: { name: "Şantiye" } }], links: { next: { href: "https://developer.api.autodesk.com/project/v1/hubs/b.h1/projects?page%5Boffset%5D=1" } } });
      if (url.includes("/hubs/b.h1/projects")) return json({ data: [{ id: "b.p1", attributes: { name: "Bina" } }] });
      return json({ data: [] });
    });
    expect(await listHubProjects(new AutodeskClient("t"))).toEqual([
      { id: "b.h1", name: "7Dimensions", projects: [{ id: "b.p1", name: "Bina" }, { id: "b.p2", name: "Şantiye" }] },
      { id: "b.h2", name: "Zeta", projects: [] },
    ]);
  });

  /** Admin, project and connection to project source rows into. */
  async function connectionFixture(code: string) {
    const [admin] = await handle.db
      .insert(users)
      .values({ email: `${code.toLowerCase()}@autodesk.test`, name: "Admin", passwordHash: await hashPassword("Sifre-1234567"), isAdmin: true })
      .returning();
    const [project] = await handle.db.insert(projects).values({ code, name: `${code} test`, createdBy: admin!.id }).returning();
    await handle.db.insert(projectMembers).values({ projectId: project!.id, userId: admin!.id, isProjectAdmin: true });
    const [connection] = await handle.db
      .insert(autodeskConnections)
      .values({ projectId: project!.id, clientId: "client", externalProjectId: `b.${code}`, createdBy: admin!.id })
      .returning();
    return { admin: admin!, project: project!, connection: connection! };
  }

  it("reads only the chosen record kinds, and the companies with the users", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({ results: [] })));
    const resources = await fetchAutodeskResources(new AutodeskClient("t"), "b.p", { kinds: ["issue", "user"] });
    expect(resources.map((r) => r.kind).sort()).toEqual(["company", "issue", "user"]);
    const paths = fetchMock.mock.calls.map(([url]) => new URL(String(url)).pathname);
    expect(paths.some((p) => p.includes("/forms"))).toBe(false);
    expect(paths.some((p) => p.includes("/issues"))).toBe(true);
  });

  it("reads companies from the HQ API of the hub's account and the other kinds from their current endpoints", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) =>
      String(input).includes("/hq/v1/") ? new Response(JSON.stringify([{ id: "c-1", name: "TCDD" }])) : new Response(JSON.stringify({ results: [] })),
    );
    const resources = await fetchAutodeskResources(new AutodeskClient("user"), "b.p", {
      hubId: "b.acc",
      appClient: new AutodeskClient("app"),
      updatedAfter: { issue: "2026-11-02T10:00:00.000Z", review: "2026-11-02T10:00:00.000Z" },
    });
    expect(resources.find((r) => r.kind === "company")?.records).toEqual([{ id: "c-1", name: "TCDD" }]);
    const urls = fetchMock.mock.calls.map(([url]) => new URL(String(url)));
    const at = (part: string) => urls.find((u) => u.pathname.includes(part));
    expect(at("/hq/v1/accounts/acc/projects/p/companies")).toBeTruthy();
    expect(at("/construction/submittals/v2/projects/p/items")).toBeTruthy();
    expect(at("/forms")!.searchParams.get("limit")).toBe("50");
    expect(at("/forms")!.searchParams.has("includeInactiveFormTemplates")).toBe(false);
    expect(at("/reviews")!.searchParams.get("limit")).toBe("50");
    expect(at("/reviews")!.searchParams.has("filter[updatedAt]")).toBe(false);
    expect(at("/issues")!.searchParams.get("filter[updatedAt]")).toBe("2026-11-02T10:00:00.000Z..");
    // Companies go with the app token, the rest with the user's.
    const auth = (part: string) => (fetchMock.mock.calls.find(([url]) => String(url).includes(part))![1]!.headers as Record<string, string>).authorization;
    expect(auth("/hq/v1/")).toBe("Bearer app");
    expect(auth("/issues")).toBe("Bearer user");
  });

  it("schedules only the connections of the installation's current APS app", async () => {
    const { connection: current } = await connectionFixture("NOW");
    const { connection: old } = await connectionFixture("OLD");
    await handle.db.update(autodeskConnections).set({ refreshTokenEnc: "x", enabled: true }).where(eq(autodeskConnections.id, current.id));
    await handle.db.update(autodeskConnections).set({ refreshTokenEnc: "x", enabled: true, clientId: "earlier-app" }).where(eq(autodeskConnections.id, old.id));
    const queued: string[] = [];
    const jobs = { enqueue: async (_kind: string, payload: { connectionId: string }) => (queued.push(payload.connectionId), "j") } as unknown as JobQueue;
    const stop = startAutodeskScheduler(handle.db, jobs, { everyMs: 60_000, clientId: "client" });
    await vi.waitFor(() => expect(queued).toEqual([current.id]));
    stop();
  });

  it("does not retry an unauthorized or forbidden request", async () => {
    for (const status of [401, 403]) {
      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(new Response(JSON.stringify({ detail: "Yetki yok" }), { status }));
      const error = await new AutodeskClient("access").get("/project/v1/hubs").catch((e: unknown) => e);
      expect(error).toBeInstanceOf(AutodeskApiError);
      expect((error as AutodeskApiError).status).toBe(status);
      expect((error as AutodeskApiError).message).toBe("Yetki yok");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      fetchMock.mockRestore();
    }
  });

  it("retries a server error a bounded number of times, then gives up", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => new Response("unavailable", { status: 503, headers: { "retry-after": "0.001" } }));
    const error = await new AutodeskClient("access").get("/project/v1/hubs").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AutodeskApiError);
    expect((error as AutodeskApiError).status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("recovers when a server error clears before the last attempt", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("bad gateway", { status: 502, headers: { "retry-after": "0.001" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: "hub" }] })));
    expect(await new AutodeskClient("access").get("/project/v1/hubs")).toEqual({ data: [{ id: "hub" }] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("follows cursor pagination until the cursor runs out", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ results: [{ id: "1" }], pagination: { nextCursor: "c2" } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ results: [{ id: "2" }], nextCursor: "c3" })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ results: [{ id: "3" }] })));
    const rows = await new AutodeskClient("access").cursorCollection("/construction/rfis/v2/projects/p/rfis", { limit: 1 });
    expect(rows.map((row) => row.id)).toEqual(["1", "2", "3"]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[0]![0])).not.toContain("cursor=");
    expect(String(fetchMock.mock.calls[1]![0])).toContain("cursor=c2");
    expect(String(fetchMock.mock.calls[2]![0])).toContain("cursor=c3");
  });

  it("maps issue status and priority, and skips issues deleted at the source", async () => {
    const { project, connection } = await connectionFixture("MAP");
    const issue = (externalId: string, payload: Record<string, unknown>, sourceDeleted = false) => ({
      connectionId: connection.id,
      kind: "issue",
      externalId,
      displayName: externalId,
      payload: { id: externalId, ...payload },
      contentHash: externalId,
      sourceDeleted,
    });
    await handle.db.insert(externalEntities).values([
      issue("closed", { title: "Kapandı", status: "closed", priority: "Critical" }),
      issue("review", { title: "İncelemede", status: "in_review", priority: "Low" }),
      issue("progress", { title: "Devam", status: "in_progress", issueType: { title: "Kalite" } }),
      issue("untitled", { displayId: 42, status: "draft", priority: "high" }),
      issue("deleted", { title: "Silindi", status: "open" }, true),
    ]);

    await projectAutodeskEntities(handle.db, connection);

    const rows = await handle.db.select().from(issues).where(eq(issues.projectId, project.id));
    const byTitle = Object.fromEntries(rows.map((r) => [r.title, r]));
    expect(Object.keys(byTitle).sort()).toEqual(["Autodesk Issue 42", "Devam", "Kapandı", "İncelemede"].sort());
    expect(byTitle["Kapandı"]).toMatchObject({ status: "closed", priority: "critical", type: "Issue · Autodesk" });
    expect(byTitle["İncelemede"]).toMatchObject({ status: "in_review", priority: "low" });
    expect(byTitle["Devam"]).toMatchObject({ status: "in_progress", priority: "normal", type: "Kalite · Autodesk" });
    expect(byTitle["Autodesk Issue 42"]).toMatchObject({ status: "open", priority: "high" });
  });

  it("updates a linked issue when it is deleted at the source instead of creating a new one", async () => {
    const { project, connection } = await connectionFixture("DEL");
    const [row] = await handle.db
      .insert(externalEntities)
      .values({ connectionId: connection.id, kind: "issue", externalId: "i-1", displayName: "i-1", payload: { id: "i-1", title: "Açık", status: "open" }, contentHash: "a" })
      .returning();
    await projectAutodeskEntities(handle.db, connection);
    await handle.db
      .update(externalEntities)
      .set({ payload: { id: "i-1", title: "Açık", status: "void" }, sourceDeleted: true })
      .where(eq(externalEntities.id, row!.id));
    await projectAutodeskEntities(handle.db, connection);
    const rows = await handle.db.select().from(issues).where(eq(issues.projectId, project.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("closed");
  });

  describe("OAuth callback", () => {
    const key = Buffer.alloc(32, 4);
    const url = "/api/v1/integrations/autodesk/callback";
    let dataDir: string;
    let app: Awaited<ReturnType<typeof buildApp>>;

    beforeEach(async () => {
      dataDir = mkdtempSync(path.join(os.tmpdir(), "7dcde-autodesk-"));
      const storage = new LocalStorage(path.join(dataDir, "storage"));
      app = await buildApp({
        db: handle.db,
        storage,
        jobs: new JobQueue(handle.db, storage),
        secretKey: key,
        autodeskAuth: { clientId: "client", callbackUrl: "https://cde.test/api/v1/integrations/autodesk/callback" },
      });
    });

    afterEach(async () => {
      await app.close();
      rmSync(dataDir, { recursive: true, force: true });
    });

    const state = (over: Partial<OAuthState> = {}): OAuthState => ({
      connectionId: "c",
      projectId: "p",
      userId: "u",
      verifier: "v",
      nonce: "nonce-1",
      expiresAt: Date.now() + 60_000,
      ...over,
    });
    const callback = (query: string, cookie?: string) =>
      app.inject({ method: "GET", url: `${url}?${query}`, headers: cookie ? { cookie: `cde_autodesk_oauth=${cookie}` } : {} });

    it("rejects a return without the state cookie, code or state", async () => {
      const sealed = encryptSecret(key, JSON.stringify(state()));
      for (const res of [await callback("code=x&state=nonce-1"), await callback("state=nonce-1", sealed), await callback("code=x", sealed)]) {
        expect(res.statusCode).toBe(400);
        expect(res.json().message).toBe("Autodesk OAuth dönüş bilgisi eksik.");
      }
    });

    it("rejects a tampered or foreign state cookie", async () => {
      const foreign = encryptSecret(Buffer.alloc(32, 5), JSON.stringify(state()));
      for (const cookie of ["not-encrypted", foreign]) {
        const res = await callback("code=x&state=nonce-1", cookie);
        expect(res.statusCode).toBe(400);
        expect(res.json().message).toBe("Autodesk OAuth oturumu geçersiz.");
      }
    });

    it("rejects an expired state and a nonce that does not match", async () => {
      const fetchMock = vi.spyOn(globalThis, "fetch");
      const expired = await callback("code=x&state=nonce-1", encryptSecret(key, JSON.stringify(state({ expiresAt: Date.now() - 1 }))));
      const mismatch = await callback("code=x&state=other", encryptSecret(key, JSON.stringify(state())));
      for (const res of [expired, mismatch]) {
        expect(res.statusCode).toBe(400);
        expect(res.json().message).toBe("Autodesk OAuth oturumu süresi dolmuş.");
      }
      // No code exchange with Autodesk for a rejected state.
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("connects without bringing anything, and the earlier ACC project of the CDE project stops", async () => {
      const { project, connection } = await connectionFixture("CON");
      const [earlier] = await handle.db
        .insert(autodeskConnections)
        .values({ projectId: project.id, clientId: "client", externalProjectId: "b.earlier", enabled: true })
        .returning();
      await handle.db.update(autodeskConnections).set({ enabled: false }).where(eq(autodeskConnections.id, connection.id));
      vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({ access_token: "a", refresh_token: "r", expires_in: 3600, scope: "data:read" })));
      const sealed = encryptSecret(key, JSON.stringify(state({ projectId: project.id, connectionId: connection.id })));
      const res = await callback("code=x&state=nonce-1", sealed);
      expect(res.headers.location).toBe(`/projects/${project.id}/forma-esitleme?autodesk=connected`);
      const [now] = await handle.db.select().from(autodeskConnections).where(eq(autodeskConnections.id, connection.id));
      expect(now!.authorizedAt).toBeInstanceOf(Date);
      // Nothing comes before Getir: no sync run, the automatic sync stays off.
      expect(now!.enabled).toBe(false);
      expect(await handle.db.select().from(integrationSyncRuns).where(eq(integrationSyncRuns.connectionId, connection.id))).toHaveLength(0);
      const [before] = await handle.db.select().from(autodeskConnections).where(eq(autodeskConnections.id, earlier!.id));
      expect(before!.enabled).toBe(false);
    });

    it("sends a cancelled sign-in back to the project's Forma Eşitleme page", async () => {
      const pid = "6f1c2a9e-3b4d-4e5f-8a7b-9c0d1e2f3a4b";
      const res = await callback("error=access_denied", encryptSecret(key, JSON.stringify(state({ projectId: pid }))));
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe(`/projects/${pid}/forma-esitleme?autodesk=cancelled`);
      // Without the sign-in cookie there is no project to go back to.
      expect((await callback("error=access_denied")).headers.location).toBe("/home");
    });
  });
});
