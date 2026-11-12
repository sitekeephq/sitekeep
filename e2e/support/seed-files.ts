import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, type APIRequestContext, type APIResponse } from "@playwright/test";

const SERVER_FIXTURES = path.resolve(__dirname, "../../apps/server/test/fixtures");
export const E2E_FIXTURES = path.resolve(__dirname, "../fixtures");

async function expectJson<T>(response: APIResponse, operation: string): Promise<T> {
  if (!response.ok()) throw new Error(`${operation} failed (${response.status()}): ${await response.text()}`);
  return (await response.json()) as T;
}

export async function uploadProjectFile(
  request: APIRequestContext,
  projectId: string,
  folderId: string,
  name: string,
  data: Buffer,
  mimeType: string,
): Promise<{ fileId: string }> {
  const body = await expectJson<{ results: Array<{ ok: boolean; fileId?: string; errors: string[] }> }>(
    await request.post(`/api/v1/projects/${projectId}/folders/${folderId}/files`, {
      multipart: { file: { name, mimeType, buffer: data } },
    }),
    `upload ${name}`,
  );
  const row = body.results[0];
  if (!row?.ok || !row.fileId) throw new Error(`upload ${name}: ${row?.errors.join(", ") || "no file id"}`);
  return { fileId: row.fileId };
}

export async function projectFile(
  request: APIRequestContext,
  projectId: string,
  fileId: string,
): Promise<{ id: string; name: string; latest: { id: string; derivativeStatus: string; derivativeError: string | null } }> {
  return expectJson(await request.get(`/api/v1/projects/${projectId}/files/${fileId}`), `file ${fileId}`);
}

/** Waits until the IFC fragment job has finished (model checkbox / viewer load need this). */
export async function waitForIfcReady(request: APIRequestContext, projectId: string, fileId: string) {
  await expect
    .poll(
      async () => {
        const file = await projectFile(request, projectId, fileId);
        if (file.latest.derivativeStatus === "failed") {
          throw new Error(file.latest.derivativeError ?? "IFC conversion failed");
        }
        return file.latest.derivativeStatus;
      },
      { timeout: 90_000, intervals: [500, 1_000, 2_000] },
    )
    .toBe("ready");
  return projectFile(request, projectId, fileId);
}

export async function uploadIfcBuffer(
  request: APIRequestContext,
  projectId: string,
  folderId: string,
  uploadName: string,
  data: Buffer,
) {
  const { fileId } = await uploadProjectFile(request, projectId, folderId, uploadName, data, "application/x-step");
  const file = await waitForIfcReady(request, projectId, fileId);
  return { fileId, versionId: file.latest.id, name: uploadName };
}

export async function uploadServerIfc(
  request: APIRequestContext,
  projectId: string,
  folderId: string,
  fixtureName: string,
  uploadName: string,
) {
  const data = await readFile(path.join(SERVER_FIXTURES, fixtureName));
  return uploadIfcBuffer(request, projectId, folderId, uploadName, data);
}
