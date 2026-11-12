import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { hasCoordinate } from "../helpers/modules.js"; // clash tests are the Coordinate module's
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app/build-app.js";
import { hashPassword } from "../../src/core/security/auth.js";
import { openDb, type DbHandle } from "../../src/db/index.js";
import { users } from "../../src/db/schema.js";
import { JobQueue } from "../../src/jobs/queue.js";
import { LocalStorage } from "../../src/core/platform/storage.js";
import { parseIds } from "../../src/coordination/ids.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (n: string) => readFileSync(path.join(here, "../fixtures", n));

const WALL1 = "3vB2YO$MX4xv5uCqZZG0A1";
const WALL2 = "3vB2YO$MX4xv5uCqZZG0A2";
const SLAB = "1pPHnf7cXCpPsNEnQf8_A3";
const DUCT = "2DuctAaaaaaaaaaaaaaaB1";
const PIPE = "2PipeAaaaaaaaaaaaaaaB2";
const TRAY = "2TrayAaaaaaaaaaaaaaaB3";
const RING = "2RingAaaaaaaaaaaaaaaR1";
const NICK = "2NickAaaaaaaaaaaaaaaR2";
const HOLE = "2HoleAaaaaaaaaaaaaaaR3";

const IDS = `<?xml version="1.0" encoding="UTF-8"?>
<ids xmlns="http://standards.buildingsmart.org/IDS" xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <info><title>ZAVM bilgi gereksinimleri</title></info>
  <specifications>
    <specification name="Duvar yangın dayanımı" ifcVersion="IFC2X3 IFC4">
      <applicability minOccurs="1" maxOccurs="unbounded">
        <entity><name><simpleValue>IFCWALL</simpleValue></name></entity>
      </applicability>
      <requirements>
        <property dataType="IFCLABEL" cardinality="required">
          <propertySet><simpleValue>Pset_WallCommon</simpleValue></propertySet>
          <baseName><simpleValue>FireRating</simpleValue></baseName>
          <value><xs:restriction base="xs:string"><xs:enumeration value="REI60"/><xs:enumeration value="REI90"/></xs:restriction></value>
        </property>
      </requirements>
    </specification>
    <specification name="Duvar adı" ifcVersion="IFC4">
      <applicability><entity><name><simpleValue>IFCWALL</simpleValue></name></entity></applicability>
      <requirements>
        <attribute cardinality="required">
          <name><simpleValue>Name</simpleValue></name>
          <value><xs:restriction><xs:pattern value="Duvar-\\d{2}"/></xs:restriction></value>
        </attribute>
      </requirements>
    </specification>
    <specification name="Döşeme dış mı" ifcVersion="IFC4">
      <applicability><entity><name><simpleValue>IFCSLAB</simpleValue></name></entity></applicability>
      <requirements>
        <property cardinality="required">
          <propertySet><simpleValue>Pset_SlabCommon</simpleValue></propertySet>
          <baseName><simpleValue>IsExternal</simpleValue></baseName>
        </property>
        <material cardinality="required"/>
      </requirements>
    </specification>
    <specification name="Dış duvarlar" ifcVersion="IFC4">
      <applicability>
        <entity><name><simpleValue>IFCWALL</simpleValue></name></entity>
        <property><propertySet><simpleValue>Pset_WallCommon</simpleValue></propertySet><baseName><simpleValue>IsExternal</simpleValue></baseName><value><simpleValue>true</simpleValue></value></property>
      </applicability>
      <requirements>
        <attribute cardinality="prohibited"><name><simpleValue>Description</simpleValue></name></attribute>
      </requirements>
    </specification>
    <specification name="Kapı yok" ifcVersion="IFC4">
      <applicability minOccurs="1"><entity><name><simpleValue>IFCDOOR</simpleValue></name></entity></applicability>
      <requirements/>
    </specification>
  </specifications>
</ids>`;

let handle: DbHandle;
let app: FastifyInstance;
let jobs: JobQueue;
let dataDir: string;
const PW = "Sifre-1234567";

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), "7dcde-coord-"));
  handle = await openDb("memory://");
  const storage = new LocalStorage(path.join(dataDir, "storage"));
  jobs = new JobQueue(handle.db, storage);
  app = await buildApp({ db: handle.db, storage, jobs });
  await handle.db
    .insert(users)
    .values({ email: "admin@7d.test", name: "Admin", passwordHash: await hashPassword(PW), isAdmin: true });
});

afterAll(async () => {
  await app.close();
  await handle.close();
  rmSync(dataDir, { recursive: true, force: true });
});

async function login(email: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: PW } });
  expect(res.statusCode, res.body).toBe(200);
  return `cde_session=${res.cookies.find((c) => c.name === "cde_session")!.value}`;
}

function api(cookie: string) {
  const call = async (method: string, url: string, payload?: unknown) => {
    const res = await app.inject({ method: method as "GET", url: `/api/v1${url}`, headers: { cookie }, payload: payload as object });
    let body: any = null;
    try {
      body = res.body ? res.json() : null;
    } catch {
      body = res.body;
    }
    return { status: res.statusCode, body, raw: res };
  };
  return {
    get: (u: string) => call("GET", u),
    post: (u: string, p?: unknown) => call("POST", u, p ?? {}),
    patch: (u: string, p: unknown) => call("PATCH", u, p),
    put: (u: string, p: unknown) => call("PUT", u, p),
    del: (u: string) => call("DELETE", u),
    upload: async (url: string, list: { name: string; data: Buffer | string }[]) => {
      const form = new FormData();
      for (const f of list) form.append("file", new Blob([f.data]), f.name);
      const req = new Request("http://x", { method: "POST", body: form });
      const res = await app.inject({
        method: "POST",
        url: `/api/v1${url}`,
        headers: { cookie, "content-type": req.headers.get("content-type")! },
        payload: Buffer.from(await req.arrayBuffer()),
      });
      return { status: res.statusCode, body: res.json() };
    },
  };
}

describe("IDS subset parser", () => {
  it("reads entity, attribute and property facets and flags unsupported ones", () => {
    const doc = parseIds(IDS);
    expect(doc.title).toBe("ZAVM bilgi gereksinimleri");
    expect(doc.specs).toHaveLength(5);
    expect(doc.specs[0]).toMatchObject({ name: "Duvar yangın dayanımı", ifcVersions: ["IFC2X3", "IFC4"], minOccurs: 1 });
    expect(doc.specs[0]!.requirements[0]).toMatchObject({ kind: "property", dataType: "IFCLABEL", value: { enumeration: ["REI60", "REI90"] } });
    expect(doc.specs[2]!.unsupported).toEqual(["gereksinim: malzeme"]);
    expect(() => parseIds("<foo/>")).toThrow(/IDS/);
    expect(() => parseIds("<ids><specifications>")).toThrow();
  });
});

describe("model coordination", () => {
  let admin: ReturnType<typeof api>;
  let semih: ReturnType<typeof api>; // view only, no company assignment
  let murat: ReturnType<typeof api>; // view, member of the MEP company
  let osman: ReturnType<typeof api>; // member without folder access
  let projectId: string;
  let folderId: string;
  let mepCompanyId: string;
  const file: Record<string, string> = {};
  const version: Record<string, string> = {};
  let setId: string;
  let hardId: string;
  let clearId: string;
  let hardClashId: string;
  let groupId: string;

  async function upload(name: string, data: Buffer | string) {
    const up = await admin.upload(`/projects/${projectId}/folders/${folderId}/files`, [{ name, data }]);
    expect(up.status, JSON.stringify(up.body)).toBe(200);
    const id = up.body.results[0].fileId as string;
    const f = await admin.get(`/projects/${projectId}/files/${id}`);
    return { fileId: id, versionId: f.body.latest.id as string };
  }

  async function runTest(testId: string, who = admin) {
    const r = await who.post(`/projects/${projectId}/clash-tests/${testId}/run`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.status).toBe("queued");
    const t0 = Date.now();
    await jobs.drain();
    const ms = Date.now() - t0;
    const runs = await who.get(`/projects/${projectId}/clash-tests/${testId}/runs`);
    return { run: runs.body[0], ms };
  }

  it("sets up users, permissions and two intersecting IFC models", async () => {
    admin = api(await login("admin@7d.test"));
    mepCompanyId = (await admin.post("/companies", { name: "Mekanik A.Ş." })).body.id;
    const ids: Record<string, string> = {};
    for (const [key, name, companyId] of [
      ["semih", "Semih", null],
      ["murat", "Murat", mepCompanyId],
      ["osman", "Osman", null],
    ] as const) {
      const u = await admin.post("/users", { email: `${key}@7d.test`, name, password: PW, companyId });
      expect(u.status, JSON.stringify(u.body)).toBe(200);
      ids[key] = u.body.id;
    }
    const p = await admin.post("/projects", { code: "KRD", name: "Koordinasyon" });
    projectId = p.body.id;
    const contents = await admin.get(`/projects/${projectId}/folders/${p.body.rootFolderId}/contents`);
    folderId = (await admin.post(`/projects/${projectId}/folders`, { parentId: contents.body.folders[0].id, name: "Modeller" })).body.id;
    for (const key of ["semih", "murat", "osman"])
      expect((await admin.post(`/projects/${projectId}/members`, { email: `${key}@7d.test` })).status).toBe(200);
    const perms = await admin.put(`/projects/${projectId}/folders/${folderId}/permissions`, {
      entries: [
        { subjectType: "user", subjectId: ids.semih, level: "view" },
        { subjectType: "user", subjectId: ids.murat, level: "view" },
      ],
    });
    expect(perms.status).toBe(200);
    semih = api(await login("semih@7d.test"));
    murat = api(await login("murat@7d.test"));
    osman = api(await login("osman@7d.test"));

    const arch = await upload("ARC-Model.ifc", fixture("coord-arch.ifc"));
    const mep = await upload("MEP-Model.ifc", fixture("coord-mep.ifc"));
    const ids2 = await upload("ZAVM-Gereksinimler.ids", IDS);
    file.arch = arch.fileId;
    file.mep = mep.fileId;
    file.ids = ids2.fileId;
    version.arch = arch.versionId;
    version.mep = mep.versionId;
    version.ids = ids2.versionId;
    await jobs.drain();
  });

  it("creates model sets with latest / pinned versions and saved views", async () => {
    // Members without access to the files cannot build a set from them.
    expect(
      (await osman.post(`/projects/${projectId}/model-sets`, { name: "X", items: [{ fileId: file.arch, versionId: null }] })).status,
    ).toBe(404);
    // Only IFC files.
    expect(
      (await admin.post(`/projects/${projectId}/model-sets`, { name: "X", items: [{ fileId: file.ids, versionId: null }] })).status,
    ).toBe(400);
    const res = await admin.post(`/projects/${projectId}/model-sets`, {
      name: "Federasyon",
      items: [
        { fileId: file.arch, versionId: version.arch },
        { fileId: file.mep, versionId: null },
      ],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    setId = res.body.id;
    expect(res.body.items).toMatchObject([
      { fileId: file.arch, versionId: version.arch, resolvedVersionId: version.arch, fileName: "ARC-Model.ifc" },
      { fileId: file.mep, versionId: null, resolvedVersionId: version.mep, resolvedVersion: 1 },
    ]);
    // A pinned version must belong to the file.
    expect(
      (await admin.patch(`/projects/${projectId}/model-sets/${setId}`, { items: [{ fileId: file.arch, versionId: version.mep }] })).status,
    ).toBe(400);

    const view = await semih.post(`/projects/${projectId}/model-sets/${setId}/views`, {
      name: "Mekanik kırmızı",
      state: {
        camera: { position: [10, 10, 10], target: [2, 1, 0], projection: "perspective" },
        hiddenFileIds: [],
        rules: [{ classes: ["IfcDuctSegment"], action: "color", color: "#d92d20" }, { classes: ["IfcSlab"], action: "hide" }],
        sections: { planes: [{ origin: [0, 2, 0], normal: [0, 1, 0], enabled: false }] },
        measurements: [{ kind: "angle", points: [[1, 0, 0], [0, 0, 0], [0, 0, 1]], value: 90 }],
      },
    });
    expect(view.status, JSON.stringify(view.body)).toBe(200);
    expect(view.body.state.sections.planes[0].enabled).toBe(false);
    expect(view.body.state.measurements[0].value).toBe(90);
    const set = await semih.get(`/projects/${projectId}/model-sets/${setId}`);
    expect(set.body.views).toHaveLength(1);
    expect(set.body.canEdit).toBe(false);
    expect((await semih.patch(`/projects/${projectId}/model-sets/${setId}`, { name: "Y" })).status).toBe(403);
    // Osman sees the set but not the files in it.
    const hidden = await osman.get(`/projects/${projectId}/model-sets/${setId}`);
    expect(hidden.body.items.every((i: { hidden?: boolean; fileName: string | null }) => i.hidden && i.fileName === null)).toBe(true);
  });

  it.skipIf(!hasCoordinate)("finds the hard clash between the wall and the duct, not touching elements", async () => {
    const res = await admin.post(`/projects/${projectId}/clash-tests`, {
      name: "Mimari × Mekanik (sert)",
      modelSetId: setId,
      selectionA: { fileIds: [file.arch], classes: ["IfcWall", "IfcSlab"] },
      selectionB: { fileIds: [file.mep], classes: [] },
      type: "hard",
      toleranceMm: 0,
      groupBy: "elementA",
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    hardId = res.body.id;
    // Selections must use files of the set.
    expect(
      (await admin.post(`/projects/${projectId}/clash-tests`, { ...res.body, name: "Z", selectionA: { fileIds: [file.ids], classes: [] } })).status,
    ).toBe(400);

    const { run, ms } = await runTest(hardId);
    expect(run.status, run.error).toBe("done");
    expect(run.stats).toMatchObject({ elementsA: 3, elementsB: 3, clashes: 1, new: 1, active: 0, resolved: 0 });
    console.log(`[perf] hard clash run on fixtures: ${ms} ms total, worker timings ${JSON.stringify(run.stats.timings)}, ${run.stats.triangles} triangles`);
    expect(run.versions.map((v: { versionId: string }) => v.versionId).sort()).toEqual([version.arch, version.mep].sort());

    const results = await admin.get(`/projects/${projectId}/clash-tests/${hardId}/results`);
    expect(results.status).toBe(200);
    expect(results.body.clashes).toHaveLength(1);
    const c = results.body.clashes[0];
    expect(c).toMatchObject({
      a: { globalId: WALL1, ifcClass: "IfcWall", name: "Duvar-01", storey: "Zemin Kat", versionId: version.arch },
      b: { globalId: DUCT, ifcClass: "IfcDuctSegment", system: "Havalandirma", versionId: version.mep },
      status: "new",
    });
    expect(c.distance).toBeCloseTo(-0.2, 3); // wall thickness = penetration
    expect(c.point[0]).toBeCloseTo(2.5, 3);
    expect(c.point[1]).toBeCloseTo(0.1, 3);
    expect(c.point[2]).toBeCloseTo(1.5, 3);
    hardClashId = c.id;
    expect(results.body.groups).toHaveLength(1);
    expect(results.body.groups[0]).toMatchObject({ title: "IfcWall Duvar-01", counts: { new: 1 } });
    groupId = results.body.groups[0].id;
    expect(results.body.byClassPair).toEqual([{ pair: "IfcWall × IfcDuctSegment", counts: { new: 1, active: 0, resolved: 0, approved: 0 } }]);

    // Same file, walls standing on the slab: touching is not a clash.
    const self = await admin.post(`/projects/${projectId}/clash-tests`, {
      name: "Duvar × Döşeme",
      modelSetId: setId,
      selectionA: { fileIds: [file.arch], classes: ["IfcWall"] },
      selectionB: { fileIds: [file.arch], classes: ["IfcSlab"] },
    });
    const selfRun = await runTest(self.body.id);
    expect(selfRun.run.stats).toMatchObject({ elementsA: 2, elementsB: 1, clashes: 0 });
  });

  it.skipIf(!hasCoordinate)("keeps clash ids stable across re-runs and carries the status", async () => {
    const { run } = await runTest(hardId);
    expect(run.stats).toMatchObject({ clashes: 1, new: 0, active: 1 });
    const results = await admin.get(`/projects/${projectId}/clash-tests/${hardId}/results`);
    expect(results.body.clashes.map((c: { id: string }) => c.id)).toEqual([hardClashId]);
    expect(results.body.clashes[0].status).toBe("active");
    expect(results.body.groups[0].id).toBe(groupId);
    // A running test cannot be queued twice.
    expect((await admin.post(`/projects/${projectId}/clash-tests/${hardId}/run`)).status).toBe(200);
    expect((await admin.post(`/projects/${projectId}/clash-tests/${hardId}/run`)).status).toBe(409);
    await jobs.drain();
  });

  it.skipIf(!hasCoordinate)("measures clearance (30 mm pipe, touching tray) with the tolerance", async () => {
    const res = await admin.post(`/projects/${projectId}/clash-tests`, {
      name: "Boşluk 50 mm",
      modelSetId: setId,
      selectionA: { fileIds: [file.arch], classes: ["IfcWall"] },
      selectionB: { fileIds: [file.mep], classes: [] },
      type: "clearance",
      toleranceMm: 50,
      groupBy: "classPair",
    });
    clearId = res.body.id;
    const { run } = await runTest(clearId);
    expect(run.status, run.error).toBe("done");
    const r = await admin.get(`/projects/${projectId}/clash-tests/${clearId}/results`);
    const byGuid = Object.fromEntries(r.body.clashes.map((c: { b: { globalId: string }; distance: number }) => [c.b.globalId, c.distance]));
    expect(Object.keys(byGuid).sort()).toEqual([DUCT, PIPE, TRAY].sort());
    expect(byGuid[PIPE]).toBeCloseTo(0.03, 4);
    expect(byGuid[TRAY]).toBeCloseTo(0, 6);
    expect(byGuid[DUCT]).toBeLessThan(0);
    expect(r.body.groups.map((g: { title: string }) => g.title).sort()).toEqual([
      "IfcWall × IfcCableCarrierSegment",
      "IfcWall × IfcDuctSegment",
      "IfcWall × IfcPipeSegment",
    ]);

    // 20 mm: the pipe (30 mm away) is fine now and becomes resolved.
    expect((await admin.patch(`/projects/${projectId}/clash-tests/${clearId}`, { toleranceMm: 20 })).status).toBe(200);
    const second = await runTest(clearId);
    expect(second.run.stats).toMatchObject({ clashes: 2, resolved: 1 });
    const r2 = await admin.get(`/projects/${projectId}/clash-tests/${clearId}/results`);
    const pipe = r2.body.clashes.find((c: { b: { globalId: string } }) => c.b.globalId === PIPE);
    expect(pipe.status).toBe("resolved");
    expect(pipe.id).toBe(byGuidId(r.body.clashes, PIPE));

    // Property filter: only walls with FireRating REI60 (Duvar-01).
    const prop = await admin.post(`/projects/${projectId}/clash-tests`, {
      name: "REI60 duvarlar",
      modelSetId: setId,
      selectionA: { fileIds: [file.arch], classes: ["ifcwall"], property: { pset: "Pset_WallCommon", name: "FireRating", value: "REI60" } },
      selectionB: { fileIds: [file.mep], classes: ["IfcDuctSegment"] },
    });
    const pr = await runTest(prop.body.id);
    expect(pr.run.stats).toMatchObject({ elementsA: 1, elementsB: 1, clashes: 1 });
  });

  it.skipIf(!hasCoordinate)("enforces who may change status, assign and see results", async () => {
    const url = `/projects/${projectId}/clash-tests/${hardId}`;
    expect((await osman.get(`${url}/results`)).status).toBe(404);
    expect((await osman.get(`/projects/${projectId}/clash-tests`)).body).toEqual([]);
    expect((await semih.get(`${url}/results`)).status).toBe(200);
    expect((await semih.patch(`${url}/clashes/${hardClashId}`, { status: "resolved" })).status).toBe(403);
    expect((await semih.patch(`${url}/groups/${groupId}`, { assignedCompanyId: mepCompanyId })).status).toBe(403);
    expect((await semih.post(`${url}/run`)).status).toBe(200); // viewers may re-run
    await jobs.drain();
    expect((await semih.del(url)).status).toBe(403);

    const assign = await admin.patch(`${url}/groups/${groupId}`, { assignedCompanyId: mepCompanyId });
    expect(assign.status).toBe(200);
    expect(assign.body).toMatchObject({ assignedCompanyName: "Mekanik A.Ş." });
    // The assigned company may mark its clashes, but approving is the coordinator's call.
    expect((await murat.patch(`${url}/clashes/${hardClashId}`, { status: "approved" })).status).toBe(403);
    const marked = await murat.patch(`${url}/clashes/${hardClashId}`, { status: "active" });
    expect(marked.status).toBe(200);
    expect((await murat.patch(`${url}/clashes/${hardClashId}`, { status: "new" })).status).toBe(400);
    const detail = await semih.get(`${url}/clashes/${hardClashId}`);
    expect(detail.body).toMatchObject({ id: hardClashId, group: { id: groupId, assignedCompanyId: mepCompanyId }, test: { canManage: false } });
  });

  it.skipIf(!hasCoordinate)("creates an issue from a clash group and links it", async () => {
    const url = `/projects/${projectId}/clash-tests/${hardId}/groups/${groupId}/issue`;
    const res = await semih.post(url, { priority: "high" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.title).toBe("Çakışma: IfcWall Duvar-01");
    const issue = await admin.get(`/projects/${projectId}/issues/${res.body.issueId}`);
    expect(issue.body).toMatchObject({ type: "Koordinasyon", priority: "high", assigneeCompanyId: mepCompanyId });
    expect(issue.body.viewpoint.selection.sort()).toEqual([DUCT, WALL1].sort());
    expect(issue.body.viewpoint.fileVersionIds.sort()).toEqual([version.arch, version.mep].sort());
    expect(issue.body.description).toContain("Duvar-01");
    const links = await semih.get(`/projects/${projectId}/issues/${res.body.issueId}/links`);
    expect(links.body).toHaveLength(1);
    expect(links.body[0]).toMatchObject({ kind: "clash_group", targetId: groupId, target: { clashTestId: hardId, fileName: "ARC-Model.ifc" } });
    expect((await osman.get(`/projects/${projectId}/issues/${res.body.issueId}/links`)).body).toEqual([]);
    expect((await semih.post(url, {})).status).toBe(409);
    const results = await admin.get(`/projects/${projectId}/clash-tests/${hardId}/results`);
    expect(results.body.groups[0]).toMatchObject({ issueId: res.body.issueId, issueNumber: res.body.number });
  });

  it.skipIf(!hasCoordinate)("marks the clash resolved when the duct is removed in a new version", async () => {
    const up = await admin.upload(`/projects/${projectId}/folders/${folderId}/files`, [{ name: "MEP-Model.ifc", data: fixture("coord-mep-v2.ifc") }]);
    expect(up.body.results[0].version).toBe(2);
    await jobs.drain();
    const set = await admin.get(`/projects/${projectId}/model-sets/${setId}`);
    expect(set.body.items[1]).toMatchObject({ versionId: null, resolvedVersion: 2 });
    const { run } = await runTest(hardId);
    expect(run.stats).toMatchObject({ clashes: 0, resolved: 1 });
    const results = await admin.get(`/projects/${projectId}/clash-tests/${hardId}/results`);
    expect(results.body.clashes).toHaveLength(1);
    expect(results.body.clashes[0]).toMatchObject({ id: hardClashId, status: "resolved" });
    expect(results.body.test.counts).toEqual({ new: 0, active: 0, resolved: 1, approved: 0 });
    // The group (with its issue and assignment) stays.
    expect(results.body.groups[0]).toMatchObject({ id: groupId, counts: { resolved: 1 } });
  });

  it.skipIf(!hasCoordinate)("summarises statistics deterministically when no AI provider is configured", async () => {
    const res = await semih.post(`/projects/${projectId}/clash-tests/${clearId}/summary`);
    expect(res.status).toBe(200);
    expect(res.body.source).toBe("deterministic");
    expect(res.body.stats.totals).toEqual({ new: 0, active: 2, resolved: 1, approved: 0 });
    expect(res.body.stats.byClassPair[0].pair).toMatch(/^IfcWall × /);
    expect(res.body.summary).toContain("«Boşluk 50 mm»");
    expect(res.body.summary).toContain("2 açık");
  });

  it.skipIf(!hasCoordinate)("fails a run with a clear message when limits are exceeded", async () => {
    process.env.CLASH_MAX_ELEMENTS = "1";
    try {
      const { run } = await runTest(clearId);
      expect(run.status).toBe("failed");
      expect(run.error).toMatch(/çok fazla eleman/);
    } finally {
      delete process.env.CLASH_MAX_ELEMENTS;
    }
    // Earlier results are untouched by the failed run.
    const r = await admin.get(`/projects/${projectId}/clash-tests/${clearId}/results`);
    expect(r.body.clashes).toHaveLength(3);
  });

  it("checks an IFC version against an IDS file and exports the report", async () => {
    expect((await admin.post(`/projects/${projectId}/ids-reports`, { idsVersionId: version.arch, ifcVersionId: version.arch })).status).toBe(400);
    expect((await osman.post(`/projects/${projectId}/ids-reports`, { idsVersionId: version.ids, ifcVersionId: version.arch })).status).toBe(404);
    const res = await semih.post(`/projects/${projectId}/ids-reports`, { idsVersionId: version.ids, ifcVersionId: version.arch });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.status).toBe("queued");
    const t0 = Date.now();
    await jobs.drain();
    console.log(`[perf] IDS check on fixture: ${Date.now() - t0} ms`);
    const rep = await semih.get(`/projects/${projectId}/ids-reports/${res.body.id}`);
    expect(rep.body.status, rep.body.error).toBe("done");
    expect(rep.body.title).toBe("ZAVM bilgi gereksinimleri");
    const spec = (name: string) => rep.body.specs.find((s: { name: string }) => s.name === name);
    expect(spec("Duvar yangın dayanımı")).toMatchObject({ status: "fail", applicable: 2, passed: 1, failed: 1 });
    expect(spec("Duvar yangın dayanımı").failures[0]).toMatchObject({ globalId: WALL2, ifcClass: "IFCWALL", name: "Duvar-02" });
    expect(spec("Duvar yangın dayanımı").failures[0].reasons[0]).toMatch(/FireRating/);
    expect(spec("Duvar adı")).toMatchObject({ status: "pass", applicable: 2, passed: 2 });
    expect(spec("Döşeme dış mı")).toMatchObject({ status: "fail", applicable: 1, failed: 1 });
    expect(spec("Döşeme dış mı").failures[0].globalId).toBe(SLAB);
    expect(spec("Döşeme dış mı").note).toMatch(/malzeme/);
    expect(spec("Dış duvarlar")).toMatchObject({ status: "pass", applicable: 1 });
    expect(spec("Kapı yok")).toMatchObject({ status: "fail", applicable: 0 });
    expect(rep.body.totals).toMatchObject({ specs: 5, passed: 2, failed: 3, skipped: 0 });

    const csv = await semih.get(`/projects/${projectId}/ids-reports/${res.body.id}/csv`);
    expect(csv.status).toBe(200);
    expect(String(csv.raw.headers["content-type"])).toMatch(/text\/csv/);
    expect(csv.raw.body).toContain(WALL2);
    expect(csv.raw.body).toContain("Kaldı");
    expect((await osman.get(`/projects/${projectId}/ids-reports/${res.body.id}`)).status).toBe(404);
    const list = await semih.get(`/projects/${projectId}/ids-reports`);
    expect(list.body.map((r: { id: string }) => r.id)).toEqual([res.body.id]);
    expect((await osman.get(`/projects/${projectId}/ids-reports`)).body).toEqual([]);
  });

  it.skipIf(!hasCoordinate)("reports a 5 mm nick into a ring and ignores the wall standing in the hole", async () => {
    const ring = await upload("Halka.ifc", fixture("coord-ring.ifc"));
    const set = await admin.post(`/projects/${projectId}/model-sets`, {
      name: "Halka",
      items: [{ fileId: ring.fileId, versionId: ring.versionId }],
    });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    const created = await admin.post(`/projects/${projectId}/clash-tests`, {
      name: "Halka kendi içinde",
      modelSetId: set.body.id,
      selectionA: { fileIds: [ring.fileId], classes: [] },
      selectionB: { fileIds: [ring.fileId], classes: [] },
      type: "hard",
      toleranceMm: 0,
      groupBy: "elementA",
    });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const { run } = await runTest(created.body.id);
    expect(run.status, run.error).toBe("done");
    expect(run.stats).toMatchObject({ elementsA: 3, elementsB: 3, clashes: 1 });
    const results = await admin.get(`/projects/${projectId}/clash-tests/${created.body.id}/results`);
    expect(results.body.clashes).toHaveLength(1);
    const c = results.body.clashes[0];
    expect([c.a.globalId, c.b.globalId].sort()).toEqual([NICK, RING].sort());
    expect(c.distance).toBeCloseTo(-0.005, 3);
    expect(c.distance).toBeGreaterThan(-0.02);
    expect(results.body.clashes.some((x: { a: { globalId: string }; b: { globalId: string } }) => x.a.globalId === HOLE || x.b.globalId === HOLE)).toBe(false);
  });

  it.skipIf(!hasCoordinate)("protects model sets that tests use", async () => {
    expect((await admin.del(`/projects/${projectId}/model-sets/${setId}`)).status).toBe(409);
    expect((await admin.patch(`/projects/${projectId}/model-sets/${setId}`, { items: [{ fileId: file.mep, versionId: null }] })).status).toBe(409);
  });
});

function byGuidId(list: { id: string; b: { globalId: string } }[], guid: string) {
  return list.find((c) => c.b.globalId === guid)!.id;
}
