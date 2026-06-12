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
