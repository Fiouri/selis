-- 0001: library index, versions, settings.
CREATE TABLE documents (
    id              TEXT PRIMARY KEY NOT NULL,        -- uuid v7
    title           TEXT NOT NULL,                    -- '' = untitled (UI shows a localized label)
    kind            TEXT NOT NULL CHECK (kind IN ('imported', 'linked')),
    location        TEXT NOT NULL,                    -- imported: path relative to the library root
    blake3          TEXT NOT NULL,
    size_bytes      INTEGER NOT NULL CHECK (size_bytes >= 0),
    page_count      INTEGER,
    created_at      INTEGER NOT NULL,                 -- unix ms
    modified_at     INTEGER NOT NULL,
    last_opened_at  INTEGER,
    favorite        INTEGER NOT NULL DEFAULT 0 CHECK (favorite IN (0, 1)),
    thumbnail_path  TEXT
);
CREATE UNIQUE INDEX documents_blake3_imported ON documents (blake3) WHERE kind = 'imported';
CREATE INDEX documents_last_opened ON documents (last_opened_at);

CREATE TABLE versions (
    id           TEXT PRIMARY KEY NOT NULL,
    document_id  TEXT NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
    seq          INTEGER NOT NULL CHECK (seq >= 1),
    blake3       TEXT NOT NULL,
    size_bytes   INTEGER NOT NULL CHECK (size_bytes >= 0),
    created_at   INTEGER NOT NULL,
    label        TEXT NOT NULL CHECK (label IN ('auto', 'manual', 'received')),
    file_path    TEXT NOT NULL,
    UNIQUE (document_id, seq)
);

CREATE TABLE settings (
    key    TEXT PRIMARY KEY NOT NULL,
    value  TEXT NOT NULL CHECK (json_valid(value))
);
