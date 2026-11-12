/**
 * A small XML Schema validator for the official BCF-XML schemas (test/fixtures/bcf-xsd). It covers the
 * XSD subset those schemas use — global and local elements, complexType with sequence / choice
 * (minOccurs / maxOccurs, nested), attributes (use, ref, attributeGroup), simpleType restrictions
 * (pattern, enumeration, length, minLength, maxLength, min/max inclusive / exclusive, whiteSpace) and
 * the built-in types string, normalizedString, boolean, int, double, dateTime, anyURI — and throws on
 * any other XSD construct, so an unsupported schema can never pass silently.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseXml, type XmlNode } from "../../src/core/formats/xml.js";

interface Schema {
  elements: Map<string, XmlNode>;
  complexTypes: Map<string, XmlNode>;
  simpleTypes: Map<string, XmlNode>;
  attributes: Map<string, XmlNode>;
  attributeGroups: Map<string, XmlNode>;
}

const SUPPORTED_TOP = new Set(["element", "complexType", "simpleType", "attribute", "attributeGroup", "include", "annotation"]);

export function loadSchema(file: string, into?: Schema, seen = new Set<string>()): Schema {
  const s: Schema = into ?? { elements: new Map(), complexTypes: new Map(), simpleTypes: new Map(), attributes: new Map(), attributeGroups: new Map() };
  const full = path.resolve(file);
  if (seen.has(full)) return s;
  seen.add(full);
  const root = parseXml(readFileSync(full, "utf8")).children.find((c) => c.name === "schema");
  if (!root) throw new Error(`xsd-lite: ${file} is not a schema`);
  for (const c of root.children) {
    if (!SUPPORTED_TOP.has(c.name)) throw new Error(`xsd-lite: unsupported top-level xs:${c.name} in ${file}`);
    const name = c.attrs.name;
    if (c.name === "include") loadSchema(path.join(path.dirname(full), c.attrs.schemaLocation!), s, seen);
    else if (c.name === "element") s.elements.set(name!, c);
    else if (c.name === "complexType") s.complexTypes.set(name!, c);
    else if (c.name === "simpleType") s.simpleTypes.set(name!, c);
    else if (c.name === "attribute") s.attributes.set(name!, c);
    else if (c.name === "attributeGroup") s.attributeGroups.set(name!, c);
  }
  return s;
}

/** Validation errors of an XML document against the schema ([] = valid). */
export function validateXml(schema: Schema, xml: string): string[] {
  const errors: string[] = [];
  const root = parseXml(xml).children[0];
  if (!root) return ["empty document"];
  const decl = schema.elements.get(root.name);
  if (!decl) return [`unknown root element <${root.name}>`];
  new Validator(schema, errors).element(root, decl, `/${root.name}`);
  return errors;
}

const occurs = (n: XmlNode, attr: "minOccurs" | "maxOccurs") => {
  const v = n.attrs[attr];
  if (v === undefined) return 1;
  return v === "unbounded" ? Infinity : Number(v);
};

const kidsOf = (n: XmlNode) => n.children.filter((c) => c.name !== "annotation");

/** Instance attributes that belong to XML / XSI namespaces (prefixes are dropped by the parser). */
const NS_ATTRS = new Set(["xmlns", "xsi", "noNamespaceSchemaLocation", "schemaLocation"]);

class Validator {
  constructor(
    private readonly s: Schema,
    private readonly errors: string[],
  ) {}

  element(node: XmlNode, decl: XmlNode, where: string) {
    if (decl.attrs.ref) {
      const target = this.s.elements.get(decl.attrs.ref);
      if (!target) throw new Error(`xsd-lite: unknown element ref ${decl.attrs.ref}`);
      return this.element(node, target, where);
    }
    const inline = kidsOf(decl);
    const inlineComplex = inline.find((c) => c.name === "complexType");
    const inlineSimple = inline.find((c) => c.name === "simpleType");
    for (const c of inline) if (c.name !== "complexType" && c.name !== "simpleType") throw new Error(`xsd-lite: unsupported xs:${c.name} in element`);
    const type = decl.attrs.type;
    if (inlineComplex) return this.complex(node, inlineComplex, where);
    if (inlineSimple) return this.simpleContent(node, (v) => this.simpleValue(v, inlineSimple), where);
    if (!type) return; // xs:anyType
    if (type.startsWith("xs:")) return this.simpleContent(node, (v) => this.builtin(v, type), where);
    const ct = this.s.complexTypes.get(type);
    if (ct) return this.complex(node, ct, where);
    const st = this.s.simpleTypes.get(type);
    if (st) return this.simpleContent(node, (v) => this.simpleValue(v, st), where);
    throw new Error(`xsd-lite: unknown type ${type}`);
  }

  private simpleContent(node: XmlNode, check: (v: string) => string | null, where: string) {
    if (node.children.length) this.errors.push(`${where}: element content not allowed (simple type)`);
    const problem = check(node.text);
    if (problem) this.errors.push(`${where}: ${problem}`);
  }

  private complex(node: XmlNode, ct: XmlNode, where: string) {
    const parts = kidsOf(ct);
    let particle: XmlNode | undefined;
    const attrDecls = new Map<string, XmlNode>();
    for (const p of parts) {
      if (p.name === "sequence" || p.name === "choice") {
        if (particle) throw new Error("xsd-lite: two particles in one complexType");
        particle = p;
      } else if (p.name === "attribute") this.collectAttribute(p, attrDecls);
      else if (p.name === "attributeGroup") this.collectGroup(p, attrDecls);
      else throw new Error(`xsd-lite: unsupported xs:${p.name} in complexType`);
    }
    if (ct.attrs.mixed === "true") throw new Error("xsd-lite: mixed content not supported");

    for (const [name, value] of Object.entries(node.attrs)) {
      if (NS_ATTRS.has(name)) continue;
      const d = attrDecls.get(name);
      if (!d) {
        this.errors.push(`${where}: attribute ${name} not allowed`);
        continue;
      }
      const problem = this.attributeValue(value, d);
      if (problem) this.errors.push(`${where}/@${name}: ${problem}`);
    }
    for (const [name, d] of attrDecls) {
      if (d.attrs.use === "required" && !(name in node.attrs)) this.errors.push(`${where}: required attribute ${name} missing`);
    }

    if (node.text.trim()) this.errors.push(`${where}: text not allowed in element-only content`);
    const kids = node.children;
    if (!particle) {
      if (kids.length) this.errors.push(`${where}: no child elements allowed, found <${kids[0]!.name}>`);
      return;
    }
    const end = this.match(particle, kids, 0, where);
    if (end < 0) this.errors.push(`${where}: content does not match the schema (${kids.map((k) => k.name).join(", ") || "empty"})`);
    else if (end < kids.length) this.errors.push(`${where}: unexpected element <${kids[end]!.name}> at position ${end + 1}`);
  }

  private collectAttribute(a: XmlNode, into: Map<string, XmlNode>) {
    if (a.attrs.ref) {
      const g = this.s.attributes.get(a.attrs.ref);
      if (!g) throw new Error(`xsd-lite: unknown attribute ref ${a.attrs.ref}`);
      // Keep the use / default of the referencing declaration, the type of the global one.
      into.set(a.attrs.ref, { ...g, attrs: { ...g.attrs, ...a.attrs, name: a.attrs.ref } });
    } else into.set(a.attrs.name!, a);
  }

  private collectGroup(g: XmlNode, into: Map<string, XmlNode>) {
    const def = this.s.attributeGroups.get(g.attrs.ref!);
    if (!def) throw new Error(`xsd-lite: unknown attributeGroup ${g.attrs.ref}`);
    for (const a of kidsOf(def)) {
      if (a.name === "attribute") this.collectAttribute(a, into);
      else if (a.name === "attributeGroup") this.collectGroup(a, into);
      else throw new Error(`xsd-lite: unsupported xs:${a.name} in attributeGroup`);
    }
  }

  private attributeValue(v: string, d: XmlNode): string | null {
    const inline = kidsOf(d).find((c) => c.name === "simpleType");
    if (inline) return this.simpleValue(v, inline);
    const type = d.attrs.type;
    if (!type) return null;
    if (type.startsWith("xs:")) return this.builtin(v, type);
    const st = this.s.simpleTypes.get(type);
    if (!st) throw new Error(`xsd-lite: unknown attribute type ${type}`);
    return this.simpleValue(v, st);
  }

  /** Index after the matched children, or −1 when the particle does not match. */
  private match(p: XmlNode, kids: XmlNode[], i: number, where: string): number {
    const min = occurs(p, "minOccurs");
    const max = occurs(p, "maxOccurs");
    let n = 0;
    let pos = i;
    while (n < max) {
      const next = this.matchOnce(p, kids, pos, where);
      if (next < 0 || (next === pos && n >= min)) break;
      n++;
      if (next === pos) {
        // An empty match satisfies any remaining minimum.
        n = Math.max(n, min);
        break;
      }
      pos = next;
    }
    return n >= min ? pos : -1;
  }

  private matchOnce(p: XmlNode, kids: XmlNode[], i: number, where: string): number {
    if (p.name === "element") {
      const name = p.attrs.name ?? p.attrs.ref!;
      const k = kids[i];
      if (!k || k.name !== name) return -1;
      this.element(k, p, `${where}/${name}`);
      return i + 1;
    }
    if (p.name === "sequence") {
      let pos = i;
      for (const c of kidsOf(p)) {
        pos = this.match(c, kids, pos, where);
        if (pos < 0) return -1;
      }
      return pos;
    }
    if (p.name === "choice") {
      let empty = -1;
      for (const c of kidsOf(p)) {
        const pos = this.match(c, kids, i, where);
        if (pos > i) return pos;
        if (pos === i) empty = i;
      }
      return empty;
    }
    throw new Error(`xsd-lite: unsupported particle xs:${p.name}`);
  }

  private simpleValue(raw: string, st: XmlNode): string | null {
    const parts = kidsOf(st);
    const r = parts.find((c) => c.name === "restriction");
    if (!r || parts.length !== 1) throw new Error("xsd-lite: only xs:restriction simple types are supported");
    const facets = kidsOf(r);
    const ws = facets.find((f) => f.name === "whiteSpace")?.attrs.value;
    const base = r.attrs.base!;
    let v = raw;
    if (ws === "collapse") v = v.replace(/[\t\n\r ]+/g, " ").trim();
    else if (ws === "replace") v = v.replace(/[\t\n\r]/g, " ");
    const baseProblem = base.startsWith("xs:") ? this.builtin(v, base) : this.simpleValue(v, this.s.simpleTypes.get(base) ?? fail(`unknown base ${base}`));
    if (baseProblem) return baseProblem;
    if (base === "xs:double" || base === "xs:int" || (!ws && !base.startsWith("xs:string") && base !== "xs:normalizedString")) v = v.trim();
    const patterns = facets.filter((f) => f.name === "pattern").map((f) => f.attrs.value!);
    if (patterns.length && !patterns.some((p) => new RegExp(`^(?:${p})$`, "u").test(v))) return `"${v}" does not match ${patterns.join(" | ")}`;
    const enums = facets.filter((f) => f.name === "enumeration").map((f) => f.attrs.value!);
    if (enums.length && !enums.includes(v)) return `"${v}" not in (${enums.join(", ")})`;
    for (const f of facets) {
      const x = f.attrs.value!;
      switch (f.name) {
        case "pattern":
        case "enumeration":
        case "whiteSpace":
          break;
        case "length":
          if ([...v].length !== Number(x)) return `"${v}" length must be ${x}`;
          break;
        case "minLength":
          if ([...v].length < Number(x)) return `"${v}" shorter than ${x}`;
          break;
        case "maxLength":
          if ([...v].length > Number(x)) return `"${v}" longer than ${x}`;
          break;
        case "minInclusive":
          if (!(Number(v) >= Number(x))) return `${v} < ${x}`;
          break;
        case "maxInclusive":
          if (!(Number(v) <= Number(x))) return `${v} > ${x}`;
          break;
        case "minExclusive":
          if (!(Number(v) > Number(x))) return `${v} <= ${x}`;
          break;
        case "maxExclusive":
          if (!(Number(v) < Number(x))) return `${v} >= ${x}`;
          break;
        default:
          throw new Error(`xsd-lite: unsupported facet xs:${f.name}`);
      }
    }
    return null;
  }

  private builtin(raw: string, type: string): string | null {
    const v = raw.trim();
    switch (type) {
      case "xs:string":
      case "xs:normalizedString":
      case "xs:anyURI":
        return null;
      case "xs:boolean":
        return /^(true|false|1|0)$/.test(v) ? null : `"${v}" is not a boolean`;
      case "xs:int":
        return /^[+-]?\d+$/.test(v) && Math.abs(Number(v)) <= 2147483648 ? null : `"${v}" is not an int`;
      case "xs:double":
        return /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$|^(INF|-INF|NaN)$/.test(v) ? null : `"${v}" is not a double`;
      case "xs:dateTime":
        return /^-?\d{4,}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/.test(v) ? null : `"${v}" is not a dateTime`;
      default:
        throw new Error(`xsd-lite: unsupported built-in type ${type}`);
    }
  }
}

function fail(msg: string): never {
  throw new Error(`xsd-lite: ${msg}`);
}
