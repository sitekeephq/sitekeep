import { i18n } from "../i18n";
import type { MoreMenuItem } from "../shared/ui/MoreMenu";

export type ViewerMoreKey = "pin_issue" | "view_issue" | "four_d";

/**
 * Model viewer tools that move into "⋯ Diğer" on phones (≤ 700px); Modeller, Sığdır and Modele Sor
 * stay on the floating bar. Nothing to offer before a model is loaded.
 */
export function viewerMoreItems(loaded: boolean, fourD: boolean): MoreMenuItem<ViewerMoreKey>[] {
  if (!loaded) return [];
  return [
    { key: "pin_issue", label: `📍 ${i18n.t("viewers:modelMore.actions.pinIssue")}` },
    { key: "view_issue", label: `+ ${i18n.t("viewers:modelMore.actions.viewIssue")}` },
    { key: "four_d", label: `🗓 ${i18n.t("viewers:modelMore.actions.fourD")}`, checked: fourD },
  ];
}
