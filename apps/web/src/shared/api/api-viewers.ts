/** API client for the in-browser viewers (preview derivatives, PDF of office files, media). */
import type { ConvertersDto, PreviewKind, SheetPreviewDto, VersionPreviewDto } from "@sitekeep/shared";
import { i18n } from "../../i18n";
import { ApiError, request } from "./client";

const base = (pid: string, vid: string) => `/api/v1/projects/${pid}/versions/${vid}`;

export const viewersApi = {
  preview: (pid: string, vid: string) => request<VersionPreviewDto>("GET", `/projects/${pid}/versions/${vid}/preview`),
  requestPreview: (pid: string, vid: string, kind: PreviewKind) =>
    request<VersionPreviewDto>("POST", `/projects/${pid}/versions/${vid}/preview/${kind}`, {}),
  previewUrl: (pid: string, vid: string, kind: PreviewKind) => `${base(pid, vid)}/preview/${kind}`,
  /** The PDF itself, or the PDF made from an office file (used by the PDF viewer). */
  pdfUrl: (pid: string, vid: string) => `${base(pid, vid)}/pdf`,
  /** Original content inline, with byte ranges (images, video, audio, text, DXF, office files for the browser viewers). */
  mediaUrl: (pid: string, vid: string) => `${base(pid, vid)}/media`,
  async sheet(pid: string, vid: string): Promise<SheetPreviewDto> {
    const res = await fetch(viewersApi.previewUrl(pid, vid, "sheet"), { credentials: "same-origin" });
    if (!res.ok) throw new ApiError(res.status, i18n.t("shell:apiErrors.sheet", { status: res.status }));
    return (await res.json()) as SheetPreviewDto;
  },
  async bytes(url: string): Promise<ArrayBuffer> {
    const res = await fetch(url, { credentials: "same-origin" });
    if (!res.ok) throw new ApiError(res.status, i18n.t("shell:apiErrors.file", { status: res.status }));
    return res.arrayBuffer();
  },
  converters: () => request<ConvertersDto>("GET", "/admin/converters"),
};

/** UTF-8 when valid, else Windows-1254 (older Turkish text files). */
export function decodeText(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  const start = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(start));
  } catch {
    return new TextDecoder("windows-1254").decode(bytes);
  }
}
