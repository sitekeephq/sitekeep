/**
 * Unit tests run in Turkish: their expectations were written against the Turkish interface.
 * A test about another language switches with setLanguage() and switches back.
 */
// Module code (packages/ee-*) reads the web core's SDK from globalThis.
import "../src/sdk/bind";
import { initI18n, setLanguage } from "../src/i18n";
import { bundledModules } from "virtual:sitekeep-modules";
import { enableModules } from "../src/app/modules";

// Every bundled module on, as the app does when the server runs them all (app/modules.ts).
enableModules(bundledModules.map((m) => m.id));
await initI18n();
await setLanguage("tr", { persist: false });
