#!/usr/bin/env node
/**
 * ISO 19650 construction project template (multi-party: client, consultant, designer, contractor),
 * generated in two languages from this single source:
 *
 *   node apps/server/templates/src/iso19650-yapim.mjs          writes the two files
 *   node apps/server/templates/src/iso19650-yapim.mjs --check  fails when they are out of date
 *
 * Output (format 7d-cde/project-template@2, docs/features/PROJECT_TEMPLATES.md):
 *   apps/server/templates/iso19650-yapim-tr.json   Turkish folders, codes and lists
 *   apps/server/templates/iso19650-yapim-en.json   English folders, ISO 19650 codes and lists
 * Both carry the ISO 19650 "cde" block (transitions, task teams, document code standard) and the
 * v2 parts (roles, issue types, transmittal, RFI, submittals, meetings, forms); names shown in the
 * template list are given in both languages ({ "tr", "en" }).
 *
 * Source: the Forma set-up of a live data-centre construction project (4 parties, ~85 users), the
 * Metro (İBB type) template and ISO 19650-1/-2 (UK NA 2021). No client name, person or e-mail.
 * Planning notes (development repository): docs/product/PROJE_KURULUM_SIHIRBAZI.md.
 *
 * Do not edit the JSON files: change this file and regenerate.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(here, "..");
/** ÇŞB 2026 EK-2 tables (official text); the same file builds csb2026NamingStandard() in @sitekeep/shared. */
const CSB = JSON.parse(readFileSync(path.resolve(here, "../../../../packages/shared/src/kernel/naming-profiles/csb-2026-ek2.json"), "utf8"));

/** t({tr, en}) → string in the current language. */
let L = "tr";
const t = (o) => (typeof o === "string" ? o : o[L]);

// ---------------------------------------------------------------------------------------------
// Taraflar (slot). Kodlar varsayılandır; sihirbaz gerçek firma kodlarını sorar.
const SLOTS = [
  { key: "idare", party: "client", code: { tr: "IDR", en: "CLI" }, label: { tr: "İdare / İşveren", en: "Client / Appointing party" }, description: { tr: "Bilgiyi kabul eden taraf (appointing party). Yayınlamayı onaylar.", en: "Appointing party; accepts information before it is published." } },
  { key: "musavir", party: "consultant", code: { tr: "MSV", en: "CON" }, label: { tr: "Müşavir / Proje Yönetimi", en: "Consultant / Project manager" }, description: { tr: "İdare adına koordinasyon ve teknik kontrol; RFI koordinatörü.", en: "Coordinates and checks on behalf of the client; RFI coordinator." } },
  { key: "tasarimci", party: "designer", code: { tr: "TSR", en: "DES" }, label: { tr: "Tasarımcı", en: "Designer" }, description: { tr: "Tasarım ve mühendislik ekibi; RFI ve malzeme onaylarında teknik görüş verir.", en: "Design and engineering team; answers RFIs and gives technical opinion on submittals." } },
  { key: "yuklenici", party: "contractor", code: { tr: "YKL", en: "CTR" }, label: { tr: "Yüklenici", en: "Contractor" }, description: { tr: "Baş yüklenici (lead appointed party); yetkilendirir ve paylaşır.", en: "Lead appointed party; authorizes and shares information." } },
];

// Disiplinler. TR: 3 harfli Türkçe kodlar (sahada en çok kullanılan); EN: ISO 19650 UK NA rol kodları.
const DISCIPLINES = {
  tr: [
    ["MIM", "Mimari"], ["INS", "İnşaat / Statik"], ["MEK", "Mekanik"], ["ELK", "Elektrik"],
    ["ALT", "Altyapı"], ["PEY", "Peyzaj"], ["GEO", "Geoteknik / Zemin"], ["HRT", "Harita"],
    ["ICM", "İç Mimari"], ["YNG", "Yangın"], ["KRD", "Koordinasyon / BIM"], ["GNL", "Genel"],
  ],
  en: [
    ["A", "Architect"], ["S", "Structural engineer"], ["M", "Mechanical engineer"], ["E", "Electrical engineer"],
    ["C", "Civil engineer"], ["L", "Landscape architect"], ["G", "Geographical and land surveyor"],
    ["I", "Interior designer"], ["P", "Public health engineer"], ["Q", "Quantity surveyor"],
    ["K", "Client"], ["W", "Contractor"], ["X", "Subcontractor"], ["Y", "Specialist designer"], ["Z", "General (non-disciplinary)"],
  ],
};

// ISO 19650 UK NA bilgi türleri (Type).
const TYPES = [
  ["AF", "Animasyon", "Animation file"], ["BQ", "Metraj listesi", "Bill of quantities"], ["CA", "Hesap", "Calculations"],
  ["CM", "Birleşik model", "Combined model"], ["CO", "Yazışma", "Correspondence"], ["CP", "Maliyet planı", "Cost plan"],
  ["CR", "Çakışma sunumu", "Clash rendition"], ["DB", "Veritabanı", "Database"], ["DR", "Çizim", "Drawing rendition"],
  ["FN", "Dosya notu", "File note"], ["HS", "Sağlık ve güvenlik", "Health and safety"], ["IE", "Bilgi değişim dosyası", "Information exchange file"],
  ["M2", "2B model", "2D model"], ["M3", "3B model", "3D model"], ["MI", "Tutanak / aksiyon notu", "Minutes / action notes"],
  ["MR", "Model sunumu", "Model rendition"], ["MS", "Yapım yöntemi", "Method statement"], ["PP", "Sunum", "Presentation"],
  ["PR", "Program", "Programme"], ["RD", "Mahal veri sayfası", "Room data sheet"], ["RI", "Bilgi talebi", "Request for information"],
  ["RP", "Rapor", "Report"], ["SA", "Mahal çizelgesi", "Schedule of accommodation"], ["SH", "Çizelge", "Schedule"],
  ["SN", "Kroki", "Snagging list"], ["SP", "Şartname", "Specification"], ["SU", "Etüt / Ölçüm", "Survey"], ["VS", "Görselleştirme", "Visualization"],
];

const LEVELS = [
  ["ZZ", "Birden çok seviye", "Multiple levels"], ["XX", "Seviye yok", "No level applicable"],
  ["B2", "2. bodrum", "Basement level 2"], ["B1", "1. bodrum", "Basement level 1"], ["00", "Zemin", "Ground level"],
  ["01", "1. kat", "Level 01"], ["02", "2. kat", "Level 02"], ["03", "3. kat", "Level 03"],
  ["M1", "1. asma kat", "Mezzanine above level 01"], ["RF", "Çatı", "Roof level"],
];
const VOLUMES = [["ZZ", "Tüm hacimler / sistemler", "All volumes / systems"], ["XX", "Hacim yok", "No volume / system applicable"]];

// ISO 19650 UK NA 2021 uygunluk (status) kodları.
const STATUS = [
  ["S0", "Çalışmada (WIP)", "Work in progress"],
  ["S1", "Koordinasyon için", "Suitable for coordination"],
  ["S2", "Bilgi için", "Suitable for information"],
  ["S3", "İnceleme ve yorum için", "Suitable for review and comment"],
  ["S4", "Aşama onayı için", "Suitable for stage approval"],
  ["A1", "Onaylı, aşama 1 (yayınlanmış)", "Authorized and accepted, stage 1"],
  ["A2", "Onaylı, aşama 2", "Authorized and accepted, stage 2"],
  ["A3", "Onaylı, aşama 3", "Authorized and accepted, stage 3"],
  ["B1", "Şartlı onaylı, aşama 1", "Partially accepted with comments, stage 1"],
  ["B2", "Şartlı onaylı, aşama 2", "Partially accepted with comments, stage 2"],
  ["CR", "Yapıldığı gibi (as-built)", "As constructed record"],
];

// Yazışma türleri (veri merkezi projesinde kullanılan 12 tür, genelleştirilmiş).
const CORR_TYPES = {
  tr: [
    ["RFI", "Bilgi talebi"], ["NCR", "Uygunsuzluk raporu"], ["CAR", "Düzeltici faaliyet"], ["MOF", "Malzeme onay formu"],
    ["IYY", "İş yapım yöntemi"], ["ITF", "İş teslim / muayene talebi"], ["MUF", "Malzeme uygunluk formu"],
    ["DTF", "Değişiklik talep formu"], ["AYF", "Alt yüklenici onay formu"], ["MTL", "Mühendis talimatı"],
    ["LTR", "Resmi yazı"], ["TRN", "Gönderim formu (transmittal)"], ["TUT", "Toplantı tutanağı"],
  ],
  en: [
    ["RFI", "Request for information"], ["NCR", "Non-conformance report"], ["CAR", "Corrective action request"], ["MAR", "Material approval request"],
    ["MST", "Method statement"], ["INR", "Inspection request"], ["MCF", "Material conformity form"],
    ["CRQ", "Change request"], ["SCA", "Subcontractor approval"], ["EIN", "Engineer's instruction"],
    ["LTR", "Letter"], ["TRN", "Transmittal"], ["MOM", "Minutes of meeting"],
  ],
};

const MEETINGS = [
  { tr: "İdare", en: "Client" }, { tr: "Tasarım", en: "Design" }, { tr: "Saha Koordinasyon", en: "Site coordination" },
  { tr: "Kalite Kontrol", en: "Quality control" }, { tr: "Elektromekanik", en: "MEP" }, { tr: "İş Programı", en: "Programme" },
  { tr: "BIM Koordinasyon", en: "BIM coordination" }, { tr: "İSG-Ç", en: "HSE" },
];

const CONSTRUCTION_TOPICS = [
  { tr: "Kalite Kontrol", en: "Quality control" }, { tr: "Yapım Yöntemleri", en: "Method statements" },
  { tr: "Malzeme Sunumları", en: "Material submittals" }, { tr: "İş Programı", en: "Programme" },
  { tr: "Test ve Devreye Alma", en: "Testing and commissioning" }, { tr: "İSG-Ç", en: "HSE" },
];

// ---------------------------------------------------------------------------------------------
const N = {
  docStd: { tr: "ISO 19650 Doküman Kodlama", en: "ISO 19650 Document Naming" },
  corrStd: { tr: "Yazışma Kodlama", en: "Correspondence Naming" },
  status: { tr: "Uygunluk Kodu", en: "Status" },
  rev: { tr: "Revizyon", en: "Revision" },
  title: { tr: "Pafta / Doküman Adı", en: "Sheet / Document Title" },
  date: { tr: "Yazı Tarihi", en: "Letter Date" },
  disc: { tr: "Disiplin", en: "Discipline" },
  topic: { tr: "Yapım konusu", en: "Construction topic" },
  shared: { tr: "20-PAYLAŞILAN (Shared)", en: "20-SHARED" },
  forReview: { tr: "01-İnceleme için", en: "01-For Review" },
  forApproval: { tr: "02-Onay için", en: "02-For Approval" },
  published: { tr: "30-YAYINLANAN (Published)", en: "30-PUBLISHED" },
  roleField: { tr: "Rol", en: "Role" },
};

function namingStandards() {
  const list = (rows, i) => rows.map((r) => ({ code: r[0], description: r[i] }));
  const di = DISCIPLINES[L].map(([code, description]) => ({ code, description }));
  const slotCodes = SLOTS.map((s) => ({ code: `{slot:${s.key}}`, description: `{firma:${s.key}}` }));
  return [
    {
      name: t(N.docStd),
      delimiter: "-",
      fields: [
        { name: t({ tr: "Proje", en: "Project" }), type: "list", values: [{ code: "{PROJE}", description: t({ tr: "Proje kodu", en: "Project code" }) }] },
        { name: t({ tr: "Kaynak", en: "Originator" }), type: "list", values: slotCodes },
        { name: t({ tr: "Hacim", en: "Volume" }), type: "list", values: list(VOLUMES, L === "tr" ? 1 : 2) },
        { name: t({ tr: "Seviye", en: "Level" }), type: "list", values: list(LEVELS, L === "tr" ? 1 : 2) },
        { name: t({ tr: "Tip", en: "Type" }), type: "list", values: list(TYPES, L === "tr" ? 1 : 2) },
        { name: t(N.roleField), type: "list", values: di },
        { name: t({ tr: "Numara", en: "Number" }), type: "number", digits: 4 },
      ],
    },
    {
      name: t(N.corrStd),
      delimiter: "-",
      fields: [
        { name: t({ tr: "Proje", en: "Project" }), type: "list", values: [{ code: "{PROJE}", description: t({ tr: "Proje kodu", en: "Project code" }) }] },
        { name: t({ tr: "Gönderen", en: "Sender" }), type: "list", values: slotCodes },
        { name: t({ tr: "Alıcı", en: "Recipient" }), type: "list", values: slotCodes },
        { name: t({ tr: "Tür", en: "Kind" }), type: "list", values: CORR_TYPES[L].map(([code, description]) => ({ code, description })) },
        { name: t(N.disc), type: "list", values: di },
        { name: t({ tr: "Numara", en: "Number" }), type: "number", digits: 4 },
      ],
    },
  ];
}

/**
 * ÇŞB 2026 (EK-2) naming, Turkish template only: offered as the document code standard in the set-up
 * wizard. Mirrors csb2026NamingStandard({ projectCode: "{EK1}" }) (packages/shared/src/kernel/
 * naming-csb2026.ts); apps/server/test/projects/naming-csb2026.test.ts keeps them equal.
 */
function csbStandard() {
  const any = { XXXX: "Genel", DIGR: "Diğer" };
  const sub = new Map();
  for (const table of CSB.subdisciplines) {
    for (const v of table.values) {
      const known = sub.get(v.code);
      if (any[v.code]) {
        if (!known) sub.set(v.code, { code: v.code, description: any[v.code] });
      } else if (known) known.parents.push(table.discipline);
      else sub.set(v.code, { code: v.code, description: v.name, parents: [table.discipline] });
    }
  }
  return {
    name: "ÇŞB 2026 (EK-2)",
    delimiter: CSB.delimiter,
    maxLength: CSB.maxLength,
    fields: [
      { name: "Proje Kodu", type: "text", minLength: 6, maxLength: 6, charset: "alphanumeric", fixed: "{EK1}" },
      { name: "Bina Kodu", type: "text", minLength: 2, maxLength: 2, charset: "alphanumeric", suggestions: [{ code: "00", description: "Tek bina" }] },
      { name: "Disiplin", type: "list", values: CSB.disciplines.map((d) => ({ code: d.code, description: d.name })) },
      { name: "Alt Disiplin / Öge", type: "list", dependsOn: "Disiplin", values: [...sub.values()] },
      { name: "Dosya Türü", type: "list", values: CSB.fileKinds.map((k) => ({ code: k.code, description: k.note ? `${k.name} (${k.note})` : k.name })) },
      { name: "Dosya Tipi", type: "list", values: CSB.fileTypes.flatMap((g) => g.values.map((v) => ({ code: v.code, description: v.name }))) },
      {
        name: "Kat / Konum", type: "text", minLength: CSB.levelRules.length, maxLength: CSB.levelRules.length, charset: "alphanumeric",
        suggestions: CSB.levels.map((l) => ({ code: l.code, description: l.name })),
      },
      { name: "Sıra No", type: "number", digits: 2 },
      { name: "Revizyon No", type: "number", digits: 3, inCode: false },
    ],
  };
}

// Suitability (S0–S4, A, B, CR) and revision (P01 / C01) are codes of every version (ISO-2,
// docs/features/CDE_STATES.md#codes), not attributes; STATUS documents the UK NA list they follow.
function attributes() {
  return [
    { name: t(N.title), type: "text" },
    { name: t(N.date), type: "date" },
  ];
}

const g = (slot, level) => ({ slot, level });

function folders() {
  const discSkeleton = { order: [t(N.disc)] };
  const topicSkeleton = { order: [t(N.topic)] };
  return [
    {
      name: t({ tr: "00-GENEL", en: "00-GENERAL" }),
      grants: [g("*", "view_download"), g("idare", "edit"), g("musavir", "edit")],
      children: [
        { name: t({ tr: "01-İhale ve Sözleşme Dokümanları", en: "01-Tender and Contract Documents" }), children: [
          t({ tr: "Sözleşme", en: "Contract" }), t({ tr: "Teklif Dosyası", en: "Tender Submission" }),
          t({ tr: "Teknik Şartnameler", en: "Technical Specifications" }), t({ tr: "İhale Projeleri ve Raporları", en: "Tender Drawings and Reports" }),
        ] },
        { name: t({ tr: "02-Bilgi Gereksinimleri (OIR, AIR, PIR, EIR)", en: "02-Information Requirements (OIR, AIR, PIR, EIR)" }), grants: [g("idare", "manage")] },
        { name: t({ tr: "03-BIM Uygulama Planı ve Teslim Planları (BEP, MIDP, TIDP)", en: "03-BIM Execution Plan and Delivery Plans (BEP, MIDP, TIDP)" }), grants: [g("yuklenici", "edit")] },
        { name: t({ tr: "04-Standartlar ve Şablonlar", en: "04-Standards and Templates" }), children: [
          t({ tr: "Antet ve Şablonlar", en: "Title Blocks and Templates" }), t({ tr: "BIM Standartları", en: "BIM Standards" }),
          t({ tr: "Tasarım Standartları", en: "Design Standards" }), t({ tr: "Yapım Standartları", en: "Construction Standards" }),
        ] },
        t({ tr: "05-Kullanım Kılavuzları", en: "05-User Guides" }),
        { name: t({ tr: "06-Toplantı Tutanakları", en: "06-Meeting Minutes" }), children: MEETINGS.map((m, i) => `${String(i + 1).padStart(2, "0")}-${t(m)}`) },
        {
          name: t({ tr: "07-Yazışmalar", en: "07-Correspondence" }),
          naming: t(N.corrStd),
          attributes: [t(N.date)],
          grants: [g("yuklenici", "edit"), g("tasarimci", "edit")],
          children: [
            t({ tr: "01-Gelen", en: "01-Incoming" }), t({ tr: "02-Giden", en: "02-Outgoing" }),
            t({ tr: "03-Değişiklik Talep Formları", en: "03-Change Requests" }), t({ tr: "04-Alt Yüklenici Onay Formları", en: "04-Subcontractor Approvals" }),
            t({ tr: "05-Mühendis Talimatları", en: "05-Engineer's Instructions" }), t({ tr: "06-Gönderim Formları (Transmittal)", en: "06-Transmittals" }),
          ],
        },
        t({ tr: "08-Yer Teslim Tutanakları", en: "08-Site Handover Records" }),
      ],
    },
    {
      name: t({ tr: "10-ÇALIŞMA ALANLARI (WIP)", en: "10-WORK IN PROGRESS (WIP)" }),
      state: "wip",
      children: SLOTS.map((s) => ({
        name: t(s.label).split(" / ")[0],
        state: "wip",
        grants: [g(s.key, "edit")],
        ...(s.key === "tasarimci" || s.key === "yuklenici" ? { skeleton: discSkeleton } : {}),
      })),
    },
    {
      name: t(N.shared),
      state: "shared",
      naming: t(N.docStd),
      attributes: [t(N.title)],
      gate: true,
      grants: [g("*", "view_download_markup")],
      children: [
        { name: t(N.forReview), state: "shared", stateLabel: t({ tr: "İnceleme için", en: "For review" }), skeleton: discSkeleton },
        { name: t(N.forApproval), state: "shared", stateLabel: t({ tr: "Onay için", en: "For approval" }), skeleton: discSkeleton },
        { name: t({ tr: "03-Yapım Dokümanları", en: "03-Construction Documents" }), state: "shared", stateLabel: t({ tr: "Onay için", en: "For approval" }), skeleton: topicSkeleton },
      ],
    },
    {
      name: t(N.published),
      state: "published",
      naming: t(N.docStd),
      attributes: [t(N.title)],
      gate: true,
      grants: [g("*", "view_download")],
      skeleton: discSkeleton,
      children: [
        { name: t({ tr: "Yapım Dokümanları", en: "Construction Documents" }), state: "published", skeleton: topicSkeleton },
        { name: t({ tr: "İş Sonu (As-Built)", en: "As-Built" }), state: "published", stateLabel: t({ tr: "İş Sonu", en: "As-built" }), lazy: true },
      ],
    },
    {
      name: t({ tr: "40-ARŞİV (Archived)", en: "40-ARCHIVED" }),
      state: "archived",
      grants: [g("*", "view"), g("idare", "view_download")],
    },
  ];
}

function opts(party) {
  const P = { client: { tr: "İDARE", en: "CLIENT" }, consultant: { tr: "MÜŞAVİR", en: "CONSULTANT" }, contractor: { tr: "YÜKLENİCİ", en: "CONTRACTOR" }, designer: { tr: "TASARIMCI", en: "DESIGNER" } }[party];
  const pre = { client: "IDR", consultant: "MUS", contractor: "YUK", designer: "TAS" }[party];
  const p = t(P);
  return L === "tr"
    ? [
        { code: `${pre}-A`, label: `${p} ONAYLADI`, kind: "approved" },
        { code: `${pre}-B`, label: `${p} ŞARTLI ONAYLADI`, kind: "approved_with_comments" },
        { code: `${pre}-C`, label: `${p} REVİZE ET - TEKRAR SUN`, kind: "revise" },
        { code: `${pre}-D`, label: `${p} REDDETTİ`, kind: "rejected" },
      ]
    : [
        { code: `${pre}-A`, label: `${p} APPROVED`, kind: "approved" },
        { code: `${pre}-B`, label: `${p} APPROVED WITH COMMENTS`, kind: "approved_with_comments" },
        { code: `${pre}-C`, label: `${p} REVISE AND RESUBMIT`, kind: "revise" },
        { code: `${pre}-D`, label: `${p} REJECTED`, kind: "rejected" },
      ];
}

const CHECK = ["approved", "approved_with_comments", "revise_resubmit", "rejected"];

/** Workflow names referenced by the "cde" block and the v2 parts. */
const WF = {
  approval: { tr: "Onay: Müşavir + Tasarımcı → İdare kabul → Yayınla", en: "Approval: Consultant + Designer → Client acceptance → Publish" },
  rfi: { tr: "RFI: Müşavir koordinasyon → Tasarımcı cevap → Müşavir resmi cevap → İdare kapatır", en: "RFI: Consultant coordinates → Designer answers → Consultant formal answer → Client closes" },
  submittal: { tr: "Malzeme / yöntem onayı: Müşavir (+ Tasarımcı görüşü) → İdare", en: "Material / method approval: Consultant (+ designer opinion) → Client" },
  dtf: { tr: "Değişiklik talebi (DTF): Müşavir → İdare", en: "Change request: Consultant → Client" },
  ayf: { tr: "Alt yüklenici onayı (AYF): Müşavir → İdare", en: "Subcontractor approval: Consultant → Client" },
};

function workflows() {
  const req = [t(N.title)];
  const internal = (slot, label) => ({
    name: t(label),
    kind: "review",
    steps: [
      { name: t({ tr: "Kontrol (check)", en: "Check" }), assignees: [{ slot }], rule: "any", days: 2, outcomes: CHECK, requiredAttributes: req },
      { name: t({ tr: "Gözden geçirme (review)", en: "Review" }), assignees: [{ slot }], rule: "any", days: 2, outcomes: CHECK },
      { name: t({ tr: "Yetkilendirme (authorize)", en: "Authorize" }), assignees: [{ slot }], rule: "any", days: 1, outcomes: CHECK },
    ],
    chain: {
      originParty: SLOTS.find((s) => s.key === slot).party,
      namePattern: L === "tr" ? "{Proje}-IK-{0000}" : "{Project}-IC-{0000}",
      copyTarget: { folder: `${t(N.shared)}/${t(N.forApproval)}`, pattern: `{${t(N.roleField)}}`, onUnresolved: "base" },
    },
  });
  return [
    internal("yuklenici", { tr: "Yüklenici iç kontrol → Onay için paylaş", en: "Contractor internal check → share for approval" }),
    internal("tasarimci", { tr: "Tasarımcı iç kontrol → Onay için paylaş", en: "Designer internal check → share for approval" }),
    {
      name: t({ tr: "Koordinasyon için paylaş (S1–S3)", en: "Share for coordination (S1–S3)" }),
      kind: "review",
      steps: [{ name: t({ tr: "Ekip lideri yetkilendirir", en: "Task team lead authorizes" }), assignees: [{ role: "project_admin" }, { slot: "yuklenici" }], rule: "any", days: 2, outcomes: ["approved", "revise_resubmit", "rejected"], requiredAttributes: req }],
      chain: { copyTarget: { folder: `${t(N.shared)}/${t(N.forReview)}`, pattern: `{${t(N.roleField)}}`, onUnresolved: "base" } },
    },
    {
      name: t(WF.approval),
      kind: "review",
      steps: [
        { name: t({ tr: "Müşavir ve tasarımcı incelemesi", en: "Consultant and designer review" }), assignees: [{ slot: "musavir" }, { slot: "tasarimci" }], rule: "all", days: 5, outcomes: [], outcomeOptions: opts("consultant"), stage: 0, requiredAttributes: req },
        { name: t({ tr: "İdare kabulü (accept)", en: "Client acceptance" }), assignees: [{ slot: "idare" }], rule: "any", days: 3, outcomes: [], outcomeOptions: opts("client"), stage: 1 },
      ],
      chain: {
        stages: [
          { name: t({ tr: "Müşavir ve tasarımcı", en: "Consultant and designer" }), party: "consultant", days: 5, onRevise: "stop" },
          { name: t({ tr: "İdare", en: "Client" }), party: "client", days: 3, onRevise: "stop" },
        ],
        originParty: "contractor",
        namePattern: L === "tr" ? "{Proje}-ONY-{0000}" : "{Project}-APR-{0000}",
        copyTarget: { folder: t(N.published), pattern: `{${t(N.roleField)}}`, onUnresolved: "base" },
      },
    },
    {
      name: t(WF.rfi),
      kind: "rfi",
      steps: [
        { name: t({ tr: "Müşavir koordinasyon", en: "Consultant coordination" }), assignees: [{ slot: "musavir" }], rule: "any", days: 1, outcomes: ["reviewed", "rejected"] },
        { name: t({ tr: "Tasarımcı cevabı", en: "Designer answer" }), assignees: [{ slot: "tasarimci" }], rule: "any", days: 3, outcomes: ["reviewed"] },
        { name: t({ tr: "Müşavir resmi cevabı", en: "Consultant formal answer" }), assignees: [{ slot: "musavir" }], rule: "any", days: 1, outcomes: ["reviewed", "revise_resubmit"] },
        { name: t({ tr: "İdare kapatır", en: "Client closes" }), assignees: [{ slot: "idare" }], rule: "any", days: 2, outcomes: ["approved", "revise_resubmit"] },
      ],
    },
    {
      name: t(WF.submittal),
      kind: "submittal",
      steps: [
        { name: t({ tr: "Tasarımcı teknik görüşü", en: "Designer technical opinion" }), assignees: [{ slot: "tasarimci" }], rule: "any", days: 3, outcomes: ["reviewed", "approved_with_comments", "revise_resubmit"] },
        { name: t({ tr: "Müşavir değerlendirmesi", en: "Consultant evaluation" }), assignees: [{ slot: "musavir" }], rule: "any", days: 2, outcomes: ["approved", "approved_with_comments", "reviewed", "revise_resubmit", "rejected"] },
        { name: t({ tr: "İdare son karar", en: "Client final decision" }), assignees: [{ slot: "idare" }], rule: "any", days: 3, outcomes: ["approved", "approved_with_comments", "reviewed", "revise_resubmit", "rejected"] },
      ],
    },
    {
      name: t(WF.dtf),
      kind: "form",
      steps: [
        { name: t({ tr: "Müşavir değerlendirmesi", en: "Consultant evaluation" }), assignees: [{ slot: "musavir" }], rule: "any", days: 5, outcomes: ["approved", "approved_with_comments", "revise_resubmit", "rejected"] },
        { name: t({ tr: "İdare kararı", en: "Client decision" }), assignees: [{ slot: "idare" }], rule: "any", days: 5, outcomes: ["approved", "approved_with_comments", "rejected"], returnTo: 0 },
      ],
    },
    {
      name: t(WF.ayf),
      kind: "form",
      steps: [
        { name: t({ tr: "Müşavir değerlendirmesi", en: "Consultant evaluation" }), assignees: [{ slot: "musavir" }], rule: "any", days: 5, outcomes: ["approved", "approved_with_comments", "revise_resubmit", "rejected"] },
        { name: t({ tr: "İdare kararı", en: "Client decision" }), assignees: [{ slot: "idare" }], rule: "any", days: 5, outcomes: ["approved", "approved_with_comments", "rejected"], returnTo: 0 },
      ],
    },
  ];
}

function issueTypes() {
  const C = [
    [{ tr: "Tasarım Koordinasyon", en: "Design coordination" }, [{ tr: "Tasarım hatası / eksikliği", en: "Design error / omission" }, { tr: "Disiplinler arası çakışma", en: "Inter-discipline clash" }, { tr: "Doküman / çizim uyumsuzluğu", en: "Document / drawing mismatch" }]],
    [{ tr: "Saha Gözlemi", en: "Site observation" }, [{ tr: "Saha gözlemi", en: "Site observation" }, { tr: "İmalat hatası", en: "Workmanship defect" }]],
    [{ tr: "Kalite", en: "Quality" }, [{ tr: "NCR - Uygunsuzluk", en: "NCR - Non-conformance" }, { tr: "CAR - Düzeltici faaliyet", en: "CAR - Corrective action" }, { tr: "Malzeme kabul bulgusu", en: "Material inspection finding" }]],
    [{ tr: "İSG-Ç", en: "HSE" }, [{ tr: "İSG uygunsuzluğu", en: "Safety non-conformance" }, { tr: "Ramak kala / olay", en: "Near miss / incident" }, { tr: "Çevre uygunsuzluğu", en: "Environmental non-conformance" }]],
    [{ tr: "Test ve Devreye Alma", en: "Testing and commissioning" }, [{ tr: "Test bulgusu", en: "Test finding" }, { tr: "Punch / eksik iş", en: "Punch / snag" }]],
  ];
  return C.map(([cat, types]) => ({ category: t(cat), types: types.map(t) }));
}

/** Both languages, the file's own first: names shown in the template list follow the project language. */
const both = (o) => (L === "tr" ? { tr: o.tr, en: o.en } : { en: o.en, tr: o.tr });

const ARCHIVE = { tr: "40-ARŞİV (Archived)", en: "40-ARCHIVED" };

/** ISO 19650 CDE settings (docs/features/CDE_STATES.md): D-7 transitions, task teams, codes. */
function cde() {
  return {
    codeScheme: "iso_uk_na",
    enforceTransitions: true,
    wipPolicy: "team_only",
    adminSeesWip: true,
    archiveFolder: t(ARCHIVE),
    containerStandard: t(N.docStd),
    taskTeams: SLOTS.map((s) => ({ slot: s.key, ...(s.key === "yuklenici" ? { lead: true } : {}) })),
    transitions: [
      { from: null, to: "wip", mode: "direct" },
      // Three workflows share into Shared (contractor / designer internal check, share for coordination).
      { from: "wip", to: "shared", mode: "review" },
      { from: "shared", to: "wip", mode: "auto" },
      { from: "shared", to: "published", mode: "review", workflow: t(WF.approval) },
      { from: "published", to: "archived", mode: "auto" },
    ],
  };
}

/**
 * MIDP milestones (ISO-7, docs/features/DELIVERY_PLAN.md): project stages dated in days after the
 * project is created; the administrator moves them to the real dates.
 */
function deliveryPlan() {
  const m = (code, name, offsetDays) => ({ code, name: t(name), offsetDays });
  return {
    milestones: [
      m("M1", { tr: "Konsept Tasarım", en: "Concept Design" }, 60),
      m("M2", { tr: "Kesin Proje", en: "Developed Design" }, 120),
      m("M3", { tr: "Uygulama Projesi", en: "Technical Design" }, 210),
      m("M4", { tr: "Yapım Başlangıcı", en: "Construction Start" }, 270),
      m("M5", { tr: "Teslim (Yapıldığı Gibi)", en: "Handover (As-Built)" }, 720),
    ],
  };
}

function roles() {
  const role = (key, slot, name) => ({ key, slot, name: t(name) });
  return [
    ...["yuklenici", "tasarimci"].flatMap((slot) => {
      const who = t(SLOTS.find((s) => s.key === slot).label).split(" / ")[0];
      return [
        { key: `${slot}-kontrol`, slot, name: `${who} - ${t({ tr: "Kontrol", en: "Checker" })}` },
        { key: `${slot}-gozden`, slot, name: `${who} - ${t({ tr: "Gözden Geçiren", en: "Reviewer" })}` },
        { key: `${slot}-yetki`, slot, name: `${who} - ${t({ tr: "Yetkilendiren", en: "Authorizer" })}` },
      ];
    }),
    role("musavir-disiplin", "musavir", { tr: "Müşavir - Disiplin Onayı", en: "Consultant - Discipline Approval" }),
    role("tasarimci-disiplin", "tasarimci", { tr: "Tasarımcı - Disiplin Görüşü", en: "Designer - Discipline Opinion" }),
    role("idare-onay", "idare", { tr: "İdare - Kabul / Son Onay", en: "Client - Acceptance" }),
    role("idare-gozlemci", "idare", { tr: "İdare - Gözlemci", en: "Client - Watcher" }),
    role("bim-yoneticisi", "yuklenici", { tr: "BIM / Bilgi Yöneticisi", en: "Information Manager" }),
  ];
}

function template() {
  const disc = DISCIPLINES[L].filter(([c]) => !["K", "W", "X", "Z", "GNL"].includes(c));
  const other = L === "tr" ? { tr: "Türkçe adlarla", en: "Turkish names" } : { tr: "İngilizce adlarla", en: "English names" };
  return {
    format: "7d-cde/project-template@2",
    name: both({ tr: `ISO 19650 Yapım Projesi (çok taraflı, ${other.tr})`, en: `ISO 19650 Construction Project (multi-party, ${other.en})` }),
    description: both({
      tr: "İdare, müşavir, tasarımcı ve yüklenici için ISO 19650-1/-2 düzeni: taraf başına çalışma alanı (WIP), iç kontrol (kontrol → gözden geçirme → yetkilendirme), koordinasyon ve onay için paylaşılan alanlar, müşavir + tasarımcı → idare kabulüyle yayınlama, arşiv. Durum geçişleri, görev ekipleri ve tekil doküman kodu açık. Doküman ve yazışma kodlaması, uygunluk ve revizyon kodları (S0–S4, A, B, CR; P01 / C01), roller, sorun tipleri, gönderim formu, RFI, malzeme/yöntem onayı, toplantı ve form şablonları. Canlıda çalışan bir veri merkezi yapım projesinin düzeninden genelleştirildi.",
      en: "ISO 19650-1/-2 set-up for client, consultant, designer and contractor: a WIP area per party, internal check → review → authorize, shared areas for coordination and approval, publishing after consultant + designer review and client acceptance, archive. State transitions, task teams and unique document codes on. Document and correspondence naming, suitability and revision codes (S0–S4, A, B, CR; P01 / C01), roles, issue types, transmittals, RFI, material/method approval, meeting and form templates. Generalized from a live data-centre construction project.",
    }),
    language: L,
    family: "iso19650-yapim",
    modules: { correspondence: true, rfi: true, submittals: true, meetings: true, transmittals: true, issues: true, reviews: true, forms: true, coordination: true, schedule: true, spec: true, reports: true },
    cde: cde(),
    deliveryPlan: deliveryPlan(),
    slots: SLOTS.map((s) => ({ key: s.key, label: both(s.label), party: s.party, code: t(s.code), description: both(s.description) })),
    dimensions: {
      [t(N.disc)]: disc.map(([c]) => c),
      [t(N.topic)]: CONSTRUCTION_TOPICS.map((x, i) => `${String(i + 1).padStart(2, "0")}-${t(x)}`),
    },
    folders: folders(),
    namingStandards: L === "tr" ? [...namingStandards(), csbStandard()] : namingStandards(),
    attributes: attributes(),
    workflows: workflows(),
    roles: roles(),
    issues: {
      categories: issueTypes(),
      customFields: [
        { name: t(N.disc), type: "list", options: disc.map(([c]) => c) },
        { name: t({ tr: "Sorumlu Firma", en: "Responsible Company" }), type: "list", options: SLOTS.map((s) => t(s.label).split(" / ")[0]) },
        { name: t({ tr: "Maliyet Etkisi", en: "Cost Impact" }), type: "list", options: L === "tr" ? ["Var", "Yok", "Değerlendiriliyor"] : ["Yes", "No", "Under evaluation"] },
        { name: t({ tr: "Süre Etkisi", en: "Time Impact" }), type: "list", options: L === "tr" ? ["Var", "Yok", "Değerlendiriliyor"] : ["Yes", "No", "Under evaluation"] },
      ],
    },
    // Work numbering tokens are syntax, the same in every language ({Proje}, {Gönderen}, {Alıcı} …).
    transmittal: {
      numbering: "{Proje}-{Gönderen}-{Alıcı}-TRN-{0000}",
      attributes: [t({ tr: "Kaynak", en: "Originator" }), t(N.roleField), t({ tr: "Tip", en: "Type" }), t({ tr: "Seviye", en: "Level" }), t({ tr: "Numara", en: "Number" }), t(N.status), t(N.rev), t(N.title)],
    },
    rfi: {
      types: disc.map(([code, name]) => ({ code, name: `${code} - ${name}` })).concat([{ code: L === "tr" ? "GNL" : "Z", name: t({ tr: "GNL - Genel", en: "Z - General" }) }]),
      defaultType: L === "tr" ? "GNL" : "Z",
      categories: [t({ tr: "Tasarım Koordinasyonu", en: "Design Coordination" }), t({ tr: "Saha Uygulaması", en: "Site Execution" }), t({ tr: "Malzeme", en: "Material" }), t({ tr: "Diğer", en: "Other" })],
      responseDays: 7,
      numbering: "{Proje}-{Gönderen}-{Alıcı}-RFI-{Disiplin}-{0000}",
      workflow: t(WF.rfi),
      permissions: { creator: ["yuklenici"], coordinator: ["musavir"], reviewer: ["tasarimci"], manager: ["idare"], watcher: ["idare-gozlemci"] },
    },
    submittals: {
      itemTypes: L === "tr"
        ? ["MOF - Malzeme Onay Formu", "IYY - İş Yapım Yöntemi", "IMR - İmalat Resmi", "UTD - Ürün Teknik Dokümanı", "NUM - Numune", "TRP - Test Raporu", "SRT - Sertifika", "IBK - İşletme ve Bakım Kılavuzu", "GRB - Garanti Belgesi", "MCK - Mock-up", "IP - İş Programı", "DGR - Diğer"]
        : ["MAR - Material Approval Request", "MST - Method Statement", "SHD - Shop Drawing", "PDT - Product Data", "SMP - Sample", "TRP - Test Report", "CRT - Certificate", "OMM - O&M Manual", "WAR - Warranty", "MCK - Mock-up", "PRG - Programme", "OTH - Other"],
      responses: (L === "tr"
        ? [["Onaylandı", "approved"], ["Şartlı Onay", "approved_with_comments"], ["Bilgi İçin", "reviewed"], ["Revize Et - Tekrar Sun", "revise_resubmit"], ["Reddedildi", "rejected"]]
        : [["Approved", "approved"], ["Approved with comments", "approved_with_comments"], ["For information", "reviewed"], ["Revise and resubmit", "revise_resubmit"], ["Rejected", "rejected"]]
      ).map(([label, code]) => ({ label, code })),
      specSections: disc.map(([code, name]) => ({ code, name })),
      responseDays: 14,
      workflow: t(WF.submittal),
      watchers: ["musavir", "idare-gozlemci"],
    },
    meetings: MEETINGS.map((m, i) => ({
      name: t(m),
      agenda: [
        t({ tr: "Önceki toplantı aksiyonlarının takibi", en: "Review of previous actions" }),
        ...({
          0: [{ tr: "Proje genel durumu ve ilerleme", en: "Overall status and progress" }, { tr: "Sözleşme ve hakediş konuları", en: "Contract and payment matters" }, { tr: "İdare kararı gereken konular", en: "Items for client decision" }],
          1: [{ tr: "Tasarım teslim planı (MIDP) durumu", en: "Delivery plan (MIDP) status" }, { tr: "Açık RFI'lar ve tasarım değişiklikleri", en: "Open RFIs and design changes" }, { tr: "İnceleme ve onay bekleyen dokümanlar", en: "Documents awaiting review and approval" }],
          2: [{ tr: "Haftalık saha programı", en: "Weekly site programme" }, { tr: "Arayüz ve ekip koordinasyonu", en: "Interfaces and trade coordination" }, { tr: "Saha gözlemleri ve açık sorunlar", en: "Site observations and open issues" }],
          3: [{ tr: "Açık NCR ve CAR'lar", en: "Open NCRs and CARs" }, { tr: "Malzeme onayları ve testler", en: "Material approvals and tests" }, { tr: "Muayene talepleri", en: "Inspection requests" }],
          4: [{ tr: "Elektromekanik tasarım ve imalat durumu", en: "MEP design and installation status" }, { tr: "Test ve devreye alma planı", en: "Testing and commissioning plan" }, { tr: "Tedarik ve teslim süreleri", en: "Procurement lead times" }],
          5: [{ tr: "Program sapmaları ve kritik yol", en: "Programme variances and critical path" }, { tr: "Gecikme ve hızlandırma önlemleri", en: "Delays and recovery measures" }, { tr: "Gelecek dönem planı", en: "Look-ahead plan" }],
          6: [{ tr: "Model teslimleri ve kalite kontrol", en: "Model deliveries and quality checks" }, { tr: "Çakışma raporu ve çözümler", en: "Clash report and resolutions" }, { tr: "Kodlama ve CDE uyumu", en: "Naming and CDE compliance" }],
          7: [{ tr: "Olay ve ramak kala bildirimleri", en: "Incidents and near misses" }, { tr: "Saha denetim bulguları", en: "Site inspection findings" }, { tr: "Çevre ve atık yönetimi", en: "Environment and waste" }],
        }[i].map(t)),
        t({ tr: "Kararlar ve yeni aksiyonlar", en: "Decisions and new actions" }),
      ],
      attendees: i === 0 ? ["idare", "musavir", "yuklenici"] : i === 1 || i === 6 ? ["musavir", "tasarimci", "yuklenici"] : ["musavir", "yuklenici"],
      minutesFolder: `${t({ tr: "00-GENEL", en: "00-GENERAL" })}/${t({ tr: "06-Toplantı Tutanakları", en: "06-Meeting Minutes" })}/${String(i + 1).padStart(2, "0")}-${t(m)}`,
    })),
    forms: [
      { key: "DTF", name: t({ tr: "Değişiklik Talep Formu", en: "Change Request" }), workflow: t(WF.dtf), sections: [
        [t({ tr: "Genel bilgiler", en: "General" }), "yuklenici"], [t({ tr: "Değişiklik tanımı", en: "Description of change" }), "yuklenici"],
        [t({ tr: "Etki analizi (maliyet, süre)", en: "Impact (cost, time)" }), "yuklenici"], [t({ tr: "Müşavir değerlendirmesi", en: "Consultant evaluation" }), "musavir"],
        [t({ tr: "İdare kararı", en: "Client decision" }), "idare"],
      ].map(([name, editor]) => ({ name, editor })) },
      { key: "AYF", name: t({ tr: "Alt Yüklenici Onay Formu", en: "Subcontractor Approval" }), workflow: t(WF.ayf), sections: [
        [t({ tr: "Form bilgileri", en: "Form details" }), "yuklenici"], [t({ tr: "Firma bilgileri", en: "Company details" }), "yuklenici"],
        [t({ tr: "Ek belgeler (var / yok listesi)", en: "Attachments checklist" }), "yuklenici"], [t({ tr: "Müşavir değerlendirmesi", en: "Consultant evaluation" }), "musavir"],
        [t({ tr: "İdare kararı", en: "Client decision" }), "idare"],
      ].map(([name, editor]) => ({ name, editor })) },
      { key: L === "tr" ? "MTL" : "EIN", name: t({ tr: "Mühendis Talimatı", en: "Engineer's Instruction" }), sections: [
        [t({ tr: "Genel bilgiler", en: "General" }), "musavir"], [t({ tr: "Talimat", en: "Instruction" }), "musavir"], [t({ tr: "Yüklenici tebellüğü", en: "Contractor acknowledgement" }), "yuklenici"],
      ].map(([name, editor]) => ({ name, editor })) },
      { key: L === "tr" ? "GR" : "DR", name: t({ tr: "Günlük Rapor", en: "Daily Report" }), sections: [
        t({ tr: "Hava", en: "Weather" }), t({ tr: "Personel", en: "Labour" }), t({ tr: "Makine ve ekipman", en: "Plant and equipment" }),
        t({ tr: "İSG", en: "HSE" }), t({ tr: "Yapılan imalatlar", en: "Work done" }),
      ].map((name) => ({ name, editor: "yuklenici" })) },
    ],
    notes: [
      t({ tr: "Firma kodları (Kaynak, Gönderen, Alıcı) proje oluştururken her taraf için sorulur.", en: "Company codes (Originator, Sender, Recipient) are asked for each party when the project is created." }),
      t({ tr: "Disiplin listesi ve kodlama alanları örnektir; kurulum sihirbazında müşterinin kodlamasına göre değiştirilir (ör. Alt Disiplin, Aşama alanı eklenir).", en: "The discipline list and naming fields are examples; the setup wizard adapts them to the client's coding (e.g. adds Sub-discipline or Stage)." }),
      t({ tr: "Paylaşılan ve yayınlanan alanlara dosya yalnız onaylı inceleme ile girer (ISO 19650-2 §5.6.4, §5.7.4); geçiş kuralları açık.", en: "Files enter the shared and published areas only through an approved review (ISO 19650-2 §5.6.4, §5.7.4); the transition rules are enforced." }),
      ...(L === "tr"
        ? ["ÇŞB 2026 (EK-2) dosya isimlendirmesi seçenek olarak gelir: kurulum sihirbazında doküman kodu standardı olarak seçilirse paylaşılan ve yayınlanan klasörler bu standarda göre adlandırılır. Proje Kodu, proje bilgilerindeki ÇŞB proje kodundan (EK-1) dolar; Revizyon No (000, 001 …) idarenin revizyon talebini sayar, ISO revizyon kodundan (P01 / C01) ayrıdır."]
        : []),
      t({ tr: "Uygunluk ve revizyon kodları ISO düzenindedir (S0–S4, A, B, CR; P01 / C01). Sahadaki R00 düzeni Proje Ayarları → CDE → Kod Düzeni'nden seçilebilir.", en: "Suitability and revision codes follow ISO 19650 (S0–S4, A, B, CR; P01 / C01). The R00 scheme can be chosen in Project Settings → CDE → Code Scheme." }),
      t({ tr: "RFI, malzeme onayı ve toplantı ayarları Manage, form şablonları Field modülü kuruluysa uygulanır; değilse atlanır.", en: "RFI, submittal and meeting settings are applied when the Manage module is installed, form templates when Field is; otherwise they are skipped." }),
    ],
  };
}

const check = process.argv.includes("--check");
let stale = 0;
for (const lang of ["tr", "en"]) {
  L = lang;
  const file = path.join(outDir, `iso19650-yapim-${lang}.json`);
  const text = JSON.stringify(template(), null, 2) + "\n";
  if (check) {
    let current = "";
    try {
      current = readFileSync(file, "utf8");
    } catch {}
    if (current !== text) {
      console.error(`${path.relative(process.cwd(), file)} is out of date: node ${path.relative(process.cwd(), fileURLToPath(import.meta.url))}`);
      stale++;
    }
  } else writeFileSync(file, text);
}
if (stale) process.exit(1);
console.log("ok");
