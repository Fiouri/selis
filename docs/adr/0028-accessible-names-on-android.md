# ADR 0028 — Accessible names that reach TalkBack: aria-label, one name per control, real roles

- Status: accepted
- Date: 2026-10-15

## Context

The P5b TalkBack walkthrough on the Galaxy S23 (Samsung TalkBack 16.2, Android System WebView
15x; `docs/release/1.0-rc.md`) heard several controls differently from what the WebView's
accessibility tree said:

- Names given with `aria-labelledby` (switches, sheets, dialogs, radio groups) were not spoken:
  "Off, Switch". The tree (DevTools `getFullAXTree`) had the names.
- `aria-describedby` text was spoken *before* the name ("2 pages · Today, Open Lease agreement").
- `aria-pressed` buttons were spoken as "Switch", also where only one of them can be chosen.
- A focusable `role="region"` was spoken as just "region".
- Scan's full-screen layer lived inside `#root`: keyboard and TalkBack focus reached the
  library's hidden buttons behind the camera.

## Decision

- Name controls with `aria-label` (the visible text, from `t()`), never `aria-labelledby`.
  `Switch` takes `label`; `BottomSheet`, `Dialog`, radio groups and the note editor use their
  title as `aria-label`.
- One name per control that carries what was a description: document cards and rows are
  "Open <title>, <pages or size · date>, Favorite, Received"; settings switches are
  "<label>, <helper>". Maestro flows match these names with `"Open <title>,.*"`.
- Roles that say what the control is: exclusive choices are `radio` in a `radiogroup` (library
  filters, annotate and redact tools, scan filters; `Chip` takes `kind="radio" | "menu"`), page
  selection is `checkbox`; `aria-pressed` stays only for real on/off toggles (torch, tag rows,
  signature cards).
- The viewer's scroller is a named `group`.
- Full-screen layers over the tabs (`FullScreenLayer`: Scan, Images → PDF) are portalled
  outside `#root` and make it inert, like sheets.

## Consequences

- Visual design unchanged; Playwright and Maestro selectors follow the new names and roles.
- New controls must follow the same rules; the RC walkthrough method (TalkBack + keyboard Tab +
  "Display speech output", `docs/release/1.0-rc.md`) can repeat the check.
- Focusing the viewer's scroller now reads the visible pages' text after the document name
  (TalkBack collects a focusable group's text); swiping moves page by page as before.
