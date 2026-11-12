import type { WorkCategory, WorkTone } from "./work-catalog.js";

/** Leaf list-card contract shared by work details and build-work extensions. */
export interface WorkSummaryDto {
  id: string;
  projectId: string;
  typeId: string;
  typeKey: string;
  typeName: string;
  category: WorkCategory;
  number: string;
  title: string;
  status: string;
  statusLabel: string;
  statusTone: WorkTone;
  closed: boolean;
  fromCompanyId: string | null;
  toCompanyIds: string[];
  ccCompanyIds: string[];
  assigneeUserId: string | null;
  dueDate: string | null;
  replyRequired: boolean;
  overdue: boolean;
  createdBy: string;
  createdByName?: string;
  createdAt: string;
  updatedAt: string;
  sentAt: string | null;
  /** Parent package or meeting. */
  parentWorkId?: string | null;
}
