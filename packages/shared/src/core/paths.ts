/**
 * App path of a project page: `/projects/<id>/<rest>` (rest may carry a query, e.g.
 * `works?due=overdue`). Every server, MCP and web link to a project page is built here; the old
 * `/p/<id>/…` form is only a redirect for links already sent out.
 */
export function projectPath(projectId: string, rest = ""): string {
  const tail = rest.replace(/^\/+/, "");
  return tail ? `/projects/${projectId}/${tail}` : `/projects/${projectId}`;
}
