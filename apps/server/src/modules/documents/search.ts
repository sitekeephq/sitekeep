import { and, asc, desc, eq, inArray, isNotNull, isNull, not, or, sql, type SQL } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import {
  can,
  cleanExcerpt,
  foldTr,
  parseSearchQuery,
  searchParamsFromQuery,
  searchTerms,
  termLikePattern,
  termPieces,
  type DocSearchParams,
  type FolderState,
  type SearchHitDto,
  type SearchMatchPlace,
  type SearchNode,
  type SearchResultDto,
} from "@sitekeep/shared";
import type { AppDeps } from "../../app/deps.js";
import type { Db } from "../../db/index.js";
import {
  FolderTree,
  isUuid,
  loadWipRule,
  projectAccess,
  requireProjectAdmin,
  userNames,
  type ProjectAccess,
} from "../../core/security/access.js";
import {
  attributeDefinitions,
  fileVersions,
  files,
  folderGrants,
  folders,
  projectMembers,
  reviewFiles,
  reviews,
  users,
  versionTexts,
  wopiLocks,
  workflowInstances,
} from "../../db/schema.js";
import { badRequest, notFound } from "../../core/platform/http.js";
import { msg } from "../../i18n/index.js";
import { REPORT_TIME_ZONE } from "../../reports/datasets.js";
import { SUBJECT_REVIEW } from "../../workflow/review-types.js";
import { toFileDto } from "./mapper.js";
import { folderDisplayPath } from "./path.js";

/**
 * SQL side of foldTr(): Turkish I letters become "i" before lower(), so matching does not
 * depend on the database collation (PGlite runs with the C locale). The trigram indexes of
 * migration 0061 are built on exactly these expressions: keep them in step.
 */
const fold = (expr: SQL) => sql`lower(translate(${expr}, 'İIıŞĞÜÖÇ', 'iiişğüöç'))`; // i18n-ok: Turkish case folding
const likeEscape = (v: string) => v.replace(/[\\%_]/g, (c) => `\\${c}`);

/** Folder ids as one parameter, joined as a set (a hash semi-join, however many folders). */
const inIds = (column: SQL | typeof files.folderId, ids: string[]) =>
  sql`${column} in (select unnest(string_to_array(${ids.join(",")}, ',')::uuid[]))`;

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;
const MAX_OFFSET = 100_000;
/** Raw characters read around a content match before tags are stripped. */
const WINDOW = 240;
/** Characters of clean excerpt kept on each side of the match. */
const EXCERPT_SIDE = 80;

/**
 * GET /projects/:pid/search — see DocSearchParams (packages/shared/src/documents/search.ts) and
 * docs/features/DOCUMENT_SEARCH.md. The query language: words (ANDed), AND / OR / NOT,
 * parentheses, * and "phrases"; each term is a part of the name, an attribute value or the text of
 * the current version. Folder permissions are applied in SQL: a file in a folder the caller cannot
 * read is never counted, ranked or excerpted.
 */
export async function searchRoutes(api: FastifyInstance, { db }: AppDeps) {
  api.get<{ Params: { pid: string }; Querystring: Record<string, string | string[] | undefined> }>(
    "/projects/:pid/search",
    async (req): Promise<SearchResultDto> => {
      const a = await projectAccess(db, req.params.pid, req.user!);
      const raw = req.query.q;
      const q = ((Array.isArray(raw) ? raw[0] : raw) ?? "").trim();
      if (q.length > 200) throw badRequest(msg("documents:errors.searchTooLong"));
      return runDocSearch(db, a, searchParamsFromQuery(req.query));
    },
  );
}

/** Midnight of a calendar day (YYYY-MM-DD) in the reporting time zone, as an instant. */
export function dayStart(day: string, timeZone = REPORT_TIME_ZONE): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) throw badRequest(msg("documents:errors.searchBadDate", { value: day }));
  const guess = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(guess)) throw badRequest(msg("documents:errors.searchBadDate", { value: day }));
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
      .formatToParts(new Date(guess))
      .map((p) => [p.type, p.value]),
  );
  const asLocal = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  return new Date(guess - (asLocal - guess));
}

/** Midnight after the day: the exclusive end of a "to" date. */
function dayEnd(day: string, timeZone = REPORT_TIME_ZONE): Date {
  dayStart(day, timeZone); // validates
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return dayStart(d.toISOString().slice(0, 10), timeZone);
}

/** Folders of the project with grants; the recycle bin also needs the deleted ones (for paths). */
async function loadTree(db: Db, projectId: string, withDeleted: boolean): Promise<FolderTree> {
  if (!withDeleted) return FolderTree.load(db, projectId);
  const rows = await db.select().from(folders).where(eq(folders.projectId, projectId));
  const ids = rows.map((r) => r.id);
  const grants = ids.length ? await db.select().from(folderGrants).where(inArray(folderGrants.folderId, ids)) : [];
  return new FolderTree(rows, grants, await loadWipRule(db, projectId));
}

/** The ISO 19650 state a folder is in: its own or the nearest ancestor's. */
function folderState(tree: FolderTree, id: string): FolderState | null {
  for (const fid of tree.ancestry(id).reverse()) {
    const s = tree.byId.get(fid)?.state;
    if (s) return s;
  }
  return null;
}

interface FolderScope {
  /** Folders whose files the caller may see. */
  view: string[];
  /** Folders where the caller sees only the files they uploaded (upload-only permission). */
  own: string[];
}

/** Folder scope after permissions, the scope options and the ISO state filter. */
function folderScope(tree: FolderTree, a: ProjectAccess, p: DocSearchParams): FolderScope {
  const withSubs = p.subfolders !== false;
  let scope: Set<string> | null = null;
  if (p.folderId) {
    if (!isUuid(p.folderId) || !tree.byId.has(p.folderId) || !tree.visible(a.principal, p.folderId))
      throw notFound(msg("documents:entities.folder"));
    scope = new Set([p.folderId, ...(withSubs ? tree.descendants(p.folderId) : [])]);
  } else if (p.folderIds?.length) {
    // Selected folders (also from a shared saved search): folders the caller cannot see are skipped.
    scope = new Set();
    for (const id of p.folderIds.slice(0, 200)) {
      if (!isUuid(id) || !tree.byId.has(id) || !tree.visible(a.principal, id)) continue;
      scope.add(id);
      if (withSubs) for (const d of tree.descendants(id)) scope.add(d);
    }
  }
  const states = p.states?.length ? new Set<string>(p.states) : null;
  const view: string[] = [];
  const own: string[] = [];
  for (const id of tree.byId.keys()) {
    if (scope && !scope.has(id)) continue;
    if (states && !states.has(folderState(tree, id) ?? "")) continue;
    const perm = tree.permission(a.principal, id);
    if (can(perm.level, "view")) view.push(id);
    else if (perm.canUpload) own.push(id);
  }
  return { view, own };
}

/**
 * How a term is looked for in the files' text. The full-text index (version_texts.tsv, GIN) finds
 * the texts with a word starting with the term's first word. A plain word or prefix ("istasyon",
 * "rapor*") needs nothing more. A one-word term with an inner * ("ista*on") is checked against the
 * words of the text (the vector's lexemes). Anything else (a phrase, a code with punctuation) is
 * checked exactly with LIKE on the text. A term starting with * has no word start: LIKE alone,
 * served by the pg_trgm index on PostgreSQL.
 */
export function contentPlan(term: string): { prefix: string | null; check: "none" | "lexeme" | "like" } {
  const f = foldTr(term).trim();
  const first = /^[\p{L}\p{N}]+/u.exec(f)?.[0] ?? null;
  if (!first) return { prefix: null, check: "like" };
  if (f === first || f === `${first}*`) return { prefix: first, check: "none" };
  if (/^[\p{L}\p{N}*]+$/u.test(f)) return { prefix: first, check: "lexeme" };
  return { prefix: first, check: "like" };
}

/**
 * The text conditions of a search, one common table expression per term: each is computed once
 * per query however often the term is used (in the filter, the match badges and the ranking).
 */
class ContentSets {
  readonly ctes: ReturnType<ReturnType<Db["$with"]>["as"]>[] = [];
  private readonly byTerm = new Map<string, SQL>();
  constructor(private readonly db: Db) {}

  /** `file_versions.id in (versions whose text holds the term)`. */
  has(term: string): SQL {
    const known = this.byTerm.get(term);
    if (known) return known;
    const plan = contentPlan(term);
    const pattern = termLikePattern(term);
    const conds: SQL[] = [];
    if (plan.prefix) conds.push(sql`${versionTexts.tsv} @@ to_tsquery('simple', ${`${plan.prefix}:*`})`);
    if (plan.check === "lexeme")
      conds.push(sql`exists (select 1 from unnest(${versionTexts.tsv}) as lx where lx.lexeme like ${pattern.slice(1)})`);
    if (plan.check === "like") conds.push(sql`${fold(sql`${versionTexts.content}`)} like ${pattern}`);
    const cte = this.db
      .$with(`text_hits_${this.ctes.length}`)
      .as(this.db.select({ vid: versionTexts.versionId }).from(versionTexts).where(and(...conds)));
    this.ctes.push(cte);
    const ref = sql`${fileVersions.id} in (select ${cte.vid} from ${cte})`;
    this.byTerm.set(term, ref);
    return ref;
  }
}

/** The search terms of one query term, as conditions per place. */
function termConditions(term: string, sets: ContentSets | null) {
  const pattern = termLikePattern(term);
  const name = sql`${fold(sql`${files.name}`)} like ${pattern}`;
  // attributes::text holds the keys too: it only narrows (trigram index), the values decide.
  const values = sql`exists (select 1 from jsonb_each_text(${files.attributes}) as kv(key, value) where ${fold(sql`kv.value`)} like ${pattern})`;
  const attribute = /["\\]/.test(term) ? values : sql`(${fold(sql`${files.attributes}::text`)} like ${pattern} and ${values})`;
  return { name, attribute, text: sets ? sets.has(term) : null };
}

function nodeCondition(node: SearchNode, sets: ContentSets | null): SQL {
  if (node.kind === "term") {
    const c = termConditions(node.text, sets);
    return or(c.name, c.attribute, ...(c.text ? [c.text] : []))!;
  }
  if (node.kind === "not") return not(nodeCondition(node.item, sets));
  const parts = node.items.map((n) => nodeCondition(n, sets));
  return (node.kind === "and" ? and(...parts) : or(...parts))!;
}

/** Prefix query of the words of the terms, for ts_rank (letters and digits only: safe to_tsquery input). */
function rankQuery(terms: string[]): string | null {
  const words = [...new Set(terms.flatMap((t) => foldTr(t).split(/[^\p{L}\p{N}]+/u)).filter((w) => w.length >= 2))].slice(0, 12);
  return words.length ? words.map((w) => `${w}:*`).join(" | ") : null;
}

/** `= any(…)` of a short list of codes (one parameter). */
const anyOf = (values: string[]) => sql`any(string_to_array(${values.map((v) => v.replace(/,/g, "")).join(",")}, ','))`;

/** The search itself: also used by saved searches and tools. Throws 400/403/404 like the route. */
export async function runDocSearch(db: Db, a: ProjectAccess, p: DocSearchParams): Promise<SearchResultDto> {
  const q = p.q?.trim() ?? "";
  if (q.length > 200) throw badRequest(msg("documents:errors.searchTooLong"));
  const limit = Math.min(Math.max(p.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const offset = Math.min(Math.max(p.offset ?? 0, 0), MAX_OFFSET);
  const trash = !!p.trash;
  if (trash) requireProjectAdmin(a);
  const content = p.content !== false;
  const projectId = a.project.id;

  const tree = await loadTree(db, projectId, trash);
  const scope = folderScope(tree, a, p);
  const node = q ? parseSearchQuery(q) : null;
  const terms = searchTerms(node);
  const empty: SearchResultDto = { results: [], truncated: false, total: 0, offset, limit, terms };
  if (!scope.view.length && !scope.own.length) return empty;

  const access = [
    ...(scope.view.length ? [inIds(files.folderId, scope.view)] : []),
    ...(scope.own.length ? [and(inIds(files.folderId, scope.own), eq(files.createdBy, a.user.id))!] : []),
  ];
  const where: (SQL | undefined)[] = [
    eq(files.projectId, projectId),
    trash ? isNotNull(files.deletedAt) : isNull(files.deletedAt),
    or(...access),
  ];
  const sets = content ? new ContentSets(db) : null;
  if (node) where.push(nodeCondition(node, sets));

  if (p.ext?.length) where.push(or(...p.ext.map((e) => sql`lower(${files.name}) like ${`%.${likeEscape(e.toLowerCase())}`}`)));

  const attrFilters = Object.entries(p.attrs ?? {}).filter(([, v]) => v?.trim());
  if (attrFilters.length) {
    const defs = await db
      .select({ name: attributeDefinitions.name, type: attributeDefinitions.type })
      .from(attributeDefinitions)
      .where(eq(attributeDefinitions.projectId, projectId));
    const types = new Map(defs.map((d) => [d.name, d.type]));
    for (const [name, value] of attrFilters) {
      const field = fold(sql`${files.attributes} ->> ${name}::text`);
      const exact = ["list", "date", "number"].includes(types.get(name) ?? "text");
      where.push(exact ? sql`${field} = ${foldTr(value.trim())}` : sql`${field} like ${`%${likeEscape(foldTr(value.trim()))}%`}`);
    }
  }

  if (p.suitability?.length) where.push(sql`upper(${fileVersions.suitabilityCode}) = ${anyOf(p.suitability.map((s) => s.toUpperCase()))}`);
  if (p.revision?.trim()) {
    const rev = likeEscape(foldTr(p.revision.trim())).replace(/\*+/g, "%");
    where.push(sql`${fold(sql`${fileVersions.revisionCode}`)} like ${rev}`);
  }
  if (p.uploadedBy?.length) {
    const ids = p.uploadedBy.filter(isUuid);
    where.push(ids.length ? inIds(sql`${fileVersions.uploadedBy}`, ids) : sql`false`);
  }
  if (p.companies?.length) {
    const ids = p.companies.filter(isUuid);
    where.push(
      ids.length
        ? sql`exists (select 1 from ${users} u left join ${projectMembers} pm on pm.user_id = u.id and pm.project_id = ${projectId}
            where u.id = ${fileVersions.uploadedBy} and coalesce(pm.company_id, u.company_id) in (select unnest(string_to_array(${ids.join(",")}, ',')::uuid[])))`
        : sql`false`,
    );
  }
  const updated = sql`greatest(${fileVersions.uploadedAt}, coalesce(${fileVersions.codesSetAt}, ${fileVersions.uploadedAt}))`;
  if (p.updatedFrom) where.push(sql`${updated} >= ${dayStart(p.updatedFrom).toISOString()}`);
  if (p.updatedTo) where.push(sql`${updated} < ${dayEnd(p.updatedTo).toISOString()}`);
  if (p.addedFrom || p.addedTo) {
    const conds: SQL[] = [sql`v2.file_id = ${files.id}`];
    if (p.addedFrom) conds.push(sql`v2.uploaded_at >= ${dayStart(p.addedFrom).toISOString()}`);
    if (p.addedTo) conds.push(sql`v2.uploaded_at < ${dayEnd(p.addedTo).toISOString()}`);
    where.push(sql`exists (select 1 from ${fileVersions} v2 where ${sql.join(conds, sql` and `)})`);
  }
  if (p.version?.trim()) {
    const m = /^(\d{1,6})(?:\s*-\s*(\d{1,6}))?$/.exec(p.version.trim());
    if (!m) throw badRequest(msg("documents:errors.searchBadVersion", { value: p.version }));
    const lo = Number(m[1]);
    const hi = m[2] ? Number(m[2]) : lo;
    where.push(sql`${files.currentVersion} between ${Math.min(lo, hi)} and ${Math.max(lo, hi)}`);
  }
  if (p.review?.length) {
    const reviewed = sql`from ${reviewFiles} rf join ${reviews} r on r.id = rf.review_id
      join ${workflowInstances} wi on wi.subject_type = ${SUBJECT_REVIEW} and wi.subject_id = r.id
      where (rf.file_version_id = ${fileVersions.id} or rf.copied_version_id = ${fileVersions.id}) and wi.status <> 'cancelled'`;
    const conds: SQL[] = [];
    const outcomes = p.review.filter((r) => r !== "pending" && r !== "none");
    if (outcomes.length)
      conds.push(sql`(select rf.final_status ${reviewed} and rf.final_status is not null order by coalesce(rf.decided_at, r.created_at) desc limit 1) = ${anyOf(outcomes)}`);
    if (p.review.includes("pending"))
      conds.push(sql`exists (select 1 ${reviewed} and rf.file_version_id = ${fileVersions.id} and wi.status = 'running' and rf.stopped_at_step is null)`);
    if (p.review.includes("none")) conds.push(sql`not exists (select 1 ${reviewed})`);
    where.push(or(...conds));
  }
  if (p.locked) where.push(sql`exists (select 1 from ${wopiLocks} l where l.file_id = ${files.id} and l.expires_at > now())`);

  const condition = and(...where);
  const versionJoin = and(eq(fileVersions.fileId, files.id), eq(fileVersions.version, files.currentVersion));

  // Where each positive term matched (for the badges, the ranking and the excerpt).
  const positive = terms.map((t) => termConditions(t, sets));
  const hit = (pick: (c: (typeof positive)[number]) => SQL | null) => {
    const parts = positive.map(pick).filter((x): x is SQL => !!x);
    return parts.length ? sql`(${or(...parts)})` : sql`false`;
  };
  const nameHit = hit((c) => c.name);
  const attrHit = hit((c) => c.attribute);
  const textHit = hit((c) => c.text);
  const prefixHit = terms.length
    ? sql`(${or(...terms.map((t) => sql`${fold(sql`${files.name}`)} like ${`${termLikePattern(t).slice(1)}`}`))})`
    : sql`false`;
  const tsq = content ? rankQuery(terms) : null;
  const textRank = tsq ? sql`coalesce(ts_rank(${versionTexts.tsv}, to_tsquery('simple', ${tsq})), 0)` : sql`0`;
  const score = sql`((case when ${nameHit} then 8 else 0 end) + (case when ${prefixHit} then 4 else 0 end)
    + (case when ${attrHit} then 3 else 0 end) + (case when ${textHit} then 1 else 0 end) + ${textRank})`;

  const sort = p.sort ?? (terms.length ? "relevance" : "name");
  const dir = p.dir ?? (sort === "name" ? "asc" : "desc");
  const by = dir === "asc" ? asc : desc;
  const nameKey = fold(sql`${files.name}`);
  const order: SQL[] =
    sort === "relevance" && terms.length
      ? [by(score), desc(fileVersions.uploadedAt), asc(nameKey)]
      : sort === "date"
        ? [by(fileVersions.uploadedAt), asc(nameKey)]
        : sort === "size"
          ? [by(fileVersions.size), asc(nameKey)]
          : [by(nameKey), by(files.name)];

  const base = () => (sets?.ctes.length ? db.with(...sets.ctes) : db);
  // One statement: the matches, their number (window count) and the page, as narrow rows (ids and
  // flags) so sorting many matches stays cheap; the page's records are read afterwards.
  const hits = await base()
    .select({
      vid: fileVersions.id,
      nameHit: sql<boolean>`${nameHit}`,
      attrHit: sql<boolean>`${attrHit}`,
      textHit: sql<boolean>`${textHit}`,
      total: sql<number>`(count(*) over ())::int`,
    })
    .from(files)
    .innerJoin(fileVersions, versionJoin)
    .leftJoin(versionTexts, eq(versionTexts.versionId, fileVersions.id))
    .where(condition)
    .orderBy(...order, asc(files.id))
    .limit(limit)
    .offset(offset);
  let total = Number(hits[0]?.total ?? 0);
  if (!hits.length && offset > 0) {
    const [counted] = await base()
      .select({ total: sql<number>`count(*)::int` })
      .from(files)
      .innerJoin(fileVersions, versionJoin)
      .where(condition);
    total = Number(counted?.total ?? 0);
  }
  if (!hits.length) return { ...empty, total };
  const records = await db
    .select()
    .from(files)
    .innerJoin(fileVersions, eq(fileVersions.fileId, files.id))
    .where(inArray(fileVersions.id, hits.map((h) => h.vid)));
  const byVersion = new Map(records.map((r) => [r.file_versions.id, r]));
  const rows = hits.flatMap((h) => {
    const r = byVersion.get(h.vid);
    return r ? [{ ...r, nameHit: h.nameHit, attrHit: h.attrHit, textHit: h.textHit }] : [];
  });

  const names = await userNames(db, rows.map((r) => r.file_versions.uploadedBy));
  const textVersions = rows.filter((r) => r.textHit).map((r) => r.file_versions.id);
  const excerpts = await textExcerpts(db, textVersions, terms);
  const results: SearchHitDto[] = rows.map((r) => {
    const matchedIn: SearchMatchPlace[] = [];
    if (r.nameHit) matchedIn.push("name");
    if (r.attrHit) matchedIn.push("attribute");
    if (r.textHit) matchedIn.push("content");
    const ex = excerpts.get(r.file_versions.id);
    return {
      ...toFileDto(r.files, r.file_versions, names),
      folderPath: tree.byId.has(r.files.folderId) ? folderDisplayPath(tree, r.files.folderId) : "",
      ...(ex && { snippet: ex.snippet }),
      ...(ex?.page && { page: ex.page }),
      ...(terms.length && { matchedIn }),
      ...(trash && r.files.deletedAt && { deletedAt: r.files.deletedAt.toISOString() }),
    };
  });
  return { results, truncated: offset + results.length < total, total, offset, limit, terms };
}

/**
 * A clean excerpt around the first match of the terms in each version's text, and the PDF page
 * (pages are separated by form feeds, src/previews/service.ts). fold() keeps positions: translate
 * and lower map one character to one.
 */
async function textExcerpts(db: Db, versionIds: string[], terms: string[]): Promise<Map<string, { snippet: string; page?: number }>> {
  const pieces = [...new Set(terms.flatMap((t) => termPieces(t).slice(0, 1)))].slice(0, 8);
  if (!versionIds.length || !pieces.length) return new Map();
  const folded = fold(sql`${versionTexts.content}`);
  const at = sql`coalesce(${sql.join(
    pieces.map((pc) => sql`nullif(strpos(${folded}, ${pc}), 0)`),
    sql`, `,
  )}, 0)`;
  const rows = await db
    .select({
      versionId: versionTexts.versionId,
      source: versionTexts.source,
      pos: sql<number>`${at}`,
      window: sql<string>`substr(${versionTexts.content}, greatest(${at} - ${WINDOW}, 1), ${WINDOW * 2})`,
      breaks: sql<number>`length(left(${versionTexts.content}, ${at})) - length(replace(left(${versionTexts.content}, ${at}), chr(12), ''))`,
    })
    .from(versionTexts)
    .where(inArray(versionTexts.versionId, versionIds));
  const out = new Map<string, { snippet: string; page?: number }>();
  for (const r of rows) {
    const pos = Number(r.pos);
    if (!pos) continue;
    const startsAtTop = pos <= WINDOW + 1;
    const clean = cleanExcerpt(r.window);
    const f = foldTr(clean);
    let hitAt = -1;
    for (const pc of pieces) {
      hitAt = f.indexOf(pc);
      if (hitAt >= 0) break;
    }
    if (hitAt < 0) hitAt = Math.min(clean.length, startsAtTop ? 0 : WINDOW);
    let from = Math.max(0, hitAt - EXCERPT_SIDE);
    let to = Math.min(clean.length, hitAt + EXCERPT_SIDE * 2);
    // Cut at word boundaries.
    if (from > 0) {
      const sp = clean.indexOf(" ", from);
      if (sp >= 0 && sp < hitAt) from = sp + 1;
    }
    if (to < clean.length) {
      const sp = clean.lastIndexOf(" ", to);
      if (sp > hitAt) to = sp;
    }
    const lead = from > 0 || !startsAtTop ? "…" : "";
    const tail = to < clean.length || r.window.length >= WINDOW * 2 ? "…" : "";
    const snippet = `${lead}${clean.slice(from, to).trim()}${tail}`;
    out.set(r.versionId, { snippet, ...(r.source === "pdf" && { page: Number(r.breaks) + 1 }) });
  }
  return out;
}
