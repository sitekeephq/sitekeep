import { and, asc, count, eq, isNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppDeps } from "../../app/deps.js";
import { projectAccess } from "../../core/security/access.js";
import { externalDocuments, externalDocumentSources } from "../../db/schema.js";
import { notFound } from "../../core/platform/http.js";
import { msg } from "../../i18n/index.js";

export async function externalDocumentRoutes(api: FastifyInstance, { db }: AppDeps): Promise<void> {
  api.get<{ Params: { pid: string } }>("/projects/:pid/external-documents/sources", async (req) => {
    const access = await projectAccess(db, req.params.pid, req.user!);
    const sources = await db
      .select()
      .from(externalDocumentSources)
      .where(eq(externalDocumentSources.projectId, access.project.id))
      .orderBy(asc(externalDocumentSources.name));

    return Promise.all(
      sources.map(async (source) => {
        const [folders] = await db
          .select({ value: count() })
          .from(externalDocuments)
          .where(and(eq(externalDocuments.sourceId, source.id), eq(externalDocuments.kind, "folder")));
        const [files] = await db
          .select({ value: count() })
          .from(externalDocuments)
          .where(and(eq(externalDocuments.sourceId, source.id), eq(externalDocuments.kind, "file")));
        return { ...source, counts: { folders: folders?.value ?? 0, files: files?.value ?? 0 } };
      }),
    );
  });

  api.get<{ Params: { pid: string; sid: string } }>(
    "/projects/:pid/external-documents/sources/:sid/contents",
    async (req) => {
      const access = await projectAccess(db, req.params.pid, req.user!);
      const query = z.object({ parentId: z.string().min(1).max(2048).optional() }).parse(req.query);
      const [source] = await db
        .select()
        .from(externalDocumentSources)
        .where(
          and(
            eq(externalDocumentSources.id, req.params.sid),
            eq(externalDocumentSources.projectId, access.project.id),
          ),
        );
      if (!source) throw notFound(msg("documents:entities.externalSource"));

      const parentCondition = query.parentId
        ? eq(externalDocuments.parentExternalId, query.parentId)
        : isNull(externalDocuments.parentExternalId);
      const entries = await db
        .select()
        .from(externalDocuments)
        .where(and(eq(externalDocuments.sourceId, source.id), parentCondition))
        .orderBy(asc(externalDocuments.kind), asc(externalDocuments.name));
      const current = query.parentId
        ? (
            await db
              .select()
              .from(externalDocuments)
              .where(
                and(
                  eq(externalDocuments.sourceId, source.id),
                  eq(externalDocuments.externalId, query.parentId),
                  eq(externalDocuments.kind, "folder"),
                ),
              )
          )[0]
        : null;
      if (query.parentId && !current) throw notFound(msg("documents:entities.externalFolder"));
      return { source, current, entries };
    },
  );
}
