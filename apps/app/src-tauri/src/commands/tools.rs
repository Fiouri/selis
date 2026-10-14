//! Tools on a library document (P4a, ADR 0015): protect with a password, remove it, compress,
//! linearize, repair. qpdf (`selis-pdfops`) reads the current version and writes the next one;
//! `selis-core` records it as a version. Passwords live only in this call: they become
//! [`Password`]s (wiped on drop) as soon as they are read and are never logged.

use std::fmt;
use std::sync::Arc;

use selis_core::{Document, Library};
use selis_pdfops::{Operation, Outcome, Password, Permissions, Protection, Unchanged};
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::State;

use super::{CommandError, CommandResult, ErrorCode};
use crate::requests::RequestResults;

/// Who may open the document's current version.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ProtectionView {
    None,
    /// Opens without a password, has an owner password (restrictions).
    Restricted,
    /// Needs a password to open.
    Password,
}

/// The operation, as the UI asks for it.
#[derive(Clone, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ToolRequest {
    #[serde(rename_all = "camelCase")]
    Protect {
        password: String,
        owner_password: Option<String>,
        allow_print: bool,
        allow_copy: bool,
        allow_modify: bool,
    },
    Unprotect {
        password: String,
    },
    Compress,
    Linearize,
    Repair,
}

impl fmt::Debug for ToolRequest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        // Never the passwords.
        f.write_str(match self {
            Self::Protect { .. } => "Protect",
            Self::Unprotect { .. } => "Unprotect",
            Self::Compress => "Compress",
            Self::Linearize => "Linearize",
            Self::Repair => "Repair",
        })
    }
}

impl ToolRequest {
    fn into_operation(self) -> Operation {
        match self {
            Self::Protect {
                password,
                owner_password,
                allow_print,
                allow_copy,
                allow_modify,
            } => Operation::Protect {
                open: Password::new(password),
                owner: owner_password.filter(|p| !p.is_empty()).map(Password::new),
                permissions: Permissions {
                    print: allow_print,
                    copy: allow_copy,
                    modify: allow_modify,
                },
            },
            Self::Unprotect { password } => Operation::Unprotect {
                password: Password::new(password),
            },
            Self::Compress => Operation::Compress,
            Self::Linearize => Operation::Linearize,
            Self::Repair => Operation::Repair,
        }
    }
}

/// Why nothing changed although the tool ran.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ToolUnchanged {
    NotSmaller,
    AlreadyLinearized,
    NothingToRepair,
}

/// Why the tool did not run (the UI explains each; nothing was saved).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ToolProblem {
    PasswordNeeded,
    WrongPassword,
    Damaged,
    Unsupported,
    /// The request does not fit the document (e.g. no password to remove).
    NotApplicable,
    /// The document has edits that are not a version yet.
    UnsavedEdits,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum ToolOutcome {
    /// A new version was saved.
    #[serde(rename_all = "camelCase")]
    Saved {
        document: Document,
        #[specta(type = specta_typescript::Number)]
        input_bytes: u64,
        #[specta(type = specta_typescript::Number)]
        output_bytes: u64,
    },
    #[serde(rename_all = "camelCase")]
    Unchanged {
        reason: ToolUnchanged,
        #[specta(type = specta_typescript::Number)]
        input_bytes: u64,
    },
    #[serde(rename_all = "camelCase")]
    Refused { problem: ToolProblem },
}

fn problem(e: &selis_pdfops::Error) -> Option<ToolProblem> {
    use selis_pdfops::Error as E;
    Some(match e {
        E::PasswordNeeded => ToolProblem::PasswordNeeded,
        E::WrongPassword => ToolProblem::WrongPassword,
        E::Damaged(_) => ToolProblem::Damaged,
        E::Unsupported(_) => ToolProblem::Unsupported,
        E::InvalidArgument(_) => ToolProblem::NotApplicable,
        E::Io(_) => return None,
    })
}

/// Whether the document's current version needs a password to open.
#[tauri::command]
#[specta::specta]
pub async fn document_protection(
    library: State<'_, Arc<Library>>,
    id: String,
) -> CommandResult<ProtectionView> {
    let library = Arc::clone(&library);
    tauri::async_runtime::spawn_blocking(move || {
        let file = library.document_file(&id)?;
        let protection =
            selis_pdfops::protection(std::path::Path::new(&file.path)).or_else(|e| match e {
                // A file qpdf cannot read is the viewer's problem, not a protection.
                selis_pdfops::Error::Damaged(_) | selis_pdfops::Error::Unsupported(_) => {
                    Ok(Protection::None)
                }
                e => Err(CommandError::new(ErrorCode::Io, e.to_string())),
            })?;
        Ok(match protection {
            Protection::None => ProtectionView::None,
            Protection::Restricted => ProtectionView::Restricted,
            Protection::Password => ProtectionView::Password,
        })
    })
    .await
    .map_err(|e| CommandError::new(ErrorCode::Internal, e.to_string()))?
}

/// Runs a tool on the document's current version; the result becomes the next version.
/// Runs once per `request_id`.
#[tauri::command]
#[specta::specta]
pub async fn run_tool(
    library: State<'_, Arc<Library>>,
    results: State<'_, Arc<RequestResults>>,
    request_id: String,
    id: String,
    request: ToolRequest,
) -> CommandResult<ToolOutcome> {
    let library = Arc::clone(&library);
    results
        .run_once(&request_id, "run_tool", async move {
            let retention = super::settings::load(&library)?.retention();
            tauri::async_runtime::spawn_blocking(move || run(&library, &id, request, &retention))
                .await
                .map_err(|e| CommandError::new(ErrorCode::Internal, e.to_string()))?
        })
        .await
}

fn run(
    library: &Library,
    id: &str,
    request: ToolRequest,
    retention: &selis_core::RetentionPolicy,
) -> CommandResult<ToolOutcome> {
    let run = match library.begin_tool_run(id) {
        Ok(run) => run,
        Err(selis_core::Error::Conflict(_)) => {
            return Ok(ToolOutcome::Refused {
                problem: ToolProblem::UnsavedEdits,
            });
        }
        Err(e) => return Err(e.into()),
    };
    let operation = request.into_operation();
    let outcome = selis_pdfops::run(&run.input, &run.output, &operation);
    drop(operation);
    match outcome {
        Ok(Outcome::Written {
            input_bytes,
            output_bytes,
        }) => {
            let saved = library.finish_tool_run(run, retention)?;
            Ok(ToolOutcome::Saved {
                document: saved.document,
                input_bytes,
                output_bytes,
            })
        }
        Ok(Outcome::Unchanged(unchanged)) => {
            let input_bytes = std::fs::metadata(&run.input).map_or(0, |m| m.len());
            library.abandon_tool_run(run);
            let reason = match unchanged {
                Unchanged::NotSmaller { .. } => ToolUnchanged::NotSmaller,
                Unchanged::AlreadyLinearized => ToolUnchanged::AlreadyLinearized,
                Unchanged::NothingToRepair => ToolUnchanged::NothingToRepair,
            };
            Ok(ToolOutcome::Unchanged {
                reason,
                input_bytes,
            })
        }
        Err(e) => {
            library.abandon_tool_run(run);
            match problem(&e) {
                Some(problem) => Ok(ToolOutcome::Refused { problem }),
                None => Err(CommandError::new(ErrorCode::Io, e.to_string())),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use selis_core::{Library, RetentionPolicy};

    use super::{ToolOutcome, ToolProblem, ToolRequest, ToolUnchanged, run};

    /// A one-page PDF with an uncompressed content stream.
    fn pdf() -> Vec<u8> {
        let content = "BT /F1 24 Tf 72 700 Td (Hello) Tj ET
"
        .repeat(50);
        let objects = [
            "<< /Type /Catalog /Pages 2 0 R >>".to_owned(),
            "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_owned(),
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>".to_owned(),
            format!("<< /Length {} >>
stream
{content}
endstream", content.len() + 1),
            "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".to_owned(),
        ];
        let mut out = b"%PDF-1.7
"
        .to_vec();
        let mut offsets = Vec::new();
        for (i, body) in objects.iter().enumerate() {
            offsets.push(out.len());
            out.extend_from_slice(
                format!(
                    "{} 0 obj
{body}
endobj
",
                    i + 1
                )
                .as_bytes(),
            );
        }
        let xref = out.len();
        out.extend_from_slice(
            b"xref
0 6
0000000000 65535 f 
",
        );
        for o in offsets {
            out.extend_from_slice(
                format!(
                    "{o:010} 00000 n 
"
                )
                .as_bytes(),
            );
        }
        out.extend_from_slice(
            format!(
                "trailer
<< /Size 6 /Root 1 0 R >>
startxref
{xref}
%%EOF
"
            )
            .as_bytes(),
        );
        out
    }

    /// Versions stored (each under its own hash in the library folder).
    fn versions(dir: &std::path::Path) -> usize {
        std::fs::read_dir(dir.join("lib").join("library"))
            .expect("library dir")
            .flatten()
            .filter(|e| e.path().extension().is_some_and(|x| x == "pdf"))
            .count()
    }

    #[test]
    fn protect_then_a_wrong_password_saves_nothing_and_the_right_one_a_version() {
        let dir = tempfile::tempdir().expect("tempdir");
        let library = Library::open(dir.path().join("lib")).expect("library");
        let src = dir.path().join("doc.pdf");
        std::fs::write(&src, pdf()).expect("write");
        let id = library.import_path(&src).expect("import").document.id;
        let retention = RetentionPolicy::default();
        let protect = ToolRequest::Protect {
            password: "correct horse".into(),
            owner_password: None,
            allow_print: true,
            allow_copy: true,
            allow_modify: true,
        };
        assert!(matches!(
            run(&library, &id, protect, &retention),
            Ok(ToolOutcome::Saved { .. })
        ));
        assert_eq!(versions(dir.path()), 2);

        let wrong = ToolRequest::Unprotect {
            password: "wrong horse".into(),
        };
        assert_eq!(
            run(&library, &id, wrong, &retention).expect("run"),
            ToolOutcome::Refused {
                problem: ToolProblem::WrongPassword
            }
        );
        assert_eq!(versions(dir.path()), 2);
        assert_eq!(
            run(&library, &id, ToolRequest::Compress, &retention).expect("run"),
            ToolOutcome::Refused {
                problem: ToolProblem::PasswordNeeded
            }
        );

        let right = ToolRequest::Unprotect {
            password: "correct horse".into(),
        };
        assert!(matches!(
            run(&library, &id, right, &retention),
            Ok(ToolOutcome::Saved { .. })
        ));
        assert_eq!(versions(dir.path()), 3);
        // Nothing left in the work folder.
        let work: Vec<_> = std::fs::read_dir(dir.path().join("lib").join("work"))
            .expect("work dir")
            .flatten()
            .filter(|e| e.path().is_file())
            .collect();
        assert!(work.is_empty(), "{work:?}");
    }

    #[test]
    fn compressing_twice_saves_one_version() {
        let dir = tempfile::tempdir().expect("tempdir");
        let library = Library::open(dir.path().join("lib")).expect("library");
        let src = dir.path().join("doc.pdf");
        std::fs::write(&src, pdf()).expect("write");
        let id = library.import_path(&src).expect("import").document.id;
        let retention = RetentionPolicy::default();
        assert!(matches!(
            run(&library, &id, ToolRequest::Compress, &retention),
            Ok(ToolOutcome::Saved { output_bytes, input_bytes, .. }) if output_bytes < input_bytes
        ));
        assert!(matches!(
            run(&library, &id, ToolRequest::Compress, &retention),
            Ok(ToolOutcome::Unchanged {
                reason: ToolUnchanged::NotSmaller,
                ..
            })
        ));
        assert_eq!(versions(dir.path()), 2);
    }

    #[test]
    fn requests_never_print_passwords() {
        let request = ToolRequest::Protect {
            password: "correct horse".into(),
            owner_password: Some("owner battery".into()),
            allow_print: true,
            allow_copy: true,
            allow_modify: true,
        };
        let shown = format!("{request:?}");
        assert!(
            !shown.contains("horse") && !shown.contains("battery"),
            "{shown}"
        );
    }
}
