# Name check — "Selis" (2026-10-14)

**Decision (owner, 2026-10-15; ADR 0025): keep "Selis".** Recorded findings:

- US **SELIS**, serial **86463675** (registered) — Lam Research Corp., class 7 (semiconductor manufacturing
  machinery): different goods and customers, **no conflict**.
- US **SELIS**, serial **76171221** (class 9 goods on Justia) — **status unverified** (TSDR not
  readable from here); owner check below.
- **"SELISE Signature"** (Secure Link Services Limited) — a similar name in the e-signature space
  on the App Store: **low-to-medium risk** of a complaint; nothing found suggesting an EU/Swiss
  class 9/42 mark.

A screening, not legal clearance.

| Where | How | Result |
| --- | --- | --- |
| Google Play | Store search "selis" (apps) | No app named Selis. Nearest: **Selisseo** (Adisseo, animal-nutrition business app), **SELICELL**, **Senlis** (Lumiplan), developer **Selisys** (eCust field-service apps). None is a PDF or document app. |
| App Store | iTunes Search API, term "selis", US and GR storefronts | No app named Selis. Nearest: **SELISE Signature** and **SELISE App** (Secure Link Services Limited — SELISE, a Swiss IT company); SELISE Signature is an **e-signature** app ("sign, manage, and verify documents", eIDAS/ZertES). Others: Selia (mental health), Sely, SeliShow. |
| F-Droid | search.f-droid.org "selis" | No results. |
| USPTO | Public aggregators (TSDR itself rate-limited the check) | **SELIS**, serial 86463675, Lam Research Corp. — live, incontestable; goods listed as semiconductor machinery (class 7), not software. **SELIS**, serial 76171221 — class 9 goods (data-processing apparatus, computers) on Justia; owner and status not readable without TSDR. |
| EUIPO / TMview | eSearch plus and TMview are interactive apps without an open API; not reachable from here | **Not checked** — owner action below. |

## Assessment

- No store has an app called Selis, and none in the PDF / document category with a confusable
  name, except **SELISE Signature**: a different word (SELISE ≠ Selis), but the same field
  (signing documents) and a company name that reads close. Risk: low-to-medium of a complaint
  if SELISE holds an EU/Swiss mark in class 9/42; nothing found to suggest it does.
- USPTO: the live SELIS mark is for semiconductor equipment (different goods, different
  customers); the class-9 SELIS record needs its status checked in TSDR.

## Owner actions (free, ~15 minutes)

1. EUIPO eSearch plus (<https://euipo.europa.eu/eSearch/>): word mark "SELIS", Nice classes 9
   and 42, all statuses; also "SELISE".
2. TMview (<https://www.tmdn.org/tmview/>): "SELIS", territories EU, GR, CH, US, classes 9 / 42.
3. USPTO TSDR (<https://tsdr.uspto.gov/>): serial 76171221 — owner and status (live or dead).
4. Greek register (OBI / GR TMview office): "SELIS", "ΣΕΛΙΣ".

If a live class 9/42 "SELIS" mark appears in the EU or US, ask a trademark attorney before the
store listings go live (the SPEC's fallback: the repo renames easily, store listings do not).
