/**
 * Inline editors on the page in annotate mode: the typed-text box and the
 * sticky-note popover (docs/design/p1-ui-brief.md §3: 150 px wide, #fff6d6,
 * border #ecd48a, radius 8, title "Σημείωση" 600).
 */
import { X } from "lucide-react";
import { type CSSProperties, type RefObject, useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

const KEEP_CLEAR: CSSProperties = {
  scrollMarginTop: "calc(var(--selis-cover-top, 0px) + 8px)",
  scrollMarginBottom: "calc(var(--selis-cover-bottom, 0px) + 8px)",
};

/** Brief: 150 px. Greek "Αποθήκευση" + "Διαγραφή" as 44 px targets need a bit more. */
const NOTE_WIDTH = 200;

type TextEditorProps = {
  left: number;
  top: number;
  width: number;
  /** CSS px, matches the size the text will have on the page. */
  fontSize: number;
  color: string;
  onDone: (text: string) => void;
  onCancel: () => void;
};

/**
 * Keeps an inline editor (box + its buttons) in view: when it opens and when the
 * viewport shrinks for the on-screen keyboard, which on a phone otherwise pushes
 * "Add" under the mode's sheet. The sheet and the top bar lie over the pages, so
 * the editor's scroll margins (KEEP_CLEAR) are what they cover (set by the viewer).
 */
function useKeepInView(): RefObject<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const reveal = () => ref.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
    reveal();
    const viewport = window.visualViewport;
    viewport?.addEventListener("resize", reveal);
    window.addEventListener("resize", reveal);
    return () => {
      viewport?.removeEventListener("resize", reveal);
      window.removeEventListener("resize", reveal);
    };
  }, []);
  return ref;
}

export function TextEditor({ left, top, width, fontSize, color, onDone, onCancel }: TextEditorProps) {
  const { t } = useTranslation();
  const id = useId();
  const [text, setText] = useState("");
  const ref = useKeepInView();
  return (
    <div
      ref={ref}
      className="absolute z-10 flex flex-col gap-1"
      style={{ ...KEEP_CLEAR, left, top, width: Math.max(width, 160) }}
      onPointerDown={(e) => e.stopPropagation()}
      data-testid="text-editor"
    >
      <label htmlFor={id} className="sr-only">
        {t("annotate.textLabel")}
      </label>
      <textarea
        id={id}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") onCancel();
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) onDone(text);
        }}
        placeholder={t("annotate.textPlaceholder")}
        autoFocus
        rows={2}
        className="selis-focus resize-none rounded-[4px] border border-dashed border-accent-9 bg-white/85 p-0.5 leading-[1.36] outline-none"
        style={{ width, fontSize: Math.max(12, fontSize), color }}
        data-testid="text-editor-input"
      />
      <div className="flex gap-2 self-start rounded-full bg-surface-raised p-1 shadow-2">
        <button
          type="button"
          onClick={onCancel}
          className="selis-focus h-11 rounded-full px-4 text-sm font-medium text-neutral-11 active:bg-neutral-3"
        >
          {t("annotate.cancel")}
        </button>
        <button
          type="button"
          onClick={() => onDone(text)}
          disabled={text.trim() === ""}
          className="selis-focus h-11 rounded-full bg-accent-9 px-4 text-sm font-semibold text-accent-contrast disabled:opacity-45"
          data-testid="text-editor-add"
        >
          {t("annotate.textAdd")}
        </button>
      </div>
    </div>
  );
}

type NoteEditorProps = {
  /** Point under the note icon, CSS px within the page. */
  anchorLeft: number;
  anchorTop: number;
  pageWidth: number;
  initial: string;
  canDelete: boolean;
  onSave: (text: string) => void;
  onDelete: () => void;
  onCancel: () => void;
};

export function NoteEditor({ anchorLeft, anchorTop, pageWidth, initial, canDelete, onSave, onDelete, onCancel }: NoteEditorProps) {
  const { t } = useTranslation();
  const id = useId();
  const titleId = useId();
  const [text, setText] = useState(initial);
  const width = Math.min(NOTE_WIDTH, pageWidth - 8);
  const left = Math.min(Math.max(4, anchorLeft), Math.max(4, pageWidth - width - 4));
  const ref = useKeepInView();
  return (
    <div
      ref={ref}
      role="dialog"
      aria-labelledby={titleId}
      className="absolute z-10 flex flex-col gap-1.5 rounded-[8px] border border-note-border bg-note-paper p-2 text-note-ink shadow-2"
      style={{ ...KEEP_CLEAR, left, top: anchorTop + 4, width }}
      onPointerDown={(e) => e.stopPropagation()}
      data-testid="note-editor"
    >
      <div className="-mt-1 -mr-1 flex items-center justify-between">
        <h3 id={titleId} className="text-sm font-semibold">
          {t("annotate.noteTitle")}
        </h3>
        <button
          type="button"
          onClick={onCancel}
          aria-label={t("annotate.cancel")}
          title={t("annotate.cancel")}
          className="selis-focus flex size-11 items-center justify-center rounded-full active:bg-black/5"
          data-testid="note-editor-cancel"
        >
          <X size={20} strokeWidth={1.75} aria-hidden="true" />
        </button>
      </div>
      <label htmlFor={id} className="sr-only">
        {t("annotate.noteLabel")}
      </label>
      <textarea
        id={id}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") onCancel();
        }}
        placeholder={t("annotate.notePlaceholder")}
        autoFocus
        rows={3}
        className="selis-focus resize-none rounded-[4px] bg-white/60 p-1 text-sm outline-none placeholder:text-note-muted"
        data-testid="note-editor-input"
      />
      <div className="flex justify-between gap-1">
        {canDelete ? (
          <button
            type="button"
            onClick={onDelete}
            className="selis-focus h-11 rounded-full px-3 text-sm font-medium text-note-danger active:bg-black/5"
            data-testid="note-editor-delete"
          >
            {t("annotate.noteDelete")}
          </button>
        ) : (
          <span />
        )}
        <button
          type="button"
          onClick={() => onSave(text)}
          className="selis-focus h-11 rounded-full px-3 text-sm font-semibold text-note-action active:bg-black/5"
          data-testid="note-editor-save"
        >
          {t("annotate.noteSave")}
        </button>
      </div>
    </div>
  );
}
