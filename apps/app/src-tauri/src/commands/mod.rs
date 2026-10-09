//! Thin command wrappers: validate input → call `selis-core` → typed result.
//! No business logic lives here.

pub mod device;
pub mod library;
pub mod settings;

use serde::Serialize;
use specta::Type;

/// Machine-readable error category; the UI maps it to a localized message.
#[derive(Debug, Clone, Copy, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ErrorCode {
    NotPdf,
    EmptyFile,
    NotFound,
    Io,
    InvalidArgument,
    Internal,
}

#[derive(Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CommandError {
    pub code: ErrorCode,
    /// Developer-facing detail, never shown verbatim to users.
    pub message: String,
}

impl CommandError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl From<selis_core::Error> for CommandError {
    fn from(err: selis_core::Error) -> Self {
        use selis_core::Error as E;
        let code = match &err {
            E::NotPdf => ErrorCode::NotPdf,
            E::EmptyFile => ErrorCode::EmptyFile,
            E::NotFound(_) => ErrorCode::NotFound,
            E::Io { .. } => ErrorCode::Io,
            E::InvalidArgument(_) => ErrorCode::InvalidArgument,
            E::Db(_) | E::Json(_) | E::SchemaTooNew { .. } => ErrorCode::Internal,
        };
        Self::new(code, err.to_string())
    }
}

pub type CommandResult<T> = Result<T, CommandError>;
