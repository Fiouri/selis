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

/// The QR code drawn with half-block characters (terminal).
pub fn terminal(text: &str) -> Option<String> {
    let code = QrCode::with_error_correction_level(text, EcLevel::M).ok()?;
    Some(code.render::<unicode::Dense1x2>().quiet_zone(true).build())
}

#[cfg(test)]
mod tests {
    #[test]
    fn renders() {
        let link = "selis://transfer/selisabc";
        assert!(super::svg(link).is_some_and(|s| s.starts_with("<?xml") || s.contains("<svg")));
        assert!(super::terminal(link).is_some_and(|s| !s.is_empty()));
    }
}
