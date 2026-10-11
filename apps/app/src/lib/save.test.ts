import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";
import { saveWorkingCopy, toBase64, upload } from "./save";

afterEach(() => {
  vi.restoreAllMocks();
});

function bytes(n: number): ArrayBuffer {
  return Uint8Array.from({ length: n }, (_, i) => i % 251).buffer;
}

describe("toBase64", () => {
  it("encodes like btoa, empty included", async () => {
    const data = new Uint8Array([0, 1, 2, 250, 255, 37, 80, 68, 70]);
    expect(await toBase64(data)).toBe(btoa(String.fromCharCode(...data)));
    expect(await toBase64(new Uint8Array())).toBe("");
  });
});

describe("upload", () => {
  it("sends the file in order, in chunks, and decodes back to the same bytes", async () => {
    const received: { offset: number; data: Uint8Array }[] = [];
    vi.spyOn(api, "uploadChunk").mockImplementation((_id, offset, data) => {
      const chunk = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
      received.push({ offset, data: chunk });
      return Promise.resolve(offset + chunk.length);
    });
    const file = bytes(10_000);
    await upload(file, 4_096);
    expect(received.map((r) => r.offset)).toEqual([0, 4_096, 8_192]);
    const joined = new Uint8Array(received.flatMap((r) => Array.from(r.data)));
    expect(joined).toEqual(new Uint8Array(file));
  });

  it("drops the upload when Rust disagrees about its length", async () => {
    vi.spyOn(api, "uploadChunk").mockResolvedValue(1);
    const abort = vi.spyOn(api, "abortUpload").mockResolvedValue(null);
    await expect(upload(bytes(100), 50)).rejects.toThrow("out of step");
    expect(abort).toHaveBeenCalledTimes(1);
  });
});

describe("saveWorkingCopy", () => {
  it("commits the upload as the working copy of the version the edits started from", async () => {
    vi.spyOn(api, "uploadChunk").mockImplementation((_id, offset, data) => Promise.resolve(offset + atob(data).length));
    const commit = vi
      .spyOn(api, "commitWorkingCopy")
      .mockResolvedValue({ documentId: "d", baseBlake3: "h1", sizeBytes: 300, savedAt: 1 });
    await saveWorkingCopy("d", "h1", bytes(300));
    expect(commit).toHaveBeenCalledWith(expect.any(String), "d", "h1", 300);
  });
});
