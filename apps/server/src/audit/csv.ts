/**
 * The audit log as CSV (docs/features/AUDIT_LOG.md#api): the download routes and the close-out
 * archive (closeout/build.ts) share it. `;` separated, UTF-8 with BOM, CRLF.
 */
import type { SQL } from "drizzle-orm";
import type { Principal } from "@sitekeep/shared";
import type { Db } from "../db/index.js";
import type { FolderTree } from "../core/security/access.js";
import type { tFor } from "../i18n/index.js";
import { CSV_BOM, csvLine } from "../docintel/export.js";
import { auditRows, toAuditDtos } from "./query.js";

const COLUMNS = ["id", "time", "project", "user", "action", "targetType", "targetId", "target", "ip", "userAgent", "details", "hash"] as const;

/**
 * Every row of a query as CSV lines, newest first. `client: false` leaves out the IP address and
 * user agent columns (personal data with its own retention period; the close-out archive keeps none).
 */
export async function* auditCsvLines(
  db: Db,
  where: SQL | undefined,
  t: ReturnType<typeof tFor>,
  opts: { client: boolean; viewer?: { tree: FolderTree; principal: Principal }; userTargets?: boolean },
): AsyncGenerator<string> {
  const columns = COLUMNS.filter((c) => opts.client || (c !== "ip" && c !== "userAgent"));
  yield CSV_BOM + csvLine(columns.map((c) => t(`audit:csv.columns.${c}`)));
  for await (const rows of auditRows(db, where)) {
    for (const e of await toAuditDtos(db, rows, { client: opts.client, projectCodes: true, viewer: opts.viewer, userTargets: opts.userTargets })) {
      const removed = e.personalRemoved ? t(`audit:csv.personalRemoved.${e.personalRemoved}`) : "";
      const cells: Record<(typeof COLUMNS)[number], string | number> = {
        id: e.id,
        time: e.at,
        project: e.projectCode ?? "",
        user: e.userName ?? e.userId ?? "",
        action: e.action,
        targetType: e.targetType ?? "",
        targetId: e.targetId ?? "",
        target: e.targetName ?? "",
        ip: e.ip ?? removed,
        userAgent: e.userAgent ?? removed,
        details: e.details ? JSON.stringify(e.details) : "",
        hash: e.hash ?? "",
      };
      yield csvLine(columns.map((c) => cells[c]));
    }
  }
}
