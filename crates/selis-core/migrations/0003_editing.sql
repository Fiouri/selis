-- 0003: P2 editing — autosaved working copies (crash recovery); edited documents
-- may end up with the same content as another document, so hashes repeat.
CREATE TABLE working_copies (
    document_id  TEXT PRIMARY KEY NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
    base_blake3  TEXT NOT NULL,                    -- the version the edits started from
    size_bytes   INTEGER NOT NULL CHECK (size_bytes >= 0),
    saved_at     INTEGER NOT NULL                  -- unix ms
);

DROP INDEX documents_blake3_imported;
CREATE INDEX documents_blake3 ON documents (blake3);
