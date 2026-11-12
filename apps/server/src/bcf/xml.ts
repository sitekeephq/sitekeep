/**
 * XML for BCF files: a tiny writer (element order follows the XSDs, so it is spelled out by the
 * callers) and a guarded reader for untrusted .bcfzip content.
 *
 * Reading: any DOCTYPE / ENTITY declaration is refused before parsing, so neither external entities
 * (XXE) nor entity expansion ("billion laughs") can happen; the underlying parser does not resolve
 * entities beyond the five XML ones and character references anyway.
 */
import { parseXml, type XmlNode } from "../core/formats/xml.js";
import { DEFAULT_LANGUAGE, msg, render as renderMsg, type Msg } from "../i18n/index.js";

export type { XmlNode };

export class BcfFormatError extends Error {
  /** The text for the reader (rendered in the request's language); `message` is the installation's language. */
  constructor(readonly msg: Msg) {
    super(renderMsg(DEFAULT_LANGUAGE, msg));
  }
}

/** XML that must never be parsed (DOCTYPE / ENTITY): the whole file is refused. */
export class BcfUnsafeXmlError extends BcfFormatError {}

/** Largest XML document read from a .bcfzip (markup, viewpoint, version, project, extensions). */
export const MAX_XML_BYTES = 8 * 1024 * 1024;

export function parseBcfXml(buf: Buffer | string, what: string): XmlNode {
  if (buf.length > MAX_XML_BYTES) throw new BcfFormatError(msg("bcf:xml.tooLarge", { what }));
  let text = typeof buf === "string" ? buf : buf.toString("utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new BcfUnsafeXmlError(msg("bcf:xml.unsafe", { what }));
  const root = parseXml(text);
  const el = root.children[0];
  if (!el) throw new BcfFormatError(msg("bcf:xml.unreadable", { what }));
  return el;
}

// ------------------------------------------------------------------ reading helpers

export function kid(node: XmlNode | undefined, name: string): XmlNode | undefined {
  return node?.children.find((c) => c.name === name);
}

export function kids(node: XmlNode | undefined, name: string): XmlNode[] {
  return node ? node.children.filter((c) => c.name === name) : [];
}

/** Trimmed text of a child element; null when missing or blank. */
export function text(node: XmlNode | undefined, name: string): string | null {
  const t = kid(node, name)?.text.trim();
  return t ? t : null;
}

/** Attribute value, trimmed; null when missing or blank. Attribute names are matched case-insensitively (2.1 "isExternal" vs 3.0 "IsExternal"). */
export function attr(node: XmlNode | undefined, name: string): string | null {
  if (!node) return null;
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(node.attrs)) if (k.toLowerCase() === lower) return v.trim() || null;
  return null;
}

export function num(node: XmlNode | undefined, name: string): number | null {
  const t = text(node, name);
  if (t === null) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

export function bool(v: string | null): boolean | undefined {
  if (v === null) return undefined;
  if (/^(true|1)$/i.test(v)) return true;
  if (/^(false|0)$/i.test(v)) return false;
  return undefined;
}

// ------------------------------------------------------------------ writing

export function esc(s: string): string {
  return s
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** An element: attributes with undefined / null values are left out; children are elements or text. */
export interface El {
  name: string;
  attrs?: Record<string, string | number | boolean | null | undefined>;
  children?: (El | null | undefined | false)[];
  text?: string | number | null;
}

export const el = (name: string, attrs?: El["attrs"], children?: El["children"]): El => ({ name, attrs, children });
export const tx = (name: string, value: string | number | null | undefined, attrs?: El["attrs"]): El | null =>
  value === null || value === undefined ? null : { name, attrs, text: value };

export function render(root: El, schemaHint?: string): string {
  const out: string[] = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'];
  const first = { ...root, attrs: { ...(schemaHint && { "xmlns:xsi": "http://www.w3.org/2001/XMLSchema-instance", "xsi:noNamespaceSchemaLocation": schemaHint }), ...root.attrs } };
  write(first, 0, out);
  return out.join("\n") + "\n";
}

function write(e: El, depth: number, out: string[]) {
  const pad = "  ".repeat(depth);
  const attrs = Object.entries(e.attrs ?? {})
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => ` ${k}="${esc(String(v))}"`)
    .join("");
  const kids = (e.children ?? []).filter((c): c is El => !!c);
  if (e.text !== undefined && e.text !== null) {
    out.push(`${pad}<${e.name}${attrs}>${esc(String(e.text))}</${e.name}>`);
  } else if (!kids.length) {
    out.push(`${pad}<${e.name}${attrs}/>`);
  } else {
    out.push(`${pad}<${e.name}${attrs}>`);
    for (const k of kids) write(k, depth + 1, out);
    out.push(`${pad}</${e.name}>`);
  }
}

/** xs:double text: plain decimal, never "NaN" / "Infinity". */
export function dbl(n: number): string {
  if (!Number.isFinite(n)) return "0";
  return String(n + 0);
}
