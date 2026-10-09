import { Skeleton } from "@selis/ui";
import { ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import { DocumentGlyph } from "../../components/Illustrations";
import type { Document } from "../../lib/api";

const ROW_HEIGHT = 72;

export function documentTitle(doc: Document, untitled: string): string {
  return doc.title.trim() || untitled;
}

function useFileSize() {
  const { i18n } = useTranslation();
  return (bytes: number) => {
    const mb = bytes / (1024 * 1024);
    const [value, unit] = mb >= 1 ? [mb, "megabyte"] : [Math.max(bytes / 1024, 0.1), "kilobyte"];
    return new Intl.NumberFormat(i18n.language, {
      style: "unit",
      unit,
      unitDisplay: "short",
      maximumFractionDigits: 1,
    }).format(value);
  };
}

type Props = {
  documents: readonly Document[];
  activeId?: string | null;
  onOpen: (id: string) => void;
};

export function DocumentList({ documents, activeId = null, onOpen }: Props) {
  const { t } = useTranslation();
  const fileSize = useFileSize();
  return (
    <ul className="flex flex-col gap-2 px-4 pb-4" data-testid="document-list">
      {documents.map((doc) => {
        const title = documentTitle(doc, t("library.untitled"));
        const meta = [doc.pageCount !== null ? t("library.pages", { count: doc.pageCount }) : null, fileSize(doc.sizeBytes)]
          .filter(Boolean)
          .join(" · ");
        const active = doc.id === activeId;
        return (
          <li key={doc.id}>
            <button
              type="button"
              onClick={() => onOpen(doc.id)}
              aria-label={t("library.openDocument", { title })}
              aria-current={active ? "true" : undefined}
              style={{ minHeight: ROW_HEIGHT }}
              className={`selis-focus flex w-full items-center gap-3 rounded-card border px-3 text-left transition-colors duration-150 ease-standard ${
                active
                  ? "border-accent-7 bg-accent-3"
                  : "border-neutral-5 bg-surface-raised hover:bg-neutral-2 active:bg-neutral-3"
              }`}
            >
              <DocumentGlyph />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-md font-medium text-neutral-12">{title}</span>
                <span className="truncate text-sm text-neutral-11">{meta}</span>
              </span>
              <ChevronRight size={20} strokeWidth={1.75} className="shrink-0 text-neutral-9" aria-hidden="true" />
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** Same geometry as real rows so nothing moves when data arrives. */
export function DocumentListSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <ul className="flex flex-col gap-2 px-4 pb-4" aria-busy="true">
      {Array.from({ length: rows }, (_, i) => (
        <li key={i}>
          <div
            className="flex items-center gap-3 rounded-card border border-neutral-5 bg-surface-raised px-3"
            style={{ height: ROW_HEIGHT }}
          >
            <Skeleton className="h-12 w-10" />
            <div className="flex flex-1 flex-col gap-2">
              <Skeleton className="h-4 w-3/5" />
              <Skeleton className="h-3 w-2/5" />
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}
