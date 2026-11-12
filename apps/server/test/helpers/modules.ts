/** Installed modules for tests (SITEKEEP_MODULES, app/modules.ts): steps of a module run only when it is. */
import { moduleIds } from "../../src/app/modules.js";

export const installed = (id: string): boolean => moduleIds().includes(id);
export const hasField = installed("field");
export const hasCoordinate = installed("coordinate");
export const hasPlanning = installed("planning");
export const hasAi = installed("ai");
export const hasManage = installed("manage");
export const hasConnect = installed("connect");
export const hasCost = installed("cost");
