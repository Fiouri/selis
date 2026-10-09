/** Empty-state illustrations: line art in neutral tones with one accent stroke. */

const common = {
  width: 120,
  height: 120,
  viewBox: "0 0 120 120",
  fill: "none",
  "aria-hidden": true,
  focusable: false,
} as const;

export function LibraryIllustration() {
  return (
    <svg {...common}>
      <rect x="30" y="22" width="56" height="72" rx="6" fill="var(--neutral-3)" stroke="var(--neutral-7)" strokeWidth="2" />
      <rect x="38" y="30" width="56" height="72" rx="6" fill="var(--surface-raised)" stroke="var(--neutral-8)" strokeWidth="2" />
      <path d="M48 50h36M48 60h36M48 70h24" stroke="var(--neutral-6)" strokeWidth="4" strokeLinecap="round" />
      <circle cx="90" cy="92" r="16" fill="var(--accent-9)" />
      <path d="M90 84v16M82 92h16" stroke="var(--accent-contrast)" strokeWidth="3.5" strokeLinecap="round" />
    </svg>
  );
}

export function RecentIllustration() {
  return (
    <svg {...common}>
      <rect x="28" y="24" width="54" height="70" rx="6" fill="var(--surface-raised)" stroke="var(--neutral-8)" strokeWidth="2" />
      <path d="M38 42h34M38 52h34M38 62h20" stroke="var(--neutral-6)" strokeWidth="4" strokeLinecap="round" />
      <circle cx="82" cy="82" r="20" fill="var(--surface-raised)" stroke="var(--accent-9)" strokeWidth="3" />
      <path d="M82 70v12l8 6" stroke="var(--accent-9)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function TransferIllustration() {
  return (
    <svg {...common}>
      <rect x="14" y="30" width="36" height="60" rx="7" fill="var(--surface-raised)" stroke="var(--neutral-8)" strokeWidth="2" />
      <rect x="70" y="30" width="36" height="60" rx="7" fill="var(--surface-raised)" stroke="var(--neutral-8)" strokeWidth="2" />
      <path d="M24 44h16M24 52h16M80 44h16M80 52h16" stroke="var(--neutral-6)" strokeWidth="3" strokeLinecap="round" />
      <path
        d="M50 66c6-8 14-8 20 0"
        stroke="var(--accent-9)"
        strokeWidth="3"
        strokeLinecap="round"
        strokeDasharray="3 5"
      />
      <path d="M64 60l6 6-8 2" stroke="var(--accent-9)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function DesktopIllustration() {
  return (
    <svg {...common}>
      <rect x="16" y="26" width="88" height="58" rx="6" fill="var(--surface-raised)" stroke="var(--neutral-8)" strokeWidth="2" />
      <rect x="16" y="26" width="24" height="58" rx="6" fill="var(--neutral-3)" />
      <path d="M50 42h42M50 52h42M50 62h26" stroke="var(--neutral-6)" strokeWidth="4" strokeLinecap="round" />
      <path d="M48 96h24M60 84v12" stroke="var(--neutral-8)" strokeWidth="3" strokeLinecap="round" />
      <circle cx="94" cy="30" r="8" fill="var(--accent-9)" />
    </svg>
  );
}

export function DocumentGlyph() {
  return (
    <svg width="40" height="48" viewBox="0 0 40 48" fill="none" aria-hidden="true" focusable="false">
      <path
        d="M6 2h20l12 12v30a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z"
        fill="var(--surface-raised)"
        stroke="var(--neutral-7)"
        strokeWidth="1.5"
      />
      <path d="M26 2v10a2 2 0 0 0 2 2h10" fill="var(--neutral-4)" stroke="var(--neutral-7)" strokeWidth="1.5" />
      <path d="M11 24h18M11 30h18M11 36h11" stroke="var(--accent-7)" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}
