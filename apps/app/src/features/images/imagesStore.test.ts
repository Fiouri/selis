import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as ApiModule from "../../lib/api";
import type { Document, ImportOutcome } from "../../lib/api";

const importUpload = vi.fn<(uploadId: string, title: string) => Promise<ImportOutcome>>();
const upload = vi.fn<(bytes: ArrayBuffer) => Promise<string>>();
const session = {
  add: vi.fn<(bytes: ArrayBuffer, mime: string, size: string) => Promise<number>>(),
  finish: vi.fn<() => Promise<ArrayBuffer>>(),
  discard: vi.fn<() => Promise<void>>(),
};

vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof ApiModule>();
  return { ...actual, api: { ...actual.api, importUpload } };
});
vi.mock("../../lib/save", () => ({ upload }));
vi.mock("../../lib/engine", () => ({ getEngine: () => ({ createImagePdf: () => Promise.resolve(session) }) }));

const { useImages } = await import("./imagesStore");
const { EngineError } = await import("@selis/engine");

const doc = { id: "d1", title: "Photos" } as Document;
const revoke = vi.fn<(url: string) => void>();

function files(n: number): File[] {
  return Array.from({ length: n }, (_, i) => new File([new Uint8Array([0xff, 0xd8, 0xff, i])], `p${String(i)}.jpg`, { type: "image/jpeg" }));
}

describe("images to PDF", () => {
  beforeEach(() => {
    for (const f of [importUpload, upload, session.add, session.finish, session.discard]) f.mockReset();
    globalThis.URL.createObjectURL = vi.fn(() => `blob:${String(Math.random())}`);
    revoke.mockReset();
    globalThis.URL.revokeObjectURL = revoke;
    useImages.getState().close();
    useImages.setState({ size: "fit" });
  });

  it("collects picked files, reorders and removes them", () => {
    useImages.getState().addFiles(files(3));
    const ids = useImages.getState().items.map((i) => i.id);
    expect(useImages.getState().phase).toEqual({ step: "edit" });
    useImages.getState().move(ids[2] ?? "", -1);
    expect(useImages.getState().items.map((i) => i.id)).toEqual([ids[0], ids[2], ids[1]]);
    useImages.getState().move(ids[0] ?? "", -1); // already first: nothing
    expect(useImages.getState().items[0]?.id).toBe(ids[0]);
    useImages.getState().remove(ids[1] ?? "");
    expect(useImages.getState().items.map((i) => i.id)).toEqual([ids[0], ids[2]]);
    expect(revoke).toHaveBeenCalledOnce();
  });

  it("adds every photo in order, uploads the PDF and lets the photos go", async () => {
    useImages.getState().addFiles(files(3));
    useImages.getState().setSize("a4");
    session.add.mockResolvedValueOnce(1).mockResolvedValueOnce(2).mockResolvedValueOnce(3);
    session.finish.mockResolvedValue(new ArrayBuffer(8));
    upload.mockResolvedValue("u1");
    importUpload.mockResolvedValue({ document: doc, duplicate: false });
    const result = await useImages.getState().create("Photos 14/10/2026");
    expect(result).toEqual({ kind: "created", document: doc, skipped: 0 });
    expect(session.add).toHaveBeenCalledTimes(3);
    expect(session.add.mock.calls.every((c) => c[2] === "a4")).toBe(true);
    expect(importUpload).toHaveBeenCalledWith("u1", "Photos 14/10/2026");
    expect(useImages.getState()).toMatchObject({ items: [], phase: { step: "closed" } });
  });

  it("leaves out photos the engine cannot read and says how many", async () => {
    useImages.getState().addFiles(files(3));
    session.add
      .mockResolvedValueOnce(1)
      .mockRejectedValueOnce(new EngineError("format", "HEIC"))
      .mockResolvedValueOnce(2);
    session.finish.mockResolvedValue(new ArrayBuffer(8));
    upload.mockResolvedValue("u1");
    importUpload.mockResolvedValue({ document: doc, duplicate: false });
    expect(await useImages.getState().create("t")).toEqual({ kind: "created", document: doc, skipped: 1 });
  });

  it("keeps the photos when none could be read or something failed", async () => {
    useImages.getState().addFiles(files(2));
    session.add.mockRejectedValue(new EngineError("format", "unreadable"));
    expect(await useImages.getState().create("t")).toEqual({ kind: "noneReadable" });
    expect(session.discard).toHaveBeenCalled();
    expect(useImages.getState().items).toHaveLength(2);
    expect(useImages.getState().phase).toEqual({ step: "edit" });

    session.add.mockReset();
    session.add.mockResolvedValue(1);
    session.finish.mockResolvedValue(new ArrayBuffer(8));
    upload.mockRejectedValue(new Error("disk full"));
    expect(await useImages.getState().create("t")).toEqual({ kind: "failed" });
    expect(useImages.getState().items).toHaveLength(2);
  });
});
