import type { FastifyInstance } from "fastify";
import type { ResolvedDeps } from "../../app/deps.js";
import { onWorkflowEvent } from "../../workflow/service.js";
import { autoTransmittalListener } from "../service.js";
import { createWorksRouteContext } from "./route-helpers.js";
import { registerWorkTypeRoutes } from "./work-types.js";
import { registerWorkItemRoutes } from "./work-items.js";
import { registerWorkLinkRoutes } from "./work-links.js";
import { registerWorkActionRoutes } from "./work-actions.js";
import { registerWorkTodayRoutes } from "./work-today.js";
import { workFlowRoutes } from "./work-flow.js";

/** Registers works endpoints in their historical order. */
export async function worksRoutes(api: FastifyInstance, deps: ResolvedDeps) {
  const routes = createWorksRouteContext(api, deps);

  // One listener per route plugin/database handle, removed with the plugin.
  const off = onWorkflowEvent(deps.db, autoTransmittalListener(routes.worksCtx));
  api.addHook("onClose", async () => off());

  registerWorkTypeRoutes(routes);
  registerWorkItemRoutes(routes);
  registerWorkLinkRoutes(routes);
  registerWorkActionRoutes(routes);
  registerWorkTodayRoutes(routes);
  await workFlowRoutes(api, deps);
}
