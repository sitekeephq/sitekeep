import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../../app/deps.js";
import { attributeRoutes } from "./attributes.js";
import { savedSearchRoutes } from "./saved-searches.js";
import { searchRoutes } from "./search.js";
import { trashRoutes } from "./trash.js";
import { zipRoutes } from "./zip.js";

/** Docs depth (Sprint B): typed attributes, recycle bin, bulk zip download, search and saved searches. */
export async function docsPlusRoutes(api: FastifyInstance, deps: AppDeps) {
  await attributeRoutes(api, deps);
  await trashRoutes(api, deps);
  await zipRoutes(api, deps);
  await searchRoutes(api, deps);
  await savedSearchRoutes(api, deps);
}
