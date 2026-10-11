/**
 * Pages screen per docs/design/p1-ui-brief.md §4: top bar (close, "{n}
 * selected", undo / redo, "Select all"), hint, the 3-column grid and the bottom
 * action bar (rotate, duplicate, extract, add PDF, delete). Every change to
 * the document is an EditSession command (undo / redo, autosave, a version on
 * close); extract and split make new library documents instead.
 */
import type { DocHandle, PageOp } from "@selis/engine";
import { IconButton } from "@selis/ui";
import { useQueryClient } from "@tanstack/react-query";
import { Copy, FilePlus2, FileOutput, type LucideIcon, Redo2, RotateCw, Scissors, Trash2, Undo2, X } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { Sheet } from "../../components/Sheet";
import { useToast } from "../../components/Toast";
import { api } from "../../lib/api";
import { pickPdf, readDocumentBytes } from "../../lib/files";
import type { EditSession, SessionState } from "../annotate/session";
import { refreshLibrary } from "../library/queries";
import { extractToLibrary, isNoOpMove, moveTarget, pageCommand, pageRanges } from "./pageCommands";
import { PagesGrid } from "./PagesGrid";

/** A4 in points: a blank page with nothing selected to copy the size of. */
const A4 = { width: 595, height: 842 };

type Props = {
  doc: DocHandle;
  session: EditSession;
  sessionState: SessionState;
  structure: number;
  /** Document title, for the names of extracted documents. */
  title: string;
  onClose: () => void;
};

type Pending = "add" | "extract" | "delete" | null;

const row = "selis-focus flex min-h-14 w-full items-center gap-4 px-5 text-left text-md text-neutral-12 active:bg-neutral-3 disabled:opacity-45";

export function PagesMode({ doc, session, sessionState, structure, title, onClose }: Props) {
  const { t } = useTranslation();
  const showToast = useToast((s) => s.show);
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());
  const [seenStructure, setSeenStructure] = useState(structure);
  const [pending, setPending] = useState<Pending>(null);
  const [busy, setBusy] = useState(false);
  const count = doc.pageCount;

  // Pages that no longer exist (undo / redo of a delete) drop out of the selection.
  if (structure !== seenStructure) {
    setSeenStructure(structure);
    if ([...selected].some((i) => i >= count)) setSelected(new Set([...selected].filter((i) => i < count)));
  }

  const sorted = [...selected].sort((a, b) => a - b);
  const allSelected = count > 0 && selected.size === count;

  const toggle = (index: number) => {
    const next = new Set(selected);
    if (next.has(index)) next.delete(index);
    else next.add(index);
    setSelected(next);
  };

  /** Runs a document change; `after` picks the selection in the result. */
  const run = async (op: PageOp, after: ReadonlySet<number>, done?: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await session.run(pageCommand(doc, op));
      setSelected(after);
      if (done) showToast(done);
    } catch (err) {
      console.warn(`selis: page operation ${op.op} failed`, err);
      showToast(t("pages.failed"), "error");
    } finally {
      setBusy(false);
    }
  };

  const needSelection = (): boolean => {
    if (selected.size > 0) return true;
    showToast(t("pages.selectFirst"));
    return false;
  };

  const rotate = () => {
    if (needSelection()) void run({ op: "rotate", indices: sorted, turns: 1 }, selected);
  };

  const duplicate = () => {
    if (!needSelection()) return;
    // Each copy lands right after its page: the copies are selected afterwards.
    const copies = new Set(sorted.map((index, k) => index + k + 1));
    void run({ op: "duplicate", indices: sorted }, copies);
  };

  const confirmDelete = () => {
    if (!needSelection()) return;
    if (allSelected) {
      showToast(t("pages.deleteAll"));
      return;
    }
    setPending("delete");
  };

  const move = (pages: number[], slot: number) => {
    if (isNoOpMove(pages, slot)) return;
    const to = moveTarget(pages, slot);
    void run({ op: "move", indices: pages, to }, new Set(pages.map((_, k) => to + k)), t("pages.moved"));
  };

  /** New pages go after the last selected page, or at the end. */
  const insertAt = sorted.length > 0 ? (sorted[sorted.length - 1] as number) + 1 : count;

  const addBlank = () => {
    setPending(null);
    const like = doc.pages[insertAt - 1] ?? doc.pages[0];
    const size = like ? { width: like.width, height: like.height } : A4;
    void run({ op: "insertBlank", at: insertAt, ...size }, new Set([insertAt]), t("pages.added", { count: 1 }));
  };

  const addPdf = async () => {
    setPending(null);
    let staged: string | null = null;
    try {
      const source = await pickPdf();
      if (!source) return;
      setBusy(true);
      staged = await api.stagePdf(source);
      const bytes = await readDocumentBytes(staged);
      const before = count;
      setBusy(false);
      await run({ op: "insertPdf", at: insertAt, bytes }, new Set());
      const added = doc.pageCount - before;
      if (added > 0) {
        setSelected(new Set(Array.from({ length: added }, (_, k) => insertAt + k)));
        showToast(t("pages.added", { count: added }));
      }
    } catch (err) {
      console.warn("selis: adding a PDF failed", err);
      showToast(t("pages.failed"), "error");
    } finally {
      setBusy(false);
      if (staged) void api.unstage(staged).catch(() => undefined);
    }
  };

  /** Each group of pages becomes a new library document. */
  const extract = async (groups: number[][]) => {
    setPending(null);
    if (busy || groups.length === 0) return;
    setBusy(true);
    try {
      for (const group of groups) {
        await extractToLibrary(doc, group, t("pages.partTitle", { title, pages: pageRanges(group) }));
      }
      refreshLibrary(queryClient);
      showToast(t("pages.extracted", { count: groups.length }));
    } catch (err) {
      console.warn("selis: extracting pages failed", err);
      showToast(t("pages.failed"), "error");
    } finally {
      setBusy(false);
    }
  };

  const undo = () => {
    session.undo().catch(() => showToast(t("annotate.failed"), "error"));
  };
  const redo = () => {
    session.redo().catch(() => showToast(t("annotate.failed"), "error"));
  };

  const splitAt = sorted.length === 1 && (sorted[0] as number) > 0 ? (sorted[0] as number) : null;
  const all = Array.from({ length: count }, (_, i) => i);

  const actions: { key: string; label: string; icon: LucideIcon; onClick: () => void; danger?: boolean }[] = [
    { key: "rotate", label: t("pages.rotate"), icon: RotateCw, onClick: rotate },
    { key: "duplicate", label: t("pages.duplicate"), icon: Copy, onClick: duplicate },
    { key: "extract", label: t("pages.extract"), icon: FileOutput, onClick: () => needSelection() && setPending("extract") },
    { key: "add", label: t("pages.addPdf"), icon: FilePlus2, onClick: () => setPending("add") },
    { key: "delete", label: t("pages.delete"), icon: Trash2, onClick: confirmDelete, danger: true },
  ];

  return (
    <div className="absolute inset-0 z-10 flex flex-col bg-page-canvas" data-testid="pages-mode">
      <header
        className="shrink-0 border-b border-neutral-5 bg-surface-app"
        style={{ paddingTop: "var(--safe-top)", paddingLeft: "var(--safe-left)", paddingRight: "var(--safe-right)" }}
        data-testid="pages-bar"
      >
        {/* Tight: "{n} επιλεγμένες" and "Επιλογή όλων" must both fit at 360 px. */}
        <div className="flex h-13 items-center pr-1 pl-1">
          <IconButton label={t("pages.close")} icon={<X size={22} strokeWidth={1.75} />} onClick={onClose} data-testid="pages-close" />
          <h1 className="min-w-0 flex-1 truncate pl-1 text-md leading-tight font-semibold text-neutral-12" aria-live="polite" data-testid="pages-selected">
            {t("pages.selected", { count: selected.size })}
          </h1>
          <IconButton
            label={t("annotate.undo")}
            icon={<Undo2 size={22} strokeWidth={1.75} />}
            onClick={undo}
            disabled={!sessionState.canUndo || busy}
            className="disabled:opacity-45"
            data-testid="pages-undo"
          />
          <IconButton
            label={t("annotate.redo")}
            icon={<Redo2 size={22} strokeWidth={1.75} />}
            onClick={redo}
            disabled={!sessionState.canRedo || busy}
            className="disabled:opacity-45"
            data-testid="pages-redo"
          />
          <button
            type="button"
            onClick={() => setSelected(allSelected ? new Set() : new Set(all))}
            className="selis-focus h-11 shrink-0 rounded-full px-1.5 text-sm font-semibold text-accent-selected active:bg-neutral-3"
            data-testid="pages-select-all"
          >
            {allSelected ? t("pages.selectNone") : t("pages.selectAll")}
          </button>
        </div>
      </header>
      <p className="shrink-0 px-5 pt-3 text-[13px] text-neutral-11" aria-live="polite" data-testid="pages-hint">
        {busy ? t("pages.working") : t("pages.hint", { count })}
      </p>
      <div className="relative min-h-0 flex-1" aria-busy={busy}>
        <PagesGrid doc={doc} structure={structure} selected={selected} onToggle={toggle} onMove={move} insetTop={0} insetBottom={24} />
      </div>
      <nav
        aria-label={t("pages.actions")}
        className="grid shrink-0 grid-cols-5 border-t border-neutral-5 bg-surface-app"
        style={{ paddingBottom: "calc(var(--safe-bottom) + 6px)", paddingLeft: "var(--safe-left)", paddingRight: "var(--safe-right)" }}
        data-testid="pages-actions"
      >
        {actions.map((a) => (
          <button
            key={a.key}
            type="button"
            onClick={a.onClick}
            disabled={busy}
            className={`selis-focus flex min-h-16 min-w-0 flex-col items-center justify-start gap-1 px-0.5 pt-2.5 pb-1.5 active:bg-neutral-3 disabled:opacity-45 ${
              a.danger ? "text-danger-9" : "text-neutral-12"
            }`}
            data-testid={`pages-${a.key}`}
          >
            <a.icon size={22} strokeWidth={1.75} aria-hidden="true" />
            {/* Two lines at most: "Προσθήκη PDF" does not fit one fifth of a phone. */}
            <span className="line-clamp-2 max-w-full text-center text-[11px] leading-[1.2] font-medium">{a.label}</span>
          </button>
        ))}
      </nav>

      <Sheet open={pending === "add"} onClose={() => setPending(null)} title={t("pages.addTitle")} testId="pages-add-sheet">
        <p className="px-5 pb-1 text-sm text-neutral-11">
          {insertAt >= count ? t("pages.addAtEnd") : t("pages.addWhere", { page: insertAt })}
        </p>
        <ul className="flex flex-col pb-2">
          <li>
            <button type="button" className={row} onClick={addBlank} data-testid="pages-add-blank">
              <FilePlus2 size={22} strokeWidth={1.75} className="text-neutral-11" aria-hidden="true" />
              <span className="flex-1">{t("pages.addBlank")}</span>
            </button>
          </li>
          <li>
            <button type="button" className={row} onClick={() => void addPdf()} data-testid="pages-add-file">
              <FileOutput size={22} strokeWidth={1.75} className="text-neutral-11" aria-hidden="true" />
              <span className="flex-1">{t("pages.addFromFile")}</span>
            </button>
          </li>
        </ul>
      </Sheet>

      <Sheet open={pending === "extract"} onClose={() => setPending(null)} title={t("pages.extractTitle")} testId="pages-extract-sheet">
        <ul className="flex flex-col">
          <li>
            <button type="button" className={row} onClick={() => void extract([sorted])} data-testid="pages-extract-selected">
              <FileOutput size={22} strokeWidth={1.75} className="text-neutral-11" aria-hidden="true" />
              <span className="flex-1">{t("pages.extractSelected")}</span>
            </button>
          </li>
          {sorted.length > 1 ? (
            <li>
              <button type="button" className={row} onClick={() => void extract(sorted.map((i) => [i]))} data-testid="pages-extract-each">
                <Copy size={22} strokeWidth={1.75} className="text-neutral-11" aria-hidden="true" />
                <span className="flex-1">{t("pages.extractEach")}</span>
              </button>
            </li>
          ) : null}
          {splitAt !== null ? (
            <li>
              <button
                type="button"
                className={`${row} py-2`}
                onClick={() => void extract([all.slice(0, splitAt), all.slice(splitAt)])}
                data-testid="pages-split"
              >
                <Scissors size={22} strokeWidth={1.75} className="text-neutral-11" aria-hidden="true" />
                <span className="flex flex-1 flex-col">
                  <span>{t("pages.split", { page: splitAt + 1 })}</span>
                  <span className="text-xs text-neutral-11">{t("pages.splitHint")}</span>
                </span>
              </button>
            </li>
          ) : null}
        </ul>
        <p className="px-5 pt-1 pb-3 text-xs text-neutral-11">{t("pages.extractNote")}</p>
      </Sheet>

      <ConfirmDialog
        open={pending === "delete"}
        danger
        title={t("pages.deleteTitle", { count: selected.size })}
        message={t("pages.deleteBody")}
        confirmLabel={t("pages.deleteConfirm")}
        cancelLabel={t("pages.deleteCancel")}
        onConfirm={() => {
          setPending(null);
          void run({ op: "delete", indices: sorted }, new Set());
        }}
        onCancel={() => setPending(null)}
        testId="pages-delete-dialog"
      />
    </div>
  );
}
