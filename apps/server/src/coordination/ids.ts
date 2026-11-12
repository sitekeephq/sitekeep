/**
 * IDS (buildingSMART Information Delivery Specification 1.0) reader for the subset SiteKeep
 * checks itself: entity, attribute and property facets with simple values and xs:restriction
 * (enumeration, pattern, bounds, length). Classification, material and partOf facets are
 * reported as unsupported instead of being passed silently.
 *
 * (@thatopen/components IDSSpecifications needs a browser Fragments worker; on the server the
 * same subset is evaluated directly with web-ifc in jobs/ids-worker.ts.)
 *
 * Texts of a parsed document (requirement texts, unsupported facets) are stored with the report:
 * they are written in the installation's language (DEFAULT_LANGUAGE) unless a language is given.
 */
import { DEFAULT_LANGUAGE, msg, render, tFor, type Msg } from "../i18n/index.js";

export type IdsRestriction =
  | { simple: string }
  | {
      enumeration?: string[];
      pattern?: string;
      minInclusive?: number;
      maxInclusive?: number;
      minExclusive?: number;
      maxExclusive?: number;
      length?: number;
      minLength?: number;
      maxLength?: number;
    };

export type IdsCardinality = "required" | "optional" | "prohibited";

export type IdsFacet =
  | { kind: "entity"; name: IdsRestriction; predefinedType?: IdsRestriction }
  | { kind: "attribute"; name: IdsRestriction; value?: IdsRestriction; cardinality: IdsCardinality }
  | {
      kind: "property";
      pset: IdsRestriction;
      name: IdsRestriction;
      value?: IdsRestriction;
      dataType?: string;
      cardinality: IdsCardinality;
    };

export interface IdsSpec {
  name: string;
  description: string | null;
  ifcVersions: string[];
  /** Applicability cardinality: min 0 = optional spec, max 0 = prohibited. */
  minOccurs: number;
  maxOccurs: number | "unbounded";
  applicability: IdsFacet[];
  requirements: IdsFacet[];
  /** Facets outside the supported subset ("applicability: material", …). */
  unsupported: string[];
  /** Human readable requirement lines (Turkish). */
  requirementTexts: string[];
}

export interface IdsDocument {
  title: string | null;
  specs: IdsSpec[];
}

export class IdsParseError extends Error {
  constructor(readonly msg: Msg) {
    super(render(DEFAULT_LANGUAGE, msg));
  }
}

interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

/** A small, strict-enough XML parser (elements, attributes, text, CDATA, comments, entities). */
export function parseXml(src: string): XmlNode {
  let i = 0;
  const root: XmlNode = { name: "#root", attrs: {}, children: [], text: "" };
  const stack: XmlNode[] = [root];
  const decode = (s: string) =>
    s.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi, (_, e: string) => {
      const k = e.toLowerCase();
      if (k === "lt") return "<";
      if (k === "gt") return ">";
      if (k === "amp") return "&";
      if (k === "quot") return '"';
      if (k === "apos") return "'";
      return String.fromCodePoint(k.startsWith("#x") ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10));
    });
  const local = (n: string) => n.slice(n.indexOf(":") + 1);
  if (src.charCodeAt(0) === 0xfeff) i = 1;
  while (i < src.length) {
    const lt = src.indexOf("<", i);
    const top = stack[stack.length - 1]!;
    if (lt < 0) {
      top.text += decode(src.slice(i));
      break;
    }
    if (lt > i) top.text += decode(src.slice(i, lt));
    if (src.startsWith("<!--", lt)) {
      const end = src.indexOf("-->", lt + 4);
      if (end < 0) throw new IdsParseError(msg("coordination:ids.unclosedComment"));
      i = end + 3;
    } else if (src.startsWith("<![CDATA[", lt)) {
      const end = src.indexOf("]]>", lt + 9);
      if (end < 0) throw new IdsParseError(msg("coordination:ids.unclosedCdata"));
      top.text += src.slice(lt + 9, end);
      i = end + 3;
    } else if (src.startsWith("<?", lt)) {
      const end = src.indexOf("?>", lt + 2);
      if (end < 0) throw new IdsParseError(msg("coordination:ids.unclosedDeclaration"));
      i = end + 2;
    } else if (src.startsWith("<!", lt)) {
      const end = src.indexOf(">", lt + 2);
      if (end < 0) throw new IdsParseError(msg("coordination:ids.unclosedDoctype"));
      i = end + 1;
    } else if (src.startsWith("</", lt)) {
      const end = src.indexOf(">", lt + 2);
      if (end < 0) throw new IdsParseError(msg("coordination:ids.unclosedTag"));
      const name = local(src.slice(lt + 2, end).trim());
      const node = stack.pop();
      if (!node || node.name !== name || stack.length === 0)
        throw new IdsParseError(msg("coordination:ids.tagMismatch", { name }));
      i = end + 1;
    } else {
      // Start tag: name, attributes with quoted values, optional self-closing slash.
      const re = /\s*([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)')/y;
      let j = lt + 1;
      const nameMatch = /[^\s/>]+/y;
      nameMatch.lastIndex = j;
      const nm = nameMatch.exec(src);
      if (!nm) throw new IdsParseError(msg("coordination:ids.invalidTag"));
      j = nameMatch.lastIndex;
      const attrs: Record<string, string> = {};
      for (;;) {
        re.lastIndex = j;
        const m = re.exec(src);
        if (!m) break;
        attrs[local(m[1]!)] = decode(m[3] ?? m[4] ?? "");
        j = re.lastIndex;
      }
      while (j < src.length && /\s/.test(src[j]!)) j++;
      const selfClosing = src[j] === "/";
      if (selfClosing) j++;
      if (src[j] !== ">") throw new IdsParseError(msg("coordination:ids.invalidTagNamed", { name: nm[0] }));
      const node: XmlNode = { name: local(nm[0]), attrs, children: [], text: "" };
      top.children.push(node);
      if (!selfClosing) stack.push(node);
      i = j + 1;
    }
  }
  if (stack.length !== 1) throw new IdsParseError(msg("coordination:ids.unclosedTagNamed", { name: stack[stack.length - 1]!.name }));
  return root;
}

const child = (n: XmlNode | undefined, name: string) => n?.children.find((c) => c.name === name);
const children = (n: XmlNode | undefined, name: string) => n?.children.filter((c) => c.name === name) ?? [];

function restriction(n: XmlNode | undefined): IdsRestriction | undefined {
  if (!n) return undefined;
  const simple = child(n, "simpleValue");
  if (simple) return { simple: simple.text.trim() };
  const r = child(n, "restriction");
  if (!r) return n.text.trim() ? { simple: n.text.trim() } : undefined;
  const out: Exclude<IdsRestriction, { simple: string }> = {};
  const enums = children(r, "enumeration").map((e) => e.attrs.value ?? "");
  if (enums.length) out.enumeration = enums;
  const pattern = child(r, "pattern")?.attrs.value;
  if (pattern !== undefined) out.pattern = pattern;
  for (const k of ["minInclusive", "maxInclusive", "minExclusive", "maxExclusive", "length", "minLength", "maxLength"] as const) {
    const val = child(r, k)?.attrs.value;
    if (val !== undefined && Number.isFinite(Number(val))) out[k] = Number(val);
  }
  return out;
}

function cardinalityOf(n: XmlNode): IdsCardinality {
  const c = n.attrs.cardinality;
  if (c === "optional" || c === "prohibited" || c === "required") return c;
  // IDS 0.9 style.
  if (n.attrs.maxOccurs === "0") return "prohibited";
  if (n.attrs.minOccurs === "0") return "optional";
  return "required";
}

export function describeRestriction(r: IdsRestriction | undefined, lang = DEFAULT_LANGUAGE): string {
  const t = tFor(lang);
  if (!r) return t("coordination:ids.any");
  if ("simple" in r) return `"${r.simple}"`;
  const parts: string[] = [];
  if (r.enumeration) parts.push(r.enumeration.map((e) => `"${e}"`).join(" | "));
  if (r.pattern !== undefined) parts.push(`/${r.pattern}/`);
  if (r.minInclusive !== undefined) parts.push(`≥ ${r.minInclusive}`);
  if (r.minExclusive !== undefined) parts.push(`> ${r.minExclusive}`);
  if (r.maxInclusive !== undefined) parts.push(`≤ ${r.maxInclusive}`);
  if (r.maxExclusive !== undefined) parts.push(`< ${r.maxExclusive}`);
  if (r.length !== undefined) parts.push(t("coordination:ids.length", { value: r.length }));
  if (r.minLength !== undefined) parts.push(t("coordination:ids.minLength", { value: r.minLength }));
  if (r.maxLength !== undefined) parts.push(t("coordination:ids.maxLength", { value: r.maxLength }));
  return parts.join(", ") || t("coordination:ids.any");
}

const CARDINALITY = { required: "coordination:ids.required", optional: "coordination:ids.optional", prohibited: "coordination:ids.prohibited" } as const;

export function describeFacet(f: IdsFacet, lang = DEFAULT_LANGUAGE): string {
  const t = tFor(lang);
  const d = (r: IdsRestriction | undefined) => describeRestriction(r, lang);
  if (f.kind === "entity")
    return f.predefinedType ? t("coordination:ids.entityTyped", { name: d(f.name), type: d(f.predefinedType) }) : t("coordination:ids.entity", { name: d(f.name) });
  const cardinality = t(CARDINALITY[f.cardinality]);
  if (f.kind === "attribute")
    return f.value ? t("coordination:ids.attributeValue", { name: d(f.name), cardinality, value: d(f.value) }) : t("coordination:ids.attribute", { name: d(f.name), cardinality });
  const rest = `${f.value ? ` = ${d(f.value)}` : ""}${f.dataType ? ` [${f.dataType}]` : ""}`;
  return t("coordination:ids.property", { pset: d(f.pset), name: d(f.name), cardinality, rest });
}

const UNSUPPORTED = {
  classification: "coordination:ids.classification",
  material: "coordination:ids.material",
  partOf: "coordination:ids.partOf",
} as const;

function facets(n: XmlNode | undefined, where: string, unsupported: string[], lang: string): IdsFacet[] {
  const out: IdsFacet[] = [];
  for (const f of n?.children ?? []) {
    if (f.name === "entity") {
      const name = restriction(child(f, "name"));
      if (!name) throw new IdsParseError(msg("coordination:ids.entityNoName"));
      out.push({ kind: "entity", name, predefinedType: restriction(child(f, "predefinedType")) });
    } else if (f.name === "attribute") {
      const name = restriction(child(f, "name"));
      if (!name) throw new IdsParseError(msg("coordination:ids.attributeNoName"));
      out.push({ kind: "attribute", name, value: restriction(child(f, "value")), cardinality: cardinalityOf(f) });
    } else if (f.name === "property") {
      const pset = restriction(child(f, "propertySet"));
      const name = restriction(child(f, "baseName") ?? child(f, "name"));
      if (!pset || !name) throw new IdsParseError(msg("coordination:ids.propertyIncomplete"));
      out.push({
        kind: "property",
        pset,
        name,
        value: restriction(child(f, "value")),
        dataType: f.attrs.dataType ? f.attrs.dataType.toUpperCase() : undefined,
        cardinality: cardinalityOf(f),
      });
    } else {
      unsupported.push(`${where}: ${f.name in UNSUPPORTED ? render(lang, msg(UNSUPPORTED[f.name as keyof typeof UNSUPPORTED])) : f.name}`);
    }
  }
  return out;
}

/** Parses an IDS document (throws IdsParseError with a Msg). */
export function parseIds(xml: string, lang = DEFAULT_LANGUAGE): IdsDocument {
  const t = tFor(lang);
  const root = parseXml(xml);
  const ids = child(root, "ids");
  if (!ids) throw new IdsParseError(msg("coordination:ids.notIds"));
  const title = child(child(ids, "info"), "title")?.text.trim() || null;
  const specNodes = children(child(ids, "specifications"), "specification");
  if (!specNodes.length) throw new IdsParseError(msg("coordination:ids.noSpecs"));
  const specs = specNodes.map((s, i): IdsSpec => {
    const unsupported: string[] = [];
    const app = child(s, "applicability");
    const applicability = facets(app, t("coordination:ids.applicability"), unsupported, lang);
    const requirements = facets(child(s, "requirements"), t("coordination:ids.requirement"), unsupported, lang);
    const max = app?.attrs.maxOccurs ?? s.attrs.maxOccurs ?? "unbounded";
    return {
      name: s.attrs.name?.trim() || t("coordination:ids.specName", { number: i + 1 }),
      description: s.attrs.description?.trim() || s.attrs.instructions?.trim() || null,
      ifcVersions: (s.attrs.ifcVersion ?? "").split(/\s+/).filter(Boolean).map((v) => v.toUpperCase()),
      minOccurs: Number(app?.attrs.minOccurs ?? s.attrs.minOccurs ?? 0) || 0,
      maxOccurs: max === "unbounded" ? "unbounded" : Number(max) || 0,
      applicability,
      requirements,
      unsupported,
      requirementTexts: requirements.map((f) => describeFacet(f, lang)),
    };
  });
  return { title, specs };
}
