/** `t()` keys are typed from the English files: a key missing in English is a compile error. */
import "i18next";
import type { en } from "./resources";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace SiteKeep {
    /**
     * Namespaces a module brings (`<package>/locales/web/en/<namespace>.json`), added by the
     * module's own declaration: `declare global { namespace SiteKeep { interface WebResources { contracts: typeof contracts } } }`.
     */
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    interface WebResources {}
    /** Enum label tables a module brings (`<package>/locales/shared/en/labels.json`): useLabel("<table>", key). */
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    interface LabelTables {}
  }
}

declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "common";
    resources: typeof en & SiteKeep.WebResources;
  }
}
