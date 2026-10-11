-- 0004: P2 visual signatures, kept locally and reused (docs/SPEC.md, `signatures`).
CREATE TABLE signatures (
    id          TEXT PRIMARY KEY NOT NULL,                       -- uuid, chosen by the UI (idempotent saves)
    kind        TEXT NOT NULL CHECK (kind IN ('drawn', 'typed', 'image')),
    file_path   TEXT NOT NULL,                                   -- signatures/<id>.png, relative to the library root
    width       INTEGER NOT NULL CHECK (width > 0),
    height      INTEGER NOT NULL CHECK (height > 0),
    created_at  INTEGER NOT NULL                                 -- unix ms
);
