-- 0002: P1 library — origin (received via transfer), reading position,
-- thumbnail cache bookkeeping, tags.
ALTER TABLE documents ADD COLUMN origin TEXT NOT NULL DEFAULT 'import'
    CHECK (origin IN ('import', 'received'));
ALTER TABLE documents ADD COLUMN last_page INTEGER CHECK (last_page >= 0);
-- thumbnail_path (0001) is relative to the library root; bytes/used_at drive the LRU.
ALTER TABLE documents ADD COLUMN thumbnail_bytes INTEGER NOT NULL DEFAULT 0
    CHECK (thumbnail_bytes >= 0);
ALTER TABLE documents ADD COLUMN thumbnail_used_at INTEGER;

CREATE INDEX documents_favorite ON documents (favorite) WHERE favorite = 1;
CREATE INDEX documents_thumbnail_lru ON documents (thumbnail_used_at)
    WHERE thumbnail_path IS NOT NULL;

CREATE TABLE tags (
    id          TEXT PRIMARY KEY NOT NULL,   -- uuid v7
    name        TEXT NOT NULL,
    name_key    TEXT NOT NULL UNIQUE,        -- selis_fold(name): one tag per spelling
    created_at  INTEGER NOT NULL
);

CREATE TABLE document_tags (
    document_id  TEXT NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
    tag_id       TEXT NOT NULL REFERENCES tags (id) ON DELETE CASCADE,
    PRIMARY KEY (document_id, tag_id)
) WITHOUT ROWID;
CREATE INDEX document_tags_tag ON document_tags (tag_id);
