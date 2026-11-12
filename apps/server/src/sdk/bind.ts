/**
 * Binds the core's SDK for modules (@7dimensions-project/sitekeep-sdk/server reads it). Imported
 * by app/modules.ts before any module is loaded.
 */
import * as shared from "@sitekeep/shared";
import * as sdk from "./index.js";

(globalThis as Record<symbol, unknown>)[Symbol.for("sitekeep.sdk.server")] = sdk;
// Modules import packages/shared through the SDK too (@7dimensions-project/sitekeep-sdk/shared).
(globalThis as Record<symbol, unknown>)[Symbol.for("sitekeep.sdk.shared")] = shared;
