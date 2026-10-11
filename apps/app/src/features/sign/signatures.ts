/**
 * Saved signatures (Rust: `signatures/`, SQLite) and picking a picture for one.
 */
import { type QueryClient, useQuery } from "@tanstack/react-query";
import { api, type Signature, type SignatureKind } from "../../lib/api";
import { assetUrl } from "../../lib/files";
import { isTauri } from "../../lib/platform";
import { toBase64 } from "../../lib/save";

export const signaturesKey = ["signatures"] as const;

export function useSignatures() {
  return useQuery({ queryKey: signaturesKey, queryFn: () => api.listSignatures() });
}

/** Stores a new signature image and puts it first in the cached list. */
export async function createSignature(queryClient: QueryClient, kind: SignatureKind, png: Blob): Promise<Signature> {
  const bytes = new Uint8Array(await png.arrayBuffer());
  const saved = await api.saveSignature(crypto.randomUUID(), kind, await toBase64(bytes));
  queryClient.setQueryData<Signature[]>(signaturesKey, (old) => [saved, ...(old ?? []).filter((s) => s.id !== saved.id)]);
  return saved;
}

/** Forgets a saved signature (optimistic; refetched on failure). */
export async function deleteSignature(queryClient: QueryClient, id: string): Promise<boolean> {
  const previous = queryClient.getQueryData<Signature[]>(signaturesKey);
  queryClient.setQueryData<Signature[]>(signaturesKey, (old) => (old ?? []).filter((s) => s.id !== id));
  try {
    await api.deleteSignature(id);
    return true;
  } catch {
    queryClient.setQueryData(signaturesKey, previous);
    void queryClient.invalidateQueries({ queryKey: signaturesKey });
    return false;
  }
}

export function signatureSrc(signature: Signature): string {
  return assetUrl(signature.path);
}

/** The signature's PNG, for placing it on a page. */
export async function signatureBytes(signature: Signature): Promise<ArrayBuffer> {
  const response = await fetch(signatureSrc(signature));
  if (!response.ok) throw new Error(`failed to read signature (${response.status})`);
  return response.arrayBuffer();
}

export type PictureFile = { mime: string; bytes: ArrayBuffer };

function base64ToBytes(data: string): ArrayBuffer {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

/** Opens the system picker for a picture; null if cancelled. */
export async function pickPicture(): Promise<PictureFile | null> {
  if (isTauri()) {
    const outcome = await api.pickImage();
    return outcome.status === "picked" ? { mime: outcome.mime, bytes: base64ToBytes(outcome.data) } : null;
  }
  const file = await new Promise<File | null>((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/png,image/jpeg,image/webp";
    input.style.display = "none";
    const done = (picked: File | null) => {
      input.remove();
      resolve(picked);
    };
    input.addEventListener("change", () => done(input.files?.[0] ?? null), { once: true });
    input.addEventListener("cancel", () => done(null), { once: true });
    document.body.append(input);
    input.click();
  });
  return file ? { mime: file.type || "image/png", bytes: await file.arrayBuffer() } : null;
}
