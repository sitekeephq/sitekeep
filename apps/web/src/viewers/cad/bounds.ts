/**
 * Robust extents of a drawing for "Sığdır" (stray far-away entities do not shrink the drawing to a
 * dot). The implementation lives in packages/shared/src/cad-bounds.ts: the server uses the same
 * function to put the prebuilt 2D scene's origin in the drawing's main body (float32 precision).
 * Tests: apps/web/test/viewers/cad-bounds.test.ts.
 */
export { mainInterval, robustBounds, type RobustBounds } from "@sitekeep/shared";
