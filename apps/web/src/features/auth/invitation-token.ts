/**
 * The token of an invitation link (/invite#<token>): everything after "#". The fragment never
 * reaches the server, so the token is not in request logs or referrers.
 */
export function invitationToken(hash: string): string {
  try {
    return decodeURIComponent(hash.replace(/^#/, "").replace(/^token=/, "")).trim();
  } catch {
    return "";
  }
}
