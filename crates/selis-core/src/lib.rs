//! Selis core: library index (SQLite), atomic file store, BLAKE3 content hashing.
//!
//! This crate has no Tauri dependency so it can be tested on its own.
//! Invariant: an original file supplied by the user is never written to.

pub mod cancel;
mod db;
pub mod delete;
pub mod error;
pub mod fold;
pub mod fsutil;
pub mod hash;
pub mod library;
pub mod received;
pub mod retention;
pub mod save;
pub mod signatures;
pub mod tags;
pub mod thumbs;
pub mod transfers;

pub use cancel::{CancelToken, CancellableReader};
pub use delete::DeleteReport;
pub use error::{Error, Result};
pub use fsutil::atomic_write;
pub use hash::Blake3Hash;
pub use library::{
    Document, DocumentFile, DocumentKind, ImportOutcome, Library, LibraryFilter, LibraryQuery,
    LibrarySort, title_from_file_name,
};
pub use received::{ReceivedDocument, ReceivedFile};
pub use retention::{RetentionPolicy, RetentionReport};
pub use save::{SavedVersion, VersionLabel, WorkingCopy};
pub use signatures::{Signature, SignatureKind};
pub use tags::Tag;
pub use transfers::{Outgoing, TransferDirection, TransferRow, TransferRowState, TransferUpdate};
