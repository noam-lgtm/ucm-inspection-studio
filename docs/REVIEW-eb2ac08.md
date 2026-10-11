# Review of commit eb2ac086e40a5b85914f452055e4d55cb8538be4

Independent product and code review of the single-file prototype (`index.html`, 943 lines) and the GitHub Pages deployment. Line numbers refer to `index.html` at that commit (`git show eb2ac08:index.html`).

Legend: **Proven** = reproduced in code or in a browser; **Suspected** = strong reading of the code, not executed; **Unverified** = could not be checked from this environment.

Deployment check: the Pages workflow run `pages build and deployment` #1 built `main` at `eb2ac08` successfully, so the live site is this file. Direct fetching of `noam-lgtm.github.io` was blocked by the review environment's network policy (Unverified by direct fetch).

## Critical

### C1. Sample size ignores the Table II-A arrows (wrong sample size for common CNC lot sizes) — Proven
* Evidence: `samplePlan` (lines 102–123) maps lot size → code letter → sample size using Table I only. Line 721 prints "Sample size only: AQL 2.5 acceptance/rejection rules are NOT calculated".
* The standard (MIL-STD-105D/E, ANSI/ASQ Z1.4, ISO 2859-1) selects the plan from Table II-A, whose arrow cells say "use first sampling plan below/above the arrow"; the sample size changes with the arrow. For the default AQL 2.5, code letters A, B, C are down arrows and E is an up arrow, all resolving to code D (n=8, Ac 0 / Re 1).
* Reproduction: Quantity 60, level II → the app shows **13**. Standard: lot 51–90 → E → ↑ → **D, n=8, Ac 0 Re 1**. Quantity 10 → app shows **3**; standard: **8**. Quantity 20 → app **5**; standard **8**.
* Impact: inspection reports for small lots understate the required sample by up to 2.7× and carry no acceptance numbers.
* Correction: implement Table II-A with arrow resolution and the "n ≥ lot → 100% inspection" rule (done: `src/sampling.js`, tests in `tests/unit/sampling.test.js`).

### C2. "Required" and "Nominal" are independent fields; a contradiction still yields PASS — Proven
* Evidence: `evaluateFeature` (lines 150–169) uses `feature.nominal/minus/plus`; the screen (line 633) and the PDF (line 713) print `feature.required` (free text). The nominal is never printed.
* Reproduction: Template editor → row with Required `25.00`, Nominal `30`, TOL− `0.1`, TOL+ `0.1`. Report → enter Min `30`, Max `30` → status **WITHIN LIMITS**. PDF prints "25.00 | 0.1 | 0.1 | 30 | 30 | WITHIN LIMITS".
* Correction: derive the printed requirement from the structured nominal/deviations and print the computed limits (done: `requirementText`, `limitsText` in `src/core.js`). Migrated v1 rows whose text disagreed with the nominal keep the old text as a visible label plus a note so the author must reconcile them.

## High

### H1. "Keep" on Quantity / Accepted / Rejected locks the field empty forever — Proven
* Evidence: `freshReport` blanks `quantity`, `accepted`, `rejected` (lines 236–239) while `renderReport` disables any field with `keep[k]` (lines 642, 645, 599).
* Reproduction: Template → tick "keep" for Quantity → New report → Quantity is disabled and empty; sample size stays "—".
* Correction: these fields are never lockable (done: `lockable: false` in `HEADER_FIELDS`, enforced in `createReport` and `normalizeTemplate`).

### H2. Shifted and some unilateral tolerances cannot be expressed — Proven (code)
* Evidence: line 155 rejects `minus < 0 || plus < 0`; lower limit is always `nominal − minus`. A shaft `20 +0.10/+0.05` or a bore `20 −0.02/−0.05` has no representation, forcing wrong limits.
* Correction: signed upper/lower deviations with `lower ≤ upper` validation (done; see `featureLimits` tests).

### H3. No report history; "New report" and template switch destroy the previous report; backup excludes report data — Proven
* Evidence: line 797 replaces `local.report`; line 882 likewise; export deliberately excludes measurements (line 827 comment).
* Correction: automatic archive of every report, reopen/duplicate/delete, full backup including reports (done).

### H4. Min > Max is printed as a nonconformance — Proven
* Evidence: line 147 returns `state: 'fail'` ("Minimum exceeds maximum"); the PDF prints **OUT OF LIMITS**.
* Correction: treat as a data-entry error that blocks the verdict (REVIEW), never FAIL (done).

### H5. PDF note hard-codes "AQL 2.5" regardless of the AQL field — Proven
* Evidence: line 721. With AQL 1.0 entered, the customer document still says "AQL 2.5 acceptance/rejection rules are NOT calculated".
* Correction: notes generated from the actual plan (done).

### H6. PDF does not show nominal or limits — Proven
* Only the free text and TOL−/TOL+ magnitudes are printed (lines 713, 726). Combined with C2 the customer cannot see what the verdict was computed against.
* Correction: Limits column with computed min–max (done).

## Medium

### M1. Hebrew UI strings are obfuscated through a keyboard-layout cipher with a false rationale — Proven
* Lines 262–466: `heb()` maps Latin keys to Hebrew code points "without requiring external fonts" (fonts are unrelated to source encoding). A second `Object.assign` (line 397) overrides most of a first, partly garbled layer. Maintenance hazard; cannot be proof-read in the source.
* Correction: plain UTF-8 strings in `src/i18n.js` (done).

### M2. Labels are not associated with inputs — Proven
* Line 601 emits `<label for="h_key">` but inputs have only `name`. Screen readers announce unlabeled fields; clicking a label does nothing.
* Correction: ids on all header controls (done).

### M3. Tab buttons use `aria-selected` without `role="tab"`; `role="tablist"` wraps plain buttons — Proven (lines 47–51, 617). Replaced by a `<nav>` with `aria-current` (done).

### M4. Multi-page print: masthead only on page 1, no running header — Proven in Chromium
* Table header repeats (line 25), page numbers rely on `@page` margin boxes (Chrome ≥131 only).
* Correction: running header on every page via a repeating table head (verified in the 3-page PDF test), page numbers kept.

### M5. Saved PDF is named after the page title ("UCM | Inspection Studio") — Proven. Title now set to `<report no>_<part no>` while printing (done; PDF metadata checked in the e2e test).

### M6. Logo stored full size as base64; 30 templates × 470 KB could exceed the localStorage quota — Suspected. Logos are now downscaled on a canvas (≤900×360) before storing (done).

### M7. Only general inspection levels I–III; special levels S-1…S-4 missing — Proven. Added (cross-checked against an independent transcription).

### M8. AQL is free text with no normalisation ("2,5", "2.50") — Proven. Now a select of the shipped columns plus an explicit "other" that disables Ac/Re (done).

### M9. The "composite" heuristic (`x` and `°` in the Required text → PARTIAL, lines 164–168) is fragile: "Ø10 x 45°" is flagged, "10 ±0.1 / 30°" is not — Proven (regex). Removed; one row per characteristic by design.

### M10. Import replaces all local templates (line 845) — Proven. Import now merges by id and deletes nothing (done).

### M11. Storage origin is shared with every other GitHub Pages site of the same account — Unverified whether other sites exist. Documented in README; a custom domain or dedicated account isolates it.

### M12. No Content-Security-Policy; all code inline — Proven. Strict CSP meta added; scripts moved to files.

### M13. No tests, no CI — Proven. 30 unit tests, 11 end-to-end tests (real Chromium, real PDFs checked with pdftotext/pdfinfo), GitHub Actions workflow added.

### M14. Accepted / Rejected quantities unvalidated — Proven. Integer checks and "sum exceeds lot" / "nonconforming exceeds sample" warnings added.

### M15. No offline capability for a shop-floor tool — Proven. Service worker added and tested offline.

### M16. `confirm()`/`alert()` for help; help text is a wall of text — Low/Medium. `<dialog>` with steps (done).

## Low

* L1. Lot size parsing accepts `1e3` and `0x10` (`Number()` at line 103) — Proven; strict integer parse now.
* L2. Measurement parser rejects "25.5 mm" and treats "1,250" as 1.250 — Proven; unit suffixes accepted, comma-decimal kept (Hebrew keyboards).
* L3. Template editor shows an internal note "address and logo restored from the old document, approve before official use" to end users — Proven (key `contact_verification`). Removed; details are editable per template.
* L4. Feature unit labelled "degrees" in the select but printed as "deg" — Proven; unit symbols unified.
* L5. The sample size "—" placeholder renders as a thin line at 58 px — cosmetic.
* L6. Dates printed ISO (`2026-10-11`) — acceptable but unusual on customer documents; now `11 Oct 2026`.
* L7. Measurement rows require both Min and Max even for a lot of one — now "=" button and Enter-in-empty-Max copy the Min.
* L8. Preview pane uses `min-width: 1050px` media rule for `.print-sheet` display (line 22) plus inline override — Suspected harmless; superseded.

## Deferred (not implemented, with reasons)

* D1. Table II-A columns for AQL < 0.65 and > 6.5. The structure is known, but only the six columns above were cross-checked against independent transcriptions. Add after checking against a primary copy of the standard.
* D2. Tightened / reduced inspection and switching rules. Need lot history and a QA policy decision; deliberately out of scope so that nothing is invented.
* D3. Per-piece recording (n values per characteristic) instead of Min/Max. Would let the app count nonconforming units automatically, but multiplies data entry; current paper forms use Min/Max. Candidate for an optional mode.
* D4. Hebrew-language PDF variant. The customer document is English by design.
* D5. Drawn/digital signatures. Signature lines are printed instead.
* D6. CSV/Excel export of the archive. JSON backup exists; add when needed.
* D7. Cloud sync, accounts, multi-user — rejected per requirements (no infrastructure).

## Rejected

* R1. Using the npm packages `aql-sample-size` / `garment-aql-calculator` at runtime. Both resolve arrow cells wrongly (they keep the letter's own sample size), which is exactly defect C1. Used only as cross-check fixtures in tests.

## Unverified

* U1. Table II-A arrow positions rest on the table's documented structure (constant n×AQL diagonals, one up-arrow directly under each 0/1 cell) and secondary sources, not on a primary copy of MIL-STD-105E. Five-minute check against the company's paper copy: the AQL 2.5 column for A…R must read ↓ ↓ ↓ 0/1 ↑ 1/2 2/3 3/4 5/6 7/8 10/11 14/15 21/22 ↑ ↑ ↑.
* U2. Printing verified in headless Chromium 141 only. Firefox and Safari do not support `@page` margin boxes, so page numbers are absent there; the running header still repeats.
* U3. Hebrew glyph rendering on Windows (Arial has Hebrew) not checked visually.
* U4. Service worker behaviour under the `/ucm-inspection-studio/` path on GitHub Pages; registration is relative and tested on a local root path.
* U5. Logo downscaling tested with a 1×1 PNG only.
