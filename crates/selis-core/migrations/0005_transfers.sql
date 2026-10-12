-- 0005: P3 transfers (ADR 0010). One row per send or receive. A receive that
-- stopped mid-way keeps `resume` (the opaque token selis-transfer needs to
-- continue it) until it finishes, fails for good or the user cancels.
CREATE TABLE transfers (
    id           TEXT PRIMARY KEY NOT NULL,                        -- uuid v7
    direction    TEXT NOT NULL CHECK (direction IN ('send', 'receive')),
    state        TEXT NOT NULL CHECK (state IN ('active', 'interrupted', 'done', 'failed', 'cancelled')),
    peer         TEXT,                                             -- the other device's endpoint id (hex)
    doc_count    INTEGER NOT NULL DEFAULT 0 CHECK (doc_count >= 0),
    total_bytes  INTEGER NOT NULL DEFAULT 0 CHECK (total_bytes >= 0),
    done_bytes   INTEGER NOT NULL DEFAULT 0 CHECK (done_bytes >= 0),
    resume       TEXT,                                             -- receive only, while resumable
    error        TEXT,                                             -- selis_transfer::TransferError, camelCase
    created_at   INTEGER NOT NULL,                                 -- unix ms
    updated_at   INTEGER NOT NULL
);
CREATE INDEX transfers_resumable ON transfers (updated_at) WHERE resume IS NOT NULL;
