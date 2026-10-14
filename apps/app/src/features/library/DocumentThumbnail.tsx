import { Skeleton } from "@selis/ui";
import { useQueryClient } from "@tanstack/react-query";
import { LockKeyhole } from "lucide-react";
import { useEffect, useState } from "react";
import { DocumentGlyph } from "../../components/Illustrations";
import type { Document } from "../../lib/api";
import { assetUrl } from "../../lib/files";
import { requestThumbnail, thumbnailBroken, useThumbnailStatus } from "./thumbnails";

type Variant = "card" | "row";

/** Box the page image fits in (CSS px); the skeleton has exactly this size. */
const BOX: Record<Variant, { width: number; height: number }> = {
  card: { width: 128, height: 176 },
  row: { width: 40, height: 52 },
};

/**
 * Page-1 preview: skeleton while it is being made, the cached image once it
 * exists, a document glyph if it cannot be made. The box never changes size.
 */
export function DocumentThumbnail({ doc, variant }: { doc: Document; variant: Variant }) {
  const queryClient = useQueryClient();
  const failed = useThumbnailStatus((s) => s.failed.has(doc.id));
  const locked = useThumbnailStatus((s) => s.locked.has(doc.id));
  const [loadedPath, setLoadedPath] = useState<string | null>(null);
  const box = BOX[variant];

  useEffect(() => {
    if (doc.thumbnailPath === null && !failed) requestThumbnail(queryClient, doc);
    // Re-run only when the thumbnail state changes, not for every field of `doc`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.id, doc.thumbnailPath, failed, queryClient]);

  const path = doc.thumbnailPath;
  const loaded = path !== null && loadedPath === path;

  if (path === null && failed) {
    return (
      <span className="flex items-center justify-center" style={box} aria-hidden="true" data-testid={locked ? "thumbnail-locked" : undefined}>
        {locked ? (
          <span className="flex size-16 items-center justify-center rounded-[12px] bg-neutral-3 text-neutral-11">
            <LockKeyhole size={32} strokeWidth={1.75} />
          </span>
        ) : (
          <DocumentGlyph />
        )}
      </span>
    );
  }

  return (
    <span className="relative flex items-center justify-center" style={box} aria-hidden="true">
      {loaded ? null : <Skeleton className="absolute inset-0 rounded-[3px]" />}
      {path ? (
        <img
          key={path}
          src={assetUrl(path)}
          alt=""
          decoding="async"
          draggable={false}
          onLoad={() => setLoadedPath(path)}
          onError={() => thumbnailBroken(queryClient, doc)}
          className={`relative max-h-full max-w-full rounded-[3px] bg-white shadow-1 transition-opacity duration-150 ease-standard ${
            loaded ? "opacity-100" : "opacity-0"
          }`}
        />
      ) : null}
    </span>
  );
}
