# selis-transfer

Peer-to-peer document transfer for Selis, planned for **P3** (see `docs/SPEC.md`, "Μεταφορά αρχείων χωρίς λογαριασμό").

- Transport: [iroh](https://iroh.computer) 1.x + iroh-blobs, ALPN `selis/transfer/1`.
- Device identity: a locally generated Ed25519 key in OS secure storage. No accounts.
- Discovery order: mDNS on the same Wi-Fi → QUIC hole punching → n0 public relay (optional, user-controllable).
- The endpoint is opened only while the Transfer screen is visible.

**Boundary rule:** this is the only crate in the workspace allowed to open network connections.
Nothing here runs at app startup.

Currently an empty library so the workspace layout and CI are in place. See `docs/adr/0003-iroh-transfer.md`.
