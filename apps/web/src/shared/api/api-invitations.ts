/** API client for invitations of people without an account (docs/features/INVITATIONS.md). */
import type {
  InvitationDeliveryDto,
  InvitationInfoDto,
  InvitationLanguage,
  InvitationListDto,
  InvitationSettings,
  InviteRequest,
  InviteResultDto,
  TwoFactorChallengeDto,
  UserDto,
} from "@sitekeep/shared";
import { request } from "./client";

export const invitationsApi = {
  list: (pid: string) => request<InvitationListDto>("GET", `/projects/${pid}/invitations`),
  invite: (pid: string, body: InviteRequest) => request<InviteResultDto>("POST", `/projects/${pid}/invitations`, body),
  resend: (pid: string, id: string, language?: InvitationLanguage) =>
    request<InvitationDeliveryDto>("POST", `/projects/${pid}/invitations/${id}/resend`, language ? { language } : {}),
  revoke: (pid: string, id: string) => request<{ ok: true }>("DELETE", `/projects/${pid}/invitations/${id}`),
  settings: () => request<InvitationSettings>("GET", "/admin/invitations"),
  updateSettings: (s: InvitationSettings) => request<InvitationSettings>("PUT", "/admin/invitations", s),
  /** Accept page (signed out): the token comes from the link's fragment. */
  lookup: (token: string) => request<InvitationInfoDto>("POST", "/invitations/lookup", { token }),
  /** The user, or { twoFactor: "enrol" } when the administrator requires two-factor for everyone. */
  accept: (token: string, name: string, password: string, privacyNoticeVersion?: number) =>
    request<UserDto | TwoFactorChallengeDto>("POST", "/invitations/accept", { token, name, password, ...(privacyNoticeVersion && { privacyNoticeVersion }) }),
  /** Remembers the invitation for the Google callback; then the browser goes to `url`. */
  google: (token: string, privacyNoticeVersion?: number) =>
    request<{ url: string }>("POST", "/invitations/google", { token, ...(privacyNoticeVersion && { privacyNoticeVersion }) }),
  /** Set-up wizard: a CSV or Excel file of people as a table (first row: the header). */
  peopleFile: (fileName: string, content: string) => request<{ table: string[][] }>("POST", "/projects/setup/people-file", { fileName, content }),
};
