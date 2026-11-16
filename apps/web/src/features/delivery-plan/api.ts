/** API client for the ISO 19650 delivery plan (TIDP / MIDP, docs/features/DELIVERY_PLAN.md). */
import type {
  DeliverableDto,
  DeliverableInput,
  DeliveryMilestoneDto,
  DeliveryMilestoneInput,
  DeliveryPlanDto,
  DeliveryPlanImportReportDto,
} from "@sitekeep/shared";
import { del, get, patch, post, put, qs } from "../../shared/api/client";

const base = (pid: string) => `/projects/${pid}/delivery-plan`;

export const deliveryPlanApi = {
  plan: (pid: string, teamId?: string | null) => get<DeliveryPlanDto>(`${base(pid)}${qs({ teamId: teamId || undefined })}`),
  addMilestone: (pid: string, body: DeliveryMilestoneInput) => post<DeliveryMilestoneDto>(`${base(pid)}/milestones`, body),
  updateMilestone: (pid: string, mid: string, body: Partial<DeliveryMilestoneInput>) => patch<DeliveryMilestoneDto>(`${base(pid)}/milestones/${mid}`, body),
  deleteMilestone: (pid: string, mid: string) => del<{ ok: true }>(`${base(pid)}/milestones/${mid}`),
  setLead: (pid: string, teamId: string, userId: string | null) => put<{ teamId: string; userId: string | null }>(`${base(pid)}/teams/${teamId}/lead`, { userId }),
  addDeliverable: (pid: string, body: DeliverableInput) => post<DeliverableDto>(`${base(pid)}/deliverables`, body),
  updateDeliverable: (pid: string, id: string, body: Partial<DeliverableInput>) => patch<DeliverableDto>(`${base(pid)}/deliverables/${id}`, body),
  deleteDeliverable: (pid: string, id: string) => del<{ ok: true }>(`${base(pid)}/deliverables/${id}`),
  importFile: (pid: string, body: { fileName: string; content: string; teamId?: string | null; dryRun?: boolean }) =>
    post<DeliveryPlanImportReportDto>(`${base(pid)}/import`, body),
  exportUrl: (pid: string, format: "xlsx" | "csv", teamId?: string | null) =>
    `/api/v1${base(pid)}/export${qs({ format, teamId: teamId || undefined })}`,
};
