//! qpdf operations on small PDFs made here (the npm fixture corpus is not built for Rust tests).
//! Every written file must pass `qpdf --check` (`selis_pdfops::check`).

use std::path::{Path, PathBuf};

use qpdf::{EncryptionParams, EncryptionParamsR3, EncryptionParamsR6, PrintPermission, QPdf};
use selis_pdfops::{
    Error, Operation, Outcome, Password, Permissions, Protection, Unchanged, check, protection, run,
};

/// A PDF with `pages` pages, uncompressed content streams and an unreferenced 64 KB stream, so
/// compressing has something to do.
fn make_pdf(dir: &Path, name: &str, pages: usize) -> PathBuf {
    let mut objects: Vec<String> = Vec::new();
    // 1 catalog, 2 pages, 3 font, then per page: page + contents; last: unreferenced filler.
    let kids: Vec<String> = (0..pages).map(|i| format!("{} 0 R", 4 + i * 2)).collect();
    objects.push("<< /Type /Catalog /Pages 2 0 R >>".into());
    objects.push(format!(
        "<< /Type /Pages /Kids [{}] /Count {pages} >>",
        kids.join(" ")
    ));
    objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".into());
    for i in 0..pages {
        objects.push(format!(
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents {} 0 R /Resources << /Font << /F1 3 0 R >> >> >>",
            5 + i * 2
        ));
        let text = format!("BT /F1 24 Tf 72 700 Td (Page {} of {pages}) Tj ET\n", i + 1).repeat(40);
        objects.push(format!(
            "<< /Length {} >>\nstream\n{text}\nendstream",
            text.len() + 1
        ));
    }
    let filler = "0123456789abcdef".repeat(4096);
    objects.push(format!(
        "<< /Length {} >>\nstream\n{filler}\nendstream",
        filler.len() + 1
    ));

    let mut out = b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n".to_vec();
    let mut offsets = Vec::new();
    for (i, body) in objects.iter().enumerate() {
        offsets.push(out.len());
        out.extend_from_slice(format!("{} 0 obj\n{body}\nendobj\n", i + 1).as_bytes());
    }
    let xref = out.len();
    out.extend_from_slice(
        format!("xref\n0 {}\n0000000000 65535 f \n", objects.len() + 1).as_bytes(),
    );
    for o in offsets {
        out.extend_from_slice(format!("{o:010} 00000 n \n").as_bytes());
    }
    out.extend_from_slice(
        format!(
            "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n",
            objects.len() + 1
        )
        .as_bytes(),
    );
    let path = dir.join(name);
    std::fs::write(&path, out).expect("write pdf");
    path
}

/// BLAKE3 of each page's decoded content stream.
fn page_contents(path: &Path, password: Option<&str>) -> Vec<String> {
    let doc = match password {
        Some(p) => QPdf::read_encrypted(path, p),
        None => QPdf::read(path),
    }
    .expect("open");
    doc.get_pages()
        .expect("pages")
        .iter()
        .map(|page| {
            blake3::hash(&page.get_page_content_data().expect("contents"))
                .to_hex()
                .to_string()
        })
        .collect()
}

fn pw(s: &str) -> Password {
    Password::new(s.to_owned())
}

fn protect(open: &str) -> Operation {
    Operation::Protect {
        open: pw(open),
        owner: None,
        permissions: Permissions::ALL,
    }
}

#[test]
fn protect_then_unprotect_keeps_every_page_content_stream() {
    let dir = tempfile::tempdir().expect("tempdir");
    let input = make_pdf(dir.path(), "in.pdf", 3);
    let locked = dir.path().join("locked.pdf");
    let open = dir.path().join("open.pdf");

    let outcome = run(&input, &locked, &protect("correct horse")).expect("protect");
    assert!(matches!(outcome, Outcome::Written { .. }));
    assert_eq!(
        protection(&locked).expect("protection"),
        Protection::Password
    );
    check(&locked, Some(&pw("correct horse"))).expect("qpdf --check on the protected file");
    // AES-256: revision 6.
    let doc = QPdf::read_encrypted(&locked, "correct horse").expect("open protected");
    assert!(doc.is_encrypted());

    run(
        &locked,
        &open,
        &Operation::Unprotect {
            password: pw("correct horse"),
        },
    )
    .expect("unprotect");
    assert_eq!(protection(&open).expect("protection"), Protection::None);
    check(&open, None).expect("qpdf --check on the unprotected file");

    let original = page_contents(&input, None);
    assert_eq!(original.len(), 3);
    assert_eq!(page_contents(&locked, Some("correct horse")), original);
    assert_eq!(page_contents(&open, None), original);
}

#[test]
fn a_wrong_password_is_refused_and_writes_nothing() {
    let dir = tempfile::tempdir().expect("tempdir");
    let input = make_pdf(dir.path(), "in.pdf", 1);
    let locked = dir.path().join("locked.pdf");
    run(&input, &locked, &protect("correct horse")).expect("protect");

    let out = dir.path().join("out.pdf");
    let err = run(
        &locked,
        &out,
        &Operation::Unprotect {
            password: pw("wrong horse"),
        },
    );
    assert_eq!(err, Err(Error::WrongPassword));
    assert!(!out.exists());
    // Other operations on a file that needs a password say so.
    assert_eq!(
        run(&locked, &out, &Operation::Compress),
        Err(Error::PasswordNeeded)
    );
    assert_eq!(
        run(&locked, &out, &protect("another one")),
        Err(Error::PasswordNeeded)
    );
    assert!(!out.exists());
}

#[test]
fn removing_a_password_the_file_does_not_have_is_refused() {
    let dir = tempfile::tempdir().expect("tempdir");
    let input = make_pdf(dir.path(), "in.pdf", 1);
    let out = dir.path().join("out.pdf");
    assert!(matches!(
        run(
            &input,
            &out,
            &Operation::Unprotect {
                password: pw("anything")
            }
        ),
        Err(Error::InvalidArgument(_))
    ));
    assert!(!out.exists());
}

#[test]
fn restrictions_need_a_separate_owner_password() {
    let dir = tempfile::tempdir().expect("tempdir");
    let input = make_pdf(dir.path(), "in.pdf", 1);
    let out = dir.path().join("out.pdf");
    let no_print = Permissions {
        print: false,
        ..Permissions::ALL
    };
    let without_owner = Operation::Protect {
        open: pw("open sesame"),
        owner: None,
        permissions: no_print,
    };
    assert!(matches!(
        run(&input, &out, &without_owner),
        Err(Error::InvalidArgument(_))
    ));
    let same_owner = Operation::Protect {
        open: pw("open sesame"),
        owner: Some(pw("open sesame")),
        permissions: no_print,
    };
    assert!(matches!(
        run(&input, &out, &same_owner),
        Err(Error::InvalidArgument(_))
    ));
    let empty = Operation::Protect {
        open: pw(""),
        owner: None,
        permissions: Permissions::ALL,
    };
    assert!(matches!(
        run(&input, &out, &empty),
        Err(Error::InvalidArgument(_))
    ));
    let long = Operation::Protect {
        open: pw(&"x".repeat(128)),
        owner: None,
        permissions: Permissions::ALL,
    };
    assert!(matches!(
        run(&input, &out, &long),
        Err(Error::InvalidArgument(_))
    ));

    let good = Operation::Protect {
        open: pw("open sesame"),
        owner: Some(pw("owner only")),
        permissions: no_print,
    };
    run(&input, &out, &good).expect("protect with restrictions");
    let doc = QPdf::read_encrypted(&out, "open sesame").expect("open");
    assert!(doc.is_encrypted());
    check(&out, Some(&pw("owner only"))).expect("check with the owner password");
}

#[test]
fn a_file_with_only_an_owner_password_counts_as_restricted() {
    let dir = tempfile::tempdir().expect("tempdir");
    let input = make_pdf(dir.path(), "in.pdf", 1);
    let restricted = dir.path().join("restricted.pdf");
    let doc = QPdf::read(&input).expect("open");
    let mut writer = doc.writer();
    writer.encryption_params(EncryptionParams::R6(EncryptionParamsR6 {
        user_password: String::new(),
        owner_password: "owner".into(),
        allow_accessibility: true,
        allow_extract: false,
        allow_assemble: false,
        allow_annotate_and_form: false,
        allow_form_filling: false,
        allow_modify_other: false,
        allow_print: PrintPermission::None,
        encrypt_metadata: true,
    }));
    writer.write(&restricted).expect("write");
    assert_eq!(
        protection(&restricted).expect("protection"),
        Protection::Restricted
    );
    // It can be given an open password (replacing the old protection).
    let out = dir.path().join("out.pdf");
    run(&restricted, &out, &protect("new password")).expect("protect");
    assert_eq!(protection(&out).expect("protection"), Protection::Password);
}

#[test]
fn a_legacy_rc4_password_can_be_removed() {
    let dir = tempfile::tempdir().expect("tempdir");
    let input = make_pdf(dir.path(), "in.pdf", 2);
    let rc4 = dir.path().join("rc4.pdf");
    let doc = QPdf::read(&input).expect("open");
    let mut writer = doc.writer();
    writer.encryption_params(EncryptionParams::R3(EncryptionParamsR3 {
        user_password: "old".into(),
        owner_password: "old owner".into(),
        allow_accessibility: true,
        allow_extract: true,
        allow_print: PrintPermission::Full,
        allow_assemble: true,
        allow_annotate_and_form: true,
        allow_form_filling: true,
        allow_modify_other: true,
    }));
    writer.write(&rc4).expect("write");
    let out = dir.path().join("out.pdf");
    run(
        &rc4,
        &out,
        &Operation::Unprotect {
            password: pw("old"),
        },
    )
    .expect("unprotect");
    check(&out, None).expect("check");
    assert_eq!(page_contents(&out, None), page_contents(&input, None));
}

#[test]
fn compress_makes_the_file_smaller_once_then_reports_nothing_to_gain() {
    let dir = tempfile::tempdir().expect("tempdir");
    let input = make_pdf(dir.path(), "in.pdf", 5);
    let small = dir.path().join("small.pdf");
    let Outcome::Written {
        input_bytes,
        output_bytes,
    } = run(&input, &small, &Operation::Compress).expect("compress")
    else {
        panic!("expected a smaller file");
    };
    assert!(output_bytes < input_bytes, "{output_bytes} < {input_bytes}");
    check(&small, None).expect("check");
    assert_eq!(page_contents(&small, None), page_contents(&input, None));

    let again = dir.path().join("again.pdf");
    let outcome = run(&small, &again, &Operation::Compress).expect("compress again");
    assert!(matches!(
        outcome,
        Outcome::Unchanged(Unchanged::NotSmaller { .. })
    ));
    assert!(!again.exists());
}

#[test]
fn linearize_once() {
    let dir = tempfile::tempdir().expect("tempdir");
    let input = make_pdf(dir.path(), "in.pdf", 4);
    let fast = dir.path().join("fast.pdf");
    run(&input, &fast, &Operation::Linearize).expect("linearize");
    assert!(QPdf::read(&fast).expect("open").is_linearized());
    check(&fast, None).expect("check");
    assert_eq!(page_contents(&fast, None), page_contents(&input, None));

    let again = dir.path().join("again.pdf");
    assert_eq!(
        run(&fast, &again, &Operation::Linearize),
        Ok(Outcome::Unchanged(Unchanged::AlreadyLinearized))
    );
    assert!(!again.exists());
}

#[test]
fn repair_rebuilds_a_broken_cross_reference_table() {
    let dir = tempfile::tempdir().expect("tempdir");
    let input = make_pdf(dir.path(), "in.pdf", 3);
    // Shift every object by 7 bytes: every xref offset is now wrong.
    let bytes = std::fs::read(&input).expect("read");
    let header_end = bytes.iter().position(|&b| b == b'\n').expect("header") + 1;
    let mut broken = bytes[..header_end].to_vec();
    broken.extend_from_slice(b"%junk\n\n");
    broken.extend_from_slice(&bytes[header_end..]);
    let damaged = dir.path().join("damaged.pdf");
    std::fs::write(&damaged, broken).expect("write");

    let fixed = dir.path().join("fixed.pdf");
    let outcome = run(&damaged, &fixed, &Operation::Repair).expect("repair");
    assert!(matches!(outcome, Outcome::Written { .. }));
    check(&fixed, None).expect("the repaired file passes qpdf --check");
    assert_eq!(page_contents(&fixed, None), page_contents(&input, None));

    let again = dir.path().join("again.pdf");
    assert_eq!(
        run(&fixed, &again, &Operation::Repair),
        Ok(Outcome::Unchanged(Unchanged::NothingToRepair))
    );
}

#[test]
fn not_a_pdf_is_damaged() {
    let dir = tempfile::tempdir().expect("tempdir");
    let junk = dir.path().join("junk.pdf");
    std::fs::write(&junk, b"hello, not a pdf").expect("write");
    let out = dir.path().join("out.pdf");
    assert!(matches!(
        run(&junk, &out, &Operation::Compress),
        Err(Error::Damaged(_))
    ));
    assert!(!out.exists());
}

#[test]
fn passwords_never_show_in_debug_output() {
    let op = protect("correct horse battery");
    assert!(!format!("{op:?}").contains("horse"));
}
