import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { text } from "node:stream/consumers";
import { and, eq, isNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../../../src/app/build-app.js";
import { hashPassword } from "../../../src/core/security/auth.js";
import { encryptSecret } from "../../../src/core/platform/secrets.js";
import { LocalStorage } from "../../../src/core/platform/storage.js";
import { openDb, type DbHandle } from "../../../src/db/index.js";
import { fileVersions, files, users } from "../../../src/db/schema.js";
import { autodeskConnections, autodeskFileImports, externalEntities, externalEntityLinks } from "@7dimensions-project/sitekeep-ee-connect/internal/schema-tables.js";
import { parseStorageId } from "@7dimensions-project/sitekeep-ee-connect/internal/autodesk/documents.js";
import { resumeInterruptedImports } from "@7dimensions-project/sitekeep-ee-connect/internal/autodesk/file-import.js";
import { JobQueue } from "../../../src/jobs/queue.js";

const API = "https://developer.api.autodesk.com";
const S3 = "https://cdn.s3.test";
const HUB = "b.hub-1";
const PROJECT = "b.acc-1";
const FOLDER = "urn:adsk.wipprod:fs.folder:co.models";
const ITEM = "urn:adsk.wipprod:dm.lineage:item-1";
const version = (n: number) => `urn:adsk.wipprod:fs.file:vf.item-1?version=${n}`;

/** What the fake Autodesk answers: the tip version of the one file, and whether the download works. */
const acc = { tip: 1, s3Status: 200 };
const storageOf = (n: number) => `urn:adsk.objects:os.object:wip.dm.prod/obj-${n}.txt`;

function versionJson(n: number) {
  return {
    type: "versions",
    id: version(n),
    attributes: { name: "Saha Notları.txt", displayName: "Saha Notları.txt", versionNumber: n, storageSize: 9, fileType: "txt", lastModifiedTime: "2026-10-30T10:00:00Z" },
    relationships: { item: { data: { type: "items", id: ITEM } }, storage: { data: { type: "objects", id: storageOf(n) } } },
  };
}

function fakeAutodesk(input: string | URL | Request): Response {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const p = decodeURIComponent(url.pathname);
  if (url.origin === S3) return acc.s3Status === 200 ? new Response(`içerik v${url.searchParams.get("n")}`) : new Response("denied", { status: acc.s3Status });
  if (p === "/project/v1/hubs") return json({ data: [{ id: "b.other-hub" }, { id: HUB }] });
  if (p === `/project/v1/hubs/b.other-hub/projects/${PROJECT}`) return json({ errors: [{ detail: "not found" }] }, 404);
  if (p === `/project/v1/hubs/${HUB}/projects/${PROJECT}`) return json({ data: { id: PROJECT } });
  if (p === `/project/v1/hubs/${HUB}/projects/${PROJECT}/topFolders`)
    return json({ data: [{ type: "folders", id: "urn:top", attributes: { displayName: "Project Files" } }, { type: "folders", id: "urn:hidden", attributes: { name: "x", hidden: true } }] });
  if (p === `/data/v1/projects/${PROJECT}/folders/${FOLDER}/contents`)
    return json({
      data: [
        { type: "folders", id: "urn:sub", attributes: { displayName: "Arşiv" } },
        { type: "items", id: ITEM, attributes: { displayName: "Saha Notları.txt" }, relationships: { tip: { data: { type: "versions", id: version(acc.tip) } } } },
      ],
      included: [versionJson(acc.tip)],
    });
  const v = /^\/data\/v1\/projects\/b\.acc-1\/versions\/(.+)$/.exec(p);
  if (v) return json({ data: versionJson(Number(/version=(\d+)/.exec(v[1]!)![1])) });
  const s = /^\/oss\/v2\/buckets\/wip\.dm\.prod\/objects\/obj-(\d+)\.txt\/signeds3download$/.exec(p);
  if (s) return json({ status: "complete", url: `${S3}/obj?n=${s[1]}`, size: 9 });
  return json({ message: `unexpected ${p}` }, 500);
}

describe("Autodesk Docs file import", () => {
  const key = Buffer.alloc(32, 5);
  let handle: DbHandle;
  let app: FastifyInstance;
  let jobs: JobQueue;
  let storage: LocalStorage;
  let dataDir: string;
  let cookie: string;
  let pid: string;
  let folderId: string;
  let cid: string;

  const call = (method: "GET" | "POST", url: string, payload?: unknown, as = cookie) =>
    app.inject({ method, url: `/api/v1${url}`, headers: { cookie: as }, ...(payload ? { payload } : {}) });
  const login = async (email: string) => {
    const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: "Sifre-1234567" } });
    return `cde_session=${res.cookies.find((c) => c.name === "cde_session")!.value}`;
  };
  const request = (n: number) => ({ itemId: ITEM, versionId: version(n), versionNumber: n, name: "Saha Notları.txt", path: "Project Files/Modeller", size: 9 });

  beforeAll(async () => {
    dataDir = mkdtempSync(path.join(os.tmpdir(), "7dcde-autodesk-files-"));
    handle = await openDb("memory://");
    storage = new LocalStorage(path.join(dataDir, "storage"));
    jobs = new JobQueue(handle.db, storage);
    app = await buildApp({ db: handle.db, storage, jobs, secretKey: key });
    const hash = await hashPassword("Sifre-1234567");
    await handle.db.insert(users).values([
      { email: "admin@acc.test", name: "Admin", passwordHash: hash, isAdmin: true },
      { email: "uye@acc.test", name: "Üye", passwordHash: hash },
    ]);
    cookie = await login("admin@acc.test");
    const p = await call("POST", "/projects", { code: "ACCF", name: "ACC dosya", template: "empty" });
    pid = p.json().id;
    folderId = (await call("POST", `/projects/${pid}/folders`, { parentId: p.json().rootFolderId, name: "Modeller" })).json().id;
    const [admin] = await handle.db.select().from(users).where(eq(users.email, "admin@acc.test"));
    const [connection] = await handle.db
      .insert(autodeskConnections)
      .values({
        projectId: pid,
        clientId: "client",
        externalProjectId: "acc-1",
        accessTokenEnc: encryptSecret(key, "access"),
        refreshTokenEnc: encryptSecret(key, "refresh"),
        tokenExpiresAt: new Date(Date.now() + 3600_000),
        status: "ready",
        createdBy: admin!.id,
      })
      .returning();
    cid = connection!.id;
  });

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => fakeAutodesk(input as string));
    acc.tip = 1;
    acc.s3Status = 200;
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await app.close();
    await handle.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("reads storage ids of Data Management versions", () => {
    expect(parseStorageId(storageOf(3))).toEqual({ bucketKey: "wip.dm.prod", objectKey: "obj-3.txt" });
    expect(parseStorageId("urn:other")).toBeNull();
  });

  it("browses Autodesk Docs live, finding and keeping the project's hub", async () => {
    const top = await call("GET", `/projects/${pid}/integrations/autodesk/${cid}/docs`);
    expect(top.statusCode, top.body).toBe(200);
    expect(top.json()).toMatchObject({ folderId: null, folders: [{ id: "urn:top", name: "Project Files" }], files: [] });
    const [row] = await handle.db.select().from(autodeskConnections).where(eq(autodeskConnections.id, cid));
    expect(row!.externalHubId).toBe(HUB);

    const inside = await call("GET", `/projects/${pid}/integrations/autodesk/${cid}/docs?folder=${encodeURIComponent(FOLDER)}`);
    expect(inside.json()).toMatchObject({
      folders: [{ id: "urn:sub", name: "Arşiv" }],
      files: [{ itemId: ITEM, versionId: version(1), versionNumber: 1, name: "Saha Notları.txt", size: 9, downloadable: true, imported: null }],
    });
  });

  it("is only for project administrators", async () => {
    const member = await login("uye@acc.test");
    expect((await call("GET", `/projects/${pid}/integrations/autodesk/${cid}/docs`, undefined, member)).statusCode).toBe(404);
  });

  it("imports a file, adds a version when Autodesk has a newer one, and skips the same version", async () => {
    const queued = await call("POST", `/projects/${pid}/integrations/autodesk/${cid}/imports`, { targetFolderId: folderId, files: [request(1)] });
    expect(queued.statusCode, queued.body).toBe(200);
    expect(queued.json()).toEqual({ queued: 1, rejected: [] });
    await jobs.drain();

    const [file] = await handle.db.select().from(files).where(and(eq(files.projectId, pid), eq(files.name, "Saha Notları.txt")));
    expect(file).toMatchObject({ folderId, currentVersion: 1 });
    const [v1] = await handle.db.select().from(fileVersions).where(eq(fileVersions.fileId, file!.id));
    expect(await text(storage.get(v1!.storageKey))).toBe("içerik v1");
    expect(v1!.comment).toContain("Project Files/Modeller");
    const [link] = await handle.db.select().from(externalEntityLinks).where(eq(externalEntityLinks.externalId, ITEM));
    expect(link).toMatchObject({ kind: "document", nativeType: "file", nativeId: file!.id, metadata: { versionNumber: 1 } });

    // The listing now says which CDE file holds the item.
    const listed = await call("GET", `/projects/${pid}/integrations/autodesk/${cid}/docs?folder=${encodeURIComponent(FOLDER)}`);
    expect(listed.json().files[0].imported).toEqual({ fileId: file!.id, versionNumber: 1 });

    // Same version again: skipped, nothing downloaded.
    await call("POST", `/projects/${pid}/integrations/autodesk/${cid}/imports`, { targetFolderId: folderId, files: [request(1)] });
    await jobs.drain();
    // Autodesk v2: a new version of the same CDE file.
    acc.tip = 2;
    await call("POST", `/projects/${pid}/integrations/autodesk/${cid}/imports`, { targetFolderId: folderId, files: [request(2)] });
    await jobs.drain();
    const [after] = await handle.db.select().from(files).where(eq(files.id, file!.id));
    expect(after!.currentVersion).toBe(2);

    const recent = (await call("GET", `/projects/${pid}/integrations/autodesk/imports`)).json();
    expect(recent.map((r: { status: string; action: string }) => [r.status, r.action])).toEqual([
      ["done", "version"],
      ["skipped", "skipped"],
      ["done", "new"],
    ]);
    expect(recent[0]).toMatchObject({ name: "Saha Notları.txt", versionNumber: 2, targetFolderName: "Modeller", requestedBy: "Admin" });
  });

  it("reports the bytes received while a download runs, and none once it is done", async () => {
    await handle.db.delete(externalEntityLinks).where(eq(externalEntityLinks.externalId, ITEM));
    await handle.db.update(files).set({ deletedAt: new Date() }).where(eq(files.projectId, pid));
    const put = storage.put.bind(storage);
    let during: unknown[] = [];
    vi.spyOn(storage, "put").mockImplementation(async (source, prefix) => {
      const body = await text(source as NodeJS.ReadableStream);
      during = (await call("GET", `/projects/${pid}/integrations/autodesk/imports`)).json().filter((r: { status: string }) => r.status === "running");
      return put(Readable.from([Buffer.from(body)]), prefix);
    });
    await call("POST", `/projects/${pid}/integrations/autodesk/${cid}/imports`, { targetFolderId: folderId, files: [request(1)] });
    await jobs.drain();
    expect(during).toEqual([expect.objectContaining({ name: "Saha Notları.txt", bytesReceived: Buffer.byteLength("içerik v1") })]);
    const [latest] = (await call("GET", `/projects/${pid}/integrations/autodesk/imports`)).json();
    expect(latest).toMatchObject({ status: "done", bytesReceived: null });
  });

  it("brings again an import a restart left running without its job", async () => {
    await handle.db.delete(externalEntityLinks).where(eq(externalEntityLinks.externalId, ITEM));
    await handle.db.update(files).set({ deletedAt: new Date() }).where(eq(files.projectId, pid));
    const [admin] = await handle.db.select().from(users).where(eq(users.email, "admin@acc.test"));
    const [stuck] = await handle.db
      .insert(autodeskFileImports)
      .values({
        projectId: pid,
        connectionId: cid,
        externalItemId: ITEM,
        externalVersionId: version(1),
        name: "Saha Notları.txt",
        targetFolderId: folderId,
        status: "running",
        requestedBy: admin!.id,
      })
      .returning();
    expect(await resumeInterruptedImports(handle.db, jobs)).toBe(1);
    // Its job is queued now: a second start does not queue it again.
    expect(await resumeInterruptedImports(handle.db, jobs)).toBe(0);
    await jobs.drain();
    const [row] = await handle.db.select().from(autodeskFileImports).where(eq(autodeskFileImports.id, stuck!.id));
    expect(row).toMatchObject({ status: "done", action: "new" });
  });

  it("records a failed download and keeps nothing in storage", async () => {
    acc.s3Status = 403;
    // Unlinked again, so the item is brought as a new file and the download is attempted.
    await handle.db.delete(externalEntityLinks).where(eq(externalEntityLinks.externalId, ITEM));
    await handle.db.update(files).set({ deletedAt: new Date() }).where(eq(files.projectId, pid));
    await call("POST", `/projects/${pid}/integrations/autodesk/${cid}/imports`, { targetFolderId: folderId, files: [request(1)] });
    await jobs.drain();
    const [row] = await handle.db.select().from(autodeskFileImports).where(eq(autodeskFileImports.status, "failed"));
    expect(row!.error).toContain("403");
    expect(row!.fileId).toBeNull();
  });

  it("rejects names that cannot be stored and files already in the queue", async () => {
    const bad = await call("POST", `/projects/${pid}/integrations/autodesk/${cid}/imports`, {
      targetFolderId: folderId,
      files: [{ ...request(1), itemId: "urn:x", name: "a|b.txt" }],
    });
    expect(bad.json()).toMatchObject({ queued: 0, rejected: [{ name: "a|b.txt" }] });

    await call("POST", `/projects/${pid}/integrations/autodesk/${cid}/imports`, { targetFolderId: folderId, files: [{ ...request(1), itemId: "urn:y" }] });
    const twice = await call("POST", `/projects/${pid}/integrations/autodesk/${cid}/imports`, { targetFolderId: folderId, files: [{ ...request(1), itemId: "urn:y" }] });
    expect(twice.json()).toMatchObject({ queued: 0, rejected: [{ name: "Saha Notları.txt" }] });
  });
  it("lists the record kinds with their ACC and CDE counts, and saves the chosen ones for every sync", async () => {
    await handle.db.insert(externalEntities).values([
      { connectionId: cid, kind: "issue", externalId: "i-1", payload: {}, contentHash: "a" },
      { connectionId: cid, kind: "issue", externalId: "i-2", payload: {}, contentHash: "b", sourceDeleted: true },
    ]);
    await handle.db.update(autodeskConnections).set({ counts: { issue: 2 } }).where(eq(autodeskConnections.id, cid));
    const kinds = (await call("GET", `/projects/${pid}/integrations/autodesk/${cid}/records`)).json();
    expect(kinds.find((k: { kind: string }) => k.kind === "issue")).toEqual({ kind: "issue", selected: true, inAcc: 1, inCde: 0 });
    // Never read yet: unknown rather than zero.
    expect(kinds.find((k: { kind: string }) => k.kind === "form")).toMatchObject({ selected: true, inAcc: null });

    expect((await call("POST", `/projects/${pid}/integrations/autodesk/${cid}/records`, { kinds: [] })).statusCode).toBe(400);
    const saved = await call("POST", `/projects/${pid}/integrations/autodesk/${cid}/records`, { kinds: ["form", "issue"] });
    expect(saved.json()).toMatchObject({ queued: true, connection: { syncKinds: ["issue", "form"] } });
    const [row] = await handle.db.select().from(autodeskConnections).where(eq(autodeskConnections.id, cid));
    expect(row!.syncKinds).toEqual(["issue", "form"]);
    // Bringing kinds turns the automatic sync on for them.
    expect(row!.enabled).toBe(true);
  });
  it("cancels a queued import before it starts and stops a running download", async () => {
    await handle.db.delete(externalEntityLinks).where(eq(externalEntityLinks.externalId, ITEM));
    await handle.db.update(files).set({ deletedAt: new Date() }).where(eq(files.projectId, pid));
    // Queued: never starts.
    await call("POST", `/projects/${pid}/integrations/autodesk/${cid}/imports`, { targetFolderId: folderId, files: [request(1)] });
    let [row] = (await call("GET", `/projects/${pid}/integrations/autodesk/imports`)).json();
    expect(row).toMatchObject({ status: "queued", cancellable: true });
    expect((await call("POST", `/projects/${pid}/integrations/autodesk/imports/${row.id}/cancel`)).json()).toEqual({ cancelled: true });
    await jobs.drain();
    [row] = (await call("GET", `/projects/${pid}/integrations/autodesk/imports`)).json();
    expect(row).toMatchObject({ status: "cancelled", cancellable: false, fileId: null });

    // Running: the download stops and nothing is kept.
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (!String(input).startsWith(S3)) return fakeAutodesk(input as string);
      const signal = init!.signal!;
      const body = new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode("ilk parça"));
          signal.addEventListener("abort", () => c.error(signal.reason));
        },
      });
      return new Response(body);
    });
    const put = storage.put.bind(storage);
    vi.spyOn(storage, "put").mockImplementation(async (source, prefix) => {
      const [running] = (await call("GET", `/projects/${pid}/integrations/autodesk/imports`)).json();
      expect(running).toMatchObject({ status: "running", cancellable: true });
      await call("POST", `/projects/${pid}/integrations/autodesk/imports/${running.id}/cancel`);
      return put(source, prefix);
    });
    await call("POST", `/projects/${pid}/integrations/autodesk/${cid}/imports`, { targetFolderId: folderId, files: [request(1)] });
    await jobs.drain();
    [row] = (await call("GET", `/projects/${pid}/integrations/autodesk/imports`)).json();
    expect(row).toMatchObject({ status: "cancelled", error: null, fileId: null });
    expect(await handle.db.select().from(files).where(and(eq(files.projectId, pid), isNull(files.deletedAt)))).toHaveLength(0);
  });

  it("shows the record sync step by step and stops a queued one", async () => {
    await handle.db.update(autodeskConnections).set({ status: "ready", syncKinds: ["issue", "user"] }).where(eq(autodeskConnections.id, cid));
    await call("POST", `/projects/${pid}/integrations/autodesk/${cid}/sync`);
    let { run } = (await call("GET", `/projects/${pid}/integrations/autodesk/${cid}/progress`)).json();
    expect(run).toMatchObject({ status: "queued", percent: 0, projectStep: "waiting" });
    expect(run.steps.map((s: { kind: string; state: string }) => [s.kind, s.state])).toEqual([["issue", "waiting"], ["user", "waiting"]]);
    expect((await call("POST", `/projects/${pid}/integrations/autodesk/${cid}/sync/cancel`)).json()).toEqual({ cancelled: true });
    await jobs.drain();
    ({ run } = (await call("GET", `/projects/${pid}/integrations/autodesk/${cid}/progress`)).json());
    expect(run).toMatchObject({ status: "cancelled", projectStep: "cancelled" });
    const [connection] = await handle.db.select().from(autodeskConnections).where(eq(autodeskConnections.id, cid));
    expect(connection!.status).toBe("ready");
    expect((await call("POST", `/projects/${pid}/integrations/autodesk/${cid}/sync/cancel`)).json()).toEqual({ cancelled: false });
  });
  it("lists the ACC records of a kind with their details and brings a chosen one into the project", async () => {
    await handle.db.update(autodeskConnections).set({ status: "ready" }).where(eq(autodeskConnections.id, cid));
    await handle.db.insert(externalEntities).values([
      {
        connectionId: cid,
        kind: "issue",
        externalId: "iss-7",
        displayName: "Döşeme kotu hatalı",
        payload: { id: "iss-7", title: "Döşeme kotu hatalı", displayId: 7, status: "open", description: "Aks 3", watchers: ["a", "b"], links: { self: "x" } },
        contentHash: "c",
      },
      { connectionId: cid, kind: "issue", externalId: "iss-8", displayName: "Kapı ölçüsü", payload: { title: "Kapı ölçüsü", status: "closed" }, contentHash: "d" },
    ]);
    const listed = (await call("GET", `/projects/${pid}/integrations/autodesk/${cid}/records/issue`)).json();
    const seven = listed.records.find((r: { externalId: string }) => r.externalId === "iss-7");
    expect(seven).toMatchObject({ name: "Döşeme kotu hatalı", number: "7", status: "open", native: null, deletedInAcc: false });
    // Plain fields as ACC names them; nested objects are left out.
    expect(seven.details).toEqual(expect.arrayContaining([["description", "Aks 3"], ["watchers", "a, b"]]));
    expect(seven.details.some(([k]: [string]) => k === "links")).toBe(false);

    const brought = await call("POST", `/projects/${pid}/integrations/autodesk/${cid}/records/bring`, { records: [{ kind: "issue", externalId: "iss-7" }] });
    expect(brought.json()).toEqual({ brought: 1 });
    const after = (await call("GET", `/projects/${pid}/integrations/autodesk/${cid}/records/issue`)).json();
    expect(after.records.find((r: { externalId: string }) => r.externalId === "iss-7").native).toMatchObject({ type: "issue" });
    // Only the chosen one came.
    expect(after.records.find((r: { externalId: string }) => r.externalId === "iss-8").native).toBeNull();
    expect((await call("GET", `/projects/${pid}/integrations/autodesk/${cid}/records/bogus`)).statusCode).toBe(400);
  });
  it("stops a record sync cancelled before it reaches ACC", async () => {
    await handle.db.update(autodeskConnections).set({ status: "ready", externalHubId: null }).where(eq(autodeskConnections.id, cid));
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (String(input).endsWith("/project/v1/hubs")) await gate;
      return fakeAutodesk(input as string);
    });
    await call("POST", `/projects/${pid}/integrations/autodesk/${cid}/sync`);
    const drained = jobs.drain();
    await vi.waitFor(async () => expect((await call("GET", `/projects/${pid}/integrations/autodesk/${cid}/progress`)).json().run.status).toBe("running"));
    expect((await call("POST", `/projects/${pid}/integrations/autodesk/${cid}/sync/cancel`)).json()).toEqual({ cancelled: true });
    open();
    await drained;
    const { run } = (await call("GET", `/projects/${pid}/integrations/autodesk/${cid}/progress`)).json();
    expect(run.status).toBe("cancelled");
  });
});
