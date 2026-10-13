import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PackExportView } from "../../lib/api";

const packExport = vi.fn<(ids: string[] | null, history: boolean, passphrase: string | null) => Promise<PackExportView>>();

vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return { ...actual, api: { ...actual.api, packExport } };
});

const { usePack } = await import("./packStore");

const summary = { documents: 2, files: 2, bytes: 10, encrypted: true };

describe("pack export", () => {
  beforeEach(() => {
    packExport.mockReset();
    usePack.getState().resetExport();
  });

  it("is done once the pack is shared or saved", async () => {
    packExport.mockResolvedValue({ status: "shared", summary });
    await usePack.getState().exportPack(null, true, "correct horse");
    expect(usePack.getState().exportState).toEqual({ phase: "done", summary });
  });

  it("goes back to the choices when the save dialog is cancelled", async () => {
    packExport.mockResolvedValue({ status: "cancelled" });
    const exporting = usePack.getState().exportPack(["a"], false, null);
    expect(usePack.getState().exportState).toEqual({ phase: "working" });
    await exporting;
    expect(usePack.getState().exportState).toEqual({ phase: "idle" });
  });

  it("fails when the pack cannot be written", async () => {
    const { ApiError } = await import("../../lib/api");
    packExport.mockRejectedValue(new ApiError({ code: "io", message: "disk full" }));
    await usePack.getState().exportPack(null, true, null);
    expect(usePack.getState().exportState).toEqual({ phase: "failed" });
  });
});
