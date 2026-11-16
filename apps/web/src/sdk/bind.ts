/**
 * Binds the web core's SDK for modules (@sitekeephq/sitekeep-sdk/web reads it). Imported
 * by app/modules.ts before any module is loaded.
 */
import * as shared from "@sitekeep/shared";
import * as sdk from "./index";

(globalThis as Record<symbol, unknown>)[Symbol.for("sitekeep.sdk.web")] = sdk;
// Modules import packages/shared through the SDK too (@sitekeephq/sitekeep-sdk/shared).
(globalThis as Record<symbol, unknown>)[Symbol.for("sitekeep.sdk.shared")] = shared;
