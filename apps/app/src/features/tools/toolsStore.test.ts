import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as ApiModule from "../../lib/api";
import type { Document, ProtectionView, ToolOutcome, ToolRequest } from "../../lib/api";

const documentProtection = vi.fn<(id: string) => Promise<ProtectionView>>();
const runTool = vi.fn<(id: string, request: ToolRequest) => Promise<ToolOutcome>>();

vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof ApiModule>();
  return { ...actual, api: { ...actual.api, documentProtection, runTool } };
});

const { useTools } = await import("./toolsStore");
const { useThumbnailStatus } = await import("../library/thumbnails");
const { ApiError } = await import("../../lib/api");

const doc = { id: "d1", title: "Contract" } as Document;
const saved = (inputBytes = 100, outputBytes = 74): ToolOutcome => ({ status: "saved", document: doc, inputBytes, outputBytes });

describe("tools", () => {
  beforeEach(() => {
    documentProtection.mockReset();
    runTool.mockReset();
    useTools.setState({ docId: null, protection: null, view: { step: "menu" }, notice: null, onSaved: null });
  });

  it("opens on a document and learns its protection", async () => {
    documentProtection.mockResolvedValue("password");
    await useTools.getState().open("d1", () => undefined);
    expect(useTools.getState()).toMatchObject({ docId: "d1", protection: "password", view: { step: "menu" } });
  });

  it("shows the sizes after compressing and tells the host about the new version", async () => {
    documentProtection.mockResolvedValue("none");
    const onSaved = vi.fn();
    await useTools.getState().open("d1", onSaved);
    runTool.mockResolvedValue(saved(4_200_000, 3_100_000));
    const running = useTools.getState().run({ kind: "compress" });
    expect(useTools.getState().view).toEqual({ step: "running", kind: "compress" });
    await running;
    expect(useTools.getState().view).toEqual({ step: "compressed", inputBytes: 4_200_000, outputBytes: 3_100_000 });
    expect(onSaved).toHaveBeenCalledWith(doc);
  });

  it("closes with a notice after protecting, and the card shows a lock", async () => {
    documentProtection.mockResolvedValue("none");
    const onSaved = vi.fn();
    await useTools.getState().open("d1", onSaved);
    runTool.mockResolvedValue(saved());
    await useTools.getState().run({
      kind: "protect",
      password: "correct horse",
      ownerPassword: null,
      allowPrint: true,
      allowCopy: true,
      allowModify: true,
    });
    expect(useTools.getState().docId).toBeNull();
    expect(useTools.getState().notice).toMatchObject({ key: "saved", error: false });
    expect(useThumbnailStatus.getState().locked.has("d1")).toBe(true);
    expect(onSaved).toHaveBeenCalledOnce();
  });

  it("asks again after a wrong password and saves nothing", async () => {
    documentProtection.mockResolvedValue("password");
    const onSaved = vi.fn();
    await useTools.getState().open("d1", onSaved);
    runTool.mockResolvedValue({ status: "refused", problem: "wrongPassword" });
    await useTools.getState().run({ kind: "unprotect", password: "wrong horse" });
    expect(useTools.getState().view).toEqual({ step: "unprotect", wrong: true });
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("says why when nothing was changed", async () => {
    documentProtection.mockResolvedValue("none");
    await useTools.getState().open("d1", () => undefined);
    runTool.mockResolvedValue({ status: "unchanged", reason: "nothingToRepair", inputBytes: 100 });
    await useTools.getState().run({ kind: "repair" });
    expect(useTools.getState().notice).toMatchObject({ key: "nothingToRepair", error: false });

    await useTools.getState().open("d1", () => undefined);
    runTool.mockResolvedValue({ status: "unchanged", reason: "notSmaller", inputBytes: 100 });
    await useTools.getState().run({ kind: "compress" });
    expect(useTools.getState().view).toEqual({ step: "notSmaller", inputBytes: 100 });
  });

  it("reports refusals and failures as errors", async () => {
    documentProtection.mockResolvedValue("none");
    await useTools.getState().open("d1", () => undefined);
    runTool.mockResolvedValue({ status: "refused", problem: "unsavedEdits" });
    await useTools.getState().run({ kind: "linearize" });
    expect(useTools.getState().notice).toMatchObject({ key: "unsavedEdits", error: true });

    await useTools.getState().open("d1", () => undefined);
    runTool.mockRejectedValue(new ApiError({ code: "io", message: "disk full" }));
    await useTools.getState().run({ kind: "compress" });
    expect(useTools.getState().view).toEqual({ step: "menu" });
    expect(useTools.getState().notice).toMatchObject({ key: "failed", error: true });
  });

  it("does not close while an operation runs", async () => {
    documentProtection.mockResolvedValue("none");
    await useTools.getState().open("d1", () => undefined);
    let finish: (outcome: ToolOutcome) => void = () => undefined;
    runTool.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const running = useTools.getState().run({ kind: "compress" });
    useTools.getState().close();
    expect(useTools.getState().docId).toBe("d1");
    finish(saved());
    await running;
  });
});
