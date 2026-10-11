import { Skeleton } from "@selis/ui";
import { Star } from "lucide-react";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLongPress } from "../../components/useLongPress";
import type { Document, LibraryView } from "../../lib/api";
import { relativeDay } from "../../lib/dates";
import { useNavigation } from "../../state/navigation";
import { DocumentMenu } from "./DocumentMenu";
import { DocumentThumbnail } from "./DocumentThumbnail";
import { documentTitle } from "./importFeedback";

const THUMB_AREA_HEIGHT = 212;
const ROW_HEIGHT = 72;

function useMeta() {
  const { t, i18n } = useTranslation();
  return (doc: Document, dateOf: (doc: Document) => number) => {
    const size =
      doc.pageCount !== null
        ? t("library.pagesShort", { count: doc.pageCount })
        : new Intl.NumberFormat(i18n.language, {
            style: "unit",
            unit: doc.sizeBytes >= 1024 * 1024 ? "megabyte" : "kilobyte",
            unitDisplay: "short",
            maximumFractionDigits: 1,
          }).format(doc.sizeBytes >= 1024 * 1024 ? doc.sizeBytes / (1024 * 1024) : Math.max(doc.sizeBytes / 1024, 0.1));
    return `${size} · ${relativeDay(dateOf(doc), Date.now(), i18n.language)}`;
  };
}

/** Last activity: opened, else imported. */
export function activityDate(doc: Document): number {
  return Math.max(doc.lastOpenedAt ?? 0, doc.createdAt);
}

type ItemProps = {
  doc: Document;
  meta: string;
  onOpen: (id: string) => void;
  onMenu: (doc: Document) => void;
};

function Badges({ doc }: { doc: Document }) {
  const { t } = useTranslation();
  return (
    <>
      {doc.received ? (
        <span className="absolute top-2.5 left-2.5 rounded-full bg-accent-3 px-2 py-0.5 text-[11px] font-semibold text-accent-selected">
          {t("library.received")}
        </span>
      ) : null}
      {doc.favorite ? (
        <Star
          size={18}
          strokeWidth={1.75}
          className="absolute top-2.5 right-2.5 fill-warning-9 text-warning-9"
          aria-hidden="true"
          data-testid="favorite-badge"
        />
      ) : null}
    </>
  );
}

function DocumentCard({ doc, meta, onOpen, onMenu }: ItemProps) {
  const { t } = useTranslation();
  const describedBy = useId();
  const press = useLongPress(() => onMenu(doc));
  const title = documentTitle(doc, t("library.untitled"));
  return (
    <li>
      <button
        type="button"
        {...press}
        onClick={() => onOpen(doc.id)}
        aria-label={t("library.openDocument", { title })}
        aria-describedby={describedBy}
        data-testid="document-card"
        className="selis-focus group flex w-full flex-col rounded-card text-left"
      >
        <span
          className="relative flex w-full items-center justify-center rounded-card bg-neutral-3 transition-colors duration-150 ease-standard group-active:bg-neutral-4"
          style={{ height: THUMB_AREA_HEIGHT }}
        >
          <DocumentThumbnail doc={doc} variant="card" />
          <Badges doc={doc} />
        </span>
        <span className="mt-2 line-clamp-2 text-sm leading-[1.35] font-semibold text-neutral-12">{title}</span>
        <span id={describedBy} className="mt-0.5 truncate text-xs text-neutral-11">
          {meta}
          {doc.favorite ? <span className="sr-only">, {t("library.favorite")}</span> : null}
          {doc.received ? <span className="sr-only">, {t("library.received")}</span> : null}
        </span>
      </button>
    </li>
  );
}

function DocumentRow({ doc, meta, onOpen, onMenu }: ItemProps) {
  const { t } = useTranslation();
  const describedBy = useId();
  const press = useLongPress(() => onMenu(doc));
  const title = documentTitle(doc, t("library.untitled"));
  return (
    <li>
      <button
        type="button"
        {...press}
        onClick={() => onOpen(doc.id)}
        aria-label={t("library.openDocument", { title })}
        aria-describedby={describedBy}
        data-testid="document-row"
        style={{ minHeight: ROW_HEIGHT }}
        className="selis-focus flex w-full items-center gap-3 rounded-[14px] border border-neutral-5 bg-surface-raised px-3 text-left transition-colors duration-150 ease-standard active:bg-neutral-3"
      >
        <span className="flex size-13 shrink-0 items-center justify-center rounded-control bg-neutral-3">
          <DocumentThumbnail doc={doc} variant="row" />
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-semibold text-neutral-12">{title}</span>
          <span id={describedBy} className="truncate text-xs text-neutral-11">
            {meta}
            {doc.favorite ? <span className="sr-only">, {t("library.favorite")}</span> : null}
            {doc.received ? <span className="sr-only">, {t("library.received")}</span> : null}
          </span>
        </span>
        {doc.received ? (
          <span className="shrink-0 rounded-full bg-accent-3 px-2 py-0.5 text-[11px] font-semibold text-accent-selected" aria-hidden="true">
            {t("library.received")}
          </span>
        ) : null}
        {doc.favorite ? (
          <Star size={18} strokeWidth={1.75} className="shrink-0 fill-warning-9 text-warning-9" aria-hidden="true" data-testid="favorite-badge" />
        ) : null}
      </button>
    </li>
  );
}

type Props = {
  documents: readonly Document[];
  view: LibraryView;
  /** Date shown in the metadata line (Recent shows "last opened"). */
  dateOf?: (doc: Document) => number;
  /** Extra space under the last row (e.g. for the import button). */
  bottomInset?: number;
};

/** 2-column grid of cards (or a list), with the long-press menu. */
export function DocumentCollection({ documents, view, dateOf = activityDate, bottomInset = 16 }: Props) {
  const meta = useMeta();
  const openDocument = useNavigation((s) => s.openDocument);
  const [menuFor, setMenuFor] = useState<Document | null>(null);
  // The menu follows cache updates (favorite / tags change under it).
  const current = menuFor ? (documents.find((d) => d.id === menuFor.id) ?? menuFor) : null;

  const items = documents.map((doc) => {
    const props = { doc, meta: meta(doc, dateOf), onOpen: openDocument, onMenu: setMenuFor };
    return view === "grid" ? <DocumentCard key={doc.id} {...props} /> : <DocumentRow key={doc.id} {...props} />;
  });

  return (
    <>
      <ul
        className={view === "grid" ? "grid grid-cols-2 gap-x-4 gap-y-5 px-5" : "flex flex-col gap-2 px-5"}
        style={{ paddingBottom: bottomInset }}
        data-testid="document-collection"
        data-view={view}
      >
        {items}
      </ul>
      <DocumentMenu doc={current} onClose={() => setMenuFor(null)} />
    </>
  );
}

/** Same geometry as real cards/rows, so nothing moves when data arrives. */
export function DocumentCollectionSkeleton({ view, count = 4 }: { view: LibraryView; count?: number }) {
  return (
    <ul
      className={view === "grid" ? "grid grid-cols-2 gap-x-4 gap-y-5 px-5" : "flex flex-col gap-2 px-5"}
      aria-busy="true"
    >
      {Array.from({ length: count }, (_, i) =>
        view === "grid" ? (
          <li key={i} className="flex flex-col">
            <Skeleton className="w-full rounded-card" style={{ height: THUMB_AREA_HEIGHT }} />
            <Skeleton className="mt-2 h-4 w-4/5" />
            <Skeleton className="mt-1.5 h-3 w-1/2" />
          </li>
        ) : (
          <li key={i}>
            <div className="flex items-center gap-3 rounded-[14px] border border-neutral-5 bg-surface-raised px-3" style={{ height: ROW_HEIGHT }}>
              <Skeleton className="size-13" />
              <div className="flex flex-1 flex-col gap-2">
                <Skeleton className="h-4 w-3/5" />
                <Skeleton className="h-3 w-2/5" />
              </div>
            </div>
          </li>
        ),
      )}
    </ul>
  );
}
