import { z } from "zod";
import type { CdeCall } from "../../core/types.js";
import type { ToolAdder } from "../../core/define.js";
import { clean, cut, day, qs, type Any } from "../../format/common.js";
import { capList } from "../../format/lists.js";
import {
  SUBMITTAL_DISCIPLINES,
  SUBMITTAL_TYPE_CODES,
  foldTr,
  projectPath,
  submittalDisciplineLabel,
  submittalTypeLabel,
} from "@sitekeep/shared";

const confirm = " Changes live project data: confirm with the user first.";
const SPEC_DISCIPLINES = SUBMITTAL_DISCIPLINES.map((d) => d.code) as [string, ...string[]];
const SPEC_TYPES = [...SUBMITTAL_TYPE_CODES] as [string, ...string[]];

function specItemRow(i: Any) {
  return clean({
    id: i.id,
    page: i.page,
    section: [i.sectionCode, i.sectionTitle].filter(Boolean).join(" ") || null,
    type: i.type,
    typeLabel: i.type ? submittalTypeLabel(i.type) : null,
    discipline: i.discipline,
    disciplineLabel: i.discipline ? submittalDisciplineLabel(i.discipline) : null,
    description: i.description,
    excerpt: cut(i.excerpt, 240),
    excluded: i.excluded || undefined,
    aiAssisted: i.aiAssisted || undefined,
  });
}

function formatSpecRegister(r: Any, opts: { type?: string; discipline?: string; q?: string; includeExcluded?: boolean; limit: number }) {
  const all = ((r.items ?? []) as Any[]).filter((i) => opts.includeExcluded || !i.excluded);
  const byType: Record<string, number> = {};
  const byDiscipline: Record<string, number> = {};
  for (const i of all) {
    const t = i.type ? `${i.type} (${submittalTypeLabel(i.type)})` : "Belirsiz";
    const d = i.discipline ? `${i.discipline} (${submittalDisciplineLabel(i.discipline)})` : "Belirsiz";
    byType[t] = (byType[t] ?? 0) + 1;
    byDiscipline[d] = (byDiscipline[d] ?? 0) + 1;
  }
  const wantQ = opts.q ? foldTr(opts.q.trim()) : "";
  const filtered = all.filter((i) => {
    if (opts.type && i.type !== opts.type) return false;
    if (opts.discipline && i.discipline !== opts.discipline) return false;
    if (wantQ && !foldTr(`${i.id} ${i.sectionCode ?? ""} ${i.sectionTitle ?? ""} ${i.description ?? ""} ${i.excerpt ?? ""}`).includes(wantQ)) return false;
    return true;
  });
  const list = capList(filtered.map(specItemRow), opts.limit);
  return clean({
    id: r.id,
    fileId: r.fileId,
    versionId: r.versionId,
    file: r.fileName,
    v: r.version,
    pages: r.pageCount,
    sections: r.sectionCount,
    usedAi: !!r.usedAi,
    updated: day(r.updatedAt),
    totalItems: all.length,
    matched: filtered.length !== all.length ? filtered.length : undefined,
    byType,
    byDiscipline,
    items: list.items,
    more: list.more,
    link: projectPath(r.projectId, `spec/${r.id}`),
  });
}


export function registerDocumentTools(tool: ToolAdder, call: CdeCall): void {
  const id = (what: string) => z.string().uuid().describe(what);
  const pid = id("Project id (from cde_projects_list).");
// ---- Document intelligence ---------------------------------------------------------------

tool(
  "cde_spec_registers_list",
  "Specification (şartname) submittal registers built from PDF specs: source file, version, item count.",
  { projectId: pid },
  async (a) =>
    (await call<Any[]>("GET", `/projects/${a.projectId}/docintel/spec-registers`)).map((r) =>
      clean({ id: r.id, fileId: r.fileId, versionId: r.versionId, file: r.fileName, v: r.version, items: r.itemCount, updated: day(r.updatedAt) }),
    ),
);

tool(
  "cde_spec_register_get",
  "Items of a specification (şartname) submittal register: code (S001…), page, section, submittal type (MOS Malzeme Onay, NUM Numune, UCZ Uygulama Çizimi, " +
    "TR Test/Rapor, KS Kalite/Test, YB Yöntem Beyanı, IP İş Programı, ISG, PMR…), discipline (MIM, INS, MEK, ELK, GEO, ALT, PEY, GNL), description and excerpt. " +
    "Give registerId, fileId, or a part of the file name (`file`); default: the newest register. Filter by type, discipline or text (`q`).",
  {
    projectId: pid,
    registerId: id("Specification register id (cde_spec_registers_list).").optional(),
    fileId: id("Source PDF file id.").optional(),
    file: z.string().max(200).optional().describe("Part of the specification PDF file name, when registerId is not known."),
    type: z.enum(SPEC_TYPES).optional().describe("Submittal type code, e.g. MOS, NUM, UCZ, TR, KS, YB."),
    discipline: z.enum(SPEC_DISCIPLINES).optional().describe("Discipline code: MIM, INS, GEO, MEK, ELK, ALT, PEY, GNL."),
    q: z.string().max(200).optional().describe("Text in section, description or excerpt."),
    includeExcluded: z.boolean().default(false),
    limit: z.number().int().min(1).max(200).default(50),
  },
  async (a) => {
    let rid = a.registerId;
    if (!rid) {
      const list = await call<Any[]>("GET", `/projects/${a.projectId}/docintel/spec-registers`);
      if (!list.length) throw new Error("Bu projede henüz şartname analizi yok.");
      if (a.fileId) {
        const hit = list.find((r) => r.fileId === a.fileId);
        if (!hit) throw new Error("Bu dosya için şartname analizi bulunamadı.");
        rid = hit.id;
      } else if (a.file) {
        const want = foldTr(a.file.trim());
        const hit = list.find((r) => foldTr(String(r.fileName)).includes(want));
        if (!hit) throw new Error(`"${a.file}" adlı bir şartname analizi yok. Mevcut: ${list.map((r) => r.fileName).join(", ")}`);
        rid = hit.id;
      } else {
        rid = list[0]!.id;
      }
    }
    const r = await call<Any>("GET", `/projects/${a.projectId}/docintel/spec-registers/${rid}`);
    return formatSpecRegister(r, a);
  },
);

tool(
  "cde_spec_register_build",
  "Analyses a PDF specification (şartname) and builds or updates its submittal register (teknik onay listesi): scans headings and requirement sentences, " +
    "classifies each item by submittal type (MOS, NUM, UCZ…) and discipline (INS, MEK, ELK…). Give versionId, fileId (uses the current version), or `file` " +
    "(part of the PDF file name)." +
    confirm,
  {
    projectId: pid,
    versionId: id("PDF version id.").optional(),
    fileId: id("PDF file id (current version).").optional(),
    file: z.string().max(200).optional().describe("Part of the PDF file name in the project."),
    ai: z.boolean().default(false).describe("Also refine uncertain items with the project's AI provider."),
  },
  async (a) => {
    let vid = a.versionId;
    if (!vid) {
      let fid = a.fileId;
      if (!fid && a.file) {
        const res = await call<{ results: { id: string; name: string }[] }>(
          "GET",
          `/projects/${a.projectId}/search${qs({ q: a.file, ext: "pdf", limit: 20 })}`,
        );
        const want = foldTr(a.file.trim());
        // Only a name match: this tool writes, so a loose search hit must not be analysed instead.
        const hit = res.results.find((f) => foldTr(f.name) === want) ?? res.results.find((f) => foldTr(f.name).includes(want));
        if (!hit) {
          const seen = res.results.slice(0, 5).map((f) => f.name);
          throw new Error(`"${a.file}" adlı bir PDF dosyası bulunamadı.${seen.length ? ` Benzer sonuçlar: ${seen.join(", ")}` : ""}`);
        }
        fid = hit.id;
      }
      if (!fid) throw new Error("versionId, fileId ya da file gerekli.");
      const f = await call<Any>("GET", `/projects/${a.projectId}/files/${fid}`);
      vid = (f.versions as Any[]).find((v) => v.version === f.currentVersion)?.id ?? f.latest?.id;
      if (!vid) throw new Error("Dosyanın versiyonu bulunamadı.");
    }
    const r = await call<Any>("POST", `/projects/${a.projectId}/docintel/spec-register`, { versionId: vid, ai: a.ai });
    return formatSpecRegister(r, { limit: 30 });
  },
  { write: true },
);

tool(
  "cde_file_antet",
  "Title block (antet) of a PDF version: fields read from the drawing (drawing no, revision, scale, date…), revision table and revision warnings. " +
    "Give versionId, or fileId for the current version.",
  { projectId: pid, fileId: id("File id").optional(), versionId: id("Version id").optional() },
  async (a) => {
    let vid = a.versionId;
    let fileName: string | undefined;
    if (!vid) {
      if (!a.fileId) throw new Error("fileId veya versionId gerekli.");
      const f = await call<Any>("GET", `/projects/${a.projectId}/files/${a.fileId}`);
      fileName = f.name;
      vid = (f.versions as Any[]).find((v) => v.version === f.currentVersion)?.id ?? f.latest?.id;
      if (!vid) throw new Error("Dosyanın versiyonu bulunamadı.");
    }
    const d = await call<Any>("GET", `/projects/${a.projectId}/versions/${vid}/docintel`);
    const antet = d.antet;
    return clean({
      file: fileName,
      fileId: d.fileId,
      v: d.version,
      status: d.status,
      note:
        d.status === "pending" || d.status === "processing"
          ? "Antet henüz okunmadı (arka planda işleniyor ya da web arayüzünden başlatılmalı)."
          : d.status === "unsupported"
            ? "Yalnız PDF dosyalarının anteti okunur."
            : (d.error ?? antet?.note),
      kind: antet?.kind,
      fields: (antet?.fields ?? []).map((f: Any) => clean({ key: f.key, label: f.label, value: f.value, conf: Math.round(f.confidence * 100) / 100 })),
      revision: d.revision?.value,
      revisionTable: (antet?.revisionTable ?? []).slice(-5),
      warnings: (d.warnings ?? []).map((w: Any) => `${w.severity === "warn" ? "Uyarı" : "Bilgi"}: ${w.message}`),
    });
  },
);

tool(
  "cde_document_compare",
  "Revision comparison of two document versions (PDF drawings/reports, XLSX, CSV, DOCX): text changes per page " +
    "(changed / added / removed lines with examples), title-block (antet) changes such as revision, date, drawing no, " +
    "revision checks (e.g. content changed but revision not updated) and the AI change summary when one was made in the web app. " +
    "Give fromVersionId + toVersionId, or fileId alone to compare its current version with the previous one.",
  {
    projectId: pid,
    fromVersionId: id("Old version id").optional(),
    toVersionId: id("New version id").optional(),
    fileId: id("File id: current vs previous version").optional(),
  },
  async (a) => {
    let from = a.fromVersionId;
    let to = a.toVersionId;
    if (!from || !to) {
      if (!a.fileId) throw new Error("fromVersionId + toVersionId ya da fileId gerekli.");
      const f = await call<Any>("GET", `/projects/${a.projectId}/files/${a.fileId}`);
      const versions = [...(f.versions as Any[])].sort((x, y) => y.version - x.version);
      const cur = versions.find((v) => v.version === f.currentVersion) ?? versions[0];
      const prev = versions.find((v) => v.version < cur?.version);
      if (!cur || !prev) throw new Error("Dosyanın karşılaştırılacak önceki versiyonu yok.");
      from = prev.id;
      to = cur.id;
    }
    const d = await call<Any>("GET", `/projects/${a.projectId}/doc-compare${qs({ from, to, wait: 20000 })}`);
    const r = d.result;
    const regionCount = new Map<number, number>(((d.regions ?? []) as Any[]).map((p) => [p.page, p.regions.length]));
    const line = (c: Any) =>
      c.kind === "changed" ? `~ "${cut(c.old, 80)}" → "${cut(c.new, 80)}"` : c.kind === "added" ? `+ "${cut(c.new, 100)}"` : `- "${cut(c.old, 100)}"`;
    const aiDone = d.ai?.status === "done" && d.ai.bullets?.length;
    return clean({
      file: d.to.fileName === d.from.fileName ? d.to.fileName : `${d.from.fileName} → ${d.to.fileName}`,
      versions: `V${d.from.version} → V${d.to.version}`,
      revision: r && (r.revisionA || r.revisionB) ? `${r.revisionA ?? "?"} → ${r.revisionB ?? "?"}` : null,
      status: d.status === "running" ? "hesaplanıyor; biraz sonra tekrar deneyin" : d.status === "failed" ? `hata: ${d.error}` : null,
      kind: r?.kind,
      note: r?.note,
      identical: r?.identical,
      pageCount: r && r.pageCountA !== r.pageCountB ? `${r.pageCountA} → ${r.pageCountB}` : r?.pageCountB,
      totals: r?.totals,
      checks: (d.flags ?? []).map((f: Any) => `${f.severity === "warn" ? "Uyarı" : "Bilgi"}: ${f.message}`),
      antet: (r?.antet ?? []).map((c: Any) => `${c.label}: ${c.old ?? "—"} → ${c.new ?? "—"}`),
      pages: capList(
        ((r?.pages ?? []) as Any[]).map((p) =>
          clean({
            page: p.page,
            changed: p.changed,
            added: p.added,
            removed: p.removed,
            regions: regionCount.get(p.page),
            examples: (p.changes as Any[]).filter((c) => !c.antet).slice(0, 6).map(line),
          }),
        ),
        15,
      ),
      sheets: r?.sheets
        ? (r.sheets as Any[])
            .filter((s) => s.status !== "same")
            .map((s) =>
              clean({
                name: s.name,
                status: s.status,
                changed: s.changed,
                added: s.added,
                removed: s.removed,
                examples: (s.rows as Any[]).slice(0, 6).map((x) =>
                  x.kind === "changed"
                    ? `satır ${x.rowB}: ${(x.cells as Any[]).map((c) => `${c.col} "${cut(c.old, 30)}" → "${cut(c.new, 30)}"`).join(", ")}`
                    : `satır ${x.rowB ?? x.rowA} ${x.kind === "added" ? "eklendi" : "silindi"}: ${cut(x.text, 80)}`,
                ),
              }),
            )
        : null,
      aiSummary: aiDone ? (d.ai.bullets as Any[]).map((b) => `${b.page ? `[s.${b.page}] ` : ""}${b.text}`) : null,
      summary: aiDone ? null : (d.summary as Any[]).map((b) => b.text),
      summaryNote: aiDone ? `Yapay zekâ özeti (${d.ai.model}).` : "Kural tabanlı özet; yapay zekâ özeti web arayüzünden (Revizyon karşılaştır) oluşturulur.",
      link: projectPath(a.projectId, `compare?from=${from}&to=${to}`),
    });
  },
);
}
