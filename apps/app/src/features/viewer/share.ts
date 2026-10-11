/**
 * "Share" from the viewer. Android: the native share sheet (commands/share.rs,
 * SharePlugin.kt). Elsewhere: the Web Share API with the file (iOS WKWebView),
 * if the platform offers it.
 */
import { ApiError, api } from "../../lib/api";
import { readDocumentBytes } from "../../lib/files";
import { isTauri } from "../../lib/platform";

export type ShareResult = "shared" | "unsupported" | "failed";

async function webShare(title: string, path: string): Promise<ShareResult> {
  if (typeof navigator.canShare !== "function") return "unsupported";
  const bytes = await readDocumentBytes(path);
  const file = new File([bytes], `${title || "document"}.pdf`, { type: "application/pdf" });
  if (!navigator.canShare({ files: [file] })) return "unsupported";
  try {
    await navigator.share({ files: [file], title });
    return "shared";
  } catch (err) {
    // The user closing the sheet is not an error.
    return err instanceof DOMException && err.name === "AbortError" ? "shared" : "failed";
  }
}

export async function shareDocument(id: string, title: string, path: string): Promise<ShareResult> {
  if (isTauri()) {
    try {
      await api.shareDocument(id);
      return "shared";
    } catch (err) {
      if (!(err instanceof ApiError && err.code === "unsupported")) return "failed";
    }
  }
  try {
    return await webShare(title, path);
  } catch {
    return "failed";
  }
}
