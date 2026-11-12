import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../../app/deps.js";
import { docsPlusRoutes } from "./docs-plus.js";
import { externalDocumentRoutes } from "./external.js";
import { fileRoutes } from "./files.js";
import { folderRoutes } from "./folders.js";

/** Registers the complete document-management HTTP surface. */
export async function documentRoutes(api: FastifyInstance, deps: AppDeps): Promise<void> {
  await folderRoutes(api, deps);
  await fileRoutes(api, deps);
  await docsPlusRoutes(api, deps);
  await externalDocumentRoutes(api, deps);
}
