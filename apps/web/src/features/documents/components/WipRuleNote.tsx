import { useTranslation } from "react-i18next";
import type { WhoCanSeeDto } from "@sitekeep/shared";

/**
 * "Who can see" → the WIP team rule (ISO-5): when the folder is a task team's work in progress
 * under the "owning task team only" policy, says so above the list.
 */
export function WipRuleNote({ data }: { data: WhoCanSeeDto }) {
  const { t } = useTranslation("cde");
  const rule = data.entries.flatMap((e) => e.reasons).find((r) => r.via === "task_team_wip");
  if (!rule) return null;
  return (
    <p className="notice small" data-testid="wip-rule-note">
      {t("teams.whoCanSee.note", { team: rule.subjectName ?? "", folder: rule.folderName ?? "" })}
    </p>
  );
}
