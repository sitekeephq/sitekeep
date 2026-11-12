import type { Any } from "./common.js";
const CHAIN_MARK: Record<string, string> = { done: "✓", current: "⧗", pending: "·", returned: "↩", skipped: "–" };
/** Compact workflow chain text. */
export function chainText(cells: Any[] | undefined): string | null {
  if (!cells?.length) return null;
  return cells.map((cell) => `${cell.name} ${CHAIN_MARK[cell.state] ?? cell.state}${cell.label ? ` (${cell.label})` : ""}`).join(" → ");
}
