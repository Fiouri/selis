# ADR 0026 — `--control-line`: control boundaries at ≥ 3:1, checked on every test run

- Status: accepted
- Date: 2026-10-15

## Context

The RC QA (`docs/release/1.0-rc.md`) measured the borders of text fields, chips and outlined
buttons (`--neutral-6/7`) at 1.8–1.9:1 against the app background in all three themes. WCAG 2.2
SC 1.4.11 Non-text Contrast asks for 3:1 for the "visual information required to identify user
interface components and states" (<https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html>).
Raising `--neutral-6/7` themselves would darken every divider and card edge, which need no
contrast and carry the "calm paper" look.

## Decision

- A semantic token `--control-line` per theme (light `#8f8577`, dark `#726c60`, sepia
  `#8d7957`), the lightest step on each theme's neutral ramp that reaches ≥ 3.1:1 on
  `--neutral-1/2/3`, `--surface-app` and `--surface-raised`. Tailwind: `border-control-line`,
  `bg-control-line`.
- Used for the boundary or state of controls: text fields and text areas, chips, secondary
  buttons, unchecked checkboxes, switch tracks (off), unselected selectable tiles and signature
  cards, the Library's floating buttons, sheet grabbers, and the website's language and ghost
  buttons. Dividers, list containers and decorative illustrations keep `--neutral-5/6/7/8`.
- `tokens.test.ts` resolves each theme's palette (including `var()` references and inherited
  light values) and asserts every pair the UI uses: text 4.5:1 (body text 7:1), control lines,
  icons, selected outlines and the focus ring 3:1, the white switch knob on the off track 3:1.
  It fails with the list of pairs below the minimum (shown with the old border value: 1.55–1.80).
- The Linux visual baselines of the changed screens are regenerated from CI (ADR 0019).

## Consequences

- Borders of controls are visibly darker than dividers; the hierarchy reads "you can act here".
- New tokens or themes must pass the same table before they merge.
