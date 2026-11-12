/** Attribution texts shown in "Hakkında" (Hesabım) and the model viewer's shortcut help. */

import { i18n } from "../../i18n";

/** The model viewer is built on That Open Company's open source components (MIT); their wordmark is off. */
export function viewerAboutText(): string {
  return i18n.t("shell:about.viewer");
}
