-- 0006: P3b trusted devices (ADR 0014). A device saved after a transfer: it may
-- send here without QR code or code while the Receive screen is open, and a
-- send to it skips the code. Removing it ends both at once.
CREATE TABLE trusted_devices (
    endpoint_id   TEXT PRIMARY KEY NOT NULL,       -- iroh endpoint id (Ed25519 public key, hex)
    name          TEXT NOT NULL,
    added_at      INTEGER NOT NULL,                -- unix ms
    last_seen_at  INTEGER                          -- last transfer with it (unix ms)
);
