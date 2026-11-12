/**
 * Developer tools (cde_dev_*, /api/v1/dev/*) exist only on a development server: CDE_DEV_TOOLS=1
 * and NODE_ENV not "production". Production defaults never register them.
 */
export function devToolsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CDE_DEV_TOOLS === "1" && env.NODE_ENV !== "production";
}

/** Why the developer tools are off (Turkish, for the 404 / tool error). */
export function devToolsOffReason(env: NodeJS.ProcessEnv = process.env): string {
  if (env.NODE_ENV === "production") return "Geliştirici araçları üretim ortamında (NODE_ENV=production) çalışmaz.";
  return "Geliştirici araçları kapalı. Sunucuyu CDE_DEV_TOOLS=1 ile başlatın (apps/server/.env.development).";
}
