/**
 * Moves an edited document from the PDF engine to Rust: the bytes go up in
 * base64 chunks (the Android IPC carries JSON only; one huge message would
 * also hold the file twice in memory), then become the document's working
 * copy. Versions are made from the working copy (`api.saveVersion`).
 */
import { api, type WorkingCopy } from "./api";

/** 3 MiB raw ≈ 4 MiB base64 per IPC message (Rust accepts up to 8 MiB). */
export const CHUNK_BYTES = 3 * 1024 * 1024;

type Base64Capable = Uint8Array & { toBase64?: () => string };

/** Base64 without building a giant string of char codes. */
export async function toBase64(bytes: Uint8Array): Promise<string> {
  const native = (bytes as Base64Capable).toBase64;
  if (typeof native === "function") return native.call(bytes);
  const url = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") resolve(reader.result);
      else reject(new Error("base64 encoding failed"));
    };
    reader.onerror = () => reject(reader.error ?? new Error("base64 encoding failed"));
    // A copy: the Blob must not see later changes to the caller's buffer.
    reader.readAsDataURL(new Blob([bytes.slice()]));
  });
  return url.slice(url.indexOf(",") + 1);
}

function newUploadId(): string {
  return crypto.randomUUID();
}

/** Sends `bytes` to Rust; returns the upload id. A failed upload is dropped. */
export async function upload(bytes: ArrayBuffer, chunkBytes = CHUNK_BYTES): Promise<string> {
  const uploadId = newUploadId();
  const view = new Uint8Array(bytes);
  try {
    let offset = 0;
    // An empty file is still one (empty) chunk, so Rust creates the upload.
    do {
      const piece = view.subarray(offset, Math.min(offset + chunkBytes, view.length));
      const length = await api.uploadChunk(uploadId, offset, await toBase64(piece));
      if (length !== offset + piece.length) throw new Error(`upload out of step at ${offset} (Rust has ${length})`);
      offset = length;
    } while (offset < view.length);
    return uploadId;
  } catch (err) {
    void api.abortUpload(uploadId).catch(() => undefined);
    throw err;
  }
}

/** Autosave: the edited bytes become the document's working copy. */
export async function saveWorkingCopy(documentId: string, baseBlake3: string, bytes: ArrayBuffer): Promise<WorkingCopy> {
  const size = bytes.byteLength;
  const uploadId = await upload(bytes);
  return api.commitWorkingCopy(uploadId, documentId, baseBlake3, size);
}
