/**
 * Plain text of Office Open XML and OpenDocument files read straight from their XML parts, so
 * search and the assistant work even without LibreOffice. Also reads PowerPoint speaker notes.
 * Binary formats (.doc, .ppt, .rtf) get their text from the converted PDF instead.
 */
import { readZip } from "../core/formats/zip.js";

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

export function decodeXml(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : "";
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Text runs of one paragraph-structured XML part: `para` closes a paragraph, `run` holds text. */
function paragraphs(xml: string, para: RegExp, run: RegExp, tab?: RegExp): string[] {
  const out: string[] = [];
  for (const p of xml.split(para)) {
    let t = "";
    const marked = tab ? p.replace(tab, "<__tab/>") : p;
    const re = new RegExp(`${run.source}|<__tab/>`, "g");
    for (const m of marked.matchAll(re)) t += m[1] !== undefined ? decodeXml(m[1]) : "\t";
    t = t.replace(/[ \t]+/g, " ").trim();
    if (t) out.push(t);
  }
  return out;
}

const DOCX_RUN = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/;
const DRAWING_RUN = /<a:t(?:\s[^>]*)?>([^<]*)<\/a:t>/;

function docxText(zip: Map<string, () => Buffer>): string {
  const parts = ["word/document.xml", "word/footnotes.xml", "word/endnotes.xml"];
  const out: string[] = [];
  for (const name of parts) {
    const get = zip.get(name);
    if (get) out.push(...paragraphs(get().toString("utf8"), /<\/w:p>/, DOCX_RUN, /<w:tab\/>/g));
  }
  return out.join("\n");
}

/** Slide parts in presentation order (presentation.xml sldIdLst → relationships). */
function slideOrder(zip: Map<string, () => Buffer>): string[] {
  const pres = zip.get("ppt/presentation.xml")?.().toString("utf8");
  const rels = zip.get("ppt/_rels/presentation.xml.rels")?.().toString("utf8");
  const numeric = [...zip.keys()]
    .filter((k) => /^ppt\/slides\/slide\d+\.xml$/.test(k))
    .sort((a, b) => Number(/(\d+)\.xml$/.exec(a)![1]) - Number(/(\d+)\.xml$/.exec(b)![1]));
  if (!pres || !rels) return numeric;
  const targets = new Map<string, string>();
  for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = /\bId="([^"]+)"/.exec(m[0])?.[1];
    const target = /\bTarget="([^"]+)"/.exec(m[0])?.[1];
    if (id && target) targets.set(id, target.startsWith("/") ? target.slice(1) : `ppt/${target}`);
  }
  const ordered = [...pres.matchAll(/<p:sldId\b[^>]*\br:id="([^"]+)"/g)]
    .map((m) => targets.get(m[1]!))
    .filter((t): t is string => !!t && zip.has(t));
  return ordered.length ? ordered : numeric;
}

function relTarget(zip: Map<string, () => Buffer>, part: string, typeSuffix: string): string | null {
  const dir = part.slice(0, part.lastIndexOf("/"));
  const relsName = `${dir}/_rels/${part.slice(dir.length + 1)}.rels`;
  const rels = zip.get(relsName)?.().toString("utf8");
  if (!rels) return null;
  for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
    if (!new RegExp(`Type="[^"]*${typeSuffix}"`).test(m[0])) continue;
    const target = /\bTarget="([^"]+)"/.exec(m[0])?.[1];
    if (!target) continue;
    // Resolve "../notesSlides/notesSlide1.xml" against the part's folder.
    const segs = dir.split("/");
    for (const s of target.split("/")) {
      if (s === "..") segs.pop();
      else if (s !== ".") segs.push(s);
    }
    return segs.join("/");
  }
  return null;
}

/** Speaker notes of a notes slide: the body placeholder's paragraphs. */
function notesOf(xml: string): string {
  const shapes = xml.split(/<\/p:sp>/).filter((s) => /<p:ph\b[^>]*type="body"/.test(s));
  return shapes.flatMap((s) => paragraphs(s, /<\/a:p>/, DRAWING_RUN)).join("\n");
}

export interface PptxText {
  slides: string[];
  notes: string[];
}

export function pptxText(buf: Buffer): PptxText {
  const zip = readZip(buf);
  const slides: string[] = [];
  const notes: string[] = [];
  for (const part of slideOrder(zip)) {
    slides.push(paragraphs(zip.get(part)!().toString("utf8"), /<\/a:p>/, DRAWING_RUN).join("\n"));
    const n = relTarget(zip, part, "/notesSlide");
    notes.push(n && zip.has(n) ? notesOf(zip.get(n)!().toString("utf8")) : "");
  }
  return { slides, notes };
}

function odfText(zip: Map<string, () => Buffer>): string {
  const xml = zip.get("content.xml")?.().toString("utf8");
  if (!xml) return "";
  // Paragraphs and headings end with </text:p> / </text:h>; spaces and tabs are elements.
  const body = xml
    .replace(/<text:s(?:\s+text:c="(\d+)")?\s*\/>/g, (_, n: string | undefined) => " ".repeat(Number(n ?? 1)))
    .replace(/<text:tab\s*\/>/g, "\t")
    .replace(/<text:line-break\s*\/>/g, "\n");
  return body
    .split(/<\/text:(?:p|h)>/)
    .map((p) => decodeXml(p.replace(/<[^>]+>/g, "")).replace(/[ \t]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

/**
 * Text of an office file by extension; null when the format is binary or not an archive
 * (then the PDF text is used).
 */
export function officeText(buf: Buffer, extension: string): { text: string; notes?: string[] } | null {
  const ext = extension.toLowerCase();
  try {
    if (["docx", "docm", "dotx"].includes(ext)) return { text: docxText(readZip(buf)) };
    if (["pptx", "pptm", "ppsx"].includes(ext)) {
      const p = pptxText(buf);
      const text = p.slides
        .map((s, i) => [`[Slayt ${i + 1}]`, s, p.notes[i] ? `Notlar: ${p.notes[i]}` : ""].filter(Boolean).join("\n"))
        .join("\n\n");
      return { text, notes: p.notes };
    }
    if (["odt", "ott", "odp"].includes(ext)) return { text: odfText(readZip(buf)) };
  } catch {
    return null;
  }
  return null;
}
