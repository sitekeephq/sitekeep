/** DTOs for the recycle bin, search and bulk download (Sprint B). */
import type { FileDto } from "../core/types.js";

export interface TrashFolderDto {
  id: string;
  name: string;
  parentId: string | null;
  /** Original location, e.g. "Proje Dosyaları / 01-WIP (Çalışmada)". */
  path: string;
  deletedAt: string;
  deletedBy: string | null;
  deletedByName?: string;
  /** Subfolders and files that were deleted together with this folder. */
  folderCount: number;
  fileCount: number;
  /** False when the parent folder is deleted too (restore the parent first). */
  parentAlive: boolean;
}

export interface TrashFileDto {
  id: string;
  name: string;
  folderId: string;
  path: string;
  currentVersion: number;
  size: number;
  deletedAt: string;
  deletedBy: string | null;
  deletedByName?: string;
  /** False when the folder is deleted too (restore the folder first). */
  folderAlive: boolean;
}

export interface TrashDto {
  folders: TrashFolderDto[];
  files: TrashFileDto[];
}

/** Where a search hit matched: the file name, an attribute value or the file's text. */
export type SearchMatchPlace = "name" | "attribute" | "content";

export interface SearchHitDto extends FileDto {
  folderPath: string;
  /** Matched inside the file's text (office, sheet, drawing, PDF): a short clean excerpt around the match. */
  snippet?: string;
  /** PDF page of the excerpt (1-based), when the match is in a PDF's text. */
  page?: number;
  /** Where the query matched (empty for a search with filters only). */
  matchedIn?: SearchMatchPlace[];
  /** Recycle bin search: when the file was deleted. */
  deletedAt?: string;
}

export interface SearchResultDto {
  results: SearchHitDto[];
  /** True when more files matched than were returned (another page exists). */
  truncated: boolean;
  /** Number of files that matched (all pages). */
  total?: number;
  offset?: number;
  limit?: number;
  /** Terms to highlight (the positive terms of the query). */
  terms?: string[];
}

export interface ZipRequest {
  fileIds?: string[];
  folderIds?: string[];
  versionIds?: string[];
}

/** Name of the report added to a zip when some requested files were left out. */
export const ZIP_MISSING_FILE = "_eksikler.txt";
