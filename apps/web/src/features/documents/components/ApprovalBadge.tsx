import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { OUTCOME_TONE, type ApprovalStatus, type VersionApprovalDto } from "@sitekeep/shared";
import { useLabel } from "../../../i18n";

export function approvalTone(status: ApprovalStatus): string {
  return status === "in_review" ? "warn" : OUTCOME_TONE[status];
}

/** Approval status of a file version, linking to the review that set it. */
export function ApprovalBadge({ projectId, approval }: { projectId: string; approval: VersionApprovalDto | undefined }) {
  const { t } = useTranslation(["documents", "common"]);
  const label = useLabel();
  if (!approval) return null;
  const title =
    t(approval.isCopy ? "approval.titleCopy" : "approval.title", { number: approval.reviewNumber, name: approval.reviewName }) +
    (approval.chainFull ? `
${approval.chainFull}` : "");
  return (
    <Link
      to={`/projects/${projectId}/reviews/${approval.reviewId}`}
      className={`badge ${approvalTone(approval.status)}`}
      title={title}
      onClick={(e) => e.stopPropagation()}
    >
      {approval.label ?? label("approvalStatus", approval.status)}
      {approval.chain && (
        <span className="mono" style={{ marginLeft: 6, opacity: 0.8 }}>
          {approval.chain}
        </span>
      )}
    </Link>
  );
}
