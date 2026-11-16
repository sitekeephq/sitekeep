/**
 * Outbound connections of module releases built before the SDK had registerPrivacyConnection()
 * (SDK < 0.15.0). The core declares them on the module's behalf after the module loads, so the
 * Privacy Centre lists them and their calls pass the SDK's declared-connection check. A module that
 * declares the id itself wins (registerPrivacyConnectionFor skips it). Remove an entry once every
 * supported release of that module declares its own connections.
 */
import { msg } from "../i18n/index.js";
import { registerPrivacyConnectionFor, type PrivacyConnectionDef } from "./connections.js";

const LEGACY: Record<string, PrivacyConnectionDef[]> = {
  // Connect (sitekeep-ee-connect <= 0.3.x): Autodesk APS / ACC record sync and file import.
  connect: [
    {
      id: "autodesk",
      name: msg("privacy:connections.autodesk"),
      description: msg("privacy:connections.autodeskSends"),
      // File content comes from short-lived signed addresses Autodesk hands out; the list adds the hosts the log saw.
      hosts: ["developer.api.autodesk.com"],
    },
  ],
  // AI (sitekeep-ee-ai <= 0.4.x): a user's own Claude API / Cursor key ("Kişisel yapay zekâ").
  ai: [
    {
      id: "ai:personal:anthropic",
      name: msg("privacy:connections.personalClaude"),
      description: msg("privacy:connections.personalAiSends"),
      hosts: ["api.anthropic.com"],
    },
    {
      id: "ai:personal:cursor",
      name: msg("privacy:connections.personalCursor"),
      description: msg("privacy:connections.personalAiSends"),
      hosts: ["api.cursor.com"],
    },
  ],
};

/** Declares the legacy connections of the loaded modules (app/modules.ts, after loading them). */
export function registerLegacyConnections(loadedModuleIds: readonly string[]): void {
  for (const id of loadedModuleIds) for (const def of LEGACY[id] ?? []) registerPrivacyConnectionFor(id, def);
}
