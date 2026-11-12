/**
 * Minimal, non-validating XML reader for MS Project XML (MSPDI) and the parts of an .xlsx file.
 * DOCTYPE declarations are skipped without expanding entities (no XXE, no entity bombs);
 * namespace prefixes are dropped from element names.
 */

export interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  /** Direct text content (entities decoded, CDATA included). */
  text: string;
}

const ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

export function decodeEntities(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e] ?? m;
  });
}

const localName = (n: string) => {
  const i = n.indexOf(":");
  return i >= 0 ? n.slice(i + 1) : n;
};

export function parseXml(src: string): XmlNode {
  const root: XmlNode = { name: "#root", attrs: {}, children: [], text: "" };
  const stack: XmlNode[] = [root];
  const n = src.length;
  let i = 0;
  const top = () => stack[stack.length - 1]!;
  while (i < n) {
    const lt = src.indexOf("<", i);
    if (lt < 0) {
      top().text += decodeEntities(src.slice(i));
      break;
    }
    if (lt > i) top().text += decodeEntities(src.slice(i, lt));
    if (src.startsWith("<!--", lt)) {
      const e = src.indexOf("-->", lt + 4);
      i = e < 0 ? n : e + 3;
      continue;
    }
    if (src.startsWith("<![CDATA[", lt)) {
      const e = src.indexOf("]]>", lt + 9);
      top().text += src.slice(lt + 9, e < 0 ? n : e);
      i = e < 0 ? n : e + 3;
      continue;
    }
    if (src.startsWith("<?", lt)) {
      const e = src.indexOf("?>", lt + 2);
      i = e < 0 ? n : e + 2;
      continue;
    }
    if (src.startsWith("<!", lt)) {
      // DOCTYPE (an internal subset in [...] is skipped as a whole).
      let depth = 0;
      let j = lt + 2;
      for (; j < n; j++) {
        const c = src[j];
        if (c === "[") depth++;
        else if (c === "]") depth--;
        else if (c === ">" && depth <= 0) break;
      }
      i = j + 1;
      continue;
    }
    if (src[lt + 1] === "/") {
      const e = src.indexOf(">", lt);
      if (stack.length > 1) stack.pop();
      i = e < 0 ? n : e + 1;
      continue;
    }
    let j = lt + 1;
    let quote: string | null = null;
    for (; j < n; j++) {
      const c = src[j];
      if (quote) {
        if (c === quote) quote = null;
      } else if (c === '"' || c === "'") quote = c;
      else if (c === ">") break;
    }
    const raw = src.slice(lt + 1, j);
    const selfClose = raw.endsWith("/");
    const body = selfClose ? raw.slice(0, -1) : raw;
    const m = /^[^\s/>]+/.exec(body);
    if (!m) {
      i = j + 1;
      continue;
    }
    const node: XmlNode = { name: localName(m[0]), attrs: {}, children: [], text: "" };
    const attrRe = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    const rest = body.slice(m[0].length);
    let a: RegExpExecArray | null;
    while ((a = attrRe.exec(rest))) node.attrs[localName(a[1]!)] = decodeEntities(a[2] ?? a[3] ?? "");
    top().children.push(node);
    if (!selfClose) stack.push(node);
    i = j + 1;
  }
  return root;
}

export function child(node: XmlNode | undefined, name: string): XmlNode | undefined {
  return node?.children.find((c) => c.name === name);
}

export function children(node: XmlNode | undefined, name: string): XmlNode[] {
  return node ? node.children.filter((c) => c.name === name) : [];
}

/** Trimmed text of a direct child element, or "" when it is missing. */
export function childText(node: XmlNode | undefined, name: string): string {
  return child(node, name)?.text.trim() ?? "";
}

/** All text below the node (rich text runs in shared strings). */
export function deepText(node: XmlNode): string {
  return node.text + node.children.map(deepText).join("");
}

/** First element with the given name in a depth-first walk. */
export function findFirst(node: XmlNode, name: string): XmlNode | undefined {
  if (node.name === name) return node;
  for (const c of node.children) {
    const f = findFirst(c, name);
    if (f) return f;
  }
  return undefined;
}
