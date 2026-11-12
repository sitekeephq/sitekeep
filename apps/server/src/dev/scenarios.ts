/**
 * cde_dev_scenario / `npm run scenarios`: end-to-end scenarios through the real routes and
 * services, as the demo members of the right companies. Each step reports pass/fail, time, the
 * number of API calls (a rough "clicks" measure) and a web link.
 */
import type { CdeCall } from "@sitekeep/cde-tools";
import { DEV_SCENARIOS } from "@sitekeep/cde-tools";
import type { DevContext } from "./context.js";
import { link } from "./context.js";
import { ensureActors, ensureSeedFolder, ensureSubFolder, type Actors } from "./actors.js";
import { dayOffset } from "./random.js";
import { findProject, requireTestProject, updateRegistry, type ProjectRow } from "./registry.js";
import { PNG_1X1, pdfDrawing, pdfForm } from "./samples.js";
import { uploadFile } from "./upload.js";
import { projectPath } from "@sitekeep/shared";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
export type ScenarioId = (typeof DEV_SCENARIOS)[number];

export interface StepResult {
  step: string;
  ok: boolean;
  ms: number;
  calls: number;
  link?: string;
  error?: string;
  skipped?: boolean;
}

export interface ScenarioResult {
  scenario: ScenarioId;
  title: string;
  ok: boolean;
  seconds: number;
  steps: StepResult[];
}

class Check extends Error {}
function expect(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Check(message);
}

/** One scenario run: counted calls per user, steps, links. */
class Sc {
  steps: StepResult[] = [];
  calls = 0;
  failed = false;
  private cache = new Map<string, CdeCall>();
  constructor(
    readonly dev: DevContext,
    readonly p: ProjectRow,
    readonly a: Actors,
    readonly folderId: string,
  ) {}

  private counted(c: CdeCall): CdeCall {
    return (async (m: string, u: string, b?: unknown) => {
      this.calls++;
      return c(m, u, b);
    }) as CdeCall;
  }
  get admin(): CdeCall {
    return this.counted(this.dev.call);
  }
  async as(userId: string): Promise<CdeCall> {
    let c = this.cache.get(userId);
    if (!c) {
      c = this.counted(await this.dev.as(userId));
      this.cache.set(userId, c);
    }
    return c;
  }
  /** Web link to a page of the scenario project (`works/<id>`, `reports?template=…`). */
  url(rest: string): string {
    return link(this.dev, projectPath(this.p.id, rest));
  }
  async step(name: string, fn: () => Promise<string | void>): Promise<void> {
    if (this.failed) {
      this.steps.push({ step: name, ok: false, ms: 0, calls: 0, skipped: true, error: "Önceki adım başarısız; atlandı." });
      return;
    }
    const t = Date.now();
    const c0 = this.calls;
    try {
      const l = await fn();
      this.steps.push({ step: name, ok: true, ms: Date.now() - t, calls: this.calls - c0, ...(l && { link: l }) });
    } catch (e) {
      this.failed = true;
      this.steps.push({ step: name, ok: false, ms: Date.now() - t, calls: this.calls - c0, error: (e as Error).message.slice(0, 500) });
    }
  }
}

const P = (sc: Sc, rest: string) => `/projects/${sc.p.id}${rest}`;

// ---- Scenarios -------------------------------------------------------------------------------

async function incomingLetter(sc: Sc, title: string): Promise<Any> {
  const yuk = await sc.as(sc.a.contractor.userId);
  return yuk<Any>("POST", P(sc, "/works"), {
    typeKey: "gelen-yazi",
    title,
    fromCompanyId: sc.a.client.companyId,
    toCompanyIds: [sc.a.contractor.companyId],
    replyRequired: true,
    dueDate: dayOffset(5),
    fields: { sayi: `E-${Date.now() % 100000}`, tarih: dayOffset(-1), konu: title },
  });
}

async function yazismaDongusu(sc: Sc) {
  const yuk = await sc.as(sc.a.contractor.userId);
  let inc: Any;
  let reply: Any;
  await sc.step("Gelen yazı kaydı", async () => {
    inc = await incomingLetter(sc, "Beton döküm programı");
    expect(inc.status === "alindi", `Gelen yazı durumu 'alindi' olmalı, ${inc.status} geldi.`);
    return sc.url(`works/${inc.id}`);
  });
  await sc.step("Cevap taslağı (ilgi bağlantılı)", async () => {
    reply = await yuk<Any>("POST", P(sc, `/works/${inc.id}/reply`), {});
    expect(reply.status === "taslak", "Cevap taslak olmalı.");
    expect((reply.links ?? []).some((l: Any) => l.targetId === inc.id), "Cevap gelen yazıya ilgi ile bağlı olmalı.");
    await yuk("PUT", P(sc, `/works/${reply.id}/letter`), { body: "İlgi yazınız incelenmiştir; program uygundur.", signer: { name: "Mehmet Kaya", title: "Proje Müdürü" } });
    return sc.url(`works/${reply.id}`);
  });
  await sc.step("Cevabı gönder (elden)", async () => {
    const sent = await yuk<Any>("POST", P(sc, `/works/${reply.id}/send`), { channel: "elden", reference: "TUT-1" });
    expect(sent.status === "gonderildi", `Gönderilen yazı 'gonderildi' olmalı, ${sent.status} geldi.`);
  });
  await sc.step("Gelen yazı Cevaplandı", async () => {
    const w = await yuk<Any>("GET", P(sc, `/works/${inc.id}`));
    expect(w.status === "cevaplandi" && w.closed, `Gelen yazı 'cevaplandi' olmalı, ${w.status} geldi.`);
    return sc.url(`works/${inc.id}`);
  });
}

async function bilgiTalebi(sc: Sc) {
  const yuk = await sc.as(sc.a.contractor.userId);
  const msv = await sc.as(sc.a.consultant.userId);
  let rfi: Any;
  await sc.step("Bilgi talebi oluştur", async () => {
    rfi = await yuk<Any>("POST", P(sc, "/works"), {
      typeKey: "rfi",
      title: "Perde donatı bindirme boyu",
      toCompanyIds: [sc.a.consultant.companyId],
      fields: { soru: "Bindirme boyu nedir?", disiplin: "S - Statik", kategori: "Tasarım Koordinasyonu", oncelik: "Yüksek", maliyet_etkisi: "Yok", takvim_etkisi: "Var" },
    });
    expect(rfi.status === "taslak", "Yeni bilgi talebi taslak olmalı.");
    return sc.url(`works/${rfi.id}`);
  });
  await sc.step("Gönder (sıradaki taraf müşavir)", async () => {
    await yuk("POST", P(sc, `/works/${rfi.id}/submit`), { comment: "Acil" });
    const w = await yuk<Any>("GET", P(sc, `/works/${rfi.id}`));
    expect(w.status === "acik", `Durum 'acik' olmalı, ${w.status} geldi.`);
    expect((w.build?.ballInCourt ?? []).length > 0, "Sıradaki taraf boş.");
  });
  await sc.step("Müşavir cevaplar", async () => {
    await msv("POST", P(sc, `/works/${rfi.id}/respond`), { outcome: "CEVAP", response: "Bindirme boyu 50Ø uygulanacaktır." });
    const w = await yuk<Any>("GET", P(sc, `/works/${rfi.id}`));
    expect(w.status === "cevaplandi", `Durum 'cevaplandi' olmalı, ${w.status} geldi.`);
  });
  await sc.step("Kapat", async () => {
    const w = await yuk<Any>("PATCH", P(sc, `/works/${rfi.id}`), { status: "kapandi" });
    expect(w.closed, "Bilgi talebi kapanmadı.");
    return sc.url(`works/${rfi.id}`);
  });
}

async function teknikOnay(sc: Sc) {
  const yuk = await sc.as(sc.a.contractor.userId);
  const msv = await sc.as(sc.a.consultant.userId);
  let pkg: Any;
  let item: Any;
  await sc.step("Paket ve kalem", async () => {
    pkg = await yuk<Any>("POST", P(sc, "/works"), { typeKey: "submittal-paketi", title: "Mekanik malzemeler", fields: { bolum: "MOS", disiplin: "M - Mekanik" }, toCompanyIds: [sc.a.consultant.companyId] });
    item = await yuk<Any>("POST", P(sc, "/works"), {
      typeKey: "submittal-kalemi",
      title: "Klima santrali",
      fields: { tur: "MOS - Malzeme Onay", disiplin: "M - Mekanik", bolum_kodu: "23 73 00" },
      toCompanyIds: [sc.a.consultant.companyId],
      parentWorkId: pkg.id,
    });
    return sc.url(`works/${pkg.id}`);
  });
  await sc.step("Paketi incelemeye gönder", async () => {
    await yuk("POST", P(sc, `/works/${pkg.id}/submit`), {});
    const w = await yuk<Any>("GET", P(sc, `/works/${item.id}`));
    expect(w.status === "incelemede", `Kalem 'incelemede' olmalı, ${w.status} geldi.`);
  });
  await sc.step("Müşavir revize ister", async () => {
    await msv("POST", P(sc, `/works/${item.id}/respond`), { outcome: "revise_resubmit", comment: "Ses değerleri eksik" });
    const w = await yuk<Any>("GET", P(sc, `/works/${item.id}`));
    expect(w.status === "revize", `Kalem 'revize' olmalı, ${w.status} geldi.`);
  });
  await sc.step("Revize edip tekrar gönder (Rev 1)", async () => {
    await yuk("POST", P(sc, `/works/${item.id}/revise`), {});
    await yuk("POST", P(sc, `/works/${item.id}/submit`), { comment: "Rev 1" });
    const w = await yuk<Any>("GET", P(sc, `/works/${item.id}`));
    expect(w.status === "incelemede" && (w.build?.rev ?? 0) >= 1, `Rev 1 incelemede olmalı (durum ${w.status}, rev ${w.build?.rev}).`);
  });
  await sc.step("Onay", async () => {
    await msv("POST", P(sc, `/works/${item.id}/respond`), { outcome: "approved", comment: "Uygun" });
    const w = await yuk<Any>("GET", P(sc, `/works/${item.id}`));
    expect(w.status === "onaylandi", `Kalem 'onaylandi' olmalı, ${w.status} geldi.`);
    const pk = await yuk<Any>("GET", P(sc, `/works/${pkg.id}`));
    expect(pk.status === "onaylandi", `Paket 'onaylandi' olmalı, ${pk.status} geldi.`);
    return sc.url(`works/${item.id}`);
  });
}

async function meetingWithActions(sc: Sc, call: CdeCall, assignee: string): Promise<{ meeting: Any; actions: Any[] }> {
  const meeting = await call<Any>("POST", P(sc, "/works"), {
    typeKey: "toplanti",
    title: "Haftalık koordinasyon",
    toCompanyIds: [sc.a.consultant.companyId, sc.a.client.companyId],
    fields: { tur: "Koordinasyon", tarih: dayOffset(0), saat: "10:00", yer: "Şantiye ofisi" },
  });
  await call("PUT", P(sc, `/works/${meeting.id}/meeting`), {
    attendees: sc.a.all.slice(0, 3).map((x) => ({ userId: x.userId, companyId: x.companyId, present: true })),
    agenda: [{ text: "İş programı" }, { text: "Kalıp çizimleri" }],
  });
  await call("PUT", P(sc, `/works/${meeting.id}/minutes`), {
    items: [
      { konu: "İş programı", karar: "Program onaylandı" },
      { konu: "Kalıp çizimi revizyonu", karar: "Revize edilecek", sorumluUserId: assignee, termin: dayOffset(7) },
      { konu: "İSG eğitimi", sorumluCompanyId: sc.a.client.companyId, termin: dayOffset(10) },
    ],
    notes: "Toplantı notu",
  });
  const detail = await call<Any>("GET", P(sc, `/works/${meeting.id}`));
  return { meeting: detail, actions: detail.build?.children ?? [] };
}

async function toplanti(sc: Sc) {
  const yuk = await sc.as(sc.a.contractor.userId);
  let m: { meeting: Any; actions: Any[] };
  await sc.step("Toplantı, gündem ve katılımcılar", async () => {
    m = await meetingWithActions(sc, yuk, sc.a.contractor.userId);
    return sc.url(`works/${m.meeting.id}`);
  });
  await sc.step("Tutanaktan eylemler", async () => {
    expect(m.meeting.status === "yapildi", `Toplantı 'yapildi' olmalı, ${m.meeting.status} geldi.`);
    expect(m.actions.length === 2, `İki eylem bekleniyordu, ${m.actions.length} geldi.`);
  });
  await sc.step("Eylemleri kapat", async () => {
    for (const act of m.actions) {
      const who = act.assigneeUserId ? await sc.as(act.assigneeUserId) : yuk;
      const w = await who<Any>("PATCH", P(sc, `/works/${act.id}`), { status: "kapandi" }).catch(async () => yuk<Any>("PATCH", P(sc, `/works/${act.id}`), { status: "kapandi" }));
      expect(w.closed, "Eylem kapanmadı.");
    }
  });
  await sc.step("Toplantıyı kapat (tutanak yayınlandı)", async () => {
    const w = await yuk<Any>("PATCH", P(sc, `/works/${m.meeting.id}`), { status: "kapandi" });
    expect(w.closed, "Toplantı kapanmadı.");
    const pdf = await sc.dev.getBinary(P(sc, `/works/${m.meeting.id}/minutes.pdf`), sc.a.contractor.userId);
    expect(pdf.status === 200 && pdf.body.subarray(0, 5).toString() === "%PDF-", "Tutanak PDF'i alınamadı.");
    return sc.url(`works/${m.meeting.id}`);
  });
}

async function reviewTemplate(sc: Sc): Promise<string> {
  const t = await sc.admin<Any>("POST", P(sc, "/workflow-templates"), {
    kind: "review",
    name: `Senaryo İnceleme ${Date.now() % 10000}`,
    steps: [
      { name: "Müşavir", assignees: [{ type: "company", id: sc.a.consultant.companyId }], rule: "any", days: 5, outcomes: ["approved", "approved_with_comments", "revise_resubmit", "rejected"] },
      { name: "İdare", assignees: [{ type: "company", id: sc.a.client.companyId }], rule: "any", days: 3, outcomes: ["approved", "approved_with_comments", "rejected"] },
    ],
  });
  return t.id;
}

async function inceleme(sc: Sc) {
  const yuk = await sc.as(sc.a.contractor.userId);
  let ups: Any[] = [];
  let target = "";
  let tid = "";
  let rv: Any;
  await sc.step("Dosya yükle", async () => {
    ups = [];
    for (const n of ["S-301", "S-302"]) ups.push(await uploadFile(yuk, sc.p.id, sc.folderId, { name: `SCN-${Date.now() % 100000}-${n}.pdf`, data: await pdfDrawing({ number: n, revision: "B" }) }));
    return sc.url(`files/${sc.folderId}`);
  });
  await sc.step("İnceleme şablonu ve kapılı hedef klasör", async () => {
    tid = await reviewTemplate(sc);
    target = await ensureSubFolder(sc.dev, sc.p.id, sc.folderId, `Onaylı ${Date.now() % 100000}`);
    await sc.admin("PUT", P(sc, `/folders/${target}/settings`), { requireApprovedReview: true });
    let refused = false;
    try {
      await uploadFile(yuk, sc.p.id, target, { name: "dogrudan.pdf", data: await pdfDrawing() });
    } catch {
      refused = true;
    }
    expect(refused, "Kapılı klasöre doğrudan yükleme reddedilmeliydi.");
  });
  await sc.step("İncelemeyi başlat", async () => {
    rv = await yuk<Any>("POST", P(sc, "/reviews"), { name: "Statik paftalar", templateId: tid, versionIds: ups.map((u) => u.versionId), targetFolderId: target });
    expect(rv.status === "running", "İnceleme başlamadı.");
    return sc.url(`reviews/${rv.id}`);
  });
  await sc.step("Müşavir ve idare onaylar", async () => {
    await (await sc.as(sc.a.consultant.userId))("POST", P(sc, `/reviews/${rv.id}/submit`), { files: rv.files.map((f: Any) => ({ reviewFileId: f.id, outcome: "approved" })) });
    await (await sc.as(sc.a.client.userId))("POST", P(sc, `/reviews/${rv.id}/submit`), { files: rv.files.map((f: Any) => ({ reviewFileId: f.id, outcome: "approved" })) });
  });
  await sc.step("Tamamlandı, kapılı klasöre kopyalandı", async () => {
    const r = await yuk<Any>("GET", P(sc, `/reviews/${rv.id}`));
    expect(r.status === "completed", `İnceleme 'completed' olmalı, ${r.status} geldi.`);
    const c = await yuk<Any>("GET", P(sc, `/folders/${target}/contents`));
    expect((c.files ?? []).length === 2, `Hedef klasörde 2 dosya olmalı, ${(c.files ?? []).length} var.`);
    return sc.url(`reviews/${rv.id}`);
  });
}

function itemsOf(schema: Any): Any[] {
  return (schema?.sections ?? []).flatMap((s: Any) => s.items ?? []);
}

async function signature(call: CdeCall, sc: Sc, fid: string, itemId: string): Promise<string> {
  const form = new FormData();
  form.append("itemId", itemId);
  form.append("file", new Blob([new Uint8Array(PNG_1X1)], { type: "image/png" }), "imza.png");
  return (await call<Any>("POST", P(sc, `/forms/${fid}/attachments`), form)).id;
}

async function formPdf(sc: Sc) {
  let draft: Any;
  let tid = "";
  let sigs: Any[] = [];
  let fid = "";
  const yuk = await sc.as(sc.a.contractor.userId);
  const msv = await sc.as(sc.a.consultant.userId);
  await sc.step("PDF'ten alan bulma", async () => {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(await pdfForm())]), "beton-dokum.pdf");
    draft = await sc.admin<Any>("POST", P(sc, "/form-templates/pdf"), form);
    expect(draft.level === "text" && itemsOf(draft.draft?.schema).length > 3, `Metin katmanlı PDF'te alan bulunamadı (düzey ${draft.level}).`);
  });
  await sc.step("Şablonu kaydet", async () => {
    const t = await sc.admin<Any>("POST", P(sc, "/form-templates"), { code: `BD${Date.now() % 1000}`, name: draft.draft.name ?? "Beton Döküm Kontrol Formu", schema: draft.draft.schema, sourceId: draft.source.id });
    tid = t.id;
    sigs = itemsOf(t.schema).filter((i: Any) => i.type === "signature");
    expect(t.origin === "pdf", "Şablon PDF kaynaklı olmalı.");
    return sc.url(`forms/templates/pdf/${tid}`);
  });
  let sefRole = "";
  let kkRole = "";
  await sc.step("Roller ve onay akışı", async () => {
    sefRole = (await sc.admin<Any>("POST", P(sc, "/roles"), { name: `Şantiye Şefi ${Date.now() % 1000}` })).id;
    kkRole = (await sc.admin<Any>("POST", P(sc, "/roles"), { name: `Kalite Kontrol ${Date.now() % 1000}` })).id;
    await sc.admin("POST", P(sc, `/roles/${sefRole}/members/${sc.a.contractor.userId}`), {});
    await sc.admin("POST", P(sc, `/roles/${kkRole}/members/${sc.a.consultant.userId}`), {});
    const checkerSig = sigs.at(-1)?.id;
    const r = await sc.admin<Any>("PUT", P(sc, `/form-templates/${tid}/flow`), {
      name: "Beton Onay Akışı",
      steps: [
        {
          name: "Kalite Kontrol kontrol eder",
          assignees: [{ type: "role", id: kkRole }],
          rule: "any",
          days: 3,
          outcomeOptions: [
            { code: "ONAY", label: "Onay", kind: "approved" },
            { code: "RET", label: "Ret", kind: "rejected" },
          ],
          ...(checkerSig && sigs.length > 1 && { formFields: [checkerSig] }),
        },
      ],
      chain: { form: { fillers: [{ type: "role", id: sefRole }] } },
    });
    expect((r.flow?.lines ?? []).length > 0, "Akış satırları boş.");
  });
  await sc.step("Doldur ve gönder", async () => {
    const f = await yuk<Any>("POST", P(sc, "/forms"), { templateId: tid, formDate: dayOffset(0) });
    fid = f.id;
    const reserved = new Set(Object.keys(f.reservedFields ?? {}));
    const values: Record<string, unknown> = {};
    for (const it of itemsOf(f.schema ?? (await yuk<Any>("GET", P(sc, `/form-templates/${tid}`))).schema)) {
      if (reserved.has(it.id)) continue;
      if (it.type === "text") values[it.id] = "Demo";
      else if (it.type === "date") values[it.id] = dayOffset(0);
      else if (it.type === "yes_no") values[it.id] = "yes";
      else if (it.type === "number" || it.type === "km") values[it.id] = 1;
      else if (it.type === "choice" && it.options?.length) values[it.id] = it.options[0];
      else if (it.type === "signature") values[it.id] = await signature(yuk, sc, fid, it.id);
      else if (it.type === "table" && it.columns?.length) values[it.id] = [Object.fromEntries(it.columns.map((c: Any) => [c.id, c.type === "number" ? 1 : "Çimento"]))];
    }
    const s = await yuk<Any>("POST", P(sc, `/forms/${fid}/submit`), { values });
    expect(s.status === "in_review", `Form 'in_review' olmalı, ${s.status} geldi.`);
    return sc.url(`forms/${fid}`);
  });
  await sc.step("Kontrol eden imzalar ve onaylar", async () => {
    const f = await msv<Any>("GET", P(sc, `/forms/${fid}`));
    const own = Object.keys(f.reservedFields ?? {});
    if (own.length) {
      const values = { ...(f.values ?? {}) };
      for (const id of own) values[id] = await signature(msv, sc, fid, id);
      await msv("PATCH", P(sc, `/forms/${fid}/step-values`), { values });
    }
    const r = await msv<Any>("POST", P(sc, `/forms/${fid}/review`), { code: "ONAY", comment: "Uygun" });
    expect(r.status === "closed", `Form 'closed' olmalı, ${r.status} geldi.`);
  });
  await sc.step("Doldurulmuş PDF (orijinal düzen)", async () => {
    const pdf = await sc.dev.getBinary(P(sc, `/forms/${fid}/pdf`), sc.a.contractor.userId);
    expect(pdf.status === 200 && pdf.body.subarray(0, 5).toString() === "%PDF-", `PDF alınamadı (HTTP ${pdf.status}).`);
    return sc.url(`forms/${fid}`);
  });
}

async function rapor(sc: Sc) {
  let dash: Any;
  let stamp = "";
  await sc.step("Şablondan rapor paneli", async () => {
    const cat = await sc.admin<Any>("GET", P(sc, "/reports/catalog"));
    const t = (cat.templates as Any[]).find((x) => x.module === "issues") ?? cat.templates[0];
    expect(t, "Rapor şablonu yok.");
    dash = await sc.admin<Any>("POST", P(sc, "/reports"), { templateId: t.id });
    return sc.url(`reports/${dash.id}`);
  });
  await sc.step("Panel verisi hatasız", async () => {
    const d = await sc.admin<Any>("GET", P(sc, `/reports/${dash.id}/data`));
    expect(!Object.keys(d.errors ?? {}).length, `Sorgu hataları: ${JSON.stringify(d.errors)}`);
    stamp = d.stamp;
  });
  await sc.step("Yazınca damga değişir (canlı yenileme)", async () => {
    await (await sc.as(sc.a.contractor.userId))("POST", P(sc, "/issues"), { title: "Senaryo sorunu", priority: "high", dueDate: dayOffset(3) });
    const s2 = await sc.admin<Any>("GET", P(sc, `/reports/${dash.id}/stamp`));
    expect(s2.stamp && s2.stamp !== stamp, "Damga değişmedi.");
    return sc.url(`reports/${dash.id}`);
  });
}

async function karsilastirma(sc: Sc) {
  const name = `SCN-${Date.now() % 100000}-A-102.pdf`;
  let v1 = "";
  let v2 = "";
  await sc.step("İki PDF revizyonu (aynı ad = yeni versiyon)", async () => {
    v1 = (await uploadFile(sc.admin, sc.p.id, sc.folderId, { name, data: await pdfDrawing({ revision: "A" }) })).versionId;
    const u2 = await uploadFile(sc.admin, sc.p.id, sc.folderId, { name, data: await pdfDrawing({ revision: "C" }) });
    v2 = u2.versionId;
    expect(u2.version === 2, `İkinci yükleme versiyon 2 olmalı, ${u2.version} geldi.`);
  });
  await sc.step("Doküman karşılaştırma sonucu", async () => {
    const d = await sc.admin<Any>("GET", P(sc, `/doc-compare?from=${v1}&to=${v2}&wait=30000`));
    expect(d.status === "done", `Karşılaştırma bitmedi (${d.status}${d.error ? `: ${d.error}` : ""}).`);
    const changed = (d.result?.pages ?? []).reduce((n: number, p: Any) => n + (p.added ?? 0) + (p.removed ?? 0) + (p.changed ?? 0), 0);
    expect(changed > 0, "Değişiklik bulunamadı.");
    return sc.url(`compare?from=${v1}&to=${v2}`);
  });
}

/** The 15 persona tasks of docs/product/SIMPLIFICATION.md as API-level checks. */
async function gorunum(sc: Sc) {
  const saha = await sc.as(sc.a.contractor.userId);
  const doc = saha;
  const pm = await sc.as(sc.a.client.userId);
  let formId = "";
  let tpl: Any;
  let meeting: Any;
  let actions: Any[] = [];
  // Saha mühendisi
  await sc.step("Saha: Form doldur", async () => {
    const list = await sc.admin<Any[]>("GET", P(sc, "/form-templates"));
    tpl = list.find((t) => t.code === "GSR") ?? (await sc.admin<Any>("POST", P(sc, "/form-templates/from-library"), { key: "gunluk-santiye-raporu", code: "GSR" }));
    const f = await saha<Any>("POST", P(sc, "/forms"), { templateId: tpl.id, formDate: dayOffset(0) });
    formId = f.id;
    const items = itemsOf(f.schema ?? (await saha<Any>("GET", P(sc, `/form-templates/${tpl.id}`))).schema);
    const values: Record<string, unknown> = {};
    for (const it of items) if (it.type === "yes_no") values[it.id] = "yes";
    await saha("PATCH", P(sc, `/forms/${formId}`), { values });
    return sc.url(`forms/${formId}`);
  });
  await sc.step("Saha: Sorun aç", async () => {
    const i = await saha<Any>("POST", P(sc, "/issues"), { title: "Kolon pas payı yetersiz", priority: "high", dueDate: dayOffset(-2) });
    expect(i.number, "Sorun numarası yok.");
    return sc.url(`issues/${i.id}`);
  });
  await sc.step("Saha: Fotoğraf ekle", async () => {
    const f = await saha<Any>("GET", P(sc, `/forms/${formId}`));
    const photo = itemsOf(f.schema ?? (await saha<Any>("GET", P(sc, `/form-templates/${tpl.id}`))).schema).find((i: Any) => i.type === "photo");
    expect(photo, "Şablonda fotoğraf maddesi yok.");
    const form = new FormData();
    form.append("itemId", photo.id);
    form.append("file", new Blob([new Uint8Array(PNG_1X1)], { type: "image/png" }), "foto.png");
    const att = await saha<Any>("POST", P(sc, `/forms/${formId}/attachments`), form);
    await saha("PATCH", P(sc, `/forms/${formId}`), { values: { ...(f.values ?? {}), [photo.id]: [att.id] } });
  });
  await sc.step("Saha: Bana düşenlere bak", async () => {
    const t = await saha<Any>("GET", "/me/today");
    expect(t.counts, "Bugün sayfası cevap vermedi.");
    return sc.url("/today");
  });
  await sc.step("Saha: Eylemi kapat", async () => {
    const m = await meetingWithActions(sc, doc, sc.a.contractor.userId);
    meeting = m.meeting;
    actions = m.actions;
    const mine = actions.find((x) => x.assigneeUserId === sc.a.contractor.userId) ?? actions[0];
    const w = await saha<Any>("PATCH", P(sc, `/works/${mine.id}`), { status: "kapandi" });
    expect(w.closed, "Eylem kapanmadı.");
  });
  // Doküman kontrol
  let up: Any;
  await sc.step("Doküman: Dosya yükle", async () => {
    up = await uploadFile(doc, sc.p.id, sc.folderId, { name: `SCN-${Date.now() % 100000}-M-401.pdf`, data: await pdfDrawing({ number: "M-401" }) });
    return sc.url(`files/${sc.folderId}`);
  });
  await sc.step("Doküman: İncelemeye gönder", async () => {
    const tid = await reviewTemplate(sc);
    const rv = await doc<Any>("POST", P(sc, "/reviews"), { name: "Mekanik pafta", templateId: tid, versionIds: [up.versionId] });
    expect(rv.status === "running", "İnceleme başlamadı.");
    return sc.url(`reviews/${rv.id}`);
  });
  let inc: Any;
  await sc.step("Doküman: Gelen yazıyı kaydet", async () => {
    inc = await incomingLetter(sc, "Saha teslim tutanağı");
    return sc.url(`works/${inc.id}`);
  });
  await sc.step("Doküman: Cevap yaz", async () => {
    const r = await doc<Any>("POST", P(sc, `/works/${inc.id}/reply`), {});
    await doc("PUT", P(sc, `/works/${r.id}/letter`), { body: "Tutanak tarafımızca imzalanmıştır.", signer: { name: "Elif Yıldız", title: "Doküman Kontrol" } });
    await doc("POST", P(sc, `/works/${r.id}/send`), { channel: "elden" });
    return sc.url(`works/${r.id}`);
  });
  await sc.step("Doküman: Gönderim formu oluştur", async () => {
    const w = await doc<Any>("POST", P(sc, "/works"), {
      typeKey: "transmittal",
      title: "Mekanik paftalar gönderimi",
      toCompanyIds: [sc.a.consultant.companyId],
      fields: { amac: "onay" },
      links: [{ kind: "file_version", targetId: up.versionId }],
    });
    const s = await doc<Any>("POST", P(sc, `/works/${w.id}/send`), { channel: "cde" });
    expect(s.status === "gonderildi", `Gönderim formu 'gonderildi' olmalı, ${s.status} geldi.`);
    return sc.url(`works/${w.id}`);
  });
  // Proje müdürü
  await sc.step("Proje müdürü: Bugünkü durumu gör", async () => {
    const t = await pm<Any>("GET", "/me/today");
    expect(t.counts, "Bugün sayfası cevap vermedi.");
    return sc.url("/today");
  });
  await sc.step("Proje müdürü: Geciken işleri gör", async () => {
    await saha("POST", P(sc, "/works"), {
      typeKey: "gelen-yazi",
      title: "Gecikmiş yazı",
      fromCompanyId: sc.a.client.companyId,
      toCompanyIds: [sc.a.contractor.companyId, sc.a.client.companyId],
      replyRequired: true,
      dueDate: dayOffset(-3),
    });
    const list = await sc.admin<Any>("GET", P(sc, "/works?due=overdue"));
    const n = Array.isArray(list) ? list.length : (list.works ?? list.items ?? []).length;
    expect(n > 0, "Geciken iş listesi boş.");
    return sc.url("works?due=overdue");
  });
  await sc.step("Proje müdürü: Rapor aç", async () => {
    const cat = await pm<Any>("GET", P(sc, "/reports/catalog"));
    const t = (cat.templates as Any[])[0];
    expect(t, "Rapor şablonu yok.");
    const r = await pm<Any>("POST", P(sc, "/reports/query"), { queries: t.queries, strict: false });
    expect(r.results, "Rapor sorgusu cevap vermedi.");
    return sc.url(`reports?template=${t.id}`);
  });
  await sc.step("Proje müdürü: Onay ver", async () => {
    const it = await saha<Any>("POST", P(sc, "/works"), {
      typeKey: "submittal-kalemi",
      title: "Asansör kabin seçimi",
      fields: { tur: "NUM - Numune", disiplin: "A - Mimari" },
      toCompanyIds: [sc.a.client.companyId],
    });
    await saha("POST", P(sc, `/works/${it.id}/submit`), {});
    await pm("POST", P(sc, `/works/${it.id}/respond`), { outcome: "approved", comment: "Uygun" });
    const w = await pm<Any>("GET", P(sc, `/works/${it.id}`));
    expect(w.status === "onaylandi", `Onay verilemedi (${w.status}).`);
    return sc.url(`works/${it.id}`);
  });
  await sc.step("Proje müdürü: Toplantı tutanağına bak", async () => {
    const w = await pm<Any>("GET", P(sc, `/works/${meeting.id}`));
    expect(JSON.stringify(w.build?.meeting ?? {}).includes("Kalıp çizimi revizyonu"), "Tutanak maddeleri görünmüyor.");
    const pdf = await sc.dev.getBinary(P(sc, `/works/${meeting.id}/minutes.pdf`), sc.a.client.userId);
    expect(pdf.status === 200, `Tutanak PDF'i alınamadı (HTTP ${pdf.status}).`);
    return sc.url(`works/${meeting.id}`);
  });
}

const LIBRARY: Record<ScenarioId, { title: string; run: (sc: Sc) => Promise<void> }> = {
  "yazisma-dongusu": { title: "Yazışma döngüsü: gelen → cevap → gönder → Cevaplandı", run: yazismaDongusu },
  "bilgi-talebi": { title: "Bilgi talebi: oluştur → gönder → cevapla → kapat", run: bilgiTalebi },
  "teknik-onay": { title: "Teknik onay: kalem → paket → inceleme → revize → onay", run: teknikOnay },
  toplanti: { title: "Toplantı: tutanak → eylemler → kapat", run: toplanti },
  inceleme: { title: "İnceleme: yükle → onay zinciri → onay → kapılı klasör", run: inceleme },
  "form-pdf": { title: "PDF form: PDF → şablon → akış → doldur → onay → dolu PDF", run: formPdf },
  rapor: { title: "Rapor: şablondan panel, yazınca damga değişir", run: rapor },
  karsilastirma: { title: "Karşılaştırma: iki PDF revizyonu → doküman karşılaştırma", run: karsilastirma },
  gorunum: { title: "Sadeleştirme: 15 kişi görevi (saha, doküman kontrol, proje müdürü)", run: gorunum },
};

export function listScenarios() {
  return DEV_SCENARIOS.map((id) => ({ id, title: LIBRARY[id].title }));
}

/** Markdown table of the results (Turkish). */
export function scenarioTable(results: ScenarioResult[]): string {
  const rows = results.flatMap((r) => [
    `| **${r.scenario}** | ${r.ok ? "GEÇTİ" : "KALDI"} | ${r.seconds} sn | |`,
    ...r.steps.map((s) => `| · ${s.step} | ${s.skipped ? "atlandı" : s.ok ? "geçti" : "kaldı"} | ${s.ms} ms | ${s.error ? s.error.replace(/\|/g, "/").slice(0, 120) : (s.link ?? "")} |`),
  ]);
  return ["| Senaryo / Adım | Sonuç | Süre | Bağlantı / Hata |", "|---|---|---|---|", ...rows].join("\n");
}

export async function runScenarios(ctx: DevContext, a: { scenarios?: string[]; project?: string; list?: boolean }) {
  if (a.list) return { scenarios: listScenarios() };
  const ids = (a.scenarios?.length ? a.scenarios : DEV_SCENARIOS) as ScenarioId[];
  let p: ProjectRow;
  if (a.project) {
    p = await findProject(ctx.db, a.project);
    await requireTestProject(ctx.db, p, true, "Senaryo çalıştırmak");
  } else {
    const stamp = new Date().toISOString().slice(5, 19).replace(/[-T:]/g, "");
    const created = await ctx.call<Any>("POST", "/projects", { code: `SCN-${stamp}-TEST`, name: `Senaryo Testi ${stamp}`, template: "iso19650" });
    await updateRegistry(ctx.db, ctx.admin.id, (r) => {
      r.projects[created.id] = { createdByDev: true, createdAt: new Date().toISOString() };
    });
    p = await findProject(ctx.db, created.id);
  }
  const actors = await ensureActors(ctx, p.id);
  const folderId = await ensureSeedFolder(ctx, p.id, actors.all.map((x) => x.companyId));
  const results: ScenarioResult[] = [];
  for (const id of ids) {
    const def = LIBRARY[id];
    if (!def) continue;
    const sc = new Sc(ctx, p, actors, folderId);
    const t = Date.now();
    try {
      await def.run(sc);
    } catch (e) {
      sc.steps.push({ step: "senaryo", ok: false, ms: 0, calls: 0, error: (e as Error).message });
    }
    results.push({ scenario: id, title: def.title, ok: sc.steps.every((s) => s.ok), seconds: Math.round((Date.now() - t) / 100) / 10, steps: sc.steps });
  }
  return {
    project: p.code,
    projectLink: link(ctx, projectPath(p.id)),
    passed: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    results,
    table: scenarioTable(results),
  };
}
