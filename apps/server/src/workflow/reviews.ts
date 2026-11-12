/**
 * Compatibility facade for document review workflows.
 *
 * Keep external imports on this module while the implementation remains split by concern.
 */
export {
  SUBJECT_REVIEW,
  reviewLabel,
  reviewLink,
  type ApprovalRow,
  type CopyReport,
  type InstanceRow,
  type ReviewCtx,
  type ReviewRow,
  type SubmitInput,
} from "./review-types.js";
export {
  prepareReview,
  previewReview,
  startReview,
  type PreparedReview,
  type StartReviewInput,
} from "./review-start.js";
export { submitStep } from "./review-engine.js";
export { copyApprovedFiles } from "./review-finalization.js";
export { cancelReview, loadInstance, reassignStep } from "./review-lifecycle.js";
export { approvalHistory, latestApprovals } from "./review-approvals.js";
