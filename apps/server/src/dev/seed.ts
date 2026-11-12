/**
 * cde_dev_seed: realistic synthetic records in a test/demo project, created through the real
 * routes as demo members of the right companies (so numbering, workflows, ball-in-court, PDFs and
 * permissions are the app's own), then backdated (dev only; the API stamps "now").
 *
 * Idempotent per tag: the registry (system_settings "dev.registry") keeps every record id; works
 * also carry data.devSeed = tag. action "remove" deletes a tag's records again.
 */
import { moduleTable } from "../app/modules.js";
import { waitForJobs } from "./wait-jobs.js";
import { and, count, eq, inArray, sql } from "drizzle-orm";
import type { CdeCall } from "@sitekeep/cde-tools";
import {
  files,
  issues,
  locations,
  modelSets,
  reviews,
  workflowInstances,
  workflowTemplates,
  works,
} from "../db/schema.js";
import type { DevContext } from "./context.js";
import { link } from "./context.js";
import { ensureActors, ensureSeedFolder, ensureSubFolder, type Actors } from "./actors.js";
import { DAY_SEC, setStepDue, setWorkDue, shiftForm, shiftIssue, shiftReview, shiftWork } from "./dates.js";
import {
  ISSUE_TITLES,
  LETTER_BODIES,
  LETTER_SUBJECTS,
  MEETING_ITEMS,
  MEETING_TOPICS,
  RFI_ANSWERS,
  RFI_QUESTIONS,
  Rng,
  SUBMITTAL_ITEMS,
  TRANSMITTAL_SUBJECTS,
  dayOffset,
  seedFromTag,
} from "./random.js";
import { findProject, requireTestProject, readRegistry, updateRegistry, type DevSeedEntry, type ProjectRow } from "./registry.js";
import { PNG_1X1, fixture, makeSample } from "./samples.js";
import { uploadFile } from "./upload.js";
import { projectPath } from "@sitekeep/shared";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

export const SEED_DEFAULTS = {
  incomingLetters: 6,
  outgoingLetters: 4,
  rfis: 5,
  submittals: 4,
  meetings: 2,
  transmittals: 2,
  issues: 8,
  reviews: 2,
  forms: 4,
  schedule: true,
  clashes: false,
};

type Counts = typeof SEED_DEFAULTS;
type Records = Record<string, string[]>;

const DISCIPLINES = ["A - Mimari", "S - Statik", "M - Mekanik", "E - Elektrik"];
const SUB_TYPES = ["MOS - Malzeme Onay", "UCZ - Uygulama / Atölye Çizimi", "NUM - Numune", "YB - Yöntem Beyanı"];
const PRIORITIES = ["low", "normal", "normal", "high", "critical"] as const;
const SUB_OUTCOMES = ["approved", "approved_with_comments", "revise_resubmit", "rejected"] as const;

class Seeder {
  readonly records: Records = {};
  readonly notes: string[] = [];
  private seq = 0;
  constructor(
    readonly ctx: DevContext,
    readonly p: ProjectRow,
    readonly a: Actors,
    readonly rng: Rng,
    readonly overdueRatio: number,
    readonly backdateDays: number,
    readonly tag: string,
  ) {}

  add(kind: string, id: string) {
    (this.records[kind] ??= []).push(id);
  }

  /** Days ago a record was created (spread over the backdate window, newest last). */
  age(i: number, n: number): number {
    if (this.backdateDays <= 1) return 0;
    const span = Math.max(1, this.backdateDays - 2);
    return Math.max(1, Math.round(this.backdateDays - (span * (i + this.rng.next() * 0.8)) / Math.max(1, n)));
  }

  /** Due date for an open record: overdue (in the past) with the configured ratio, else upcoming. */
  due(ageDays: number): { date: string; overdue: boolean } {
    if (this.rng.chance(this.overdueRatio) && ageDays > 2) return { date: dayOffset(-this.rng.int(1, Math.max(1, Math.min(ageDays - 1, 30)))), overdue: true };
    return { date: dayOffset(this.rng.int(3, 21)), overdue: false };
  }

  as(userId: string): Promise<CdeCall> {
    return this.ctx.as(userId);
  }

  sec(days: number): number {
    return -Math.round(days * DAY_SEC + this.rng.int(0, 6 * 3600));
  }

  nextNo(): number {
    return ++this.seq;
  }
}

// ---- Works ---------------------------------------------------------------------------------

async function letters(s: Seeder, nIn: number, nOut: number) {
  const { contractor: yuk, consultant: msv, client: idr } = s.a;
  const call = await s.as(yuk.userId);
  const p = s.p.id;
  const sent: string[] = [];
  let outLeft = nOut;
  for (let i = 0; i < nIn; i++) {
    const age = s.age(i, nIn);
    const from = s.rng.chance(0.6) ? idr : msv;
    const subject = s.rng.pick(LETTER_SUBJECTS);
    const replyRequired = s.rng.chance(0.75);
    const d = s.due(age);
    const ilgi = sent.length && s.rng.chance(0.35) ? [{ kind: "work", targetId: s.rng.pick(sent) }] : undefined;
    const w = await call<Any>("POST", `/projects/${p}/works`, {
      typeKey: "gelen-yazi",
      title: subject,
      fromCompanyId: from.companyId,
      toCompanyIds: [yuk.companyId],
      replyRequired,
      ...(replyRequired && { dueDate: d.date }),
      fields: { sayi: `E-${String(10000 + s.nextNo())}`, tarih: dayOffset(-age), konu: subject, ozet: s.rng.pick(LETTER_BODIES) },
      ...(ilgi && { links: ilgi }),
    });
    s.add("works", w.id);
    await shiftWork(s.ctx.db, w.id, s.sec(age));
    // Answer some of them: reply → letter text → send (elden: nothing leaves the server).
    if (replyRequired && outLeft > 0 && s.rng.chance(0.55)) {
      outLeft--;
      const replyAge = Math.max(0, age - s.rng.int(1, Math.min(age, 7)));
      const r = await call<Any>("POST", `/projects/${p}/works/${w.id}/reply`, {});
      s.add("works", r.id);
      await call("PUT", `/projects/${p}/works/${r.id}/letter`, {
        body: `İlgi yazınız incelenmiştir. ${s.rng.pick(LETTER_BODIES)}`,
        signer: { name: yuk.userName.replace(" (Demo)", ""), title: "Proje Müdürü" },
      });
      await call("POST", `/projects/${p}/works/${r.id}/send`, { channel: "elden", reference: `TUT-${dayOffset(-replyAge).slice(0, 4)}-${s.nextNo()}` });
      await shiftWork(s.ctx.db, r.id, s.sec(replyAge));
      sent.push(r.id);
    }
  }
  // Standalone outgoing letters (some with an ilgi to an earlier letter, some still drafts).
  for (let i = 0; i < outLeft; i++) {
    const age = s.age(i, outLeft);
    const to = s.rng.chance(0.5) ? idr : msv;
    const subject = s.rng.pick(LETTER_SUBJECTS);
    const replyRequired = s.rng.chance(0.4);
    const ilgi = s.records.works?.length && s.rng.chance(0.4) ? [{ kind: "work", targetId: s.rng.pick(s.records.works) }] : undefined;
    const w = await call<Any>("POST", `/projects/${p}/works`, {
      typeKey: "giden-yazi",
      title: subject,
      toCompanyIds: [to.companyId],
      replyRequired,
      ...(replyRequired && { dueDate: s.due(age).date }),
      fields: { konu: subject },
      ...(ilgi && { links: ilgi }),
    });
    s.add("works", w.id);
    await call("PUT", `/projects/${p}/works/${w.id}/letter`, { body: s.rng.pick(LETTER_BODIES), signer: { name: yuk.userName.replace(" (Demo)", ""), title: "Proje Müdürü" } });
    if (s.rng.chance(0.8)) await call("POST", `/projects/${p}/works/${w.id}/send`, { channel: s.rng.pick(["elden", "cde"]), reference: `GID-${s.nextNo()}` });
    await shiftWork(s.ctx.db, w.id, s.sec(age));
  }
}

async function rfis(s: Seeder, n: number) {
  const { contractor: yuk, consultant: msv } = s.a;
  const asYuk = await s.as(yuk.userId);
  const asMsv = await s.as(msv.userId);
  const p = s.p.id;
  for (let i = 0; i < n; i++) {
    const age = s.age(i, n);
    const q = s.rng.pick(RFI_QUESTIONS);
    const w = await asYuk<Any>("POST", `/projects/${p}/works`, {
      typeKey: "rfi",
      title: q.split(".")[0]!.slice(0, 80),
      toCompanyIds: [msv.companyId],
      fields: {
        soru: q,
        disiplin: s.rng.pick(DISCIPLINES),
        kategori: s.rng.pick(["Tasarım Koordinasyonu", "Saha Uygulaması", "Malzeme", "Diğer"]),
        oncelik: s.rng.pick(["Düşük", "Normal", "Yüksek", "Acil"]),
        maliyet_etkisi: s.rng.pick(["Yok", "Var", "Belirsiz"]),
        takvim_etkisi: s.rng.pick(["Yok", "Var", "Belirsiz"]),
      },
    });
    s.add("works", w.id);
    const roll = s.rng.next();
    if (roll < 0.1) {
      await shiftWork(s.ctx.db, w.id, s.sec(age));
      continue; // draft
    }
    await asYuk("POST", `/projects/${p}/works/${w.id}/submit`, { comment: "İncelemenize sunulur." });
    let open = true;
    if (roll > 0.45) {
      await asMsv("POST", `/projects/${p}/works/${w.id}/respond`, { outcome: "CEVAP", response: s.rng.pick(RFI_ANSWERS), comment: "Cevaplandı." });
      if (roll > 0.72) {
        await asYuk("PATCH", `/projects/${p}/works/${w.id}`, { status: "kapandi" });
        open = false;
      }
    }
    await shiftWork(s.ctx.db, w.id, s.sec(age));
    await setWorkDue(s.ctx.db, w.id, open ? s.due(age).date : dayOffset(-Math.max(0, age - 7)));
  }
}

async function submittals(s: Seeder, n: number) {
  if (!n) return;
  const { contractor: yuk, consultant: msv } = s.a;
  const asYuk = await s.as(yuk.userId);
  const asMsv = await s.as(msv.userId);
  const p = s.p.id;
  const packages = Math.max(1, Math.ceil(n / 4));
  let made = 0;
  for (let k = 0; k < packages; k++) {
    const age = s.age(k, packages);
    const disiplin = s.rng.pick(DISCIPLINES);
    const pkg = await asYuk<Any>("POST", `/projects/${p}/works`, {
      typeKey: "submittal-paketi",
      title: `${disiplin.slice(4)} malzemeleri`,
      fields: { bolum: "MOS", disiplin },
      toCompanyIds: [msv.companyId],
    });
    s.add("works", pkg.id);
    const items: string[] = [];
    const per = Math.min(4, n - made);
    for (let j = 0; j < per; j++, made++) {
      const it = await asYuk<Any>("POST", `/projects/${p}/works`, {
        typeKey: "submittal-kalemi",
        title: s.rng.pick(SUBMITTAL_ITEMS),
        fields: { tur: s.rng.pick(SUB_TYPES), disiplin, bolum_kodu: `${s.rng.int(3, 26)} ${s.rng.int(10, 90)} 00` },
        toCompanyIds: [msv.companyId],
        parentWorkId: pkg.id,
      });
      s.add("works", it.id);
      items.push(it.id);
    }
    await asYuk("POST", `/projects/${p}/works/${pkg.id}/submit`, {});
    for (const id of items) {
      const outcome = s.rng.chance(0.25) ? null : s.rng.pick(SUB_OUTCOMES);
      if (!outcome) continue; // still under review
      await asMsv("POST", `/projects/${p}/works/${id}/respond`, { outcome, comment: outcome === "revise_resubmit" ? "Teknik föy eksik; revize edip tekrar gönderin." : "İncelendi." });
      if (outcome === "revise_resubmit" && s.rng.chance(0.6)) {
        await asYuk("POST", `/projects/${p}/works/${id}/revise`, {});
        await asYuk("POST", `/projects/${p}/works/${id}/submit`, { comment: "Rev 1" });
        if (s.rng.chance(0.6)) await asMsv("POST", `/projects/${p}/works/${id}/respond`, { outcome: "approved", comment: "Rev 1 uygun." });
      }
    }
    for (const id of [pkg.id, ...items]) {
      await shiftWork(s.ctx.db, id, s.sec(age));
      const [w] = await s.ctx.db.select({ status: works.status }).from(works).where(eq(works.id, id));
      if (w && ["incelemede", "revize", "taslak"].includes(w.status)) await setWorkDue(s.ctx.db, id, s.due(age).date);
    }
  }
}

async function meetings(s: Seeder, n: number) {
  const { contractor: yuk, consultant: msv, client: idr } = s.a;
  const call = await s.as(yuk.userId);
  const p = s.p.id;
  for (let i = 0; i < n; i++) {
    const age = s.age(i, n);
    const held = age > 1;
    const m = await call<Any>("POST", `/projects/${p}/works`, {
      typeKey: "toplanti",
      title: s.rng.pick(MEETING_TOPICS),
      toCompanyIds: [msv.companyId, idr.companyId],
      fields: { tur: s.rng.pick(["Koordinasyon", "İlerleme", "İSG", "Tasarım"]), tarih: dayOffset(held ? -age + 1 : 3), saat: "10:00", yer: "Şantiye ofisi" },
    });
    s.add("works", m.id);
    await call("PUT", `/projects/${p}/works/${m.id}/meeting`, {
      attendees: [yuk, msv, idr].map((x) => ({ userId: x.userId, companyId: x.companyId, present: true })),
      agenda: s.rng.sample(MEETING_ITEMS, 3).map((x) => ({ text: x.konu })),
    });
    if (held) {
      const items = s.rng.sample(MEETING_ITEMS, 4).map((x, k) =>
        k < 2 ? { ...x, sorumluUserId: (k === 0 ? msv : yuk).userId, termin: dayOffset(-age + 1 + s.rng.int(5, 20)) } : x,
      );
      await call("PUT", `/projects/${p}/works/${m.id}/minutes`, { items, notes: "Toplantı olumlu geçti." });
      const actions = await s.ctx.db.select({ id: works.id, assignee: works.assigneeUserId }).from(works).where(eq(works.parentWorkId, m.id));
      for (const act of actions) {
        s.add("works", act.id);
        const closeIt = age > 20 && s.rng.chance(0.6);
        if (closeIt) await (await s.as(act.assignee ?? yuk.userId))("PATCH", `/projects/${p}/works/${act.id}`, { status: "kapandi" });
        await shiftWork(s.ctx.db, act.id, s.sec(Math.max(0, age - 1)));
        if (!closeIt) await setWorkDue(s.ctx.db, act.id, s.due(age).date);
      }
      if (age > 14) await call("PATCH", `/projects/${p}/works/${m.id}`, { status: "kapandi" });
    }
    await shiftWork(s.ctx.db, m.id, s.sec(age));
  }
}

async function transmittals(s: Seeder, n: number, folderId: string) {
  if (!n) return;
  const { contractor: yuk, consultant: msv, client: idr } = s.a;
  const asYuk = await s.as(yuk.userId);
  const asMsv = await s.as(msv.userId);
  const p = s.p.id;
  for (let i = 0; i < n; i++) {
    const age = s.age(i, n);
    const versions: string[] = [];
    for (let k = 0; k < 2; k++) {
      const u = await uploadFile(asYuk, p, folderId, await makeSample("pdf_drawing", { name: `${s.tag.toUpperCase()}-GF${i + 1}-A-${k + 101}.pdf`, revision: "A" }));
      s.add("files", u.fileId);
      versions.push(u.versionId);
    }
    const w = await asYuk<Any>("POST", `/projects/${p}/works`, {
      typeKey: "transmittal",
      title: s.rng.pick(TRANSMITTAL_SUBJECTS),
      toCompanyIds: [msv.companyId],
      ccCompanyIds: [idr.companyId],
      fields: { amac: s.rng.pick(["bilgi", "onay", "uygulama"]), not: "Ekte sunulmuştur." },
      links: versions.map((v) => ({ kind: "file_version", targetId: v })),
    });
    s.add("works", w.id);
    if (s.rng.chance(0.85)) {
      await asYuk("POST", `/projects/${p}/works/${w.id}/send`, { channel: "cde" });
      if (s.rng.chance(0.6)) await asMsv("POST", `/projects/${p}/works/${w.id}/receive`, {});
    }
    await shiftWork(s.ctx.db, w.id, s.sec(age));
  }
}

// ---- Issues, reviews, forms ------------------------------------------------------------------

async function issuesSeed(s: Seeder, n: number) {
  const p = s.p.id;
  for (let i = 0; i < n; i++) {
    const age = s.age(i, n);
    const author = s.rng.pick([s.a.contractor, s.a.consultant]);
    const assignee = s.rng.pick(s.a.all);
    const call = await s.as(author.userId);
    const d = s.due(age);
    const title = s.rng.pick(ISSUE_TITLES);
    const iss = await call<Any>("POST", `/projects/${p}/issues`, {
      title,
      description: `${title}. Sahada tespit edildi, düzeltilmesi gerekiyor.`,
      priority: s.rng.pick(PRIORITIES),
      assigneeUserId: assignee.userId,
      dueDate: d.date,
    });
    s.add("issues", iss.id);
    const r = s.rng.next();
    const status = r < 0.45 ? null : r < 0.65 ? "in_progress" : r < 0.75 ? "in_review" : "closed";
    if (status) await call("PATCH", `/projects/${p}/issues/${iss.id}`, { status });
    await shiftIssue(s.ctx.db, iss.id, s.sec(age));
  }
}

async function reviewsSeed(s: Seeder, n: number, folderId: string) {
  if (!n) return;
  const { contractor: yuk, consultant: msv, client: idr } = s.a;
  const p = s.p.id;
  const tpl = await s.ctx.call<Any>("POST", `/projects/${p}/workflow-templates`, {
    kind: "review",
    name: `Demo İnceleme (${s.tag})`,
    steps: [
      { name: "Müşavir İncelemesi", assignees: [{ type: "company", id: msv.companyId }], rule: "any", days: 5, outcomes: ["approved", "approved_with_comments", "revise_resubmit", "rejected"] },
      { name: "İdare Onayı", assignees: [{ type: "company", id: idr.companyId }], rule: "any", days: 3, outcomes: ["approved", "approved_with_comments", "rejected"] },
    ],
  });
  s.add("workflowTemplates", tpl.id);
  const target = await ensureSubFolder(s.ctx, p, folderId, "Onaylananlar");
  const asYuk = await s.as(yuk.userId);
  for (let i = 0; i < n; i++) {
    const age = s.age(i, n);
    const ups = [];
    for (let k = 0; k < 2; k++) {
      const u = await uploadFile(asYuk, p, folderId, await makeSample("pdf_drawing", { name: `${s.tag.toUpperCase()}-IN${i + 1}-S-${k + 201}.pdf`, revision: "B" }));
      s.add("files", u.fileId);
      ups.push(u);
    }
    const rv = await asYuk<Any>("POST", `/projects/${p}/reviews`, {
      name: `Statik paftalar ${i + 1}`,
      note: "İncelemenize sunulur.",
      templateId: tpl.id,
      versionIds: ups.map((u) => u.versionId),
      targetFolderId: target,
    });
    s.add("reviews", rv.id);
    const stage = s.rng.next();
    if (stage > 0.4) {
      await (await s.as(msv.userId))("POST", `/projects/${p}/reviews/${rv.id}/submit`, {
        comment: "Müşavir görüşü",
        files: rv.files.map((f: Any, k: number) => ({ reviewFileId: f.id, outcome: k === 0 ? "approved" : "approved_with_comments", ...(k > 0 && { comment: "Akslar kontrol edilsin." }) })),
      });
      if (stage > 0.75)
        await (await s.as(idr.userId))("POST", `/projects/${p}/reviews/${rv.id}/submit`, { comment: "Uygundur.", files: rv.files.map((f: Any) => ({ reviewFileId: f.id, outcome: "approved" })) });
    }
    await shiftReview(s.ctx.db, rv.id, s.sec(age));
    const [inst] = await s.ctx.db.select({ status: workflowInstances.status }).from(workflowInstances).where(sql`${workflowInstances.subjectType} = 'review' and ${workflowInstances.subjectId} = ${rv.id}`);
    if (inst?.status === "running") {
      const d = s.due(age);
      await setStepDue(s.ctx.db, "review", rv.id, new Date(`${d.date}T17:00:00`));
    }
  }
}

/** A plausible answer for every item of a form template (some yes/no items fail). */
async function fillValues(s: Seeder, call: CdeCall, formId: string, schema: Any, locationId: string | null, date: string, failRatio: number) {
  const values: Record<string, unknown> = {};
  const failures: string[] = [];
  for (const sec of schema.sections ?? [])
    for (const it of sec.items ?? []) {
      switch (it.type) {
        case "yes_no": {
          const fail = s.rng.chance(failRatio);
          values[it.id] = fail ? "no" : s.rng.chance(0.1) ? "na" : "yes";
          if (fail) failures.push(it.label);
          break;
        }
        case "text":
          values[it.id] = it.multiline ? "Genel durum iyi; tespitler tabloda." : "Demo Ekip";
          break;
        case "number":
        case "km":
          values[it.id] = typeof it.min === "number" ? it.min + (typeof it.max === "number" ? (it.max - it.min) / 2 : 1) : 12;
          break;
        case "date":
          values[it.id] = date;
          break;
        case "choice":
          if (it.options?.length) values[it.id] = it.options[0];
          break;
        case "multi_choice":
          if (it.options?.length) values[it.id] = [it.options[0]];
          break;
        case "location":
          if (locationId) values[it.id] = locationId;
          break;
        case "table":
          if (failures.length) {
            const cols = it.columns ?? [];
            values[it.id] = failures.slice(0, 2).map((f) => Object.fromEntries(cols.map((c: Any) => [c.id, c.type === "date" ? dayOffset(7) : c.type === "number" ? 1 : f.slice(0, 60)])));
          }
          break;
        case "signature": {
          const form = new FormData();
          form.append("itemId", it.id);
          form.append("file", new Blob([new Uint8Array(PNG_1X1)], { type: "image/png" }), "imza.png");
          const att = await call<Any>("POST", `/projects/${s.p.id}/forms/${formId}/attachments`, form);
          values[it.id] = att.id;
          break;
        }
        default:
          break;
      }
    }
  return values;
}

async function formsSeed(s: Seeder, n: number) {
  if (!n) return;
  const p = s.p.id;
  const list = await s.ctx.call<Any[]>("GET", `/projects/${p}/form-templates`);
  let tpl = list.find((t) => t.code === "ISG" && !t.archivedAt);
  if (!tpl) {
    tpl = await s.ctx.call<Any>("POST", `/projects/${p}/form-templates/from-library`, { key: "isg-saha-denetimi" });
    s.add("formTemplates", tpl.id);
  }
  const full = await s.ctx.call<Any>("GET", `/projects/${p}/form-templates/${tpl.id}`);
  const [loc] = await s.ctx.db.select({ id: locations.id }).from(locations).where(and(eq(locations.projectId, p), eq(locations.code, "DEMO-A")));
  let locationId = loc?.id ?? null;
  if (!locationId) {
    const l = await s.ctx.call<Any>("POST", `/projects/${p}/locations`, { name: "A Blok (demo)", code: "DEMO-A", type: "Blok" });
    locationId = l.id;
    s.add("locations", l.id);
  }
  const asYuk = await s.as(s.a.contractor.userId);
  for (let i = 0; i < n; i++) {
    const age = s.age(i, n);
    const date = dayOffset(-age);
    const f = await asYuk<Any>("POST", `/projects/${p}/forms`, { templateId: tpl.id, locationId, formDate: date });
    s.add("forms", f.id);
    const values = await fillValues(s, asYuk, f.id, full.schema, locationId, date, 0.25);
    await asYuk("PATCH", `/projects/${p}/forms/${f.id}`, { values });
    if (s.rng.chance(0.75)) {
      try {
        await asYuk("POST", `/projects/${p}/forms/${f.id}/submit`, {});
        if (s.rng.chance(0.5)) await s.ctx.call("POST", `/projects/${p}/forms/${f.id}/close`, {});
      } catch (e) {
        s.notes.push(`Form ${f.number} gönderilemedi: ${(e as Error).message.slice(0, 120)}`);
      }
    }
    await shiftForm(s.ctx.db, f.id, s.sec(age));
  }
}

// ---- Schedule and clashes --------------------------------------------------------------------

async function scheduleSeed(s: Seeder) {
  const p = s.p.id;
  const up = async (name: string, data: Buffer, fields: Record<string, string>) => {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    form.append("file", new Blob([new Uint8Array(data)]), name);
    return s.ctx.call<Any>("POST", `/projects/${p}/schedules`, form);
  };
  const v1 = await up("is-programi-v1.xml", fixture("schedule-v1.xml"), { name: `İş Programı (${s.tag})` });
  s.add("schedules", v1.id);
  const v2 = await up("is-programi-v2.xml", fixture("schedule-v2.xml"), { seriesId: v1.id });
  s.add("schedules", v2.id);
}

/** Waits until the job queue is idle (IFC conversion, clash runs). */
async function clashSeed(s: Seeder, folderId: string) {
  const p = s.p.id;
  const arch = await uploadFile(s.ctx.call, p, folderId, { name: `${s.tag.toUpperCase()}-ARC-Model.ifc`, data: fixture("coord-arch.ifc") });
  const mep = await uploadFile(s.ctx.call, p, folderId, { name: `${s.tag.toUpperCase()}-MEP-Model.ifc`, data: fixture("coord-mep.ifc") });
  s.add("files", arch.fileId);
  s.add("files", mep.fileId);
  if (!(await waitForJobs(s.ctx))) s.notes.push("IFC dönüşümü zamanında bitmedi.");
  const set = await s.ctx.call<Any>("POST", `/projects/${p}/model-sets`, {
    name: `Demo Birleşik Model (${s.tag})`,
    items: [
      { fileId: arch.fileId, versionId: null },
      { fileId: mep.fileId, versionId: null },
    ],
  });
  s.add("modelSets", set.id);
  const test = await s.ctx.call<Any>("POST", `/projects/${p}/clash-tests`, {
    name: "Mimari × Mekanik (sert)",
    modelSetId: set.id,
    selectionA: { fileIds: [arch.fileId], classes: ["IfcWall", "IfcSlab"] },
    selectionB: { fileIds: [mep.fileId], classes: [] },
    type: "hard",
  });
  s.add("clashTests", test.id);
  await s.ctx.call("POST", `/projects/${p}/clash-tests/${test.id}/run`, {});
  if (!(await waitForJobs(s.ctx))) s.notes.push("Çakışma testi zamanında bitmedi.");
}

// ---- Entry -----------------------------------------------------------------------------------

async function summarize(ctx: DevContext, projectId: string, records: Records) {
  const ids = records.works ?? [];
  const rows = ids.length
    ? await ctx.db.select({ status: works.status, due: works.dueDate, closedAt: works.closedAt }).from(works).where(inArray(works.id, ids))
    : [];
  const today = dayOffset(0);
  return {
    counts: Object.fromEntries(Object.entries(records).map(([k, v]) => [k, v.length])),
    worksOverdue: rows.filter((r) => !r.closedAt && r.due && r.due < today).length,
    link: link(ctx, projectPath(projectId, "works")),
  };
}

export async function devSeed(ctx: DevContext, a: Record<string, unknown>) {
  const p = await findProject(ctx.db, String(a.project));
  const tag = String(a.tag ?? "demo");
  const reg = await readRegistry(ctx.db);
  const existing = reg.projects[p.id]?.seeds?.[tag];
  if (a.action === "status") {
    return {
      project: p.code,
      seeds: Object.fromEntries(Object.entries(reg.projects[p.id]?.seeds ?? {}).map(([k, v]) => [k, { at: v.at, counts: v.counts }])),
    };
  }
  if (a.action === "remove") {
    await requireTestProject(ctx.db, p, a.confirm as boolean, "Örnek veriyi silmek");
    if (!existing) return { project: p.code, tag, removed: false, note: "Bu etiketle örnek veri yok." };
    const removed = await removeRecords(ctx, p.id, existing.records);
    await updateRegistry(ctx.db, ctx.admin.id, (r) => {
      delete r.projects[p.id]?.seeds?.[tag];
    });
    return { project: p.code, tag, removed: true, counts: removed };
  }
  // create: test/demo projects only (seed data must never mix with real records).
  await requireTestProject(ctx.db, p, true, "Örnek veri üretmek");
  if (existing) return { project: p.code, tag, alreadySeeded: true, at: existing.at, counts: existing.counts, note: "Bu etiket zaten üretilmiş (tekrar üretmek için önce action: remove)." };

  const counts: Counts = { ...SEED_DEFAULTS, ...(a.counts as Partial<Counts>) };
  const seed = typeof a.seed === "number" ? a.seed : seedFromTag(`${p.code}:${tag}`);
  const t0 = Date.now();
  const actors = await ensureActors(ctx, p.id, a.companies as string[] | undefined);
  const s = new Seeder(ctx, p, actors, new Rng(seed), Number(a.overdueRatio ?? 0.3), Number(a.backdateDays ?? 90), tag);
  const folderId = await ensureSeedFolder(ctx, p.id, actors.all.map((x) => x.companyId));
  const step = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (e) {
      s.notes.push(`${name}: ${(e as Error).message.slice(0, 300)}`);
    }
  };
  await step("Yazışmalar", () => letters(s, counts.incomingLetters, counts.outgoingLetters));
  await step("Bilgi talepleri", () => rfis(s, counts.rfis));
  await step("Teknik onaylar", () => submittals(s, counts.submittals));
  await step("Toplantılar", () => meetings(s, counts.meetings));
  await step("Gönderim formları", () => transmittals(s, counts.transmittals, folderId));
  await step("Sorunlar", () => issuesSeed(s, counts.issues));
  await step("İncelemeler", () => reviewsSeed(s, counts.reviews, folderId));
  if (moduleTable("field", "forms")) await step("Formlar", () => formsSeed(s, counts.forms));
  if (counts.schedule && moduleTable("planning", "schedules")) await step("İş programı", () => scheduleSeed(s));
  const hasModels = (await ctx.db.select({ n: count() }).from(files).where(and(eq(files.projectId, p.id), sql`lower(${files.name}) like '%.ifc'`, sql`${files.deletedAt} is null`)))[0]?.n;
  if (moduleTable("coordinate", "clashTests") && (counts.clashes || Number(hasModels ?? 0) > 0)) await step("Çakışmalar", () => clashSeed(s, folderId));
  // Marker on works (the registry keeps all kinds).
  if (s.records.works?.length)
    await ctx.db
      .update(works)
      .set({ data: sql`${works.data} || ${JSON.stringify({ devSeed: tag })}::jsonb` })
      .where(inArray(works.id, s.records.works));
  const summary = await summarize(ctx, p.id, s.records);
  const entry: DevSeedEntry = { at: new Date().toISOString(), seed, params: { counts, overdueRatio: s.overdueRatio, backdateDays: s.backdateDays }, records: s.records, counts: summary.counts };
  await updateRegistry(ctx.db, ctx.admin.id, (r) => {
    const pe = (r.projects[p.id] ??= {});
    (pe.seeds ??= {})[tag] = entry;
  });
  return {
    project: p.code,
    tag,
    seed,
    seconds: Math.round((Date.now() - t0) / 100) / 10,
    parties: actors.all.map((x) => `${x.role}: ${x.code} (${x.userName})`),
    ...summary,
    ...(s.notes.length && { notes: s.notes }),
  };
}

/** Deletes records by id (seeded ones, or every record of a reset). Order respects foreign keys. */
export async function removeRecords(ctx: DevContext, projectId: string, records: Records): Promise<Record<string, number>> {
  // Field's tables, when installed.
  const forms = moduleTable<Any>("field", "forms");
  const formTemplates = moduleTable<Any>("field", "formTemplates");
  const clashTests = moduleTable<Any>("coordinate", "clashTests");
  const schedules = moduleTable<Any>("planning", "schedules");
  const db = ctx.db;
  const out: Record<string, number> = {};
  const ids = (k: string) => records[k] ?? [];
  const del = async (k: string, fn: () => Promise<unknown[]>) => {
    if (!ids(k).length) return;
    out[k] = (await fn()).length;
  };
  const workIds = ids("works");
  if (workIds.length) {
    const wf = await db.select({ id: works.workflowInstanceId }).from(works).where(inArray(works.id, workIds));
    await del("works", () => db.delete(works).where(and(eq(works.projectId, projectId), inArray(works.id, workIds))).returning({ id: works.id }));
    const inst = wf.map((r) => r.id).filter((x): x is string => !!x);
    if (inst.length) await db.delete(workflowInstances).where(inArray(workflowInstances.id, inst));
    await db.delete(workflowInstances).where(sql`${workflowInstances.projectId} = ${projectId} and ${workflowInstances.subjectType} = 'work_revision' and not exists (select 1 from work_revisions r where r.id = ${workflowInstances.subjectId})`);
  }
  if (ids("reviews").length) {
    await db.delete(workflowInstances).where(and(eq(workflowInstances.subjectType, "review"), inArray(workflowInstances.subjectId, ids("reviews"))));
    await del("reviews", () => db.delete(reviews).where(and(eq(reviews.projectId, projectId), inArray(reviews.id, ids("reviews")))).returning({ id: reviews.id }));
  }
  if (forms && ids("forms").length) {
    await db.delete(workflowInstances).where(and(eq(workflowInstances.subjectType, "form"), inArray(workflowInstances.subjectId, ids("forms"))));
    await del("forms", () => db.delete(forms).where(and(eq(forms.projectId, projectId), inArray(forms.id, ids("forms")))).returning({ id: forms.id }));
  }
  await del("issues", () => db.delete(issues).where(and(eq(issues.projectId, projectId), inArray(issues.id, ids("issues")))).returning({ id: issues.id }));
  if (clashTests) await del("clashTests", () => db.delete(clashTests).where(and(eq(clashTests.projectId, projectId), inArray(clashTests.id, ids("clashTests")))).returning({ id: clashTests.id }));
  await del("modelSets", () => db.delete(modelSets).where(and(eq(modelSets.projectId, projectId), inArray(modelSets.id, ids("modelSets")))).returning({ id: modelSets.id }));
  if (schedules) await del("schedules", () => db.delete(schedules).where(and(eq(schedules.projectId, projectId), inArray(schedules.id, ids("schedules")))).returning({ id: schedules.id }));
  if (forms && formTemplates) await del("formTemplates", async () => {
    const used = await db.select({ t: forms.templateId }).from(forms).where(inArray(forms.templateId, ids("formTemplates")));
    const free = ids("formTemplates").filter((t) => !used.some((u) => u.t === t));
    return free.length ? db.delete(formTemplates).where(and(eq(formTemplates.projectId, projectId), inArray(formTemplates.id, free))).returning({ id: formTemplates.id }) : [];
  });
  await del("locations", () => db.delete(locations).where(and(eq(locations.projectId, projectId), inArray(locations.id, ids("locations")))).returning({ id: locations.id }));
  await del("workflowTemplates", () =>
    db.delete(workflowTemplates).where(and(eq(workflowTemplates.projectId, projectId), inArray(workflowTemplates.id, ids("workflowTemplates")))).returning({ id: workflowTemplates.id }),
  );
  // Files go to the trash (soft delete); storage is cleaned by the normal trash rules.
  await del("files", () =>
    db.update(files).set({ deletedAt: new Date() }).where(and(eq(files.projectId, projectId), inArray(files.id, ids("files")), sql`${files.deletedAt} is null`)).returning({ id: files.id }),
  );
  return out;
}

export { waitForJobs };
