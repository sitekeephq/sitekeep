/**
 * "Modele sor": questions and structured queries over an IFC version's element index (or over the
 * changed elements of a comparison). The AI writes a ModelQuery (validated JSON), never code; the
 * server runs it. Keyword rules give an instant answer and the fallback when AI is unavailable.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ifcClassLabel, type ModelAskResultDto, type ModelQueryResultDto, type ModelVocabDto, type ReportDraft } from "@sitekeep/shared";
import type { AppDeps, ResolvedDeps } from "../app/deps.js";
import { audit } from "../core/platform/audit.js";
import { AiError, resolveProvider, resolveSelectedProvider } from "../ai/provider.js";
import { HttpError, badRequest } from "../core/platform/http.js";
import { ModelAiError, aiQuery, queryCache, questionKey } from "../model/ai.js";
import { diffCandidates } from "../model/diff.js";
import type { ModelIndex } from "../model/model-index.js";
import { executeModelQuery, modelQuerySchema, versionCandidates, type Candidate } from "../model/query.js";
import { modelReportDraft, setModelDatasetStorage } from "../model/report-dataset.js";
import { rulesQuery } from "../model/rules.js";
import { ifcVersion, preparing, versionModelIndex, type LoadedVersion } from "../model/service.js";
import { abortOnClose, compareOf, loadComparePair } from "./compare.js";
import { msg, render, requestLanguage } from "../i18n/index.js";

type User = Parameters<typeof ifcVersion>[3];

interface Scope {
  v: LoadedVersion;
  /** Combined vocabulary of the version(s) in scope (the newer version when comparing). */
  vocab: Omit<ModelVocabDto, "versionId" | "fileName" | "version">;
  candidates: Candidate[];
  compareFrom?: string;
  versionKey: string;
}

const compareFromSchema = z.string().uuid().optional();
const versionIdsSchema = z.array(z.string().uuid()).max(50).optional();

function mergeVocabs(list: Omit<ModelVocabDto, "versionId" | "fileName" | "version">[]): Omit<ModelVocabDto, "versionId" | "fileName" | "version"> {
  if (list.length === 1) return list[0]!;
  let elementCount = 0;
  const classes = new Map<string, { label: string; count: number }>();
  const storeys = new Map<string, { elevation: number | null; count: number }>();
  const types = new Map<string, number>();
  const props = new Map<string, { name: string; count: number; numeric: boolean; samples: Set<string> }>();
  for (const v of list) {
    elementCount += v.elementCount;
    for (const c of v.classes) {
      const cur = classes.get(c.name);
      classes.set(c.name, { label: c.label, count: (cur?.count ?? 0) + c.count });
    }
    for (const s of v.storeys) {
      const cur = storeys.get(s.name);
      storeys.set(s.name, { elevation: cur?.elevation ?? s.elevation, count: (cur?.count ?? 0) + s.count });
    }
    for (const t of v.types) types.set(t.name, (types.get(t.name) ?? 0) + t.count);
    for (const p of v.properties) {
      let cur = props.get(p.key);
      if (!cur) props.set(p.key, (cur = { name: p.name, count: 0, numeric: p.numeric, samples: new Set() }));
      cur.count += p.count;
      if (!p.numeric) cur.numeric = false;
      for (const s of p.samples) if (cur.samples.size < 6) cur.samples.add(s);
    }
  }
  return {
    elementCount,
    classes: [...classes.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .map(([name, x]) => ({ name, label: x.label, count: x.count })),
    storeys: [...storeys.entries()]
      .sort((a, b) => (a[1].elevation ?? 0) - (b[1].elevation ?? 0))
      .map(([name, x]) => ({ name, elevation: x.elevation, count: x.count })),
    types: [...types.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 100)
      .map(([name, count]) => ({ name, count })),
    properties: [...props.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .map(([key, p]) => ({ key, name: p.name, count: p.count, numeric: p.numeric, samples: [...p.samples] })),
  };
}

export async function modelRoutes(api: FastifyInstance, deps: AppDeps) {
  const { db, storage } = deps;
  setModelDatasetStorage(storage);

  /** Elements in scope: one version, several federated versions, or the changed elements against `compareFrom`. */
  async function scope(pid: string, vid: string, compareFrom: string | undefined, user: User, extraVersionIds?: string[]): Promise<Scope> {
    if (compareFrom) {
      const p = await loadComparePair(deps, pid, compareFrom, vid, user);
      if (!p.oldIdx.detailed || !p.newIdx.detailed) {
        if (p.upgrading)
          throw preparing(
            [p.a.version.id, p.b.version.id],
            msg("model:errors.indexUpgrading"),
          );
        throw new HttpError(422, "index_failed", msg("model:errors.indexUpgradeFailed"));
      }
      const c = compareOf(p);
      return { v: p.b, vocab: p.newIdx.vocab(), candidates: diffCandidates(p.oldIdx, p.newIdx, c), compareFrom, versionKey: vid };
    }
    const ids = [...new Set([vid, ...(extraVersionIds ?? [])])];
    if (ids.length === 1) {
      const v = await ifcVersion(db, pid, vid, user);
      const { index } = await versionModelIndex({ db, storage, queue: deps.jobs }, v, { detail: true });
      return { v, vocab: index.vocab(), candidates: versionCandidates(index), versionKey: vid };
    }
    const loaded = await Promise.all(ids.map((id) => ifcVersion(db, pid, id, user)));
    const pending: string[] = [];
    const indexed: { v: LoadedVersion; index: ModelIndex }[] = [];
    for (const v of loaded) {
      try {
        const { index } = await versionModelIndex({ db, storage, queue: deps.jobs }, v, { detail: true });
        indexed.push({ v, index });
      } catch (e) {
        if (e instanceof HttpError && e.status === 409) pending.push(v.version.id);
        else throw e;
      }
    }
    if (pending.length) throw preparing(pending);
    const candidates = indexed.flatMap(({ v, index }) =>
      versionCandidates(index, { versionId: v.version.id, modelName: v.file.name.replace(/\.ifc$/i, "") }),
    );
    return {
      v: indexed[0]!.v,
      vocab: mergeVocabs(indexed.map((x) => x.index.vocab())),
      candidates,
      versionKey: [...ids].sort().join(","),
    };
  }

  /** Classes, storeys, types and properties of a version (filter builder). */
  api.get<{ Params: { pid: string; vid: string }; Querystring: { compareFrom?: string; versions?: string } }>(
    "/projects/:pid/versions/:vid/model-vocab",
    async (req): Promise<ModelVocabDto> => {
      const compareFrom = compareFromSchema.parse(req.query.compareFrom || undefined);
      const versionIds = req.query.versions ? versionIdsSchema.parse(req.query.versions.split(",").filter(Boolean)) : undefined;
      const s = await scope(req.params.pid, req.params.vid, compareFrom, req.user!, versionIds);
      const vocab = s.vocab;
      const lang = requestLanguage(req);
      // The index caches its vocabulary once; class labels are in the reader's language.
      const classes = vocab.classes.map((c) => ({ ...c, label: ifcClassLabel(c.name, lang) }));
      return { versionId: s.v.version.id, fileName: s.v.file.name, version: s.v.version.version, ...vocab, classes };
    },
  );

  /** Runs a structured query (no AI): the filter builder, edited chips, MCP and the Sor assistant. */
  api.post<{ Params: { pid: string; vid: string } }>("/projects/:pid/versions/:vid/model-query", async (req): Promise<ModelQueryResultDto> => {
    const body = z.object({ query: modelQuerySchema, compareFrom: compareFromSchema, versionIds: versionIdsSchema }).parse(req.body);
    const s = await scope(req.params.pid, req.params.vid, body.compareFrom, req.user!, body.versionIds);
    return executeModelQuery(s.candidates, body.query, { versionId: s.v.version.id, compareFrom: s.compareFrom }, requestLanguage(req));
  });

  /**
   * A question in plain Turkish. mode "rules": instant keyword answer. mode "auto": the project's
   * model writes the query (cached per versions + question); when AI is off or fails, the rules
   * answer comes back with aiError.
   */
  api.post<{ Params: { pid: string; vid: string } }>("/projects/:pid/versions/:vid/model-ask", async (req, reply): Promise<ModelAskResultDto> => {
    const t0 = Date.now();
    const body = z
      .object({
        question: z.string().trim().min(2).max(500),
        compareFrom: compareFromSchema,
        versionIds: versionIdsSchema,
        mode: z.enum(["auto", "rules"]).default("auto"),
        refresh: z.boolean().optional(),
        provider: z.enum(["project", "anthropic", "cursor"]).default("project"),
        model: z.string().trim().min(1).max(200).optional(),
      })
      .parse(req.body);
    const s = await scope(req.params.pid, req.params.vid, body.compareFrom, req.user!, body.versionIds);
    const lang = requestLanguage(req);
    const vocab = s.vocab;
    const run = (query: Parameters<typeof executeModelQuery>[1]) =>
      executeModelQuery(s.candidates, query, { versionId: s.v.version.id, compareFrom: s.compareFrom }, lang);
    const rules = (aiError?: string): ModelAskResultDto => ({
      ...run(rulesQuery(body.question, vocab, { comparing: !!s.compareFrom })),
      question: body.question,
      source: "rules",
      ...(aiError ? { aiError } : {}),
      ms: Date.now() - t0,
    });
    if (body.mode === "rules") return rules();

    const key = `${questionKey(s.versionKey, s.compareFrom, body.question)}|${body.provider}|${body.model ?? ""}`;
    const hit = body.refresh ? undefined : queryCache.get(key);
    if (hit) return { ...run(hit.query), question: body.question, source: "ai", model: hit.model, cached: true, ms: Date.now() - t0 };

    let provider;
    try {
      provider =
        (await resolveSelectedProvider(
          db,
          (deps as ResolvedDeps).secretKey,
          s.v.a.project.id,
          s.v.a.user.id,
          body.provider,
          body.model,
        )) ?? (await resolveProvider(db, (deps as ResolvedDeps).secretKey, s.v.a.project.id, body.model));
    } catch (e) {
      if (e instanceof AiError) return rules(e.msg ? render(lang, e.msg) : e.message);
      throw e;
    }
    const ac = abortOnClose(reply);
    try {
      const ai = await aiQuery(provider, body.question, vocab, { comparing: !!s.compareFrom, signal: ac.signal });
      queryCache.set(key, ai);
      await audit(db, {
        projectId: s.v.a.project.id,
        userId: s.v.a.user.id,
        action: "ai.model_query",
        targetType: "file_version",
        targetId: s.v.version.id,
        details: {
          question: body.question.slice(0, 200),
          compareFrom: s.compareFrom ?? null,
          provider: provider.name,
          providerSelection: body.provider,
          model: ai.model,
        },
      });
      return { ...run(ai.query), question: body.question, source: "ai", model: ai.model, ms: Date.now() - t0 };
    } catch (e) {
      return rules((e instanceof ModelAiError || e instanceof HttpError) && e.msg ? render(lang, e.msg) : (e as Error).message);
    } finally {
      ac.done();
    }
  });

  /** Report panel draft for a query; the client saves it as a personal dashboard (POST /reports). */
  api.post<{ Params: { pid: string; vid: string } }>("/projects/:pid/versions/:vid/model-query/report-draft", async (req): Promise<ReportDraft> => {
    const body = z
      .object({ query: modelQuerySchema, question: z.string().max(500).nullish(), name: z.string().max(200).nullish(), compareFrom: compareFromSchema })
      .parse(req.body);
    if (body.compareFrom) throw badRequest(msg("model:errors.compareNotReport"));
    const v = await ifcVersion(db, req.params.pid, req.params.vid, req.user!);
    return modelReportDraft({ fileId: v.file.id, fileName: v.file.name, query: body.query, question: body.question, name: body.name, lang: requestLanguage(req) });
  });
}
