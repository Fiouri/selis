import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, api, type Document } from "../../lib/api";
import { deleteDocument, documentsKey, renameDocument } from "./queries";

function doc(id: string, title = id): Document {
  return {
    id,
    title,
    kind: "imported",
    blake3: `h-${id}`,
    sizeBytes: 10,
    pageCount: 1,
    createdAt: 1,
    modifiedAt: 1,
    lastOpenedAt: null,
    favorite: false,
    received: false,
    tagIds: [],
    thumbnailPath: null,
    lastPage: null,
  };
}

const allKey = [...documentsKey, { search: "", filter: "all", tagId: null, sort: "recent" }];
const favKey = [...documentsKey, { search: "", filter: "favorites", tagId: null, sort: "recent" }];

function client() {
  const qc = new QueryClient();
  qc.setQueryData(allKey, [doc("a"), doc("b")]);
  qc.setQueryData(favKey, [doc("a")]);
  // The reconcile refetch is not under test: keep the optimistic state observable.
  const refetch = vi.spyOn(qc, "invalidateQueries").mockResolvedValue();
  return { qc, refetch };
}

const titles = (qc: QueryClient, key: readonly unknown[]) => qc.getQueryData<Document[]>(key)?.map((d) => d.title);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("deleteDocument", () => {
  it("drops the document from every listing", async () => {
    const { qc, refetch } = client();
    const call = vi.spyOn(api, "deleteDocument").mockResolvedValue({ removedFiles: 2 });
    await expect(deleteDocument(qc, doc("a"))).resolves.toBe(true);
    expect(call).toHaveBeenCalledWith("a");
    expect(titles(qc, allKey)).toEqual(["b"]);
    expect(titles(qc, favKey)).toEqual([]);
    expect(refetch).toHaveBeenCalledWith({ queryKey: documentsKey });
  });

  it("treats notFound as done (a retried delete after a lost reply)", async () => {
    const { qc } = client();
    vi.spyOn(api, "deleteDocument").mockRejectedValue(new ApiError({ code: "notFound", message: "a" }));
    await expect(deleteDocument(qc, doc("a"))).resolves.toBe(true);
    expect(titles(qc, allKey)).toEqual(["b"]);
  });

  it("reports other failures and refetches so the document comes back", async () => {
    const { qc, refetch } = client();
    vi.spyOn(api, "deleteDocument").mockRejectedValue(new ApiError({ code: "io", message: "disk" }));
    await expect(deleteDocument(qc, doc("a"))).resolves.toBe(false);
    expect(refetch).toHaveBeenCalledWith({ queryKey: documentsKey });
  });
});

describe("renameDocument", () => {
  it("shows the new title at once and keeps the backend's answer", async () => {
    const { qc } = client();
    let release!: () => void;
    vi.spyOn(api, "renameDocument").mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve(doc("a", "Νέο"));
        }),
    );
    const done = renameDocument(qc, doc("a"), "Νέο");
    expect(titles(qc, allKey)).toEqual(["Νέο", "b"]);
    release();
    await expect(done).resolves.toBe(true);
    expect(titles(qc, favKey)).toEqual(["Νέο"]);
  });

  it("rolls back when the backend refuses", async () => {
    const { qc } = client();
    vi.spyOn(api, "renameDocument").mockRejectedValue(new ApiError({ code: "notFound", message: "a" }));
    await expect(renameDocument(qc, doc("a"), "Νέο")).resolves.toBe(false);
    expect(titles(qc, allKey)).toEqual(["a", "b"]);
  });
});
