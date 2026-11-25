/**
 * Document search (docs/features/DOCUMENT_SEARCH.md): the query language, the search parameters
 * shared by the web panel, saved searches, the API and the MCP tools, and highlighting helpers.
 *
 * Query language: words are ANDed; `AND`, `OR`, `NOT` (also `VE`, `VEYA`, `DEĞİL`; upper case only,
 * so ordinary words stay words), parentheses, `*` as a wildcard and "quoted phrases". Every term
 * matches as a part of the name, of an attribute value or of the content (Turkish I aware).
 * Unquoted codes are split at - _ . / so "DOC-01-A" finds files holding DOC, 01 and A.
 */
import { foldTr } from "../kernel/attributes.js";
import type { FolderState } from "../core/types.js";

export type SearchNode =
  | { kind: "term"; text: string; phrase: boolean }
  | { kind: "and"; items: SearchNode[] }
  | { kind: "or"; items: SearchNode[] }
  | { kind: "not"; item: SearchNode };

/** Longest query text accepted. */
export const SEARCH_QUERY_MAX = 200;
/** Terms kept from one query (the rest are ignored). */
export const SEARCH_TERMS_MAX = 20;

const AND_WORDS = new Set(["AND", "VE", "&&"]);
const OR_WORDS = new Set(["OR", "VEYA", "||"]);
const NOT_WORDS = new Set(["NOT", "DEĞİL"]);

type Token = { t: "(" | ")" | "and" | "or" | "not" } | { t: "word"; text: string; phrase: boolean };

function tokenize(q: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < q.length) {
    const c = q[i]!;
    if (/\s/.test(c)) {
      i++;
    } else if (c === "(" || c === ")") {
      out.push({ t: c });
      i++;
    } else if (c === '"' || c === "“" || c === "”") {
      const end = q.slice(i + 1).search(/["“”]/);
      const text = end < 0 ? q.slice(i + 1) : q.slice(i + 1, i + 1 + end);
      i = end < 0 ? q.length : i + 2 + end;
      if (text.trim()) out.push({ t: "word", text: text.trim().replace(/\s+/g, " "), phrase: true });
    } else {
      let j = i;
      while (j < q.length && !/[\s()"“”]/.test(q[j]!)) j++;
      const w = q.slice(i, j);
      i = j;
      if (AND_WORDS.has(w)) out.push({ t: "and" });
      else if (OR_WORDS.has(w)) out.push({ t: "or" });
      else if (NOT_WORDS.has(w)) out.push({ t: "not" });
      else out.push({ t: "word", text: w, phrase: false });
    }
  }
  return out;
}

/** An unquoted word split at code separators; parts that are only wildcards are dropped. */
function wordNode(text: string): SearchNode | null {
  const parts = text
    .split(/[-_./\\]+/)
    .map((p) => p.replace(/\*{2,}/g, "*"))
    .filter((p) => p.replace(/\*/g, "").length > 0);
  if (!parts.length) return null;
  if (parts.length === 1) return { kind: "term", text: parts[0]!, phrase: false };
  return { kind: "and", items: parts.map((p) => ({ kind: "term", text: p, phrase: false }) as SearchNode) };
}

/**
 * Parses a query; never throws (a stray parenthesis or operator is ignored). Returns null when
 * nothing searchable is left.
 */
export function parseSearchQuery(q: string): SearchNode | null {
  const tokens = tokenize(q.slice(0, SEARCH_QUERY_MAX));
  let pos = 0;
  let terms = 0;
  const peek = () => tokens[pos];

  function primary(): SearchNode | null {
    const tok = peek();
    if (!tok) return null;
    if (tok.t === "(") {
      pos++;
      const inner = orExpr();
      if (peek()?.t === ")") pos++;
      return inner;
    }
    if (tok.t === "word") {
      pos++;
      if (terms >= SEARCH_TERMS_MAX) return null;
      terms++;
      return tok.phrase ? { kind: "term", text: tok.text, phrase: true } : wordNode(tok.text);
    }
    return null;
  }

  function notExpr(): SearchNode | null {
    if (peek()?.t === "not") {
      pos++;
      const inner = notExpr();
      return inner ? { kind: "not", item: inner } : null;
    }
    return primary();
  }

  function andExpr(): SearchNode | null {
    const items: SearchNode[] = [];
    for (;;) {
      const tok = peek();
      if (!tok || tok.t === ")" || tok.t === "or") break;
      if (tok.t === "and") {
        pos++;
        continue;
      }
      const before = pos;
      const n = notExpr();
      if (n) items.push(n);
      if (pos === before) pos++; // never stall on an unexpected token
    }
    return combine("and", items);
  }

  function orExpr(): SearchNode | null {
    const items: SearchNode[] = [];
    for (;;) {
      const n = andExpr();
      if (n) items.push(n);
      const tok = peek();
      if (tok?.t === "or") {
        pos++;
        continue;
      }
      break;
    }
    return combine("or", items);
  }

  let root: SearchNode | null = null;
  const parts: SearchNode[] = [];
  while (pos < tokens.length) {
    const n = orExpr();
    if (n) parts.push(n);
    if (peek()?.t === ")") pos++; // unmatched ")"
  }
  root = combine("and", parts);
  return root;
}

function combine(kind: "and" | "or", items: SearchNode[]): SearchNode | null {
  const flat = items.flatMap((n) => (n.kind === kind ? n.items : [n]));
  if (!flat.length) return null;
  if (flat.length === 1) return flat[0]!;
  return { kind, items: flat };
}

/** Terms that must or may be present (not under NOT): for highlighting and excerpts. */
export function searchTerms(node: SearchNode | null): string[] {
  const out: string[] = [];
  const walk = (n: SearchNode, negated: boolean) => {
    if (n.kind === "term") {
      if (!negated && !out.includes(n.text)) out.push(n.text);
    } else if (n.kind === "not") walk(n.item, !negated);
    else for (const c of n.items) walk(c, negated);
  };
  if (node) walk(node, false);
  return out;
}

/** The query back as text (normalised): for saved search labels and tests. */
export function formatSearchQuery(node: SearchNode | null): string {
  if (!node) return "";
  if (node.kind === "term") return node.phrase || /\s/.test(node.text) ? `"${node.text}"` : node.text;
  if (node.kind === "not") return `NOT ${wrap(node.item)}`;
  return node.items.map(wrap).join(node.kind === "and" ? " AND " : " OR ");
}

function wrap(n: SearchNode): string {
  return n.kind === "and" || n.kind === "or" ? `(${formatSearchQuery(n)})` : formatSearchQuery(n);
}

/** SQL LIKE pattern (folded, escaped with \) for one term: `*` becomes `%`. */
export function termLikePattern(text: string): string {
  const folded = foldTr(text).replace(/[\\%_]/g, (c) => `\\${c}`);
  return `%${folded.replace(/\*+/g, "%")}%`;
}

/** The literal pieces of a term (between wildcards), folded; the longest first. */
export function termPieces(text: string): string[] {
  return foldTr(text)
    .split("*")
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
}

/** Folds a text character by character, keeping a map from folded to original positions. */
function foldWithMap(text: string): { folded: string; map: number[] } {
  let folded = "";
  const map: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const f = foldTr(text[i]!);
    for (let k = 0; k < f.length; k++) map.push(i);
    folded += f;
  }
  map.push(text.length);
  return { folded, map };
}

/** Splits a text into plain and highlighted parts for the given terms (wildcard pieces each). */
export function highlightParts(text: string, terms: string[]): { text: string; hit: boolean }[] {
  const pieces = [...new Set(terms.flatMap(termPieces))].filter((p) => p.length > 0);
  if (!text || !pieces.length) return [{ text, hit: false }];
  const { folded, map } = foldWithMap(text);
  const marks = new Array<boolean>(text.length).fill(false);
  for (const p of pieces) {
    let at = folded.indexOf(p);
    while (at >= 0) {
      for (let k = map[at]!; k < map[at + p.length]!; k++) marks[k] = true;
      at = folded.indexOf(p, at + p.length);
    }
  }
  const out: { text: string; hit: boolean }[] = [];
  for (let i = 0; i < text.length; i++) {
    const last = out[out.length - 1];
    if (last && last.hit === marks[i]) last.text += text[i];
    else out.push({ text: text[i]!, hit: marks[i]! });
  }
  return out;
}

/** Removes XML/HTML tags and entities from extracted text and collapses white space. */
export function cleanExcerpt(text: string): string {
  return text
    .replace(/<\/?[A-Za-z][^<>]{0,300}>/g, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/&(nbsp|amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi, (m, e: string) => {
      const named: Record<string, string> = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
      const k = e.toLowerCase();
      if (named[k]) return named[k]!;
      const code = k.startsWith("#x") ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
      return Number.isFinite(code) && code > 31 && code < 0x110000 ? String.fromCodePoint(code) : m;
    })
    .replace(/[\s\f]+/g, " ")
    .trim();
}

// ---- Parameters --------------------------------------------------------------------------

export const SEARCH_SORTS = ["relevance", "name", "date", "size"] as const;
export type SearchSort = (typeof SEARCH_SORTS)[number];
/** Review outcome filter: an outcome code, "pending" (in a running review) or "none" (never reviewed). */
export const SEARCH_REVIEW_FILTERS = [
  "approved",
  "approved_with_comments",
  "reviewed",
  "revise_resubmit",
  "rejected",
  "pending",
  "none",
] as const;
export type SearchReviewFilter = (typeof SEARCH_REVIEW_FILTERS)[number];
export const SEARCH_STATES: readonly FolderState[] = ["wip", "shared", "published", "archived"];

/** Everything a document search can ask for. Saved searches keep this object (without paging). */
export interface DocSearchParams {
  q?: string;
  /** Also look inside the files' text (default true). */
  content?: boolean;
  /** Only this folder… */
  folderId?: string;
  /** …and its subfolders (default true). */
  subfolders?: boolean;
  /** Only these folders (with their subfolders when `subfolders`); ignored when `folderId` is set. */
  folderIds?: string[];
  /** Extensions without the dot: ["pdf", "dwg"]. */
  ext?: string[];
  /** Attribute name → value (list/date/number exact, text by part). */
  attrs?: Record<string, string>;
  /** ISO 19650 state of the folder the file is in. */
  states?: FolderState[];
  /** Suitability codes of the current version ("S2"). */
  suitability?: string[];
  /** Revision code of the current version; `*` allowed ("P01*"). */
  revision?: string;
  /** Uploader of the current version (user ids). */
  uploadedBy?: string[];
  /** Company of the uploader of the current version (company ids). */
  companies?: string[];
  /** Current version uploaded (or its codes set) on or after / before this day (YYYY-MM-DD). */
  updatedFrom?: string;
  updatedTo?: string;
  /** Some version of the file was added in this range (YYYY-MM-DD). */
  addedFrom?: string;
  addedTo?: string;
  /** Current version number: "3" or a range "2-5". */
  version?: string;
  review?: SearchReviewFilter[];
  /** Only files locked for editing (Office Online / WOPI lock). */
  locked?: boolean;
  /** Search the recycle bin instead (project administrators). */
  trash?: boolean;
  sort?: SearchSort;
  dir?: "asc" | "desc";
  offset?: number;
  limit?: number;
}

const csv = (v: string[] | undefined) => (v?.length ? v.join(",") : undefined);

/** Query string of a search (`GET /projects/:pid/search?…`). */
export function searchParamsToQuery(p: DocSearchParams): URLSearchParams {
  const out = new URLSearchParams();
  const set = (k: string, v: string | number | undefined | null) => {
    if (v !== undefined && v !== null && v !== "") out.set(k, String(v));
  };
  set("q", p.q?.trim());
  if (p.content === false) set("content", "0");
  set("folderId", p.folderId);
  if (p.subfolders === false) set("subfolders", "0");
  if (!p.folderId) set("folderIds", csv(p.folderIds));
  set("ext", csv(p.ext));
  for (const [k, v] of Object.entries(p.attrs ?? {})) if (v?.trim()) set(`attr.${k}`, v.trim());
  set("state", csv(p.states));
  set("suitability", csv(p.suitability));
  set("revision", p.revision?.trim());
  set("uploadedBy", csv(p.uploadedBy));
  set("company", csv(p.companies));
  set("updatedFrom", p.updatedFrom);
  set("updatedTo", p.updatedTo);
  set("addedFrom", p.addedFrom);
  set("addedTo", p.addedTo);
  set("version", p.version?.trim());
  set("review", csv(p.review));
  if (p.locked) set("locked", "1");
  if (p.trash) set("trash", "1");
  if (p.sort) set("sort", p.sort);
  if (p.dir) set("dir", p.dir);
  if (p.offset) set("offset", p.offset);
  if (p.limit) set("limit", p.limit);
  return out;
}

/** Reads a query string object back (unknown values are dropped; the server validates the rest). */
export function searchParamsFromQuery(query: Record<string, string | string[] | undefined>): DocSearchParams {
  const one = (k: string) => {
    const v = query[k];
    return ((Array.isArray(v) ? v[0] : v) ?? "").trim();
  };
  const list = (k: string) =>
    one(k)
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
  const p: DocSearchParams = {};
  if (one("q")) p.q = one("q");
  if (one("content") === "0") p.content = false;
  if (one("folderId")) p.folderId = one("folderId");
  if (one("subfolders") === "0") p.subfolders = false;
  if (list("folderIds").length) p.folderIds = list("folderIds");
  const ext = list("ext").map((e) => e.replace(/^\*?\./, "").toLowerCase()).filter(Boolean);
  if (ext.length) p.ext = ext;
  const attrs: Record<string, string> = {};
  for (const k of Object.keys(query)) if (k.startsWith("attr.") && k.length > 5 && one(k)) attrs[k.slice(5)] = one(k);
  if (Object.keys(attrs).length) p.attrs = attrs;
  const states = list("state").filter((s): s is FolderState => (SEARCH_STATES as readonly string[]).includes(s));
  if (states.length) p.states = states;
  if (list("suitability").length) p.suitability = list("suitability");
  if (one("revision")) p.revision = one("revision");
  if (list("uploadedBy").length) p.uploadedBy = list("uploadedBy");
  if (list("company").length) p.companies = list("company");
  for (const k of ["updatedFrom", "updatedTo", "addedFrom", "addedTo"] as const) if (one(k)) p[k] = one(k);
  if (one("version")) p.version = one("version");
  const review = list("review").filter((r): r is SearchReviewFilter => (SEARCH_REVIEW_FILTERS as readonly string[]).includes(r));
  if (review.length) p.review = review;
  if (one("locked") === "1") p.locked = true;
  if (one("trash") === "1") p.trash = true;
  const sort = one("sort");
  if ((SEARCH_SORTS as readonly string[]).includes(sort)) p.sort = sort as SearchSort;
  if (one("dir") === "asc" || one("dir") === "desc") p.dir = one("dir") as "asc" | "desc";
  if (Number(one("offset")) > 0) p.offset = Math.floor(Number(one("offset")));
  if (Number(one("limit")) > 0) p.limit = Math.floor(Number(one("limit")));
  return p;
}

/** Number of filters set besides the text and the scope (the "Filters (3)" counter). */
export function searchFilterCount(p: DocSearchParams): number {
  return (
    (p.ext?.length ? 1 : 0) +
    Object.values(p.attrs ?? {}).filter((v) => v.trim()).length +
    (p.states?.length ? 1 : 0) +
    (p.suitability?.length ? 1 : 0) +
    (p.revision?.trim() ? 1 : 0) +
    (p.uploadedBy?.length ? 1 : 0) +
    (p.companies?.length ? 1 : 0) +
    (p.updatedFrom || p.updatedTo ? 1 : 0) +
    (p.addedFrom || p.addedTo ? 1 : 0) +
    (p.version?.trim() ? 1 : 0) +
    (p.review?.length ? 1 : 0) +
    (p.locked ? 1 : 0)
  );
}

/** The search part of a saved search: paging is never stored. */
export function savedSearchParams(p: DocSearchParams): DocSearchParams {
  const { offset: _o, limit: _l, ...rest } = p;
  return rest;
}

// ---- Saved searches -----------------------------------------------------------------------

export type SavedSearchShareSubject = "user" | "company" | "project";

export interface SavedSearchShareDto {
  subjectType: SavedSearchShareSubject;
  /** User or company id; the project id for "project". */
  subjectId: string;
  subjectName?: string;
}

export interface SavedSearchDto {
  id: string;
  name: string;
  params: DocSearchParams;
  ownerId: string;
  ownerName?: string;
  /** True for the caller's own searches. */
  mine: boolean;
  /** Who it is shared with (the owner and project administrators see the list). */
  shares: SavedSearchShareDto[];
  createdAt: string;
  updatedAt: string;
}

export interface SavedSearchInput {
  name: string;
  params: DocSearchParams;
}
