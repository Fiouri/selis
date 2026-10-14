/**
 * Tools (P4a) in the mock backend. The mock cannot run qpdf: it keeps the state the UI shows
 * (protected with which password, compressed/linearized once) and saves a "version" with the
 * same bytes. A document whose bytes carry `/Encrypt` (the encrypted fixture) counts as
 * protected; its password is the fixture's. Tests use `window.__selisTest.tools`:
 *
 * - `unsavedEdits(id)`: the next tool on that document is refused for unsaved edits.
 */
import type { CommandError, Document, ProtectionView, ToolOutcome, ToolRequest } from "./ipc";

type Deps = {
  fail: (code: CommandError["code"], message: string) => never;
  runOnce: <T>(command: string, requestId: string, work: () => Promise<T>) => Promise<T>;
  documentBytes: (id: string) => Promise<Uint8Array>;
  saveSameBytes: (id: string) => Document;
};

/** The encrypted fixture's user password (packages/fixtures, ENCRYPTED_PASSWORD). */
const FIXTURE_PASSWORD = "selis";

export const TOOL_COMMANDS = new Set(["document_protection", "run_tool"]);

export function createMockTools(deps: Deps) {
  const passwords = new Map<string, string | null>();
  const compressed = new Set<string>();
  const linearized = new Set<string>();
  const unsaved = new Set<string>();

  const passwordOf = async (id: string): Promise<string | null> => {
    const known = passwords.get(id);
    if (known !== undefined) return known;
    const bytes = await deps.documentBytes(id);
    const encrypted = new TextDecoder("latin1").decode(bytes).includes("/Encrypt");
    const password = encrypted ? FIXTURE_PASSWORD : null;
    passwords.set(id, password);
    return password;
  };

  const run = async (id: string, request: ToolRequest): Promise<ToolOutcome> => {
    if (unsaved.delete(id)) return { status: "refused", problem: "unsavedEdits" };
    const password = await passwordOf(id);
    const inputBytes = (await deps.documentBytes(id)).length;
    const saved = (outputBytes: number): ToolOutcome => ({
      status: "saved",
      document: deps.saveSameBytes(id),
      inputBytes,
      outputBytes,
    });
    switch (request.kind) {
      case "protect":
        if (password !== null) return { status: "refused", problem: "passwordNeeded" };
        if (request.password.length < 8) deps.fail("invalidArgument", "password too short");
        passwords.set(id, request.password);
        return saved(inputBytes + 1_000);
      case "unprotect":
        if (password === null) return { status: "refused", problem: "notApplicable" };
        if (request.password !== password) return { status: "refused", problem: "wrongPassword" };
        passwords.set(id, null);
        return saved(inputBytes);
      case "compress":
        if (password !== null) return { status: "refused", problem: "passwordNeeded" };
        if (compressed.has(id)) return { status: "unchanged", reason: "notSmaller", inputBytes };
        compressed.add(id);
        return saved(Math.round(inputBytes * 0.74));
      case "linearize":
        if (password !== null) return { status: "refused", problem: "passwordNeeded" };
        if (linearized.has(id)) return { status: "unchanged", reason: "alreadyLinearized", inputBytes };
        linearized.add(id);
        return saved(inputBytes);
      case "repair":
        if (password !== null) return { status: "refused", problem: "passwordNeeded" };
        return { status: "unchanged", reason: "nothingToRepair", inputBytes };
    }
  };

  const hooks = {
    unsavedEdits: (id: string) => {
      unsaved.add(id);
    },
  };

  const handle = async (cmd: string, args: Record<string, unknown>): Promise<unknown> => {
    const id = String(args.id);
    switch (cmd) {
      case "document_protection": {
        const view: ProtectionView = (await passwordOf(id)) === null ? "none" : "password";
        return view;
      }
      case "run_tool":
        return deps.runOnce(cmd, String(args.requestId), () => run(id, args.request as ToolRequest));
      default:
        return deps.fail("invalidArgument", `unknown command ${cmd}`);
    }
  };

  return { handle, hooks };
}
