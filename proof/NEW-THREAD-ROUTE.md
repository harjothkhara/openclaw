# Native New Thread fork-only proof route

This branch is infrastructure/proof only. Never add these files to PR #186259.
The public product head remains 2b916adf3896eb18fb11d7702c9dd203fa1aaecf.
True base: 1b50ce5a6835798634c4d98ac87891f4e5290120.

## Determining source and oracle

At both pins and inspected main14526249956c, the native six-argument protocol
default calls the four-argument overload, whose Gateway default calls six again.
The base Mac transport lacks the concrete six-argument overload: recursion is
native and PRECEDES the RPC builder. Duplicate Gateway creates are not the red
oracle. The fix adds that concrete route using the captured new-session lease.

File > New Thread is web-only. Native ChatWindowShell's toolbar Thread > New
Thread calls viewModel.startNewSession(). Thread > Copy Session Key copies the
production viewModel.sessionKey via ChatPasteboard's clear-then-set operation.
The targeted helper uses that exact toolbar/menu, not File, keyboard shortcuts,
coordinates, a full SwiftUI tree walk or a renamed sidebar row.

## One owner per proof responsibility

- new-thread.mjs owns isolated source/profile/Gateway/app state, wire correlation,
  memory/watchdog, health/liveness and inference rejection. It delegates evidence
  persistence and process-group lifecycle to the two owners below.
- evidence.mjs owns a flushed atomic incomplete/start receipt before child work,
  bounded stack/log reads, required-artifact records, final behavior verdict before
  optional diagnostics, and manifest verification. The stack sampler writes through
  its bounded stdout pipe, not an uncontrolled external file. Limits are 8 MiB per
  process/stack/log, 2 MiB per small receipt, and 16 MiB per owned image artifact;
  these are proof collection caps, not display/upload recommendations. Reads abort
  after at most 2s. Optional export has a 32 MiB/128-file/5s collection budget;
  over-budget/overflowed logs are omitted with metadata, not partial secret-bearing
  prefixes. Required failure makes the outcome incomplete. Optional export cannot
  erase the retained verdict. Successful high-frequency ps logs are omitted from
  verbose export; failed probes remain, and newest diagnostics have priority.
  The required memory.json and command records are unchanged. Both workflow gates
  independently verify the mode's
  required file set, byte counts and hashes using manifest schema2. Filesystem/VM
  failure can still prevent writes; retained start data never implies success.
- owned-processes.mjs owns captured PGIDs, live-leader authority immediately before
  signaling, bounded TERM/KILL/pipe settlement, and observations of every group.
  Leader exit, pipe closure and group absence are distinct. A surviving PGID after
  leader exit is unattributed: do not signal it or claim retirement. Cleanup stays
  failed/incomplete and disposable-runner retirement remains coordinator-owned.
- ax-budget.mjs owns the declared operation budget: ping/fixture1s and other
  actions3s. Node passes it to targeted-menu.swift; Swift enforces monotonic work
  time and checks the final completion snapshot, and Node checks the declaration
  and elapsed work before accepting a receipt. Parent process kill is work+1s and
  pipe settlement is kill+2s; startup overhead is not helper work. AX messages keep
  <=200ms timeouts. Missing, ambiguous, untrusted or slow state stays incomplete.
  probe is read-only and does not qualify menu-item attachment; new/copy-key do.
- active-key.mjs composes fresh clipboard receipts, canonical response key, full
  durable inventory,10s monotonic endpoint stability and post-stability AX ping.
  It never returns a product verdict alone. The new ID must not alias ANY baseline
  ID, and all old key-ID pairs survive. Complete list count/total/hasMore/nextOffset
  are required by the caller; >200 isolated rows fail closed rather than truncate.
- The immutable shared canary remains owned by #185529, read-only checkout at
  13cde4984372bef34402ae61ff7891379626f260. qualified-canary.mjs calls its exported
  capture/runner diagnostic, then starts that SAME fixture briefly to qualify
  this exact compiled AX binary. The fixture is borderless/accessory, so only
  helper action fixture may omit product frontmost/focused-window requirements;
  it is strictly read-only AXWindows. Product ping/probe/new/copy retain them.
  No cloned fixture or weakened shared oracle is introduced.

The previous JXA full-tree helper, baseline fixture, row/rename selection helper
and their obsolete tests were removed. Shared direct AX+capture canary replaces
coarse System Events/desktop preflight. Only owned app windows are captured.
Necessary growth is native AX/clipboard and cross-process qualification code;
none enters the public product PR. Local Node contracts are NOT native proof.

## Serial dispatch contract

An authorized coordinator must read back the intended published proof SHA and
confirm no other live Mac proof run BEFORE dispatch. Inputs:

    target_sha: 2b916adf3896eb18fb11d7702c9dd203fa1aaecf
    serial_confirmed: true
    ax_preflight_only: false

Use the fork-only `mac-new-thread-proof.yml` workflow on
`proof/mac-new-thread-186215-2026-10-27` with `macos-26-intel`. A fail-closed
registration stub on the fork's default branch makes the manual workflow
available; the proof branch supplies the actual jobs. Verify registration and
branch-source support before dispatch. The canonical Periphery workflow remains
unchanged. Canonical ci.yml is restored byte-for-byte from exact product head.
serial_confirmed defaults false. Ubuntu admission explicitly rejects the wrong
repository/ref, absent serial confirmation and any rerun; scope failure is a failed
job, not only a skipped Mac job. The first Mac step repeats first-attempt admission
before checkout/build because partial reruns can reuse successful Ubuntu admission.
The driver and both verdict gates independently reject attempt2. A partial rerun
can still allocate a runner before that first step fails; it cannot qualify proof
or grant the coordinator's shared slot. The proof concurrency group queues a
duplicate dispatch rather than rejecting it. `serial_confirmed` records the
coordinator's check at dispatch time; it is not revalidated when a queued run
starts. The coordinator must prevent duplicate dispatches and check the shared
Mac slot immediately before each dispatch. No dispatch here.

Compilation and cheap shared/exact-helper qualification run BEFORE packaging.
The same job then reuses exact-SHA native caches, builds true base, verifies its
bundle/runtime identities and complete config, starts isolated Gateway and app,
requires an owned frontmost onscreen window and captures it before targeted AX.
After base red qualifies, it builds/runs exact PR head and requires green.

Base red requires one acknowledged native menu action, overlapping sampler,
original repeated recursive stack signatures, positive post-press allocation
growth and recognized bounded watchdog stop. A crash before a recognized watchdog
remains incomplete, even with partial stack/allocation evidence: this route does
not yet establish a causally classified crash receipt. It never treats a bare
crash, timeout or disconnect as red. No create RPCs and unchanged durable
key-ID inventory corroborate recursion; silence or timeout alone never pass.
A relay reset after the recognized red stop is expected teardown, using the same
predicate as socket closure. Resets before a guard or during green remain fatal;
other evidence failures are not cleared. Sampler pipe settlement has a16s bound
once awaited after the guard, including when its leader exited with pipes open.
Action helpers retain independent 4s kill/6s settlement bounds (ping/fixture use
2s/4s). Memory monitoring starts before the press and continues through stability.
Only red
arms the 10s action watchdog after acknowledgement; green instead gets its own
10s correlation budget after the bounded press returns. A slow valid press must
not consume that correlation budget.
Green requires exactly one native create RPC/canonical response and same admitted
connection subscribe/history, fresh active-key copies before/after action and
at least10s later, a genuinely new durable ID, cheap final AX ping, live app and
Gateway/connection, no guard/inference, then verified cleanup. No action retry.

Hosted run 40951702213 built the base app and Gateway and captured one owned,
frontmost, rendered window, but the first product AXRole read returned macOS AX
error -25204 before any action. The exact helper passed its separate AppKit
fixture check. During the 90s startup admission window, the driver now retries
only this exact read-only app-root error after reconfirming the owned window;
other AX errors still stop immediately. An exhausted window remains incomplete.
This is setup tolerance, not a red or green behavior oracle.

Optional ax_preflight_only:true is startup/Thread-target diagnostics only. It
never opens/presses a menu or copies the clipboard, forbids creation/inference,
skips green packaging and ends preflight-ready/nativeUIProof=false, not product
proof. A full build solely for startup is not preferred after a passing cheap
canary; this input is an explicit diagnostic fallback.

## Evidence and limits

Artifact mac-new-thread-real-app-<run>-<attempt> contains the shared runner and
exact-helper receipts, compile logs, per-arm retained verdict/source/runtime hashes,
required-file manifest schema2 and optional export omission/error metadata,
Gateway/config/stdout/stderr diagnostics, bounded AX stages/last command, wire
records, memory/stack, durable inventories and owned-window captures as reached.
Missing or failed setup remains incomplete; a successful workflow is insufficient
without inspecting exact-arm verdicts, logs and captures. PNG geometry alone is
not painted-content proof; images need inspection. Selection is sampled at the
endpoints, not asserted continuously visible.

Retained product receipts: native base test red40568043055; exact-head native
35/35+SwiftFormat/SwiftLint green40577761227. Real-app40598236532 was incomplete
at AX snapshot BEFORE New Thread, with no green arm. The old Finder/Dock image
was taken BEFORE app launch and does not prove postlaunch window absence.
Shared diagnostic40648820698 passed, but is not OpenClaw/New Thread proof and
cannot transfer executable-specific permissions to another VM/binary.

Local qualification: Node contracts, syntax, YAML/bash/gate checks and fresh
source review. Native Swift compilation and the separate AppKit fixture passed in
run 40951702213; product AX/menu/clipboard/action behavior remains UNVERIFIED.
No real-app red or green, review rating, or ready-for-maintainer-look claim is
made by this branch.
