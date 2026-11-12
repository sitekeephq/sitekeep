/**
 * Find in a rendered document (docx, odt): Turkish-aware matching over the text of the DOM,
 * across text nodes (Word splits words into runs), highlighted with the CSS Custom Highlight API
 * (the current hit falls back to the selection where that API is missing).
 * The string part is pure and unit-tested.
 */

/**
 * Case folding for find that keeps the length: character i of the result is character i of
 * the input, so match offsets map straight back to DOM offsets. İ, I and ı all fold to i.
 */
export function foldKeepLength(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === "İ" || c === "I" || c === "ı") out += "i"; // i18n-ok: matching document text, not UI
    else if (c === " " || c === "\t" || c === "\n" || c === "\r") out += " ";
    else {
      // Turkish folding on purpose (İ/ı), whatever the interface language: document text matching.
      const l = c.toLocaleLowerCase("tr-TR"); // i18n-ok
      out += l.length === 1 ? l : c;
    }
  }
  return out;
}

/** Non-overlapping matches of `query` in `text` as [start, end) offsets. */
export function findRanges(text: string, query: string, max = 5000): [number, number][] {
  const q = foldKeepLength(query.trim().replace(/\s+/g, " "));
  if (!q) return [];
  const t = foldKeepLength(text);
  const out: [number, number][] = [];
  for (let i = t.indexOf(q); i >= 0 && out.length < max; i = t.indexOf(q, i + q.length)) out.push([i, i + q.length]);
  return out;
}

// ---------------------------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------------------------

const BLOCK = new Set(["P", "DIV", "LI", "TD", "TH", "TR", "H1", "H2", "H3", "H4", "H5", "H6", "SECTION", "ARTICLE", "HEADER", "FOOTER", "TABLE", "BR"]);
const SKIP = new Set(["STYLE", "SCRIPT", "NOSCRIPT", "TEMPLATE"]);

interface Segment {
  node: Text;
  start: number;
}

/** Nearest block element: text in different blocks is joined with a line break, never glued. */
function blockOf(n: Node, root: Node): Node {
  for (let p = n.parentNode; p && p !== root; p = p.parentNode) if (BLOCK.has((p as Element).tagName)) return p;
  return root;
}

type HighlightRegistry = Map<string, unknown>;
type HighlightCtor = new (...ranges: Range[]) => unknown;

function highlights(): { registry: HighlightRegistry; Highlight: HighlightCtor } | null {
  const css = (globalThis as { CSS?: { highlights?: HighlightRegistry } }).CSS;
  const Highlight = (globalThis as { Highlight?: HighlightCtor }).Highlight;
  return css?.highlights && Highlight ? { registry: css.highlights, Highlight } : null;
}

export class DomFinder {
  private ranges: Range[] = [];

  constructor(private readonly root: HTMLElement) {}

  /** Highlights every match; returns the count. */
  search(query: string): number {
    this.clear();
    const segs: Segment[] = [];
    let text = "";
    let lastBlock: Node | null = null;
    const walker = document.createTreeWalker(this.root, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.parentElement && SKIP.has(n.parentElement.tagName) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
      if (!n.data) continue;
      const block = blockOf(n, this.root);
      if (lastBlock && block !== lastBlock) text += "\n";
      lastBlock = block;
      segs.push({ node: n, start: text.length });
      text += n.data;
    }
    const at = (offset: number, end: boolean): [Text, number] => {
      // Last segment that starts at or before the offset (an end offset belongs to the segment before).
      let lo = 0;
      let hi = segs.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (segs[mid]!.start < offset || (!end && segs[mid]!.start === offset)) lo = mid;
        else hi = mid - 1;
      }
      const s = segs[lo]!;
      return [s.node, Math.min(offset - s.start, s.node.data.length)];
    };
    for (const [a, b] of findRanges(text, query)) {
      const r = document.createRange();
      const [sn, so] = at(a, false);
      const [en, eo] = at(b, true);
      r.setStart(sn, so);
      r.setEnd(en, eo);
      this.ranges.push(r);
    }
    const h = highlights();
    if (h && this.ranges.length) h.registry.set("vw-find", new h.Highlight(...this.ranges));
    return this.ranges.length;
  }

  /** Marks hit i as current and scrolls it into view. */
  focus(i: number): void {
    const r = this.ranges[i];
    if (!r) return;
    const h = highlights();
    if (h) h.registry.set("vw-find-current", new h.Highlight(r));
    else {
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(r);
    }
    const el = r.startContainer.parentElement;
    el?.scrollIntoView({ block: "center", inline: "nearest" });
  }

  clear(): void {
    this.ranges = [];
    const h = highlights();
    h?.registry.delete("vw-find");
    h?.registry.delete("vw-find-current");
  }
}
