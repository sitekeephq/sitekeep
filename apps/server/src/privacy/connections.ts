/**
 * Which outbound connections exist (Gizlilik Merkezi → Dış Bağlantılar). Every `connection` id an
 * outboundFetch()/outboundCall() passes has an entry here, so the Privacy Centre lists it and it can be
 * switched off on its own (test/auth/privacy-connections.test.ts fails otherwise):
 *
 *   - the core's own connections (CORE_CONNECTIONS): SMTP, office editor/converter, the report model
 *     (ai:env), sign-in with Google, one "ai:<providerId>" per configured AI provider and one
 *     "oidc:<providerId>" per OpenID Connect sign-in provider (auth/oidc.ts);
 *   - connections a module declares with registerPrivacyConnection() (SDK) while it loads, e.g. the
 *     Connect module's Autodesk APS/ACC sync. The SDK's outboundFetch()/outboundCall() refuse a
 *     module call whose connection is not declared (sdk/privacy.ts).
 *
 * A module that is off (licence) hides its connections from the list, like its datasets and
 * capabilities (app/module-owner.ts); its switch setting stays.
 */
import { loadingModule } from "../app/module-owner.js";
import { moduleIds } from "../app/module-ids.js";
import type { Msg } from "../i18n/index.js";

/** A connection a module makes to another host (SDK: registerPrivacyConnection). */
export interface PrivacyConnectionDef {
  /** The `connection` id its outboundFetch()/outboundCall() calls pass: "autodesk". Lower case, digits, ":", "_", "-". */
  id: string;
  /** Shown in the list: a text key of the module's locales (msg("connect:privacy.autodesk")) or plain text. */
  name: Msg | string;
  /** One line on what is sent and why (shown under the name). */
  description?: Msg | string;
  /** The hosts it connects to ("developer.api.autodesk.com", "*.amazonaws.com"). */
  hosts: string[];
  /** Off until an administrator turns it on (default true: on). */
  defaultEnabled?: boolean;
}

export interface RegisteredPrivacyConnection extends PrivacyConnectionDef {
  /** The module that declared it; null for the core. */
  module: string | null;
}

/** Connection ids the core uses itself (listed by privacy/routes.ts with their live configuration). */
export const CORE_CONNECTIONS = ["ai:env", "smtp", "office:editor", "office:converter", "google"] as const;

/** "ai:<providerId>": one per AI provider configured under Administration → AI (listed per provider). */
export const AI_PROVIDER_CONNECTION = /^ai:[^:]+$/;

/** "oidc:<providerId>": one per OpenID Connect provider under Administration → Sign-in Security. */
export const OIDC_PROVIDER_CONNECTION = /^oidc:[^:]+$/;

const ID = /^[a-z][a-z0-9_:-]{0,79}$/;
const registered = new Map<string, RegisteredPrivacyConnection>();

/**
 * Declares an outbound connection of a module (SDK). Call it at the top level of the module's server
 * entry, so it is attributed to the module while it loads. Registering the same id again replaces it.
 */
export function registerPrivacyConnection(def: PrivacyConnectionDef): void {
  if (!def || typeof def.id !== "string" || !ID.test(def.id)) throw new Error(`registerPrivacyConnection: invalid id ${JSON.stringify(def?.id)}`);
  if ((CORE_CONNECTIONS as readonly string[]).includes(def.id) || AI_PROVIDER_CONNECTION.test(def.id) || OIDC_PROVIDER_CONNECTION.test(def.id))
    throw new Error(`registerPrivacyConnection: "${def.id}" is a connection of the core`);
  if (!def.name) throw new Error(`registerPrivacyConnection: "${def.id}" needs a name`);
  if (!Array.isArray(def.hosts) || !def.hosts.length || def.hosts.some((h) => typeof h !== "string" || !h.trim()))
    throw new Error(`registerPrivacyConnection: "${def.id}" needs its hosts`);
  registered.set(def.id, {
    id: def.id,
    name: def.name,
    description: def.description,
    hosts: def.hosts.map((h) => h.trim().toLowerCase()),
    defaultEnabled: def.defaultEnabled !== false,
    module: loadingModule(),
  });
}

/** Registers on behalf of a module (privacy/legacy-connections.ts) unless the module declared the id itself. */
export function registerPrivacyConnectionFor(module: string, def: PrivacyConnectionDef): void {
  if (registered.has(def.id)) return;
  registerPrivacyConnection(def);
  registered.get(def.id)!.module = module;
}

/** Declared connections, in registration order; `all` includes those of modules that are off. */
export function privacyConnections(opts: { all?: boolean } = {}): RegisteredPrivacyConnection[] {
  const list = [...registered.values()];
  if (opts.all) return list;
  const on = moduleIds();
  return list.filter((c) => !c.module || on.includes(c.module));
}

/** The declared connection with this id (of a module that is on or off), or undefined. */
export function registeredConnection(id: string): RegisteredPrivacyConnection | undefined {
  return registered.get(id);
}

/** False when the connection is off until an administrator turns it on (settings.ts). */
export function connectionDefaultEnabled(id: string): boolean {
  return registered.get(id)?.defaultEnabled !== false;
}

/** The id has a place in the Privacy Centre list (a core connection, an AI provider id or a declared one). */
export function knownConnectionId(id: string | null | undefined): boolean {
  if (!id) return false;
  return (CORE_CONNECTIONS as readonly string[]).includes(id) || AI_PROVIDER_CONNECTION.test(id) || registered.has(id);
}

/** Tests only: forgets a declaration. */
export function unregisterPrivacyConnection(id: string): void {
  registered.delete(id);
}
