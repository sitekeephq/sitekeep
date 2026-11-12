import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync } from "node:zlib";
import JSZip from "jszip";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { rebaseViewpoint, type IssueViewpoint, type Vec3 } from "@sitekeep/shared";
import { cdeParseArgs, cdeResult, cdeToolDefinitions, type CdeCall } from "@sitekeep/cde-tools";
import { buildApp } from "../../src/app/build-app.js";
import { hashPassword } from "../../src/core/security/auth.js";
import { openDb, type DbHandle } from "../../src/db/index.js";
import { fileVersions, files, users } from "../../src/db/schema.js";
import { JobQueue } from "../../src/jobs/queue.js";
import { LocalStorage } from "../../src/core/platform/storage.js";
import { fragmentsOffset } from "../../src/bcf/frame.js";
import { sanitizeSnapshot } from "../../src/bcf/image.js";
import { BcfZipError, readBcfZip, BCF_ZIP_LIMITS } from "../../src/bcf/unzip.js";
import { loadSchema, validateXml } from "./xsd-lite.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (n: string) => readFileSync(path.join(here, "../fixtures", n));
const xsd = (v: "2.1" | "3.0", n: string) => loadSchema(path.join(here, "../fixtures", "bcf-xsd", v, `${n}.xsd`));
const SCHEMAS = {
  "2.1": { markup: xsd("2.1", "markup"), visinfo: xsd("2.1", "visinfo"), version: xsd("2.1", "version"), project: xsd("2.1", "project") },
  "3.0": {
    markup: xsd("3.0", "markup"),
    visinfo: xsd("3.0", "visinfo"),
    version: xsd("3.0", "version"),
    project: xsd("3.0", "project"),
    extensions: xsd("3.0", "extensions"),
  },
};

const PW = "Sifre-1234567";
const ARCH_GUID = "2SugUv4EX5LAhcVpDp2dUH"; // IfcProject of Architectural.ifc in the buildingSMART test cases
let handle: DbHandle;
let app: FastifyInstance;
let dataDir: string;
let storage: LocalStorage;

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), "7dcde-bcf-"));
  handle = await openDb("memory://");
  storage = new LocalStorage(path.join(dataDir, "storage"));
  const jobs = new JobQueue(handle.db, storage);
  app = await buildApp({ db: handle.db, storage, jobs });
  await handle.db.insert(users).values({ email: "admin@7d.test", name: "Admin", passwordHash: await hashPassword(PW), isAdmin: true });
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

type Res = { status: number; body: any; raw: Awaited<ReturnType<FastifyInstance["inject"]>> };

function client(auth: { cookie: string } | { token: string }) {
  const headers: Record<string, string> = "cookie" in auth ? { cookie: auth.cookie } : { authorization: `Bearer ${auth.token}` };
  const call = async (method: string, url: string, payload?: unknown): Promise<Res> => {
    const res = await app.inject({ method: method as "GET", url: `/api/v1${url}`, headers, payload: payload as object });
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
    /** Multipart upload of a .bcfzip (+ optional mapping field). */
    upload: async (url: string, data: Buffer, name = "test.bcfzip", mapping?: unknown): Promise<Res> => {
      const form = new FormData();
      if (mapping !== undefined) form.append("mapping", JSON.stringify(mapping));
      form.append("file", new Blob([data]), name);
      const req = new Request("http://x", { method: "POST", body: form });
      const res = await app.inject({
        method: "POST",
        url: `/api/v1${url}`,
        headers: { ...headers, "content-type": req.headers.get("content-type")! },
        payload: Buffer.from(await req.arrayBuffer()),
      });
      return { status: res.statusCode, body: res.body ? res.json() : null, raw: res };
    },
  };
}
type Client = ReturnType<typeof client>;

async function zipOf(entries: Record<string, string | Buffer>): Promise<Buffer> {
  const z = new JSZip();
  for (const [n, d] of Object.entries(entries)) z.file(n, d);
  return z.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

async function unzip(buf: Buffer): Promise<Map<string, Buffer>> {
  const z = await JSZip.loadAsync(buf);
  const out = new Map<string, Buffer>();
  for (const [n, f] of Object.entries(z.files)) if (!f.dir) out.set(n, await f.async("nodebuffer"));
  return out;
}

/** A small valid PNG (RGB 8-bit), optionally with extra (ancillary) chunks. */
function png(w = 4, h = 3, extra: { type: string; data: Buffer }[] = []): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc(h * (1 + w * 3), 0x7f);
  for (let y = 0; y < h; y++) raw[y * (1 + w * 3)] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    ...extra.map((e) => chunk(e.type, e.data)),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** A structurally valid JPEG (SOI, APP1 Exif, DQT, SOF0, DHT, SOS + data, EOI). */
function jpeg(): Buffer {
  const seg = (marker: number, body: Buffer) => {
    const head = Buffer.from([0xff, marker, 0, 0]);
    head.writeUInt16BE(body.length + 2, 2);
    return Buffer.concat([head, body]);
  };
  const sof = Buffer.from([8, 0, 2, 0, 3, 1, 1, 0x11, 0]);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    seg(0xe1, Buffer.from("Exif\0\0GPS-secret")),
    seg(0xdb, Buffer.alloc(65, 1)),
    seg(0xc0, sof),
    seg(0xc4, Buffer.alloc(20, 0)),
    seg(0xfe, Buffer.from("yorum")),
    seg(0xda, Buffer.from([1, 1, 0, 0, 0x3f, 0])),
    Buffer.from([0x12, 0x34, 0xff, 0x00, 0x56, 0xff, 0xd0, 0x78]),
    Buffer.from([0xff, 0xd9]),
  ]);
}

const T21 = "6f8a1d10-0b6e-4c7a-9a43-0d5a8b8f0a01";
const T21_VP1 = "1a2b3c4d-0000-4000-8000-000000000001";
const T21_VP2 = "1a2b3c4d-0000-4000-8000-000000000002";
const T21_C1 = "2c000000-0000-4000-8000-000000000001";

function markup21(o: { modified?: string; comments?: { guid: string; text: string; author: string; vp?: string }[] } = {}) {
  const comments = (o.comments ?? [{ guid: T21_C1, text: "Kanal kirişle çakışıyor", author: "mehmet@baska.test", vp: T21_VP1 }])
    .map(
      (c) => `<Comment Guid="${c.guid}"><Date>2026-09-01T10:00:00Z</Date><Author>${c.author}</Author><Comment>${c.text}</Comment>${c.vp ? `<Viewpoint Guid="${c.vp}"/>` : ""}</Comment>`,
    )
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<Markup>
  <Header><File IfcProject="${ARCH_GUID}" isExternal="true"><Filename>Architectural.ifc</Filename><Date>2026-08-01T00:00:00Z</Date></File></Header>
  <Topic Guid="${T21}" TopicType="Clash" TopicStatus="Active">
    <ReferenceLink>https://example.test/a</ReferenceLink>
    <Title>Kanal &amp; kiriş çakışması</Title>
    <Priority>Major</Priority>
    <Labels>Mekanik</Labels><Labels>Kat 2</Labels>
    <CreationDate>2026-09-01T09:00:00Z</CreationDate>
    <CreationAuthor>mehmet@baska.test</CreationAuthor>
    <ModifiedDate>${o.modified ?? "2026-09-01T11:00:00Z"}</ModifiedDate>
    <DueDate>2026-10-20T00:00:00+03:00</DueDate>
    <AssignedTo>AYSE@7d.test</AssignedTo>
    <Stage>Uygulama</Stage>
    <Description>Kat 2 aksında.</Description>
    <RelatedTopic Guid="0BC2B000-0000-4000-8000-0000000000AA"/>
  </Topic>
  ${comments}
  <Viewpoints Guid="${T21_VP1}"><Viewpoint>viewpoint.bcfv</Viewpoint><Snapshot>snapshot.png</Snapshot></Viewpoints>
  <Viewpoints Guid="${T21_VP2}"><Viewpoint>${T21_VP2}.bcfv</Viewpoint><Snapshot>${T21_VP2}.jpg</Snapshot></Viewpoints>
</Markup>`;
}

const VIS21 = `<?xml version="1.0" encoding="UTF-8"?>
<VisualizationInfo Guid="${T21_VP1}">
  <Components>
    <ViewSetupHints SpacesVisible="false" SpaceBoundariesVisible="false" OpeningsVisible="false"/>
    <Selection><Component IfcGuid="3vB2YO$MX4xv5uCqZZG0A1"/></Selection>
    <Visibility DefaultVisibility="true"><Exceptions><Component IfcGuid="1pPHnf7cXCpPsNEnQf8_A3"/></Exceptions></Visibility>
    <Coloring><Color Color="FF0000"><Component IfcGuid="3vB2YO$MX4xv5uCqZZG0A1"/></Color></Coloring>
  </Components>
  <PerspectiveCamera>
    <CameraViewPoint><X>10</X><Y>-20</Y><Z>5</Z></CameraViewPoint>
    <CameraDirection><X>0</X><Y>1</Y><Z>0</Z></CameraDirection>
    <CameraUpVector><X>0</X><Y>0</Y><Z>1</Z></CameraUpVector>
    <FieldOfView>50</FieldOfView>
  </PerspectiveCamera>
  <ClippingPlanes><ClippingPlane><Location><X>0</X><Y>0</Y><Z>3</Z></Location><Direction><X>0</X><Y>0</Y><Z>1</Z></Direction></ClippingPlane></ClippingPlanes>
</VisualizationInfo>`;

const VIS21_B = VIS21.replace(T21_VP1, T21_VP2).replace("<FieldOfView>50</FieldOfView>", "<FieldOfView>60</FieldOfView>");

async function sample21(o: Parameters<typeof markup21>[0] = {}) {
  return zipOf({
    "bcf.version": `<?xml version="1.0"?><Version VersionId="2.1"><DetailedVersion>2.1</DetailedVersion></Version>`,
    [`${T21}/markup.bcf`]: markup21(o),
    [`${T21}/viewpoint.bcfv`]: VIS21,
    [`${T21}/snapshot.png`]: png(4, 3, [{ type: "tEXt", data: Buffer.from("Comment\0gizli") }]),
    [`${T21}/${T21_VP2}.bcfv`]: VIS21_B,
    [`${T21}/${T21_VP2}.jpg`]: jpeg(),
    [`${T21}/model.ifc`]: "ISO-10303-21;",
  });
}

const T30 = "a3f0c2d1-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const T30_VP = "b1c2d3e4-1111-4222-8333-944455556666";

async function sample30() {
  return zipOf({
    "bcf.version": `<?xml version="1.0"?><Version VersionId="3.0"/>`,
    "extensions.xml": `<?xml version="1.0"?><Extensions><TopicTypes><TopicType>Request</TopicType></TopicTypes></Extensions>`,
    "project.bcfp": `<?xml version="1.0"?><ProjectInfo><Project ProjectId="x"><Name>Dış Proje</Name></Project></ProjectInfo>`,
    [`${T30}/markup.bcf`]: `<?xml version="1.0"?>
<Markup>
  <Header><Files><File IsExternal="true"><Filename>Bilinmeyen.ifc</Filename></File></Files></Header>
  <Topic Guid="${T30}" ServerAssignedId="X-12" TopicType="Request" TopicStatus="In Progress">
    <ReferenceLinks><ReferenceLink>https://example.test/b</ReferenceLink></ReferenceLinks>
    <Title>Ortografik görünüm</Title>
    <Priority>Critical</Priority>
    <Labels><Label>Statik</Label></Labels>
    <CreationDate>2026-09-02T09:00:00Z</CreationDate>
    <CreationAuthor>admin@7d.test</CreationAuthor>
    <AssignedTo>kimse@baska.test</AssignedTo>
    <Comments>
      <Comment Guid="c3000000-0000-4000-8000-000000000001"><Date>2026-09-02T10:00:00Z</Date><Author>admin@7d.test</Author><Comment>İlk yorum</Comment></Comment>
      <Comment Guid="c3000000-0000-4000-8000-000000000002"><Date>2026-09-02T10:05:00Z</Date><Author>kimse@baska.test</Author><Viewpoint Guid="${T30_VP}"/></Comment>
    </Comments>
    <Viewpoints><ViewPoint Guid="${T30_VP}"><Viewpoint>${T30_VP}.bcfv</Viewpoint><Snapshot>${T30_VP}.png</Snapshot><Index>0</Index></ViewPoint></Viewpoints>
  </Topic>
</Markup>`,
    [`${T30}/${T30_VP}.bcfv`]: `<?xml version="1.0"?>
<VisualizationInfo Guid="${T30_VP}">
  <Components>
    <Visibility DefaultVisibility="false">
      <ViewSetupHints SpacesVisible="true"/>
      <Exceptions><Component IfcGuid="3vB2YO$MX4xv5uCqZZG0A1"/></Exceptions>
    </Visibility>
    <Coloring><Color Color="8000FF00"><Components><Component IfcGuid="3vB2YO$MX4xv5uCqZZG0A1"/></Components></Color></Coloring>
  </Components>
  <OrthogonalCamera>
    <CameraViewPoint><X>5</X><Y>5</Y><Z>40</Z></CameraViewPoint>
    <CameraDirection><X>0</X><Y>0</Y><Z>-1</Z></CameraDirection>
    <CameraUpVector><X>0</X><Y>1</Y><Z>0</Z></CameraUpVector>
    <ViewToWorldScale>25</ViewToWorldScale>
    <AspectRatio>1.5</AspectRatio>
  </OrthogonalCamera>
  <Lines><Line><StartPoint><X>0</X><Y>0</Y><Z>0</Z></StartPoint><EndPoint><X>1</X><Y>0</Y><Z>0</Z></EndPoint></Line></Lines>
  <ClippingPlanes>
    <ClippingPlane><Location><X>0</X><Y>0</Y><Z>0</Z></Location><Direction><X>-1</X><Y>0</Y><Z>0</Z></Direction></ClippingPlane>
    <ClippingPlane><Location><X>10</X><Y>0</Y><Z>0</Z></Location><Direction><X>1</X><Y>0</Y><Z>0</Z></Direction></ClippingPlane>
    <ClippingPlane><Location><X>0</X><Y>0</Y><Z>0</Z></Location><Direction><X>0</X><Y>-1</Y><Z>0</Z></Direction></ClippingPlane>
    <ClippingPlane><Location><X>0</X><Y>8</Y><Z>0</Z></Location><Direction><X>0</X><Y>1</Y><Z>0</Z></Direction></ClippingPlane>
    <ClippingPlane><Location><X>0</X><Y>0</Y><Z>0</Z></Location><Direction><X>0</X><Y>0</Y><Z>-1</Z></Direction></ClippingPlane>
    <ClippingPlane><Location><X>0</X><Y>0</Y><Z>6</Z></Location><Direction><X>0</X><Y>0</Y><Z>1</Z></Direction></ClippingPlane>
  </ClippingPlanes>
</VisualizationInfo>`,
    [`${T30}/${T30_VP}.png`]: png(2, 2),
  });
}

/** A Fragments-like FlatBuffer with Model.meshes.coordinates.position = p (deflated like the derivative). */
function fakeFragments(p: Vec3): Buffer {
  const b = Buffer.alloc(92);
  b.writeUInt32LE(24, 0); // root table
  b.writeUInt16LE(18, 4); // Model vtable: 7 slots
  b.writeUInt16LE(8, 6);
  b.writeUInt16LE(4, 8 + 2 * 6); // slot 6 (meshes) at table + 4
  b.writeInt32LE(24 - 4, 24);
  b.writeUInt32LE(40 - 28, 28); // → Meshes table
  b.writeUInt16LE(6, 32); // Meshes vtable: 1 slot
  b.writeUInt16LE(52, 34);
  b.writeUInt16LE(4, 36); // slot 0 (coordinates struct) at table + 4
  b.writeInt32LE(40 - 32, 40);
  b.writeDoubleLE(p[0], 44);
  b.writeDoubleLE(p[1], 52);
  b.writeDoubleLE(p[2], 60);
  return deflateSync(b);
}

describe("BCF .bcfzip import / export", () => {
  let admin: Client;
  let ayse: Client;
  let bora: Client;
  let outsider: Client;
  let adminId: string;
  let ayseId: string;
  let projectId: string;
  let otherProjectId: string;
  let archVersionId: string;
  let legacyVersionId: string;
  let issueId: string;

  beforeAll(async () => {
    admin = client({ cookie: await login("admin@7d.test") });
    adminId = (await handle.db.select().from(users).where(eq(users.email, "admin@7d.test")))[0]!.id;
    for (const [email, name] of [
      ["ayse@7d.test", "Ayşe"],
      ["bora@7d.test", "Bora"],
      ["yabanci@7d.test", "Yabancı"],
    ]) {
      const u = await admin.post("/users", { email, name, password: PW });
      expect(u.status, JSON.stringify(u.body)).toBe(200);
      if (email.startsWith("ayse")) ayseId = u.body.id;
    }
    const p = await admin.post("/projects", { code: "BCF", name: "BCF Deneme" });
    projectId = p.body.id;
    otherProjectId = (await admin.post("/projects", { code: "BCF2", name: "Hedef" })).body.id;
    for (const pid of [projectId, otherProjectId])
      for (const email of ["ayse@7d.test", "bora@7d.test"]) expect((await admin.post(`/projects/${pid}/members`, { email })).status).toBe(200);
    ayse = client({ cookie: await login("ayse@7d.test") });
    bora = client({ cookie: await login("bora@7d.test") });
    outsider = client({ cookie: await login("yabanci@7d.test") });

    // Two IFC models without running the converter: Architectural.ifc (IfcProject GUID known) and a
    // legacy one whose derivative carries a Fragments offset.
    const contents = await admin.get(`/projects/${projectId}/folders/${p.body.rootFolderId}/contents`);
    const folderId = contents.body.folders[0].id as string;
    const summary = { schema: "IFC4", projectName: "Mimari", elementCount: 2, byClass: { IfcWall: 2 } };
    const [f1] = await handle.db.insert(files).values({ projectId, folderId, name: "Architectural.ifc", createdBy: adminId }).returning();
    const [v1] = await handle.db
      .insert(fileVersions)
      .values({ fileId: f1!.id, version: 1, storageKey: "none", size: 1, sha256: "0", uploadedBy: adminId, ifcSummary: { ...summary, projectGuid: ARCH_GUID } })
      .returning();
    archVersionId = v1!.id;
    const stored = await storage.putBytes(fakeFragments([-100, -2, 50]), "derivatives");
    const [f2] = await handle.db.insert(files).values({ projectId, folderId, name: "Eski.ifc", createdBy: adminId }).returning();
    const [v2] = await handle.db
      .insert(fileVersions)
      .values({ fileId: f2!.id, version: 1, storageKey: "none", size: 1, sha256: "0", uploadedBy: adminId, ifcSummary: summary, derivativeStatus: "ready", derivativeKey: stored.key })
      .returning();
    legacyVersionId = v2!.id;
  });

  const sceneOffset: Vec3 = [-100, -2, 50];
  const nativeViewpoint = (): IssueViewpoint => ({
    camera: { position: [-90, 8, 70], target: [-100, 0, 50], projection: "perspective", up: [0, 1, 0], fov: 55, aspect: 1.5 },
    sceneOffset,
    fileVersionIds: [archVersionId],
    selection: ["3vB2YO$MX4xv5uCqZZG0A1"],
    snapshot: `data:image/png;base64,${png(2, 2).toString("base64")}`,
    visibility: { defaultVisible: true, exceptions: ["1pPHnf7cXCpPsNEnQf8_A3"] },
    coloring: [{ color: "FF8800", guids: ["3vB2YO$MX4xv5uCqZZG0A1"] }],
    sections: { planes: [{ origin: [-100, 1, 50], normal: [0, 1, 0] }], box: { min: [-110, -2, 40], max: [-90, 6, 60] } },
    measurements: [{ kind: "length", points: [[-100, 0, 50], [-95, 0, 50]], value: 5 }],
  });

  it("creates issues with a BCF GUID, labels, stage and viewpoint GUID", async () => {
    const c = await ayse.post(`/projects/${projectId}/issues`, {
      title: "Döşeme boşluğu",
      description: "Şaft yeri",
      priority: "high",
      type: "Koordinasyon",
      dueDate: "2026-11-05",
      labels: ["Mimari", "Kat 3"],
      stage: "Proje",
      viewpoint: nativeViewpoint(),
      pin: { position: [-98, 0, 52] },
    });
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    issueId = c.body.id;
    expect(c.body.guid).toBe(issueId);
    expect(c.body.labels).toEqual(["Mimari", "Kat 3"]);
    expect(c.body.viewpoint.guid).toMatch(/^[0-9a-f-]{36}$/);
    expect((await ayse.post(`/projects/${projectId}/issues/${issueId}/comments`, { body: "Kontrol edildi" })).status).toBe(200);
    const legacy = await admin.post(`/projects/${projectId}/issues`, {
      title: "Eski görünüm",
      viewpoint: { camera: { position: [10, 10, 10], target: [0, 0, 0], projection: "perspective" }, fileVersionIds: [legacyVersionId] },
    });
    expect(legacy.status).toBe(200);
  });

  it("exports BCF 2.1 and 3.0 that validate against the official XSDs", async () => {
    for (const version of ["2.1", "3.0"] as const) {
      const res = await ayse.get(`/projects/${projectId}/bcf/export?version=${version}`);
      expect(res.status, res.raw.body).toBe(200);
      expect(res.raw.headers["content-type"]).toBe("application/zip");
      expect(String(res.raw.headers["content-disposition"])).toMatch(new RegExp(`bcf${version.replace(".", "")}\\.bcfzip`));
      const zip = await unzip(res.raw.rawPayload);
      const names = [...zip.keys()].sort();
      expect(names).toContain("bcf.version");
      expect(names).toContain("project.bcfp");
      expect(names.includes("extensions.xml")).toBe(version === "3.0");
      expect(names).toContain(`${issueId}/markup.bcf`);
      expect(names).toContain(`${issueId}/viewpoint.bcfv`);
      expect(names).toContain(`${issueId}/snapshot.png`);
      const s = SCHEMAS[version];
      const check = (schema: ReturnType<typeof xsd>, name: string) => expect(validateXml(schema, zip.get(name)!.toString("utf8")), `${version} ${name}`).toEqual([]);
      check(s.version, "bcf.version");
      check(s.project, "project.bcfp");
      if (version === "3.0") check(SCHEMAS["3.0"].extensions, "extensions.xml");
      for (const n of names) {
        if (n.endsWith("markup.bcf")) check(s.markup, n);
        if (n.endsWith(".bcfv")) check(s.visinfo, n);
      }
      const markup = zip.get(`${issueId}/markup.bcf`)!.toString("utf8");
      expect(markup).toContain(`<Title>Döşeme boşluğu</Title>`);
      expect(markup).toContain(`<DueDate>2026-11-05T12:00:00.000Z</DueDate>`);
      expect(markup).toContain(`IfcProject="${ARCH_GUID}"`);
      expect(markup).toContain(`<Reference>${archVersionId}</Reference>`);
      expect(markup).toContain(version === "3.0" ? `<Label>Kat 3</Label>` : `<Labels>Kat 3</Labels>`);
      expect(markup).toContain(`TopicStatus="Open"`);
      expect(markup).toContain(`<Priority>High</Priority>`);
      const vis = zip.get(`${issueId}/viewpoint.bcfv`)!.toString("utf8");
      // Camera in IFC world coordinates: scene (−90, 8, 70) with offset (−100, −2, 50) → IFC (10, −20, 10).
      expect(vis).toMatch(/<CameraViewPoint>\s*<X>10<\/X>\s*<Y>-20<\/Y>\s*<Z>10<\/Z>/);
      expect(vis).toContain(`<Color Color="FF8800">`);
      expect(vis).toContain(`<ClippingPlane>`);
      expect(vis).toContain(`<Line>`);
    }
  });

  it("exports older viewpoints with the model offset read from the derivative", async () => {
    const res = await admin.post(`/projects/${projectId}/bcf/export`, { version: "3.0", status: "open" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.topics).toBe(2);
    expect(res.body.downloadUrl).toMatch(/\/bcf\/export\?version=3\.0&status=open$/);
    const zip = await unzip(Buffer.from(res.body.base64, "base64"));
    const legacyFolder = [...zip.keys()].find((n) => n.endsWith("markup.bcf") && zip.get(n)!.toString().includes("Eski görünüm"))!;
    const vis = zip.get(legacyFolder.replace("markup.bcf", "viewpoint.bcfv"))!.toString();
    // Scene (10, 10, 10) − offset (−100, −2, 50) = (110, 12, −40) → IFC (110, 40, 12).
    expect(vis).toMatch(/<CameraViewPoint>\s*<X>110<\/X>\s*<Y>40<\/Y>\s*<Z>12<\/Z>/);
    expect(await fragmentsOffset(fakeFragments([1.5, 2, -3]))).toEqual([1.5, 2, -3]);
  });

  it("validator self-check: official samples pass, broken XML fails", async () => {
    const z = await unzip(fixture("bcf-samples/v30-orthogonal-camera.bcf"));
    for (const [n, d] of z) {
      if (n.endsWith("markup.bcf")) expect(validateXml(SCHEMAS["3.0"].markup, d.toString())).toEqual([]);
      if (n.endsWith(".bcfv")) expect(validateXml(SCHEMAS["3.0"].visinfo, d.toString())).toEqual([]);
    }
    const bad = `<Markup><Topic Guid="NOT-A-GUID" TopicType="x" TopicStatus="y"><CreationDate>dün</CreationDate></Topic></Markup>`;
    const errors = validateXml(SCHEMAS["3.0"].markup, bad);
    expect(errors.some((e) => /Guid/.test(e))).toBe(true);
    expect(errors.some((e) => /content does not match|Title/.test(e))).toBe(true);
    const ok = `<Markup><Topic Guid="${T21}" TopicType="a" TopicStatus="b"><Title>t</Title><Priority>p</Priority><CreationDate>2026-01-01T00:00:00Z</CreationDate><CreationAuthor>a</CreationAuthor></Topic></Markup>`;
    expect(validateXml(SCHEMAS["3.0"].markup, ok)).toEqual([]);
    expect(validateXml(SCHEMAS["3.0"].markup, ok.replace("<Title>t</Title><Priority>p</Priority>", "<Priority>p</Priority><Title>t</Title>"))).toHaveLength(1);
    expect(validateXml(SCHEMAS["3.0"].markup, ok.replace("<Title>t</Title>", "<Title>  </Title>"))).toHaveLength(1);
    expect(validateXml(SCHEMAS["3.0"].markup, ok.replace(T21, T21.toUpperCase()))).toHaveLength(1);
    const cam = (fov: number) =>
      `<VisualizationInfo Guid="${T21_VP1}"><Components><Visibility/></Components><PerspectiveCamera><CameraViewPoint><X>1</X><Y>1</Y><Z>1</Z></CameraViewPoint><CameraDirection><X>1</X><Y>0</Y><Z>0</Z></CameraDirection><CameraUpVector><X>0</X><Y>0</Y><Z>1</Z></CameraUpVector><FieldOfView>${fov}</FieldOfView></PerspectiveCamera></VisualizationInfo>`;
    expect(validateXml(SCHEMAS["2.1"].visinfo, cam(50))).toEqual([]);
    expect(validateXml(SCHEMAS["2.1"].visinfo, cam(70))).toEqual(["/VisualizationInfo/PerspectiveCamera/FieldOfView: 70 > 60"]);
  });

  it("previews a hand-written BCF 2.1 file: states, suggestions and mapping", async () => {
    const res = await admin.upload(`/projects/${projectId}/bcf/import/preview`, await sample21(), "dis.bcfzip");
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const p = res.body;
    expect(p.version).toBe("2.1");
    expect(p.topics).toHaveLength(1);
    expect(p.topics[0]).toMatchObject({ guid: T21, title: "Kanal & kiriş çakışması", state: "new", comments: 1, viewpoints: 2, snapshots: 2 });
    expect(p.statuses).toEqual([{ value: "Active", count: 1, suggested: "open" }]);
    expect(p.priorities[0]).toMatchObject({ value: "Major", suggested: "high" });
    const users = Object.fromEntries(p.users.map((u: any) => [u.email, u.suggestedUserId]));
    expect(users["ayse@7d.test"]).toBe(ayseId);
    expect(users["mehmet@baska.test"]).toBeNull();
    expect(p.files).toEqual([expect.objectContaining({ filename: "Architectural.ifc", suggestedVersionId: archVersionId })]);
    expect(p.warnings.join(" ")).toMatch(/ek dosya/);
  });

  let importedId: string;

  it("imports BCF 2.1: fields, comments, viewpoints (camera, components, clipping), snapshots", async () => {
    const res = await admin.upload(`/projects/${projectId}/bcf/import`, await sample21(), "dis.bcfzip", {
      statuses: { Active: "in_progress" },
      users: { "mehmet@baska.test": null },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ created: 1, updated: 0, comments: 1, viewpoints: 2 });
    importedId = res.body.issues[0].issueId;
    const issue = (await admin.get(`/projects/${projectId}/issues/${importedId}`)).body;
    expect(issue).toMatchObject({
      guid: T21,
      title: "Kanal & kiriş çakışması",
      status: "in_progress",
      priority: "high",
      type: "Clash",
      assigneeUserId: ayseId,
      dueDate: "2026-10-20",
      labels: ["Mekanik", "Kat 2"],
      stage: "Uygulama",
      referenceLinks: ["https://example.test/a"],
      extraViewpointCount: 1,
    });
    expect(issue.createdBy).toBe(adminId);
    expect(issue.createdAt).toBe("2026-09-01T09:00:00.000Z");
    expect(issue.importedFrom).toMatchObject({ source: "bcf", version: "2.1", fileName: "dis.bcfzip", creationAuthor: "mehmet@baska.test", topicStatus: "Active" });
    const vp = issue.viewpoint as IssueViewpoint;
    expect(vp.guid).toBe(T21_VP1);
    expect(vp.fileVersionIds).toEqual([archVersionId]);
    expect(vp.sceneOffset).toEqual([0, 0, 0]);
    // IFC (10, −20, 5) looking north → scene (10, 5, 20) looking −Z.
    expect(vp.camera.position).toEqual([10, 5, 20]);
    expect(vp.camera.target).toEqual([10, 5, 10]);
    expect(vp.camera.fov).toBe(50);
    expect(vp.selection).toEqual(["3vB2YO$MX4xv5uCqZZG0A1"]);
    expect(vp.visibility).toEqual({ defaultVisible: true, exceptions: ["1pPHnf7cXCpPsNEnQf8_A3"] });
    expect(vp.coloring).toEqual([{ color: "FF0000", guids: ["3vB2YO$MX4xv5uCqZZG0A1"] }]);
    // BCF hides above Z = 3 → our plane keeps below Y = 3 (normal −Y).
    expect(vp.sections).toEqual({ planes: [{ origin: [0, 3, 0], normal: [0, -1, 0] }] });
    // The snapshot was rebuilt without its text chunk.
    const snap = Buffer.from(vp.snapshot!.split(",")[1]!, "base64");
    expect(snap.includes(Buffer.from("tEXt"))).toBe(false);
    expect(sanitizeSnapshot(snap).width).toBe(4);

    const vps = (await admin.get(`/projects/${projectId}/issues/${importedId}/viewpoints`)).body;
    expect(vps.map((v: any) => [v.guid, v.primary])).toEqual([
      [T21_VP1, true],
      [T21_VP2, false],
    ]);
    const jpg = Buffer.from(vps[1].viewpoint.snapshot.split(",")[1], "base64");
    expect(jpg.includes(Buffer.from("GPS-secret"))).toBe(false);
    expect(jpg.includes(Buffer.from("yorum"))).toBe(false);

    const comments = (await admin.get(`/projects/${projectId}/issues/${importedId}/comments`)).body;
    expect(comments).toEqual([expect.objectContaining({ guid: T21_C1, body: "Kanal kirişle çakışıyor", viewpointGuid: T21_VP1, importedAuthor: "mehmet@baska.test", authorId: adminId })]);
  });

  it("re-imports idempotently, then updates, then detects a conflict", async () => {
    const count = async () => (await admin.get(`/projects/${projectId}/issues`)).body.length;
    const before = await count();
    const again = await admin.upload(`/projects/${projectId}/bcf/import`, await sample21());
    expect(again.body).toMatchObject({ created: 0, updated: 0, unchanged: 1, comments: 0, viewpoints: 0 });
    expect(await count()).toBe(before);
    expect((await admin.get(`/projects/${projectId}/issues/${importedId}/comments`)).body).toHaveLength(1);

    // The other tool changed the topic and added a comment.
    const changed = await sample21({
      modified: "2026-09-05T08:00:00Z",
      comments: [
        { guid: T21_C1, text: "Kanal kirişle çakışıyor", author: "mehmet@baska.test" },
        { guid: "2c000000-0000-4000-8000-000000000002", text: "Revize edildi", author: "ayse@7d.test" },
      ],
    });
    const preview = await admin.upload(`/projects/${projectId}/bcf/import/preview`, changed);
    expect(preview.body.topics[0]).toMatchObject({ state: "update", existingIssueId: importedId });
    const upd = await admin.upload(`/projects/${projectId}/bcf/import`, changed, "dis.bcfzip", { statuses: { Active: "in_review" } });
    expect(upd.body).toMatchObject({ created: 0, updated: 1, comments: 1 });
    expect((await admin.get(`/projects/${projectId}/issues/${importedId}`)).body.status).toBe("in_review");

    // Changed here and in the file: kept by default, overwritten on request.
    await new Promise((r) => setTimeout(r, 1100));
    expect((await admin.patch(`/projects/${projectId}/issues/${importedId}`, { title: "Yerel başlık" })).status).toBe(200);
    const both = await sample21({ modified: "2026-09-06T08:00:00Z" });
    const p2 = await admin.upload(`/projects/${projectId}/bcf/import/preview`, both);
    expect(p2.body.topics[0].state).toBe("conflict");
    const kept = await admin.upload(`/projects/${projectId}/bcf/import`, both);
    expect(kept.body).toMatchObject({ updated: 0, skipped: 1 });
    expect((await admin.get(`/projects/${projectId}/issues/${importedId}`)).body.title).toBe("Yerel başlık");
    const over = await admin.upload(`/projects/${projectId}/bcf/import`, both, "dis.bcfzip", { conflicts: "overwrite" });
    expect(over.body).toMatchObject({ updated: 1 });
    expect((await admin.get(`/projects/${projectId}/issues/${importedId}`)).body.title).toBe("Kanal & kiriş çakışması");
  });

  it("imports BCF 3.0 (JSON body): orthographic camera, section box, lines, unmatched people and files", async () => {
    const data = (await sample30()).toString("base64");
    const res = await admin.post(`/projects/${projectId}/bcf/import`, { fileName: "v3.bcfzip", data });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ created: 1, comments: 2, viewpoints: 1 });
    const issue = (await admin.get(`/projects/${projectId}/issues/${res.body.issues[0].issueId}`)).body;
    expect(issue).toMatchObject({ status: "in_progress", priority: "critical", type: "Request", assigneeUserId: null, labels: ["Statik"] });
    expect(issue.importedFrom).toMatchObject({ version: "3.0", assignedTo: "kimse@baska.test", serverAssignedId: "X-12" });
    expect(issue.importedFrom.files).toEqual([expect.objectContaining({ filename: "Bilinmeyen.ifc", fileVersionId: null })]);
    const vp = issue.viewpoint as IssueViewpoint;
    expect(vp.camera).toMatchObject({ projection: "orthographic", viewToWorldScale: 25, aspect: 1.5, position: [5, 40, -5] });
    expect(vp.fileVersionIds).toEqual([]);
    expect(vp.visibility).toEqual({ defaultVisible: false, exceptions: ["3vB2YO$MX4xv5uCqZZG0A1"], spacesVisible: true });
    expect(vp.coloring).toEqual([{ color: "8000FF00", guids: ["3vB2YO$MX4xv5uCqZZG0A1"] }]);
    // Six inward planes → our section box (scene axes: Y up, −IFC Y is +Z).
    expect(vp.sections).toEqual({ planes: [], box: { min: [0, 0, -8], max: [10, 6, 0] } });
    expect(vp.lines).toEqual([[[0, 0, 0], [1, 0, 0]]]);
    const comments = (await admin.get(`/projects/${projectId}/issues/${issue.id}/comments`)).body;
    expect(comments[1]).toMatchObject({ body: "(görünüm)", viewpointGuid: T30_VP, importedAuthor: "kimse@baska.test" });
  });

  it("imports the official buildingSMART test cases (2.1 and 3.0)", async () => {
    const ortho = await admin.upload(`/projects/${projectId}/bcf/import`, fixture("bcf-samples/v30-orthogonal-camera.bcf"), "orthogonal camera.bcf");
    expect(ortho.status, JSON.stringify(ortho.body)).toBe(200);
    expect(ortho.body.created).toBe(1);
    const o = (await admin.get(`/projects/${projectId}/issues/${ortho.body.issues[0].issueId}`)).body;
    expect(o.title).toBe("Orthogonal Camera");
    expect(o.viewpoint.camera.projection).toBe("orthographic");
    expect(o.viewpoint.camera.viewToWorldScale).toBeCloseTo(12.0796, 3);
    // Header file Architectural.ifc (IfcProject GUID) matched our model.
    expect(o.viewpoint.fileVersionIds).toEqual([archVersionId]);

    const related = await admin.upload(`/projects/${projectId}/bcf/import`, fixture("bcf-samples/v30-related-topics.bcf"));
    expect(related.body.created).toBe(2);
    const one = await admin.upload(`/projects/${projectId}/bcf/import`, fixture("bcf-samples/v21-one-part-visible.bcf"));
    expect(one.body.created).toBe(1);
    const op = (await admin.get(`/projects/${projectId}/issues/${one.body.issues[0].issueId}`)).body;
    expect(op.viewpoint.visibility).toEqual({ defaultVisible: false, exceptions: ["32HeOfyn55zOiSkf6rlfHs"] });
    expect(op.viewpoint.snapshot).toMatch(/^data:image\/png;base64,/);
    const ua = await admin.upload(`/projects/${projectId}/bcf/import`, fixture("bcf-samples/v21-user-assignment.bcf"));
    expect(ua.body).toMatchObject({ created: 1, comments: 1 });
  });

  it("round-trips our issue through BCF 3.0 into another project and back (idempotent by GUID)", async () => {
    const exp = await ayse.get(`/projects/${projectId}/bcf/export?version=3.0&ids=${issueId}`);
    expect(exp.status).toBe(200);
    const imp = await admin.upload(`/projects/${otherProjectId}/bcf/import`, exp.raw.rawPayload);
    expect(imp.body).toMatchObject({ created: 1, comments: 1, viewpoints: 1 });
    const copy = (await admin.get(`/projects/${otherProjectId}/issues/${imp.body.issues[0].issueId}`)).body;
    const orig = (await ayse.get(`/projects/${projectId}/issues/${issueId}`)).body;
    expect(copy).toMatchObject({ guid: orig.guid, title: orig.title, description: orig.description, status: orig.status, priority: orig.priority, type: orig.type, dueDate: orig.dueDate, labels: orig.labels, stage: orig.stage, assigneeUserId: null });
    const back = rebaseViewpoint(copy.viewpoint, sceneOffset);
    const o = orig.viewpoint as IssueViewpoint;
    for (let i = 0; i < 3; i++) expect(back.camera.position[i]).toBeCloseTo(o.camera.position[i]!, 9);
    expect(back.camera.fov).toBe(55);
    expect(back.selection).toEqual(o.selection);
    expect(back.visibility).toEqual(o.visibility);
    expect(back.coloring).toEqual(o.coloring);
    expect(back.sections?.box).toEqual(o.sections?.box);
    expect(back.sections?.planes).toEqual(o.sections?.planes);
    // The pin and the measurement travelled as lines.
    expect(back.lines).toHaveLength(2);

    // Back into the source project: same GUID, nothing new.
    const home = await admin.upload(`/projects/${projectId}/bcf/import`, exp.raw.rawPayload);
    expect(home.body).toMatchObject({ created: 0, unchanged: 1, comments: 0, viewpoints: 0 });
  });

  it("refuses malicious archives: zip-slip, XXE, zip bombs, oversize entries, fake images", async () => {
    const slip = await zipOf({ "../evil/markup.bcf": markup21(), "bcf.version": "<Version VersionId='2.1'/>" });
    const r1 = await admin.upload(`/projects/${projectId}/bcf/import/preview`, slip);
    expect(r1.status).toBe(400);
    expect(r1.body.message).toMatch(/Güvensiz dosya yolu/);

    const xxe = await zipOf({
      "bcf.version": `<Version VersionId="2.1"/>`,
      [`${T21}/markup.bcf`]: `<?xml version="1.0"?><!DOCTYPE Markup [<!ENTITY x SYSTEM "file:///etc/passwd">]><Markup><Topic Guid="${T21}"><Title>&x;</Title></Topic></Markup>`,
    });
    const r2 = await admin.upload(`/projects/${projectId}/bcf/import/preview`, xxe);
    expect(r2.status).toBe(400);
    expect(r2.body.message).toMatch(/DOCTYPE/);

    const bomb = await zipOf({ "bcf.version": `<Version VersionId="2.1"/>`, [`${T21}/snapshot.png`]: Buffer.alloc(3 * 1024 * 1024) });
    await expect(readBcfZip(bomb)).rejects.toThrow(/sıkıştırma oranı/);
    await expect(readBcfZip(await zipOf({ "a/markup.bcf": "x".repeat(5000) }), { ...BCF_ZIP_LIMITS, entryBytes: 1000 })).rejects.toBeInstanceOf(BcfZipError);
    await expect(readBcfZip(Buffer.alloc(10), { ...BCF_ZIP_LIMITS, zipBytes: 5 })).rejects.toThrow(/çok büyük/);
    const notZip = await admin.upload(`/projects/${projectId}/bcf/import/preview`, Buffer.from("merhaba"));
    expect(notZip.status).toBe(400);

    // A "PNG" that is HTML and a PNG with a broken CRC are dropped with a warning; the topic still imports.
    const broken = png(2, 2);
    broken[broken.length - 20] ^= 0xff;
    const fake = await zipOf({
      "bcf.version": `<Version VersionId="2.1"/>`,
      ["7e000000-0000-4000-8000-000000000001/markup.bcf"]: `<Markup><Topic Guid="7e000000-0000-4000-8000-000000000001" TopicType="x" TopicStatus="Open"><Title>Sahte görüntü</Title><CreationDate>2026-01-01T00:00:00Z</CreationDate><CreationAuthor>a@b.c</CreationAuthor></Topic>
        <Viewpoints Guid="7e000000-0000-4000-8000-0000000000f1"><Snapshot>snapshot.png</Snapshot></Viewpoints>
        <Viewpoints Guid="7e000000-0000-4000-8000-0000000000f2"><Snapshot>b.png</Snapshot></Viewpoints></Markup>`,
      ["7e000000-0000-4000-8000-000000000001/snapshot.png"]: "<html><script>alert(1)</script></html>",
      ["7e000000-0000-4000-8000-000000000001/b.png"]: broken,
    });
    const r3 = await admin.upload(`/projects/${projectId}/bcf/import/preview`, fake);
    expect(r3.status).toBe(200);
    expect(r3.body.topics[0].snapshots).toBe(0);
    expect(r3.body.topics[0].warnings.join(" ")).toMatch(/PNG ya da JPEG değil/);
    expect(r3.body.topics[0].warnings.join(" ")).toMatch(/CRC/);
    expect(() => sanitizeSnapshot(Buffer.concat([png(2, 2).subarray(0, 40)]))).toThrow();

    // A broken topic is skipped with a warning; a file with no readable topic is refused.
    const mixed = await zipOf({ "bcf.version": `<Version VersionId="2.1"/>`, [`${T21}/markup.bcf`]: markup21(), "0d000000-0000-4000-8000-000000000001/markup.bcf": "<Markup/>" });
    const r4 = await admin.upload(`/projects/${projectId}/bcf/import/preview`, mixed);
    expect(r4.status).toBe(200);
    expect(r4.body.topics).toHaveLength(1);
    expect(r4.body.warnings.join(" ")).toMatch(/okunamadı, atlandı/);
    const none = await admin.upload(`/projects/${projectId}/bcf/import/preview`, await zipOf({ "x/markup.bcf": "<Markup/>" }));
    expect(none.status).toBe(400);
  });

  it("enforces permissions: members only, read tokens cannot import, issue edit rules", async () => {
    expect((await outsider.get(`/projects/${projectId}/bcf/export`)).status).toBe(404);
    expect((await outsider.upload(`/projects/${projectId}/bcf/import`, await sample21())).status).toBe(404);

    const t = await admin.post("/auth/tokens", { name: "BCF okuma", scope: "read" });
    expect(t.status, JSON.stringify(t.body)).toBe(200);
    const reader = client({ token: t.body.token });
    expect((await reader.post(`/projects/${projectId}/bcf/export`, { version: "2.1", issueIds: [issueId] })).status).toBe(200);
    expect((await reader.upload(`/projects/${projectId}/bcf/import/preview`, await sample21())).status).toBe(200);
    expect((await reader.upload(`/projects/${projectId}/bcf/import`, await sample21())).status).toBe(403);

    // Bora neither created nor is assigned to the imported issue: fields stay, new comments still arrive.
    const changed = await sample21({
      modified: "2026-09-20T08:00:00Z",
      comments: [{ guid: "2c000000-0000-4000-8000-000000000009", text: "Bora'nın dosyasından", author: "bora@7d.test" }],
    });
    const prev = await bora.upload(`/projects/${projectId}/bcf/import/preview`, changed);
    expect(prev.body.topics[0]).toMatchObject({ state: "update", readOnly: true });
    const res = await bora.upload(`/projects/${projectId}/bcf/import`, changed, "b.bcfzip", { statuses: { Active: "closed" } });
    expect(res.body).toMatchObject({ updated: 0, skipped: 1, comments: 1 });
    expect((await admin.get(`/projects/${projectId}/issues/${importedId}`)).body.status).not.toBe("closed");
  });

  it("MCP tools: cde_bcf_export (read) and cde_bcf_import (write; preview, then commit)", async () => {
    const cookie = await login("ayse@7d.test");
    const call: CdeCall = async <T,>(method: string, url: string, body?: unknown) => {
      const res = await app.inject({ method: method as "GET", url: `/api/v1${url}`, headers: { cookie }, payload: body as object });
      return cdeResult<T>(res.statusCode, res.body, false);
    };
    const readOnly = cdeToolDefinitions(call, { readOnly: true }).map((d) => d.name);
    expect(readOnly).toContain("cde_bcf_export");
    expect(readOnly).not.toContain("cde_bcf_import");
    const defs = new Map(cdeToolDefinitions(call).map((d) => [d.name, d]));
    const run = (name: string, args: Record<string, unknown>) => defs.get(name)!.run(cdeParseArgs(defs.get(name)!, { projectId: otherProjectId, ...args })) as Promise<any>;

    const exp = await run("cde_bcf_export", { version: "3.0", snapshots: false });
    expect(exp).toMatchObject({ version: "3.0", topics: 1 });
    expect(exp.downloadUrl).toContain("snapshots=0");
    const files = await unzip(Buffer.from(exp.base64, "base64"));
    expect([...files.keys()].some((n) => n.endsWith(".png"))).toBe(false);

    const preview = await run("cde_bcf_import", { base64: (await sample30()).toString("base64"), fileName: "mcp.bcfzip" });
    expect(preview.topics[0]).toMatchObject({ guid: T30, state: "new" });
    expect((await admin.get(`/projects/${otherProjectId}/issues`)).body).toHaveLength(1);
    const done = await run("cde_bcf_import", { base64: (await sample30()).toString("base64"), commit: true, mapping: { types: { Request: "Bilgi" } } });
    expect(done).toMatchObject({ created: 1 });
    const list = (await admin.get(`/projects/${otherProjectId}/issues`)).body;
    expect(list.find((i: any) => i.guid === T30)).toMatchObject({ type: "Bilgi" });
  });

  it("refuses imports while the Sorunlar module is off (export keeps working)", async () => {
    expect((await admin.put(`/projects/${projectId}/modules`, { modules: { issues: false } })).status).toBe(200);
    try {
      const res = await admin.upload(`/projects/${projectId}/bcf/import`, await sample30());
      expect(res.status).toBe(403);
      expect(res.body.error).toBe("module_disabled");
      expect((await admin.upload(`/projects/${projectId}/bcf/import/preview`, await sample30())).status).toBe(403);
      expect((await admin.get(`/projects/${projectId}/bcf/export?version=2.1&ids=${issueId}`)).status).toBe(200);
    } finally {
      await admin.put(`/projects/${projectId}/modules`, { modules: { issues: true } });
    }
  });
});
