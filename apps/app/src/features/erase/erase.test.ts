import type { DocHandle, EraseArea, PageObjectInfo } from "@selis/engine";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyEraseCommand, deleteObjectCommand, eraseGroups, strokeCommand, useEraseState } from "./eraseState";
import { boxOf, brushRects, clipRect, objectsAt, rectsPath } from "./geometry";

const PAGE = { width: 600, height: 800 };

describe("brushRects", () => {
  it("covers the whole stroke with squares of the brush size, without gaps", () => {
    const rects = brushRects(
      [
        { x: 100, y: 100 },
        { x: 200, y: 160 },
      ],
      12,
      PAGE,
    );
    expect(rects.every((r) => r.width === 12 && r.height === 12)).toBe(true);
    // Every point of the centre line is inside some square.
    for (let k = 0; k <= 100; k++) {
      const p = { x: 100 + k, y: 100 + 0.6 * k };
      expect(rects.some((r) => p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height), `${p.x},${p.y}`).toBe(true);
    }
  });

  it("puts one square on a spot only once and stays on the page", () => {
    const rects = brushRects(
      [
        { x: 2, y: 2 },
        { x: 2, y: 2 },
        { x: 2.5, y: 2.2 },
      ],
      12,
      PAGE,
    );
    expect(rects).toHaveLength(1);
    expect(rects[0]?.x).toBe(0);
  });

  it("is empty without points or size", () => {
    expect(brushRects([], 12, PAGE)).toEqual([]);
    expect(brushRects([{ x: 1, y: 1 }], 0, PAGE)).toEqual([]);
  });
});

describe("geometry helpers", () => {
  it("boxes two points and clips to the page", () => {
    expect(boxOf({ x: 50, y: 40 }, { x: 10, y: 60 })).toEqual({ x: 10, y: 40, width: 40, height: 20 });
    expect(clipRect({ x: 590, y: -5, width: 20, height: 20 }, PAGE)).toEqual({ x: 590, y: 0, width: 10, height: 15 });
    expect(clipRect({ x: 700, y: 0, width: 20, height: 20 }, PAGE)).toBeNull();
    expect(rectsPath([{ x: 1, y: 2, width: 3, height: 4 }], 2)).toBe("M2 4h6v8h-6Z");
  });

  it("picks the topmost object under the finger first", () => {
    const objects: PageObjectInfo[] = [
      { index: 0, kind: "image", rect: { x: 0, y: 0, width: 600, height: 800 } },
      { index: 1, kind: "path", rect: { x: 100, y: 100, width: 50, height: 50 } },
      { index: 2, kind: "text", rect: { x: 120, y: 120, width: 80, height: 10 } },
    ];
    expect(objectsAt(objects, { x: 125, y: 125 }, 2).map((o) => o.index)).toEqual([2, 1, 0]);
    expect(objectsAt(objects, { x: 300, y: 300 }, 2).map((o) => o.index)).toEqual([0]);
    // Within the tolerance of a thin object's bounds: after the ones right under the finger.
    expect(objectsAt(objects, { x: 125, y: 132 }, 3).map((o) => o.index)).toEqual([1, 0, 2]);
    // A nearby object on top does not win over the one under the finger.
    expect(objectsAt(objects, { x: 118, y: 118 }, 3).map((o) => o.index)).toEqual([1, 0, 2]);
  });
});

function fakeDoc() {
  const erase = vi.fn((area: EraseArea) => Promise.resolve({ before: new Uint8Array([area.page]).buffer }));
  const reload = vi.fn(() => Promise.resolve());
  const deleteObject = vi.fn(() => Promise.resolve({ before: new ArrayBuffer(3) }));
  return { doc: { erase, reload, deleteObject } as unknown as DocHandle, erase, reload, deleteObject };
}

describe("erase commands", () => {
  beforeEach(() => {
    useEraseState.getState().reset();
  });

  const stroke = (id: string, page: number, fill: string) => ({ id, page, fill, rects: [{ x: page, y: 0, width: 10, height: 10 }] });

  it("strokes are previews that undo one by one", async () => {
    const a = strokeCommand(stroke("a", 0, "#ffffff"));
    const b = strokeCommand(stroke("b", 0, "#ffffff"));
    expect(a.preview).toBe(true);
    await a.apply();
    await b.apply();
    expect(useEraseState.getState().strokes.map((s) => s.id)).toEqual(["a", "b"]);
    await b.revert();
    expect(useEraseState.getState().strokes.map((s) => s.id)).toEqual(["a"]);
  });

  it("groups strokes by page and fill colour", () => {
    const groups = eraseGroups([stroke("a", 1, "#ffffff"), stroke("b", 0, "#ffffff"), stroke("c", 1, "#ffffff"), stroke("d", 1, "#336699")]);
    expect(groups.map((g) => [g.page, g.fill, g.rects.length])).toEqual([
      [0, "#ffffff", 1],
      [1, "#ffffff", 2],
      [1, "#336699", 1],
    ]);
  });

  it("applies every group, and undo reloads the bytes from before and brings the strokes back", async () => {
    const { doc, erase, reload } = fakeDoc();
    useEraseState.getState().setStrokes([stroke("a", 1, "#ffffff"), stroke("b", 0, "#ffffff")]);
    const command = applyEraseCommand(doc);
    await command.apply();
    expect(erase).toHaveBeenCalledTimes(2);
    expect(useEraseState.getState().strokes).toEqual([]);
    await command.revert();
    // The bytes from before the first erase (page 0's group goes first).
    expect(new Uint8Array(reload.mock.calls[0]?.[0] as unknown as ArrayBuffer)).toEqual(new Uint8Array([0]));
    expect(useEraseState.getState().strokes.map((s) => s.id)).toEqual(["a", "b"]);
  });

  it("is all or nothing: a group that fails takes back the ones before it", async () => {
    const { doc, erase, reload } = fakeDoc();
    erase.mockImplementationOnce(() => Promise.resolve({ before: new Uint8Array([7]).buffer })).mockRejectedValueOnce(new Error("nope"));
    useEraseState.getState().setStrokes([stroke("a", 0, "#ffffff"), stroke("b", 1, "#ffffff")]);
    await expect(applyEraseCommand(doc).apply()).rejects.toThrow("nope");
    expect(new Uint8Array(reload.mock.calls[0]?.[0] as unknown as ArrayBuffer)).toEqual(new Uint8Array([7]));
    expect(useEraseState.getState().strokes).toHaveLength(2);
  });

  it("deletes the picked object and clears the selection", async () => {
    const { doc, deleteObject, reload } = fakeDoc();
    const object: PageObjectInfo = { index: 4, kind: "image", rect: { x: 0, y: 0, width: 5, height: 5 } };
    useEraseState.getState().select({ page: 2, candidates: [object], at: 0 });
    const command = deleteObjectCommand(doc, 2, object);
    await command.apply();
    expect(deleteObject).toHaveBeenCalledWith(2, object);
    expect(useEraseState.getState().selection).toBeNull();
    await command.revert();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("arms the eyedropper when the picked colour is chosen without one", () => {
    const s = useEraseState.getState();
    s.setFill("pick");
    expect(useEraseState.getState().picking).toBe(true);
    s.setPicked("#123456");
    expect(useEraseState.getState()).toMatchObject({ picked: "#123456", picking: false, fill: "pick" });
    s.setFill("white");
    s.setFill("pick");
    expect(useEraseState.getState().picking).toBe(false);
  });
});
