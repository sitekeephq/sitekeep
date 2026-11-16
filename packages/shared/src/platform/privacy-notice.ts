/**
 * Privacy notice on the sign-in page ("aydınlatma metni", docs/features/PRIVACY_NOTICE.md): text the
 * system administrator writes in English and Turkish (light markdown), shown on the sign-in and the
 * invitation pages, with an optional "I have read it" checkbox whose acceptance is recorded.
 */

/** Longest notice text per language, characters. */
export const PRIVACY_NOTICE_MAX_LENGTH = 20_000;

export interface PrivacyNoticeTexts {
  en: string;
  tr: string;
}

export interface PrivacyNoticeSettings {
  /** Shown on the sign-in and invitation pages. */
  enabled: boolean;
  /** People must tick "I have read it" before they sign in or accept an invitation; the acceptance is recorded. */
  requireAck: boolean;
  /** A new version (changed text) is asked again of people who accepted an earlier one. */
  reaskOnChange: boolean;
  text: PrivacyNoticeTexts;
}

/** Administration → Privacy Centre → Privacy Notice. */
export interface PrivacyNoticeAdminDto extends PrivacyNoticeSettings {
  /** Goes up by one each time the text changes (0: never written). */
  version: number;
  updatedAt: string | null;
  updatedByName: string | null;
  /** People who accepted the current version. */
  acceptedCurrent: number;
}

/** What the signed-out sign-in and invitation pages get (GET /auth/privacy-notice). */
export interface PrivacyNoticePublicDto {
  enabled: boolean;
  requireAck: boolean;
  version: number;
  text: PrivacyNoticeTexts;
}

export const PRIVACY_NOTICE_DEFAULTS: PrivacyNoticeSettings = {
  enabled: false,
  requireAck: false,
  reaskOnChange: true,
  text: { en: "", tr: "" },
};

/** The text in `language`, or the other language when that one is empty. */
export function privacyNoticeText(text: PrivacyNoticeTexts, language: string): string {
  const own = language.toLowerCase().startsWith("tr") ? text.tr : text.en;
  return own.trim() ? own : (text.en.trim() ? text.en : text.tr);
}
