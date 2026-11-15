import { useTranslation } from "react-i18next";
import { ApiError } from "../../../shared/api/client";
import { useAsk } from "../../../shared/ui/Ask";

/**
 * Exception grants on a task team's WIP folder (ISO-5, D-3): the server answers
 * "wip_reason_required" when a grant reaches someone outside the owning team; this asks for the
 * reason and sends the request again with it. Returns null when the person cancels.
 */
export function useWipReason() {
  const { t } = useTranslation("cde");
  const { prompt } = useAsk();
  return async function withWipReason<T>(send: (reason?: string) => Promise<T>): Promise<T | null> {
    try {
      return await send();
    } catch (e) {
      const body = e instanceof ApiError ? (e.body as { error?: string; details?: { teamName?: string } } | null) : null;
      if (body?.error !== "wip_reason_required") throw e;
      const reason = await prompt({
        title: t("teams.reason.title"),
        message: t("teams.reason.message", { team: body.details?.teamName ?? "" }),
        confirmLabel: t("teams.reason.confirm"),
      });
      if (!reason?.trim()) return null;
      return send(reason.trim());
    }
  };
}
