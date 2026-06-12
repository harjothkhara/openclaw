# Audit — <subsystem> — <YYYY-MM-DD>

**Scope:** <files/dirs audited, and why this slice>
**Method:** <how the audit was run: adversarial read, test-gap probing, fuzz sketch, etc.>
**Out of scope:** <neighboring code deliberately not audited>

## Findings (ranked)

### F<NN>-<n>: <one-line title>

- **Priority:** P0 | P1 | P2  (P0 = wrong results/data loss/crash; P1 = incorrect edge-case behavior; P2 = latent hazard/hygiene)
- **Location:** `<file>:<line>`
- **Description:** what the code does vs. what it should do, with the exact code path.
- **Repro / failing-test sketch:** concrete input and expected-vs-actual output, or a
  sketch of the unit test that would fail today.
- **Skeptic verification:** result of a fresh adversarial pass that tried to *refute*
  the finding (e.g. "claimed X overflows; checked callers — all bounded; REFUTED" or
  "reproduced with input Y on commit <sha>; CONFIRMED"). Required for any finding
  promoted to a fix branch. Include the upstream dupe-check result here (issues/PRs
  searched, anything found).

<repeat per finding>

## Non-findings

Suspicions investigated and cleared, so future audits don't re-chase them.
