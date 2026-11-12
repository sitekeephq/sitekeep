import type { PreviewKind, VersionPreviewDto } from "@sitekeep/shared";

/** Props every viewer gets. */
export interface ViewerProps {
  projectId: string;
  info: VersionPreviewDto;
  onRequest(kind: PreviewKind): void;
}
