import type { DocHandle, PageOp } from "@selis/engine";
import { describe, expect, it, vi } from "vitest";
import { isNoOpMove, moveTarget, pageCommand, pageRanges } from "./pageCommands";

describe("pageRanges", () => {
  it("joins runs with an en dash, in order, without repeats", () => {
    expect(pageRanges([4, 0, 1, 2, 2, 7])).toBe("1–3, 5, 8");
    expect(pageRanges([3])).toBe("4");
  });
});

describe("moving pages", () => {
  it("translates a drop slot into the destination index of the result", () => {
    // Pages 5 and 6 (0-based) dropped before page 0.
    expect(moveTarget([5, 6], 0)).toBe(0);
    // Page 0 dropped after page 3 (slot 4): 3 pages stay before it.
    expect(moveTarget([0], 4)).toBe(3);
    expect(moveTarget([1, 3], 5)).toBe(3);
  });

  it("knows a drop that changes nothing", () => {
    expect(isNoOpMove([2, 3], 2)).toBe(true);
    expect(isNoOpMove([2, 3], 4)).toBe(true);
    expect(isNoOpMove([2, 3], 5)).toBe(false);
    expect(isNoOpMove([1, 3], 2)).toBe(false);
  });
});

describe("pageCommand", () => {
  function fakeDoc() {
    const editPages = vi.fn((op: PageOp) => Promise.resolve(new TextEncoder().encode(`before ${op.op}`).buffer));
    const reload = vi.fn(() => Promise.resolve());
    return { doc: { editPages, reload } as unknown as DocHandle, editPages, reload };
  }

  it("undo reloads the bytes from before the first apply, redo applies again", async () => {
    const { doc, editPages, reload } = fakeDoc();
    const command = pageCommand(doc, { op: "rotate", indices: [0], turns: 1 });
    await command.apply();
    await command.revert();
    await command.apply();
    await command.revert();
    expect(editPages).toHaveBeenCalledTimes(2);
    expect(reload).toHaveBeenCalledTimes(2);
    const first = reload.mock.calls[0] as unknown as [ArrayBuffer];
    expect(new TextDecoder().decode(first[0])).toBe("before rotate");
  });

  it("sends a copy of inserted PDF bytes, so redo still has them", async () => {
    const { doc, editPages } = fakeDoc();
    const bytes = new Uint8Array([37, 80, 68, 70]).buffer;
    const command = pageCommand(doc, { op: "insertPdf", at: 0, bytes });
    await command.apply();
    const sent = (editPages.mock.calls[0] as [PageOp])[0];
    expect(sent.op === "insertPdf" && sent.bytes).not.toBe(bytes);
    expect(bytes.byteLength).toBe(4);
  });
});
