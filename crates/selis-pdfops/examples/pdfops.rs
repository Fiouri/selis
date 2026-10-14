//! Dev tool for the P4a checks (apps/app/e2e/maestro/tools.sh, docs/spike-p4.md). Not shipped.
//!
//!   pdfops run <protect|unprotect|compress|linearize|repair> <in> <out> [password]
//!       runs one operation (protect: no restrictions) and prints the outcome and the time.
//!   pdfops check <file> [password]
//!       `qpdf --check`: prints `ok` or the error (exit 1).
//!   pdfops protection <file>
//!       prints `none`, `restricted` or `password`.
//!   pdfops contents <file> [password]
//!       BLAKE3 of every page's decoded content stream, one line per page.

use std::path::Path;
use std::process::ExitCode;
use std::time::Instant;

use selis_pdfops::{Operation, Password, Permissions, Protection};

fn password(arg: Option<&String>) -> Option<Password> {
    arg.map(|p| Password::new(p.clone()))
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("run") if args.len() >= 4 => {
            let pw = || Password::new(args.get(4).cloned().unwrap_or_default());
            let op = match args[1].as_str() {
                "protect" => Operation::Protect {
                    open: pw(),
                    owner: None,
                    permissions: Permissions::ALL,
                },
                "unprotect" => Operation::Unprotect { password: pw() },
                "compress" => Operation::Compress,
                "linearize" => Operation::Linearize,
                "repair" => Operation::Repair,
                other => {
                    eprintln!("unknown operation {other}");
                    return ExitCode::from(2);
                }
            };
            let started = Instant::now();
            match selis_pdfops::run(Path::new(&args[2]), Path::new(&args[3]), &op) {
                Ok(outcome) => {
                    println!("{outcome:?} in {:.1} s", started.elapsed().as_secs_f64());
                    ExitCode::SUCCESS
                }
                Err(e) => {
                    println!("error: {e}");
                    ExitCode::FAILURE
                }
            }
        }
        Some("check") if args.len() >= 2 => {
            match selis_pdfops::check(Path::new(&args[1]), password(args.get(2)).as_ref()) {
                Ok(()) => {
                    println!("ok");
                    ExitCode::SUCCESS
                }
                Err(e) => {
                    println!("error: {e}");
                    ExitCode::FAILURE
                }
            }
        }
        Some("protection") if args.len() >= 2 => {
            match selis_pdfops::protection(Path::new(&args[1])) {
                Ok(p) => {
                    println!(
                        "{}",
                        match p {
                            Protection::None => "none",
                            Protection::Restricted => "restricted",
                            Protection::Password => "password",
                        }
                    );
                    ExitCode::SUCCESS
                }
                Err(e) => {
                    println!("error: {e}");
                    ExitCode::FAILURE
                }
            }
        }
        Some("contents") if args.len() >= 2 => {
            let path = Path::new(&args[1]);
            let doc = match args.get(2) {
                Some(p) => qpdf::QPdf::read_encrypted(path, p),
                None => qpdf::QPdf::read(path),
            };
            let pages = doc.and_then(|d| d.get_pages());
            match pages {
                Ok(pages) => {
                    for page in pages {
                        match page.get_page_content_data() {
                            Ok(data) => println!("{}", blake3::hash(&data).to_hex()),
                            Err(e) => {
                                println!("error: {e:?}");
                                return ExitCode::FAILURE;
                            }
                        }
                    }
                    ExitCode::SUCCESS
                }
                Err(e) => {
                    println!("error: {e:?}");
                    ExitCode::FAILURE
                }
            }
        }
        _ => {
            eprintln!(
                "usage: pdfops run <op> <in> <out> [password] | check <file> [password] | protection <file> | contents <file> [password]"
            );
            ExitCode::from(2)
        }
    }
}
