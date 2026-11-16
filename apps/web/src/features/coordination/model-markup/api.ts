/** API client for model markups (docs/features/MODEL_MARKUP.md). */
import type {
  IssuePriority,
  MarkupShape,
  ModelMarkupCommentDto,
  ModelMarkupDetailDto,
  ModelMarkupDto,
  ModelMarkupInput,
  ModelMarkupListDto,
  ModelMarkupStatus,
  ModelMarkupVisibility,
} from "@sitekeep/shared";
import { del, get, patch, post, qs } from "../../../shared/api/client";

export const modelMarkupApi = {
  list: (pid: string, versionIds: string[]) => get<ModelMarkupListDto>(`/projects/${pid}/model-markups${qs({ versions: versionIds.join(",") })}`),
  get: (pid: string, id: string) => get<ModelMarkupDetailDto>(`/projects/${pid}/model-markups/${id}`),
  create: (pid: string, body: ModelMarkupInput) => post<ModelMarkupDto>(`/projects/${pid}/model-markups`, body),
  update: (
    pid: string,
    id: string,
    body: { title?: string; color?: string; status?: ModelMarkupStatus; visibility?: ModelMarkupVisibility; shapes?: MarkupShape[] },
  ) => patch<ModelMarkupDto>(`/projects/${pid}/model-markups/${id}`, body),
  remove: (pid: string, id: string) => del<{ ok: boolean }>(`/projects/${pid}/model-markups/${id}`),
  comment: (pid: string, id: string, body: string) => post<ModelMarkupCommentDto>(`/projects/${pid}/model-markups/${id}/comments`, { body }),
  carryOver: (pid: string, id: string, versionId: string) =>
    post<{ markup: ModelMarkupDto; existing: boolean }>(`/projects/${pid}/model-markups/${id}/carry-over`, { versionId }),
  toIssue: (pid: string, id: string, body: { title: string; description?: string | null; priority?: IssuePriority }) =>
    post<{ markup: ModelMarkupDto; issue: { id: string; number: number } }>(`/projects/${pid}/model-markups/${id}/issue`, body),
};
