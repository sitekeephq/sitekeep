/**
 * Texts of audit log rows (docs/features/AUDIT_LOG.md): the action's label (projectSettings
 * activity.events.*, the action itself when unknown) and a one-line summary of its details.
 */
import type { AuditEntryDto } from "@sitekeep/shared";
import { i18n } from "../../i18n";

export function auditActionLabel(action: string): string {
  return i18n.t(`projectSettings:activity.events.${action}` as never, { defaultValue: action }) as string;
}

const SUMMARY_KEYS = ["tool", "name", "title", "number", "version", "email", "count"];

export function auditSummary(e: Pick<AuditEntryDto, "action" | "details" | "targetName">): string {
  const d = e.details;
  if (e.action === "cde.transition" && d) {
    const state = (s: unknown) => (s ? (i18n.t(`cde:states.${String(s)}` as never, { defaultValue: String(s) }) as string) : "—");
    const mode = i18n.t(`cde:modes.${String(d.mode)}` as never, { defaultValue: String(d.mode ?? "") }) as string;
    return [e.targetName, `${state(d.fromState)} → ${state(d.toState)}`, mode, d.reason ? String(d.reason) : null].filter(Boolean).join(" · ");
  }
  // ISO-12: the archive copy names what replaced it, the new publication what it replaced.
  if ((e.action === "cde.superseded" || e.action === "review.file_copied") && d && (d.supersededBy || d.supersedes)) {
    const ref = (x: unknown) => {
      const r = x as { name?: unknown; version?: unknown; revisionCode?: unknown };
      return [`${String(r.name ?? "?")} V${String(r.version ?? "?")}`, r.revisionCode ? String(r.revisionCode) : null].filter(Boolean).join(" · ");
    };
    const own = [e.targetName ?? (d.name !== undefined ? String(d.name) : null), d.version !== undefined ? `version: ${String(d.version)}` : null];
    const link = d.supersededBy
      ? i18n.t("cde:supersession.summaryBy", { target: ref(d.supersededBy) })
      : i18n.t("cde:supersession.summarySupersedes", { target: (d.supersedes as unknown[]).map(ref).join(", ") });
    return [...own, link].filter(Boolean).join(" · ");
  }
  if (e.action === "file.viewed" && d) {
    const kind = i18n.t(`cde:audit.viewKinds.${String(d.kind)}` as never, { defaultValue: String(d.kind ?? "") }) as string;
    return [e.targetName, kind].filter(Boolean).join(" · ");
  }
  const parts: string[] = [];
  if (e.targetName && d?.name === undefined) parts.push(e.targetName);
  if (d) for (const k of SUMMARY_KEYS) if (d[k] !== undefined) parts.push(`${k}: ${String(d[k])}`);
  if (parts.length || !d) return parts.join(" · ");
  return JSON.stringify(d).slice(0, 200);
}
