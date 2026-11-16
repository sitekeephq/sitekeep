/**
 * The outbound helpers as modules get them (SDK): the same registry calls as the core's
 * (privacy/outbound.ts), but a module must name a connection the Privacy Centre lists, i.e. one it
 * declared with registerPrivacyConnection() (or a core connection such as "ai:<providerId>", "ai:env",
 * "smtp"). A call without one, or with an undeclared one, is refused before connecting, so nothing
 * leaves the server that the administrator cannot see and switch off on its own.
 */
import { knownConnectionId } from "../privacy/connections.js";
import { outboundCall as coreOutboundCall, outboundFetch as coreOutboundFetch, type OutboundMeta } from "../privacy/outbound.js";

export class UndeclaredConnectionError extends Error {
  constructor(connection: string | null | undefined, purpose: string) {
    super(
      connection
        ? `Outbound connection "${connection}" (${purpose}) is not declared: call registerPrivacyConnection({ id: "${connection}", … }) when the module loads (docs/modules/README.md → Outbound connections).`
        : `Outbound call "${purpose}" names no connection: pass { connection: "<id>" } declared with registerPrivacyConnection() (docs/modules/README.md → Outbound connections).`,
    );
    this.name = "UndeclaredConnectionError";
  }
}

function requireDeclared(purpose: string, connection: string | null | undefined): void {
  if (!knownConnectionId(connection)) throw new UndeclaredConnectionError(connection, purpose);
}

/** fetch() through the registry, for modules: `meta.connection` must be a declared connection. */
export function moduleOutboundFetch(purpose: string, url: string | URL, init: RequestInit = {}, meta: OutboundMeta = {}): Promise<Response> {
  try {
    requireDeclared(purpose, meta.connection);
  } catch (e) {
    return Promise.reject(e);
  }
  return coreOutboundFetch(purpose, url, init, meta);
}

/** Any other protocol through the registry, for modules: `meta.connection` must be a declared connection. */
export function moduleOutboundCall<T>(
  purpose: string,
  target: string,
  meta: OutboundMeta & { method?: string; bytesOut?: number | null },
  fn: () => Promise<T>,
  measure?: (result: T) => { bytesOut?: number | null; bytesIn?: number | null; status?: number | null },
): Promise<T> {
  try {
    requireDeclared(purpose, meta.connection);
  } catch (e) {
    return Promise.reject(e);
  }
  return coreOutboundCall(purpose, target, meta, fn, measure);
}
