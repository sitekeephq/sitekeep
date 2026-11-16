/**
 * Sign-in with Google as an outbound connection (Gizlilik Merkezi → Dış Bağlantılar, id "google").
 * The server exchanges the code at GOOGLE_TOKEN_URL and reads the profile at GOOGLE_USERINFO_URL;
 * the browser itself goes to accounts.google.com. When the connection is switched off (or all
 * external connections are), the sign-in page hides the Google button and every step of the flow
 * is refused (auth/routes.ts, auth/invitation-routes.ts).
 */
import type { Db } from "../db/index.js";
import type { Msg } from "../i18n/index.js";
import { outboundRefusalMsg } from "../privacy/outbound.js";
import { refreshPrivacyState } from "../privacy/settings.js";

export const GOOGLE_CONNECTION = "google";
export const GOOGLE_PURPOSE = "giris:google";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";
/** The hosts the server calls (shown in the Privacy Centre). */
export const GOOGLE_HOSTS = [new URL(GOOGLE_TOKEN_URL).host, new URL(GOOGLE_USERINFO_URL).host];

/** Why Google sign-in is refused right now (connection off, kill switch), or null. */
export async function googleSignInRefusal(db: Db): Promise<Msg | null> {
  await refreshPrivacyState(db);
  return outboundRefusalMsg(GOOGLE_TOKEN_URL, GOOGLE_CONNECTION, GOOGLE_PURPOSE);
}
