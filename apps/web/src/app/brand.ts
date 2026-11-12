/**
 * Product name and edition (docs/brand/README.md, docs/MIMARI.md §1). The edition follows the modules
 * the server runs (app/modules.ts): none is SiteKeep Community, any is SiteKeep Enterprise. Read at
 * render time, after the modules are known. Product names are not translated.
 */
import { webModules } from "./modules";

export const PRODUCT_NAME = "SiteKeep";
export type Edition = "Community" | "Enterprise";
export const edition = (): Edition => (webModules.length ? "Enterprise" : "Community");
export const editionName = (): string => `${PRODUCT_NAME} ${edition()}`;
