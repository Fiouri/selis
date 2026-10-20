import type { DocHandle } from "@selis/engine";
import { describe, expect, it, vi } from "vitest";
import type { Document, SavedVersion } from "../../lib/api";
import { AUTOSAVE_IDLE_MS, type Command, EditSession } from "./session";

function fakeDoc(): DocHandle & { saves: number } {
  const doc = {
    saves: 0,
    save: () => {
      doc.saves++;
      return Promise.resolve(new TextEncoder().encode(`%PDF-1.7 save ${doc.saves}`).buffer);
    },
  };
  return doc as unknown as DocHandle & { saves: number };
}

function savedVersion(blake3: string, seq: number): SavedVersion {
  return { document: { blake3 } as Document, seq, created: true };
}

/** A session with a manual clock: `tick()` fires the autosave timer. */
function setup() {
  const doc = fakeDoc();
  let pending: (() => void) | null = null;
  const working: string[] = [];
  let versions = 1;
  const deps = {
    saveWorkingCopy: vi.fn((_id: string, base: string) => {
      working.push(base);
      return Promise.resolve({ documentId: "d", baseBlake3: base, sizeBytes: 1, savedAt: 1 });
    }),
    saveVersion: vi.fn(() => {
      versions++;
      return Promise.resolve(savedVersion(`hash-v${versions}`, versions));
    }),
    setTimer: vi.fn((fn: () => void) => {
      pending = fn;
      return 1;
    }),
    clearTimer: vi.fn(() => {
      pending = null;
    }),
  };
  const onVersion = vi.fn();
  const session = new EditSession(doc, "d", "hash-v1", deps, onVersion);
  const tick = async () => {
    const fire = pending;
    pending = null;
    fire?.();
    await session.autosave();
  };
  return { doc, session, deps, working, onVersion, tick };
}

/** A command that appends/removes `name` in `log`. */
function edit(log: string[], name: string, tool = "pen"): Command {
  return {
    tool,
    apply: () => {
      log.push(name);
      return Promise.resolve();
    },
    revert: () => {
      log.splice(log.lastIndexOf(name), 1);
      return Promise.resolve();
    },
  };
}

describe("EditSession", () => {
  it("undoes and redoes edits in order, per tool", async () => {
    const { session } = setup();
    const log: string[] = [];
    await session.run(edit(log, "a", "highlight"));
    await session.run(edit(log, "b", "pen"));
    expect(session.state).toMatchObject({ canUndo: true, canRedo: false, undoTool: "pen" });
    await session.undo();
    expect(log).toEqual(["a"]);
    expect(session.state.undoTool).toBe("highlight");
    await session.redo();
    expect(log).toEqual(["a", "b"]);
    // A new edit clears the redo stack.
    await session.undo();
    await session.run(edit(log, "c"));
    expect(session.state.canRedo).toBe(false);
    expect(log).toEqual(["a", "c"]);
  });

  it("autosaves the working copy once the edits pause, without making a version", async () => {
    const { session, deps, working, tick } = setup();
    await session.run(edit([], "a"));
    expect(session.state.status).toBe("saving");
    expect(deps.setTimer).toHaveBeenLastCalledWith(expect.any(Function), AUTOSAVE_IDLE_MS);
    await tick();
    expect(working).toEqual(["hash-v1"]);
    expect(deps.saveVersion).not.toHaveBeenCalled();
    expect(session.state.status).toBe("autosaved");
    // Nothing new: no second write.
    await session.autosave();
    expect(working).toHaveLength(1);
  });

  it("a preview edit is undoable but leaves nothing to autosave", async () => {
    const { session, deps } = setup();
    const shown: string[] = [];
    const preview = {
      tool: "erase:stroke",
      preview: true,
      apply: () => {
        shown.push("s");
        return Promise.resolve();
      },
      revert: () => {
        shown.pop();
        return Promise.resolve();
      },
    };
    await session.run(preview);
    expect(session.state).toMatchObject({ canUndo: true, status: "saved" });
    expect(deps.setTimer).not.toHaveBeenCalled();
    await session.undo();
    await session.redo();
    expect(shown).toEqual(["s"]);
    expect(deps.setTimer).not.toHaveBeenCalled();
    await expect(session.commit()).resolves.toBeNull();
    expect(deps.saveVersion).not.toHaveBeenCalled();
  });

  it("commit makes one version from the latest edits and rebases later saves on it", async () => {
    const { session, deps, working, onVersion } = setup();
    await session.run(edit([], "a"));
    await session.run(edit([], "b"));
    const saved = await session.commit();
    expect(saved?.seq).toBe(2);
    expect(deps.saveWorkingCopy).toHaveBeenCalledTimes(1);
    expect(deps.saveVersion).toHaveBeenCalledTimes(1);
    expect(deps.saveVersion).toHaveBeenLastCalledWith("d", "manual");
    expect(onVersion).toHaveBeenCalledWith(saved);
    expect(session.state.status).toBe("saved");
    // The next edit autosaves against the new version; a label names how it came to be.
    await session.run(edit([], "c"));
    await session.commit("erase");
    expect(deps.saveVersion).toHaveBeenLastCalledWith("d", "erase");
    expect(working).toEqual(["hash-v1", "hash-v2"]);
  });

  it("commit without edits saves nothing", async () => {
    const { session, deps } = setup();
    await expect(session.commit()).resolves.toBeNull();
    expect(deps.saveWorkingCopy).not.toHaveBeenCalled();
    expect(deps.saveVersion).not.toHaveBeenCalled();
  });

  it("an undo back to the start still saves (the version history decides it is unchanged)", async () => {
    const { session, deps } = setup();
    await session.run(edit([], "a"));
    await session.undo();
    await session.commit();
    expect(deps.saveWorkingCopy).toHaveBeenCalledTimes(1);
  });

  it("a failed autosave reports an error and is retried by the next save", async () => {
    const { session, deps } = setup();
    deps.saveWorkingCopy.mockRejectedValueOnce(new Error("disk full"));
    await session.run(edit([], "a"));
    await expect(session.autosave()).rejects.toThrow("disk full");
    expect(session.state.status).toBe("error");
    await session.commit();
    expect(deps.saveWorkingCopy).toHaveBeenCalledTimes(2);
    expect(session.state.status).toBe("saved");
  });

  it("a failed undo keeps the edit on the undo stack", async () => {
    const { session } = setup();
    const failing: Command = { tool: "pen", apply: () => Promise.resolve(), revert: () => Promise.reject(new Error("engine")) };
    await session.run(failing);
    await expect(session.undo()).rejects.toThrow("engine");
    expect(session.state.canUndo).toBe(true);
    expect(session.state.canRedo).toBe(false);
  });

  it("serializes saves after the edits queued before them", async () => {
    const { session, doc } = setup();
    const order: string[] = [];
    let release!: () => void;
    const slow: Command = {
      tool: "pen",
      apply: () =>
        new Promise<void>((resolve) => {
          release = () => {
            order.push("edit");
            resolve();
          };
        }),
      revert: () => Promise.resolve(),
    };
    const running = session.run(slow);
    const saving = (async () => {
      await session.commit();
      order.push(`save ${doc.saves}`);
    })();
    await Promise.resolve();
    release();
    await running;
    await saving;
    expect(order).toEqual(["edit", "save 1"]);
  });
});
