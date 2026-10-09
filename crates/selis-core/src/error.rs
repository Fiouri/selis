use std::path::PathBuf;

/// Errors produced by `selis-core`.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("I/O error at {path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },

    #[error("database error: {0}")]
    Db(#[from] rusqlite::Error),

    #[error("invalid JSON value: {0}")]
    Json(#[from] serde_json::Error),

    #[error("file is not a PDF document")]
    NotPdf,

    #[error("file is empty")]
    EmptyFile,

    #[error("document not found: {0}")]
    NotFound(String),

    #[error("database schema version {found} is newer than supported version {supported}")]
    SchemaTooNew { found: u32, supported: u32 },

    #[error("invalid argument: {0}")]
    InvalidArgument(&'static str),
}

impl Error {
    pub(crate) fn io(path: impl Into<PathBuf>, source: std::io::Error) -> Self {
        Self::Io {
            path: path.into(),
            source,
        }
    }
}

pub type Result<T> = std::result::Result<T, Error>;
