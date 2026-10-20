-- 0008: content erase (ADR 0033). A version written by the Erase tool is labelled 'erase'.
-- SQLite cannot change a CHECK constraint in place, so the versions table is rebuilt with
-- the same columns and rows (no other table refers to it).
CREATE TABLE versions_new (
    id           TEXT PRIMARY KEY NOT NULL,
    document_id  TEXT NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
    seq          INTEGER NOT NULL CHECK (seq >= 1),
    blake3       TEXT NOT NULL,
    size_bytes   INTEGER NOT NULL CHECK (size_bytes >= 0),
    created_at   INTEGER NOT NULL,
    label        TEXT NOT NULL CHECK (label IN ('auto', 'manual', 'received', 'erase')),
    file_path    TEXT NOT NULL,
    UNIQUE (document_id, seq)
);
INSERT INTO versions_new (id, document_id, seq, blake3, size_bytes, created_at, label, file_path)
    SELECT id, document_id, seq, blake3, size_bytes, created_at, label, file_path FROM versions;
DROP TABLE versions;
ALTER TABLE versions_new RENAME TO versions;
