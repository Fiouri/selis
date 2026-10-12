//! QR codes for transfer links: an SVG for the app's Send screen (always black
//! on white, any theme) and text for the dev peer's terminal.

use qrcode::{EcLevel, QrCode, render::svg, render::unicode};

/// SVG of `text` with a 4-module quiet zone, scaled by the UI.
pub fn svg(text: &str) -> Option<String> {
    let code = QrCode::with_error_correction_level(text, EcLevel::M).ok()?;
    Some(
        code.render::<svg::Color>()
            .quiet_zone(true)
            .dark_color(svg::Color("#000000"))
            .light_color(svg::Color("#ffffff"))
            .build(),
    )
}

/// The modules as text rows (`#` dark, `.` light), no quiet zone: test fixtures.
pub fn matrix(text: &str) -> Option<String> {
    let code = QrCode::with_error_correction_level(text, EcLevel::M).ok()?;
    let width = code.width();
    let rows = code
        .to_colors()
        .chunks(width)
        .map(|row| {
            row.iter()
                .map(|c| if *c == qrcode::Color::Dark { '#' } else { '.' })
                .collect::<String>()
        })
        .collect::<Vec<_>>();
    Some(rows.join("\n"))
}

/// The QR code drawn with half-block characters (terminal).
pub fn terminal(text: &str) -> Option<String> {
    let code = QrCode::with_error_correction_level(text, EcLevel::M).ok()?;
    Some(code.render::<unicode::Dense1x2>().quiet_zone(true).build())
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use iroh::{EndpointAddr, SecretKey, TransportAddr};
    use iroh_blobs::Hash;

    use crate::TransferTicket;

    /// A real ticket link and its QR code, for the app's mock backend and the
    /// Playwright camera test (`packages/fixtures/transfer`). Regenerate with
    /// `SELIS_REGEN_FIXTURES=1 cargo test -p selis-transfer qr`.
    #[test]
    fn fixtures_are_current() {
        let mut addrs = std::collections::BTreeSet::new();
        addrs.insert(TransportAddr::Ip(([192, 168, 1, 2], 51_000).into()));
        let ticket = TransferTicket {
            addr: EndpointAddr {
                id: SecretKey::from_bytes(&[42; 32]).public(),
                addrs,
            },
            collection: Hash::new(b"selis fixture collection"),
            token: [7; 16],
            expires_at: 4_102_444_800,
        };
        let link = ticket.to_link();
        let files = [
            ("link.txt", format!("{link}\n")),
            ("qr.svg", super::svg(&link).unwrap_or_default()),
            (
                "qr-matrix.txt",
                format!("{}\n", super::matrix(&link).unwrap_or_default()),
            ),
        ];
        let dir =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../packages/fixtures/transfer");
        for (name, content) in files {
            let path = dir.join(name);
            if std::env::var_os("SELIS_REGEN_FIXTURES").is_some() {
                std::fs::create_dir_all(&dir).unwrap_or_default();
                std::fs::write(&path, &content).unwrap_or_default();
            }
            let current = std::fs::read_to_string(&path)
                .unwrap_or_default()
                .replace("\r\n", "\n");
            assert_eq!(
                current, content,
                "{name} is stale: SELIS_REGEN_FIXTURES=1 cargo test -p selis-transfer qr"
            );
        }
    }

    #[test]
    fn renders() {
        let link = "selis://transfer/selisabc";
        assert!(super::svg(link).is_some_and(|s| s.starts_with("<?xml") || s.contains("<svg")));
        assert!(super::terminal(link).is_some_and(|s| !s.is_empty()));
    }
}
