# Privacy

Selis collects nothing: no account, no analytics, no crash reporting, no advertising, no
identifiers sent anywhere. Your library stays in the app's private storage on your device.

## Network use

Selis opens **no** network connection at startup or while you read and edit. The only part
that uses the network is **Transfer** (device to device), and only while the Transfer screen is
open — or while a transfer you started is still running (Android shows a notification then).

When you send or receive documents:

- The two devices connect **directly** when they can (same Wi‑Fi, or across networks by QUIC
  hole punching). Documents are end-to-end encrypted (QUIC with TLS 1.3); both screens show the
  same 6-digit code, which the sender confirms before anything is sent.
- If no direct path works, the encrypted traffic goes through a **relay**. By default that is a
  public relay run by n0 (the makers of iroh), and n0's address-lookup service (DNS/pkarr) is
  used to find the other device. The relay and the lookup service **see your IP address** and
  the other device's public key during the transfer; they **cannot read** the documents.
- **Settings › Transfer › Local network only** turns the relay and the address lookup off:
  devices find each other on the same Wi‑Fi (mDNS) only.
- **Settings › Transfer › Relay** lets you use your own relay (`iroh-relay`) instead of n0's;
  then no n0 server is contacted at all.

The QR code / link contains your device's network addresses (local and public IP, relay), the
documents' content hash and a one-time code valid for 10 minutes. Share it only with the device
you are sending to.

## Trusted devices and library move

- A device you save after a transfer is stored as a name and its public key, on this device
  only. It can then send here without QR code — but only while your Receive tab is open — and
  sends to it skip the code. Remove it at any time (× next to it); it takes effect at once.
- Moving your library sends your documents, versions, tags, favorites, signatures and settings
  to your other device, end-to-end encrypted, as any transfer. Your device key is not moved.

## Selis pack files (.selispack)

- **Save as file** (Send tab) writes the chosen documents, or the whole library, into one
  `.selispack` file and hands it to the app you pick in the share sheet (USB, e-mail, your own
  cloud). Selis uses no network for this; where the file goes is your choice.
- Without a passphrase the file is **not encrypted**: anyone who has it can read the documents.
  With a passphrase it is encrypted (Argon2id + XChaCha20-Poly1305, ADR 0012); the passphrase is
  never stored, and without it the file cannot be opened — there is no recovery.
- A whole-library file also carries your tags, favorites, signatures and settings, never your
  device key or trusted devices.
- On Android the file stays in the app's private share folder until the receiving app has read
  it; Selis deletes it there after a day. Opening a pack reads a private copy, which is deleted
  right after.

## Device identity

Each device has its own key (Ed25519), made on the device and kept in the system's secure
storage (Android Keystore, iOS / macOS Keychain, Windows Credential Manager). It never leaves
the device, is not backed up and is not part of a library move.

## Camera and notifications

- The camera is used only when you tap "Scan QR code" on the Receive tab, to read the transfer
  code; frames are processed on the device and never stored or sent.
- Android: a notification shows the progress of a running transfer (you can refuse the
  notification permission; the transfer still runs).

## Permissions (Android)

| Permission | Why |
| --- | --- |
| Internet, network state | Transfer, only while it is in use |
| Wi‑Fi multicast | Find your other device on the same Wi‑Fi (mDNS) |
| Camera | Scan a transfer QR code (asked when you tap Scan) |
| Foreground service (data sync), notifications | Keep a running transfer going in the background, show its progress |
