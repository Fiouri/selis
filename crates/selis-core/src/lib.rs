//! Selis core: library index (SQLite), atomic file store, BLAKE3 content hashing.
//!
//! This crate has no Tauri dependency so it can be tested on its own.
//! Invariant: an original file supplied by the user is never written to.

mod db;
pub mod error;
pub mod fsutil;
pub mod hash;
pub mod library;

pub use error::{Error, Result};
pub use fsutil::atomic_write;
pub use hash::Blake3Hash;
pub use library::{
    Document, DocumentFile, DocumentKind, ImportOutcome, Library, title_from_file_name,
};
