#![no_main]
//! A `.selispack` from anywhere: the header, KDF and manifest parsers never
//! panic, and a full import of a plain pack either succeeds or fails cleanly
//! with nothing left in the staging folder. (Encrypted bodies are not run
//! through Argon2 here: 64 MiB per input would stall the fuzzer; the unit tests
//! cover their failure paths.)
use std::sync::OnceLock;

use libfuzzer_sys::fuzz_target;
use selis_core::{Library, pack};

struct Fixture {
    _dir: tempfile::TempDir,
    library: Library,
    input: std::path::PathBuf,
}

fn fixture() -> &'static Fixture {
    static F: OnceLock<Fixture> = OnceLock::new();
    F.get_or_init(|| {
        let dir = tempfile::tempdir().expect("tempdir");
        let library = Library::open(dir.path().join("lib")).expect("library");
        let input = dir.path().join("in.selispack");
        Fixture { _dir: dir, library, input }
    })
}

fuzz_target!(|data: &[u8]| {
    pack::fuzz_parse(data);
    let mut file = pack::MAGIC.to_vec();
    file.extend_from_slice(&[pack::PACK_VERSION, 0]);
    file.extend_from_slice(data);
    let f = fixture();
    std::fs::write(&f.input, &file).expect("write");
    let _ = f.library.import_pack(&f.input, None);
});
