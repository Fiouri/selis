//! Search folding: case-, accent- and final-sigma-insensitive text keys, so
//! "Αναφορά", "αναφορα" and "ΑΝΑΦΟΡΑ" all match. Exposed to SQL as
//! `selis_fold(text)` on every connection.

use rusqlite::Connection;
use rusqlite::functions::FunctionFlags;
use unicode_normalization::UnicodeNormalization;
use unicode_normalization::char::is_combining_mark;

use crate::error::Result;

/// Lowercase, strip diacritics (NFD + drop combining marks), fold `ς` to `σ`,
/// collapse runs of whitespace.
pub fn fold(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut pending_space = false;
    for c in text.nfd().filter(|c| !is_combining_mark(*c)) {
        if c.is_whitespace() {
            pending_space = !out.is_empty();
            continue;
        }
        if pending_space {
            out.push(' ');
            pending_space = false;
        }
        for lower in c.to_lowercase() {
            out.push(if lower == 'ς' { 'σ' } else { lower });
        }
    }
    out
}

/// Registers `selis_fold(text) -> text` (deterministic, NULL-preserving).
pub(crate) fn register(conn: &Connection) -> Result<()> {
    conn.create_scalar_function(
        "selis_fold",
        1,
        FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC,
        |ctx| {
            let value: Option<String> = ctx.get(0)?;
            Ok(value.map(|v| fold(&v)))
        },
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folds_greek_case_accents_and_final_sigma() {
        assert_eq!(fold("Αναφορά"), "αναφορα");
        assert_eq!(fold("ΑΝΑΦΟΡΑ"), "αναφορα");
        assert_eq!(fold("Συμβόλαιο Πωλήσεως"), "συμβολαιο πωλησεωσ");
        assert_eq!(fold("ΐ ΰ Ϊ"), "ι υ ι");
    }

    #[test]
    fn folds_latin_and_whitespace() {
        assert_eq!(fold("  Résumé\t2026  "), "resume 2026");
        assert_eq!(fold("Straße"), "straße");
        assert_eq!(fold(""), "");
    }

    #[test]
    fn sql_function_matches_rust() -> Result<()> {
        let conn = Connection::open_in_memory()?;
        register(&conn)?;
        let folded: String =
            conn.query_row("SELECT selis_fold('Ελληνικό ΚΕΙΜΕΝΟ')", [], |r| r.get(0))?;
        assert_eq!(folded, "ελληνικο κειμενο");
        let null: Option<String> = conn.query_row("SELECT selis_fold(NULL)", [], |r| r.get(0))?;
        assert_eq!(null, None);
        Ok(())
    }
}
