#![no_main]
//! Any text pasted or scanned as a transfer link: parsing never panics, and a
//! ticket that parses re-encodes to a link that parses to the same ticket.
use libfuzzer_sys::fuzz_target;
use selis_transfer::TransferTicket;

fuzz_target!(|data: &[u8]| {
    if let Ok(s) = std::str::from_utf8(data)
        && let Ok(t) = TransferTicket::parse(s)
    {
        assert_eq!(TransferTicket::parse(&t.to_link()).ok(), Some(t));
    }
});
