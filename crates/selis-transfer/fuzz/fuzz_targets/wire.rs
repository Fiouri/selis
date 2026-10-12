#![no_main]
//! Control messages from another device: decoding never panics.
use libfuzzer_sys::fuzz_target;
use selis_transfer::wire::{ToReceiver, ToSender, decode};

fuzz_target!(|data: &[u8]| {
    let _ = decode::<ToSender>(data);
    let _ = decode::<ToReceiver>(data);
});
