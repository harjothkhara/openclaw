# FACTORY.md — agent-factory rulebook (fork-only)

This fork (`harjothkhara/openclaw`) runs an agent-factory pipeline modeled on the
Eva workflow: adversarial audit → plan → red-first implementation → evidence gate →
bot review → human self-merge. Nothing produced by the factory is pushed upstream;
all PRs target this fork's own `main`.

## Pipeline stages

1. **Audit (intake).** An adversarial audit of one bounded subsystem produces
   `audits/AUDIT-<YYYYMMDD>.md` with ranked findings (format: `audits/AUDIT-TEMPLATE.md`).
   The top finding gets a fresh skeptic pass that actively tries to refute it before
   it is accepted. Real findings only — if a slice is clean, widen the slice; never
   invent issues. Cross-check the candidate against upstream open PRs/issues and
   upstream main so we don't fix something already fixed.
2. **Plan.** A short written plan (root cause, fix shape, test shape, blast radius)
   before any code.
3. **Implement.** On a dedicated branch, test first, then fix (see branch and
   red-first policies below).
4. **Evidence gate.** The PR stays **draft** until the evidence in the PR-body
   template is real and attached.
5. **Bot review.** CodeRabbit reviews the PR; every actionable comment is resolved
   per the policy below.
6. **Merge.** The human is the merge button. The agent never merges.

## Branch policy

- Work branches: `factory/fix-<id>` where `<id>` is the audit finding ID
  (e.g. `factory/fix-f01-1`). One finding per branch, one branch per PR.
- All branches fork off freshly synced `main`. Scaffold/infra changes live on
  `factory/scaffold`-style branches.
- Worktrees used for red runs or verification are removed as soon as that phase is done.

## Red-first test policy

Every fix PR must show, in this order:

1. **Red:** the new test written against the *unfixed* tree, with the failing run
   output captured verbatim (command + failure excerpt).
2. **Green:** the same test passing after the fix, output captured verbatim.
3. The surrounding test file/suite still passes (focused run is fine; name the command).

A PR without a captured red run does not leave draft. If the bug genuinely cannot be
captured in a unit test, the PR must say so under *Deviations from spec* and substitute
the closest reproducible evidence (script, REPL transcript).

## PR body template

```markdown
## Root cause
<what is actually wrong, file:line, why it happens>

## Fix
<what changed and why this is the minimal correct fix>

## Tests (red-first)
**Red** (on unfixed tree):
<command>
<failure output excerpt>

**Green** (after fix):
<command>
<passing output excerpt>

## Verification
<focused suite run, lint/typecheck if touched area requires it>

## Deviations from spec
<anything skipped, weakened, or done differently than FACTORY.md prescribes — honest, or "None">
```

## CodeRabbit policy

- CodeRabbit (GitHub App) reviews every factory PR on this fork.
- For **each** comment: verify the claim against the actual code first. Fix valid
  issues; for invalid ones, reply with the concrete reason it doesn't apply.
- After any fix prompted by a comment, rerun the focused validation (the test(s)
  covering that file) and note it in the thread.
- Every actionable thread must be resolved (fixed or explicitly rebutted) before the
  PR is marked ready for review.

## Self-merge checklist (human)

- [ ] Red and green outputs in the PR body are real (spot-check the commands).
- [ ] All CodeRabbit threads resolved.
- [ ] *Deviations from spec* section read and accepted.
- [ ] Branch is based on current fork `main`.
- [ ] Merge performed by the human, not the agent.

## Retro — run 1 (F01-1, 2026-06-12)

Single-lane MVP: audit → fix → draft PR <https://github.com/harjothkhara/openclaw/pull/3>.

| Stage | Rough cost | Notes |
|---|---|---|
| 0 Fork hygiene | ~10 min | Backup branch + `gh repo sync --force`; existing contributor clone had live work, needed a second clone (`openclaw-factory`) — plan for one clone per concern. |
| Scaffold | ~10 min | Rulebook + templates, cheap. |
| 1 Audit | ~20 min, the bulk of model tokens | Slice choice did the heavy lifting: `src/utils` parser modules feeding exec risk analysis. One P1 confirmed (F01-1), one P2 backlogged (F01-2). Skeptic pass + bash/shlex oracle + caller walk was the valuable part; upstream dupe-check cost two `gh search` calls. |
| 2 Plan | ~5 min | Plan stayed in-session, not a committed artifact. |
| 3 Implement | ~25 min | Red run captured first try. Friction: `pnpm test src/infra` lane config matches no files (exit 1) — run explicit test *files*, not directories; full-repo `format:check` is noisy — check only touched files. |
| 4 CodeRabbit | pending | Blocked on app install; CodeRabbit skips drafts by default, needs `@coderabbitai review` comment. |
| 5 Merge | pending | Human self-merge. |

**Where it broke / what to change before 3 parallel lanes**

1. Test-lane sharding: `pnpm test <dir>` can select an empty shard and fail spuriously.
   Lanes must always name explicit test files. (Worst failure mode: an agent
   "fixes" a non-broken build.)
2. CodeRabbit drafts: the evidence gate keeps PRs draft, but CodeRabbit ignores
   drafts. Either configure CodeRabbit to review drafts or make the
   `@coderabbitai review` comment a scripted pipeline step.
3. Audit is the bottleneck and the value: one auditor produced 1 promotable finding
   per ~6 small files. For 3 lanes, run 3 auditors on disjoint slices *first*, then
   assign findings to lanes — don't audit per-lane on demand.
4. Branch bookkeeping: audit docs live on `factory/scaffold` while fixes branch off
   `main`, so fix branches can't see FACTORY.md. Merge scaffold to fork `main`
   before scaling so every lane carries the rulebook.
5. Worktrees: single-clone lane-switching worked for 1 lane; 3 lanes need one
   worktree per lane (cleaned up at lane end) to avoid checkout thrash.
