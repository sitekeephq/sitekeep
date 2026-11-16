/**
 * Invitations of people without an account (docs/features/INVITATIONS.md): the request and answer
 * shapes shared by the server, the web app and the API.
 */

/** Languages of the invitation e-mail and of the new account. */
export const INVITATION_LANGUAGES = ["en", "tr"] as const;
export type InvitationLanguage = (typeof INVITATION_LANGUAGES)[number];

/** An invitation link is valid this many days (a resend starts again). */
export const INVITATION_DAYS = 14;

/** open: can be accepted; expired: past its date (resend gives a new link); accepted / revoked: closed. */
export type InvitationStatus = "open" | "expired" | "accepted" | "revoked";

/** System setting "auth.invitations" (Administration → Users). */
export interface InvitationSettings {
  /** Project administrators may invite people without an account to their projects (default off). */
  projectAdminsMayInvite: boolean;
}

export const INVITATION_SETTINGS_DEFAULTS: InvitationSettings = { projectAdminsMayInvite: false };

/** `POST /projects/:pid/invitations`. */
export interface InviteRequest {
  email: string;
  /** Name shown until the person sets their own (default: the part before @). */
  name?: string;
  /** Company in the project; also the company of the new account. */
  companyId?: string | null;
  /** Project roles, task teams included. */
  roleIds?: string[];
  isProjectAdmin?: boolean;
  /** Language of the e-mail and the account; default the installation's language. */
  language?: InvitationLanguage;
}

/** How an invitation reached the person. */
export interface InvitationDeliveryDto {
  id: string;
  expiresAt: string;
  /** The e-mail was sent. */
  mailed: boolean;
  /** The link to hand over, when no e-mail was sent (no SMTP, e-mail switched off, or sending failed). */
  url?: string;
  /** Why no e-mail was sent: smtp_not_configured, smtp_disabled (Privacy Centre) or send_failed. */
  mailSkipped?: "smtp_not_configured" | "smtp_disabled" | "send_failed";
}

/** Answer of an invitation: an existing account is added at once, anyone else is invited. */
export interface InviteResultDto {
  status: "added" | "invited";
  userId: string;
  invitation?: InvitationDeliveryDto;
}

export interface InvitationDto {
  id: string;
  email: string;
  name: string;
  userId: string;
  projectId: string | null;
  companyId: string | null;
  companyName: string | null;
  roleIds: string[];
  isProjectAdmin: boolean;
  language: string;
  invitedByName: string | null;
  createdAt: string;
  expiresAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
  mailedAt: string | null;
  sendCount: number;
  status: InvitationStatus;
}

/** `GET /projects/:pid/invitations`. */
export interface InvitationListDto {
  /** The caller may invite in this project (system administrator, or project administrator when allowed). */
  canInvite: boolean;
  /** SMTP is configured (CDE_SMTP_URL) and switched on in the Privacy Centre. */
  mail: { configured: boolean; enabled: boolean };
  invitations: InvitationDto[];
}

/** `POST /invitations/lookup` (public, by token): what the accept page shows. */
export interface InvitationInfoDto {
  email: string;
  name: string;
  projects: { code: string; name: string }[];
  invitedBy: string | null;
  expiresAt: string;
  language: string;
  /** Google sign-in is configured: the person may accept with a Google account of the same address. */
  google: boolean;
}
