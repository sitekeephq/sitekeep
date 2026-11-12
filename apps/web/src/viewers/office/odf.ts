/**
 * Small OpenDocument text (.odt) reader for the browser: content.xml (+ styles.xml) → blocks
 * (headings, paragraphs, lists, tables, images, page breaks) with bold / italic / underline /
 * strike / colour and links. A simple view, not the page layout. Pure (no DOM): the viewer
 * renders the blocks with React, so nothing from the file becomes HTML.
 */

export interface XNode {
  name: string;
  attrs: Record<string, string>;
  children: (XNode | string)[];
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : "";
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

const TOKEN =
  /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<\/([^\s>]+)\s*>|<([^\s/>!?]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
const ATTR = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/** Minimal XML parser: elements, attributes, text and CDATA (comments, PIs and doctype are skipped). */
export function parseXml(xml: string): XNode {
  const root: XNode = { name: "#root", attrs: {}, children: [] };
  const stack = [root];
  for (const m of xml.matchAll(TOKEN)) {
    const top = stack[stack.length - 1]!;
    if (m[1] !== undefined) top.children.push(m[1]);
    else if (m[2]) {
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i]!.name === m[2]) {
          stack.length = i;
          break;
        }
      }
    } else if (m[3]) {
      const attrs: Record<string, string> = {};
      for (const a of (m[4] ?? "").matchAll(ATTR)) attrs[a[1]!] = decodeEntities(a[2] ?? a[3] ?? "");
      const node: XNode = { name: m[3], attrs, children: [] };
      top.children.push(node);
      if (!m[5]) stack.push(node);
    } else if (m[6] !== undefined) top.children.push(decodeEntities(m[6]));
  }
  return root;
}

// ---------------------------------------------------------------------------------------------

export interface OdfFormat {
  b?: boolean;
  i?: boolean;
  u?: boolean;
  s?: boolean;
  color?: string;
}

export type OdfInline =
  | ({ t: "text"; text: string; href?: string } & OdfFormat)
  | { t: "br" }
  | { t: "img"; src: string; width?: string; height?: string };

export type OdfAlign = "left" | "center" | "right" | "justify";

export interface OdfCell {
  colSpan: number;
  rowSpan: number;
  blocks: OdfBlock[];
}

export type OdfBlock =
  | { t: "h"; level: number; align?: OdfAlign; runs: OdfInline[] }
  | { t: "p"; align?: OdfAlign; runs: OdfInline[] }
  | { t: "list"; ordered: boolean; items: OdfBlock[][] }
  | { t: "table"; rows: OdfCell[][] }
  | { t: "pagebreak" };

export interface OdfDocument {
  blocks: OdfBlock[];
  /** Zip paths of the images used (Pictures/…). */
  images: string[];
}

interface StyleDef extends OdfFormat {
  parent?: string;
  align?: OdfAlign;
  breakBefore?: boolean;
  breakAfter?: boolean;
}

const ALIGN: Record<string, OdfAlign> = { start: "left", left: "left", center: "center", end: "right", right: "right", justify: "justify" };
/** Cells and rows repeated at most (spreadsheet-like tables repeat empty cells thousands of times). */
const MAX_REPEAT = 64;

function child(n: XNode, name: string): XNode | undefined {
  return n.children.find((c): c is XNode => typeof c !== "string" && c.name === name);
}

function* walk(n: XNode): Generator<XNode> {
  for (const c of n.children) {
    if (typeof c === "string") continue;
    yield c;
    yield* walk(c);
  }
}

/** Only web and mail links survive; anything else (javascript:, file:, internal refs) is dropped. */
export function safeHref(href: string | undefined): string | undefined {
  const h = href?.trim();
  return h && /^(https?:|mailto:)/i.test(h) ? h : undefined;
}

const safeColor = (c: string | undefined) => (c && /^#[0-9a-f]{3,8}$/i.test(c) ? c : undefined);

function collectStyles(roots: XNode[]): { styles: Map<string, StyleDef>; ordered: Map<string, boolean> } {
  const styles = new Map<string, StyleDef>();
  const ordered = new Map<string, boolean>();
  for (const root of roots) {
    for (const n of walk(root)) {
      if (n.name === "style:style" && n.attrs["style:name"]) {
        const def: StyleDef = { parent: n.attrs["style:parent-style-name"] };
        const tp = child(n, "style:text-properties")?.attrs;
        if (tp) {
          const w = tp["fo:font-weight"];
          if (w) def.b = w === "bold" || Number(w) >= 600;
          const st = tp["fo:font-style"];
          if (st) def.i = st === "italic" || st === "oblique";
          const u = tp["style:text-underline-style"];
          if (u) def.u = u !== "none";
          const s = tp["style:text-line-through-style"];
          if (s) def.s = s !== "none";
          def.color = safeColor(tp["fo:color"]);
        }
        const pp = child(n, "style:paragraph-properties")?.attrs;
        if (pp) {
          def.align = ALIGN[pp["fo:text-align"] ?? ""];
          def.breakBefore = pp["fo:break-before"] === "page" || undefined;
          def.breakAfter = pp["fo:break-after"] === "page" || undefined;
        }
        styles.set(n.attrs["style:name"], def);
      } else if (n.name === "text:list-style" && n.attrs["style:name"]) {
        const first = n.children.find((c): c is XNode => typeof c !== "string" && c.name.startsWith("text:list-level-style-"));
        ordered.set(n.attrs["style:name"], first?.name === "text:list-level-style-number");
      }
    }
  }
  return { styles, ordered };
}

class Reader {
  readonly images = new Set<string>();
  private readonly resolved = new Map<string, StyleDef>();

  constructor(
    private readonly styles: Map<string, StyleDef>,
    private readonly ordered: Map<string, boolean>,
  ) {}

  style(name: string | undefined): StyleDef {
    if (!name) return {};
    const hit = this.resolved.get(name);
    if (hit) return hit;
    const chain: StyleDef[] = [];
    let n: string | undefined = name;
    for (let depth = 0; n && depth < 12; depth++) {
      const d = this.styles.get(n);
      if (!d) break;
      chain.unshift(d);
      n = d.parent;
    }
    const out: StyleDef = {};
    for (const d of chain) {
      for (const k of ["b", "i", "u", "s", "color", "align"] as const) if (d[k] !== undefined) (out as Record<string, unknown>)[k] = d[k];
    }
    // Page breaks are not inherited by paragraphs from their parent style chain in practice
    // except from the direct style.
    const own = this.styles.get(name);
    out.breakBefore = own?.breakBefore;
    out.breakAfter = own?.breakAfter;
    this.resolved.set(name, out);
    return out;
  }

  blocks(nodes: (XNode | string)[], listStyle?: string): OdfBlock[] {
    const out: OdfBlock[] = [];
    for (const n of nodes) {
      if (typeof n === "string") continue;
      switch (n.name) {
        case "text:h":
        case "text:p": {
          const st = this.style(n.attrs["text:style-name"]);
          if (st.breakBefore && out.length) out.push({ t: "pagebreak" });
          const fmt: OdfFormat = { b: st.b, i: st.i, u: st.u, s: st.s, color: st.color };
          const runs = trimRuns(this.inlines(n.children, fmt));
          const align = st.align && st.align !== "left" ? st.align : undefined;
          if (n.name === "text:h") {
            const level = Math.min(6, Math.max(1, Number(n.attrs["text:outline-level"]) || 1));
            out.push({ t: "h", level, ...(align && { align }), runs });
          } else out.push({ t: "p", ...(align && { align }), runs });
          if (st.breakAfter) out.push({ t: "pagebreak" });
          break;
        }
        case "text:list": {
          const style = n.attrs["text:style-name"] ?? listStyle;
          const items: OdfBlock[][] = [];
          for (const it of n.children) {
            if (typeof it === "string" || (it.name !== "text:list-item" && it.name !== "text:list-header")) continue;
            items.push(this.blocks(it.children, style));
          }
          out.push({ t: "list", ordered: !!(style && this.ordered.get(style)), items });
          break;
        }
        case "table:table":
          out.push({ t: "table", rows: this.rows(n) });
          break;
        case "draw:frame": {
          const runs = this.inlines([n], {});
          if (runs.length) out.push({ t: "p", runs });
          break;
        }
        // Declarations, forms, annotations, tracked changes: nothing to show.
        case "text:sequence-decls":
        case "text:variable-decls":
        case "text:user-field-decls":
        case "office:forms":
        case "text:tracked-changes":
        case "office:annotation":
        case "text:soft-page-break":
        case "table:table-columns":
        case "table:table-column":
          break;
        default:
          // Sections, indexes, text boxes and unknown containers: their content.
          out.push(...this.blocks(n.children, listStyle));
      }
    }
    return out;
  }

  private rows(table: XNode): OdfCell[][] {
    const rows: OdfCell[][] = [];
    const visit = (n: XNode) => {
      for (const c of n.children) {
        if (typeof c === "string") continue;
        if (c.name === "table:table-row") {
          const row: OdfCell[] = [];
          for (const cell of c.children) {
            if (typeof cell === "string" || cell.name !== "table:table-cell") continue;
            const blocks = this.blocks(cell.children);
            const repeat = Math.min(MAX_REPEAT, Number(cell.attrs["table:number-columns-repeated"]) || 1);
            // Trailing empty repeated cells are padding.
            if (repeat > 1 && !blocks.length) continue;
            for (let k = 0; k < repeat; k++) {
              row.push({
                colSpan: Math.max(1, Number(cell.attrs["table:number-columns-spanned"]) || 1),
                rowSpan: Math.max(1, Number(cell.attrs["table:number-rows-spanned"]) || 1),
                blocks,
              });
            }
          }
          const repeat = Math.min(MAX_REPEAT, Number(c.attrs["table:number-rows-repeated"]) || 1);
          if (repeat > 1 && row.every((x) => !x.blocks.length)) continue;
          for (let k = 0; k < repeat; k++) rows.push(row);
        } else if (c.name === "table:table-header-rows" || c.name === "table:table-rows" || c.name === "table:table-row-group") visit(c);
      }
    };
    visit(table);
    return rows;
  }

  inlines(nodes: (XNode | string)[], fmt: OdfFormat, href?: string): OdfInline[] {
    const out: OdfInline[] = [];
    const text = (s: string, raw: boolean) => {
      if (!s) return;
      const run = { t: "text" as const, text: s, ...compact(fmt), ...(href && { href }) };
      if (raw) (run as { raw?: boolean }).raw = true;
      out.push(run);
    };
    for (const n of nodes) {
      if (typeof n === "string") {
        text(n.replace(/[ \t\r\n]+/g, " "), true);
        continue;
      }
      switch (n.name) {
        case "text:span": {
          const st = this.style(n.attrs["text:style-name"]);
          out.push(...this.inlines(n.children, { ...fmt, ...defined({ b: st.b, i: st.i, u: st.u, s: st.s, color: st.color }) }, href));
          break;
        }
        case "text:a":
          out.push(...this.inlines(n.children, fmt, safeHref(n.attrs["xlink:href"])));
          break;
        case "text:s":
          text(" ".repeat(Math.min(200, Number(n.attrs["text:c"]) || 1)), false);
          break;
        case "text:tab":
          text("\t", false);
          break;
        case "text:line-break":
          out.push({ t: "br" });
          break;
        case "draw:frame": {
          const img = child(n, "draw:image");
          const box = child(n, "draw:text-box");
          const src = img?.attrs["xlink:href"];
          if (src && isZipPath(src)) {
            this.images.add(normalizePath(src));
            out.push({ t: "img", src: normalizePath(src), width: size(n.attrs["svg:width"]), height: size(n.attrs["svg:height"]) });
          } else if (box) {
            for (const b of this.blocks(box.children)) {
              if (b.t === "p" || b.t === "h") {
                if (out.length) out.push({ t: "br" });
                out.push(...b.runs);
              }
            }
          }
          break;
        }
        case "draw:image": {
          const src = n.attrs["xlink:href"];
          if (src && isZipPath(src)) {
            this.images.add(normalizePath(src));
            out.push({ t: "img", src: normalizePath(src) });
          }
          break;
        }
        case "text:note":
        case "office:annotation":
        case "office:annotation-end":
        case "text:bookmark":
        case "text:bookmark-start":
        case "text:bookmark-end":
        case "text:soft-page-break":
        case "text:change":
        case "text:change-start":
        case "text:change-end":
          break;
        default:
          out.push(...this.inlines(n.children, fmt, href));
      }
    }
    return out;
  }
}

/** Embedded pictures only (no external URLs: the viewer works offline and loads nothing remote). */
function isZipPath(p: string): boolean {
  return !/^[a-z][a-z0-9+.-]*:/i.test(p) && !p.startsWith("//") && !p.includes("..");
}

function normalizePath(p: string): string {
  return p.replace(/^\.\//, "").replace(/^\//, "");
}

/** Lengths like "8cm", "2.5in", "120pt" only. */
function size(v: string | undefined): string | undefined {
  return v && /^\d+(\.\d+)?(cm|mm|in|pt|pc|px)$/.test(v) ? v : undefined;
}

function defined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

function compact(f: OdfFormat): OdfFormat {
  return defined({ b: f.b || undefined, i: f.i || undefined, u: f.u || undefined, s: f.s || undefined, color: f.color });
}

/** Leading and trailing XML whitespace of a paragraph is not shown (ODF whitespace rules). */
function trimRuns(runs: OdfInline[]): OdfInline[] {
  const first = runs[0];
  if (first?.t === "text" && (first as { raw?: boolean }).raw) first.text = first.text.replace(/^ +/, "");
  const last = runs[runs.length - 1];
  if (last?.t === "text" && (last as { raw?: boolean }).raw) last.text = last.text.replace(/ +$/, "");
  const out = runs.filter((r) => r.t !== "text" || r.text);
  for (const r of out) delete (r as { raw?: boolean }).raw;
  return out;
}

/** Reads content.xml (and styles.xml for named styles) into blocks. */
export function parseOdt(contentXml: string, stylesXml?: string): OdfDocument {
  const content = parseXml(contentXml);
  const styleRoots = [content, ...(stylesXml ? [parseXml(stylesXml)] : [])];
  const { styles, ordered } = collectStyles(styleRoots);
  const reader = new Reader(styles, ordered);
  let body: XNode | undefined;
  for (const n of walk(content)) {
    if (n.name === "office:text") {
      body = n;
      break;
    }
  }
  const blocks = body ? reader.blocks(body.children) : [];
  return { blocks, images: [...reader.images] };
}

/** Plain text of the blocks (tests, find). */
export function odfPlainText(blocks: OdfBlock[]): string {
  const lines: string[] = [];
  const inline = (runs: OdfInline[]) => runs.map((r) => (r.t === "text" ? r.text : r.t === "br" ? "\n" : "")).join("");
  for (const b of blocks) {
    if (b.t === "h" || b.t === "p") lines.push(inline(b.runs));
    else if (b.t === "list") for (const it of b.items) lines.push(odfPlainText(it));
    else if (b.t === "table") for (const row of b.rows) lines.push(row.map((c) => odfPlainText(c.blocks)).join(" | "));
  }
  return lines.join("\n");
}
