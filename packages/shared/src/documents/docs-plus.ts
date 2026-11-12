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

export interface SearchHitDto extends FileDto {
  folderPath: string;
  /** Matched inside the file's text (office, sheet, drawing, PDF): a short excerpt around the match. */
  snippet?: string;
}

export interface SearchResultDto {
  results: SearchHitDto[];
  /** True when more files matched than were returned. */
  truncated: boolean;
}

export interface ZipRequest {
  fileIds?: string[];
  folderIds?: string[];
  versionIds?: string[];
}

/** Name of the report added to a zip when some requested files were left out. */
export const ZIP_MISSING_FILE = "_eksikler.txt";
