#![no_main]
//! A manifest from another device: parsing never panics, and whatever parses
//! is valid and survives a round trip.
use libfuzzer_sys::fuzz_target;
use selis_transfer::manifest::Manifest;

fuzz_target!(|data: &[u8]| {
    if let Ok(m) = Manifest::parse(data) {
        assert!(m.validate().is_ok());
        assert_eq!(Manifest::parse(&m.to_bytes()).ok(), Some(m));
    }
});
