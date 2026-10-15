//! Dev tool for the App Store screenshots (apps/app/e2e/maestro/ios/store-screenshots.sh,
//! ADR 0029). Not shipped.
//!
//!   seed-library <library-root> <pdf>...
//!       imports the PDFs, in order, into the library at <library-root> (created if missing)
//!       through the same `Library::import_path` the app uses for a picked file, so titles
//!       come from the file names as on iOS. Prints one `imported=<title>` line per file.
//!
//! The iOS simulator's Files picker runs out of process and did not take synthesized taps
//! reliably on CI runners, so the screenshots start from a seeded library instead.

use std::path::PathBuf;
use std::process::ExitCode;

use selis_core::Library;

fn main() -> ExitCode {
    let mut args = std::env::args_os().skip(1);
    let Some(root) = args.next().map(PathBuf::from) else {
        eprintln!("usage: seed-library <library-root> <pdf>...");
        return ExitCode::from(2);
    };
    let pdfs: Vec<PathBuf> = args.map(PathBuf::from).collect();
    if pdfs.is_empty() {
        eprintln!("usage: seed-library <library-root> <pdf>...");
        return ExitCode::from(2);
    }
    let library = match Library::open(&root) {
        Ok(library) => library,
        Err(e) => {
            eprintln!("{}: {e}", root.display());
            return ExitCode::FAILURE;
        }
    };
    for pdf in &pdfs {
        match library.import_path(pdf) {
            Ok(outcome) => println!("imported={}", outcome.document.title),
            Err(e) => {
                eprintln!("{}: {e}", pdf.display());
                return ExitCode::FAILURE;
            }
        }
    }
    ExitCode::SUCCESS
}
