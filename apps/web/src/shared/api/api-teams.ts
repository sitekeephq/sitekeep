/** API client for ISO 19650 task teams (docs/features/TASK_TEAMS.md). Teams are project roles of kind 'task_team'. */
import type { FolderDto, ProjectRoleDto } from "@sitekeep/shared";
import { request } from "./client";

export interface TaskTeamInput {
  name: string;
  description?: string | null;
  companyId?: string | null;
  code?: string | null;
  isLead?: boolean;
}

export const teamsApi = {
  create: (pid: string, t: TaskTeamInput) => request<ProjectRoleDto>("POST", `/projects/${pid}/roles`, { ...t, kind: "task_team" }),
  update: (pid: string, rid: string, t: Partial<TaskTeamInput>) => request<ProjectRoleDto>("PATCH", `/projects/${pid}/roles/${rid}`, t),
  remove: (pid: string, rid: string) => request<{ ok: true; removedGrants: number }>("DELETE", `/projects/${pid}/roles/${rid}`),
  addMember: (pid: string, rid: string, uid: string) => request<ProjectRoleDto>("POST", `/projects/${pid}/roles/${rid}/members/${uid}`),
  removeMember: (pid: string, rid: string, uid: string) => request<ProjectRoleDto>("DELETE", `/projects/${pid}/roles/${rid}/members/${uid}`),
  /** A team for every company in the project that has none; owner teams on WIP folders made from template slots. */
  seed: (pid: string) => request<{ created: number; foldersOwned: number }>("POST", `/projects/${pid}/cde/teams/seed`, {}),
  setOwnerTeam: (pid: string, fid: string, teamId: string | null) =>
    request<FolderDto>("PUT", `/projects/${pid}/folders/${fid}/owner-team`, { teamId }),
};
