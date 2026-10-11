/**
 * Viewer chrome per docs/design/p1-ui-brief.md §2: top bar, page chip, scrubber,
 * floating dock, search bar.
 */
import { IconButton } from "@selis/ui";
import {
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  Files,
  MoreVertical,
  PenLine,
  Search,
  Send,
  Share2,
  Signature,
  X,
} from "lucide-react";
import { forwardRef, type PointerEvent, type ReactNode, useId, useRef } from "react";
import { useTranslation } from "react-i18next";

type TopBarProps = {
  title: string;
  subtitle: string;
  onBack: () => void;
  onSearch: () => void;
  onMore: () => void;
  hidden: boolean;
};

/** safe-top + 52 px, surface-app, 1 px bottom border. */
export const ViewerTopBar = forwardRef<HTMLElement, TopBarProps>(function ViewerTopBar(
  { title, subtitle, onBack, onSearch, onMore, hidden },
  ref,
) {
  const { t } = useTranslation();
  return (
    <header
      ref={ref}
      className="absolute inset-x-0 top-0 z-10 border-b border-neutral-5 bg-surface-app transition-transform duration-200 ease-standard"
      style={{
        paddingTop: "var(--safe-top)",
        paddingLeft: "var(--safe-left)",
        paddingRight: "var(--safe-right)",
        transform: hidden ? "translateY(-100%)" : "none",
      }}
    >
      <div className="flex h-13 items-center gap-1 px-1">
        <IconButton label={t("viewer.back")} icon={<ArrowLeft size={22} strokeWidth={1.75} />} onClick={onBack} />
        <div className="flex min-w-0 flex-1 flex-col">
          <h1 className="truncate text-md leading-tight font-semibold text-neutral-12">{title}</h1>
          <p className="truncate text-xs text-neutral-11 tabular-nums" data-testid="page-indicator">
            {subtitle}
          </p>
        </div>
        <IconButton label={t("viewer.search")} icon={<Search size={22} strokeWidth={1.75} />} onClick={onSearch} />
        <IconButton
          label={t("viewer.more")}
          icon={<MoreVertical size={22} strokeWidth={1.75} />}
          onClick={onMore}
          aria-haspopup="dialog"
        />
      </div>
    </header>
  );
});

type SearchBarProps = {
  query: string;
  onQuery: (q: string) => void;
  onClose: () => void;
  onNext: () => void;
  onPrevious: () => void;
  /** "3 / 17", "No matches", "Searching…" */
  status: string;
  canStep: boolean;
};

export const ViewerSearchBar = forwardRef<HTMLElement, SearchBarProps>(function ViewerSearchBar(
  { query, onQuery, onClose, onNext, onPrevious, status, canStep },
  ref,
) {
  const { t } = useTranslation();
  const inputId = useId();
  return (
    <header
      ref={ref}
      className="absolute inset-x-0 top-0 z-10 border-b border-neutral-5 bg-surface-app"
      style={{ paddingTop: "var(--safe-top)", paddingLeft: "var(--safe-left)", paddingRight: "var(--safe-right)" }}
      data-testid="viewer-search"
    >
      <div className="flex h-13 items-center gap-1 px-1">
        <IconButton label={t("viewer.searchClose")} icon={<X size={22} strokeWidth={1.75} />} onClick={onClose} />
        <label htmlFor={inputId} className="sr-only">
          {t("viewer.searchLabel")}
        </label>
        <input
          id={inputId}
          type="search"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              if (e.shiftKey) onPrevious();
              else onNext();
            }
          }}
          placeholder={t("viewer.searchPlaceholder")}
          autoFocus
          enterKeyHint="search"
          autoComplete="off"
          spellCheck={false}
          className="selis-focus h-11 min-w-0 flex-1 rounded-full bg-neutral-3 px-4 text-md text-neutral-12 placeholder:text-neutral-9 [&::-webkit-search-cancel-button]:hidden"
        />
        <span className="shrink-0 px-1 text-xs text-neutral-11 tabular-nums" aria-live="polite" data-testid="search-status">
          {status}
        </span>
        <IconButton
          label={t("viewer.searchPrevious")}
          icon={<ChevronUp size={22} strokeWidth={1.75} />}
          onClick={onPrevious}
          disabled={!canStep}
        />
        <IconButton label={t("viewer.searchNext")} icon={<ChevronDown size={22} strokeWidth={1.75} />} onClick={onNext} disabled={!canStep} />
      </div>
    </header>
  );
});

/** "3 / 12" under the bar on the right; fades out 1.5 s after scrolling stops. */
export function PageChip({ page, total, top, visible }: { page: number; total: number; top: number; visible: boolean }) {
  return (
    <span
      aria-hidden="true"
      data-testid="page-chip"
      className="pointer-events-none absolute z-10 rounded-[12px] px-2.5 py-1 text-xs font-semibold text-white tabular-nums transition-opacity duration-200 ease-standard"
      style={{
        top: top + 12,
        right: "calc(var(--safe-right) + 24px)",
        background: "rgb(33 31 26 / 0.74)",
        opacity: visible ? 1 : 0,
      }}
    >
      {page} / {total}
    </span>
  );
}

type ScrubberProps = {
  fraction: number;
  top: number;
  bottom: number;
  visible: boolean;
  label: string;
  onSeek: (fraction: number) => void;
  onDragging: (dragging: boolean) => void;
};

const THUMB = 44;

/** Right-edge fast seek: 4 px track, 44 px thumb, 44 px wide hit area. */
export function Scrubber({ fraction, top, bottom, visible, label, onSeek, onDragging }: ScrubberProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const seekTo = (clientY: number) => {
    const track = trackRef.current;
    if (!track) return;
    const rect = track.getBoundingClientRect();
    const usable = Math.max(1, rect.height - THUMB);
    onSeek(Math.min(1, Math.max(0, (clientY - rect.top - THUMB / 2) / usable)));
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    dragging.current = true;
    event.currentTarget.setPointerCapture(event.pointerId);
    onDragging(true);
    seekTo(event.clientY);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (dragging.current) seekTo(event.clientY);
  };
  const end = () => {
    if (!dragging.current) return;
    dragging.current = false;
    onDragging(false);
  };

  return (
    <div
      ref={trackRef}
      role="slider"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(fraction * 100)}
      tabIndex={-1}
      data-testid="scrubber"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onClick={(e) => e.stopPropagation()}
      className="absolute z-10 w-11 touch-none transition-opacity duration-200 ease-standard"
      style={{ top, bottom, right: "var(--safe-right)", opacity: visible ? 1 : 0, pointerEvents: visible ? "auto" : "none" }}
    >
      <span className="absolute top-0 right-2 bottom-0 w-1 rounded-full bg-neutral-12/15" aria-hidden="true" />
      <span
        aria-hidden="true"
        className="absolute right-1 w-2.5 rounded-full bg-neutral-11 shadow-2"
        style={{ height: THUMB, top: `calc(${fraction} * (100% - ${THUMB}px))` }}
      />
    </div>
  );
}

type DockItem = { key: string; label: string; icon: ReactNode; soon: boolean; onClick: () => void };

/** Floating dock: 64 high, radius 20, 5 equal items (P2/P3 ones disabled, "Σύντομα"). */
export function ViewerDock({ hidden, onSoon, onShare }: { hidden: boolean; onSoon: () => void; onShare: () => void }) {
  const { t } = useTranslation();
  const icon = (Icon: typeof PenLine) => <Icon size={22} strokeWidth={1.75} aria-hidden="true" />;
  const items: DockItem[] = [
    { key: "annotate", label: t("viewer.dockAnnotate"), icon: icon(PenLine), soon: true, onClick: onSoon },
    { key: "sign", label: t("viewer.dockSign"), icon: icon(Signature), soon: true, onClick: onSoon },
    { key: "pages", label: t("viewer.dockPages"), icon: icon(Files), soon: true, onClick: onSoon },
    { key: "send", label: t("viewer.dockSend"), icon: icon(Send), soon: true, onClick: onSoon },
    { key: "share", label: t("viewer.dockShare"), icon: icon(Share2), soon: false, onClick: onShare },
  ];
  return (
    <nav
      aria-label={t("viewer.dock")}
      data-testid="viewer-dock"
      className="absolute z-10 grid h-16 grid-cols-5 rounded-[20px] border border-neutral-5 bg-surface-raised shadow-3 transition-transform duration-200 ease-standard"
      style={{
        left: "calc(var(--safe-left) + 16px)",
        right: "calc(var(--safe-right) + 16px)",
        bottom: "calc(var(--safe-bottom) + 28px)",
        transform: hidden ? "translateY(calc(100% + var(--safe-bottom) + 40px))" : "none",
      }}
    >
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            item.onClick();
          }}
          aria-disabled={item.soon || undefined}
          aria-describedby={item.soon ? "viewer-soon-hint" : undefined}
          title={item.soon ? t("viewer.soon") : item.label}
          className={`selis-focus flex min-w-0 flex-col items-center justify-center gap-1 rounded-[20px] ${
            item.soon ? "text-neutral-9" : "text-neutral-12 active:bg-neutral-3"
          }`}
        >
          {item.icon}
          <span className="max-w-full truncate px-0.5 text-[11px] font-medium">{item.label}</span>
        </button>
      ))}
      <span id="viewer-soon-hint" className="sr-only">
        {t("viewer.soon")}
      </span>
    </nav>
  );
}
