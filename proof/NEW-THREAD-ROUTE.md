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
The same job then reuses exact-SHA native caches, builds/runs the exact PR head,
and checks shared consumers before retiring that disposable source checkout.
It then builds true base, verifies bundle/runtime identities and complete config,
starts isolated Gateway and app, and requires an owned frontmost onscreen window
before targeted AX. The final gate still requires both real-app green and red.

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

Hosted run 40965501000 recovered four exact app-root reads, then failed at
AXChildren values while the captured native window still showed Loading chat.
The native chat.history request had not received its Gateway response when AX
traversal began. The driver now waits for that successful response on the one
live admitted native connection before window capture and targeted AX. Missing
history remains incomplete after the existing 90s admission window; later-node
AX errors still fail immediately unless a children-values cannotComplete is
paired with a changed, still-bounded child count. In that case the helper makes
one more read of that node's children within its existing deadline. An unchanged
count or second failure stops the probe; no action is retried. The previous run
does not establish that the child count changed, so this guard may still leave
the next run setup-incomplete.

Hosted run 40976103873 reached successful native chat.history and an owned
rendered window. The targeted helper traversed the toolbar but stopped at its
combined Thread-control uniqueness/enabled guard before any menu action. Its
AX stages do not retain candidate attribute values, so this run cannot tell
whether the control was missing, duplicated, or disabled. The read-only probe
now records at most 16 toolbar button candidates as role and Boolean matches
against the expected title, description, and help; it exports no raw AX text.
If a 17th candidate appears, it records the bounded first 16 before failing.
It fails distinctly for missing, ambiguous, or disabled controls. This is
diagnostic only: the selector and no-action preflight boundary are unchanged.

Read-only hosted preflight 40986331837 found three toolbar buttons. The only
AXMenuButton had exact help Thread actions but no Thread title or description,
so the old selector stopped as missing before checking enabled or taking any
action. The helper now also accepts that exact help on an AXMenuButton within
the already unique toolbar. It still requires exactly one match and AXEnabled
before any later action; no action or product red/green verdict is inferred from
the preflight. A fresh read-only hosted preflight must qualify this selector.

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
Run 40965501000 also stopped before any New Thread action; its hosted fixture
and owned-window controls passed, but it is not base-red or PR-green proof.
No real-app red or green, review rating, or ready-for-maintainer-look claim is
made by this branch.

Run 40994619133 stopped before any action on AXHelp cannotComplete (-25204).
The existing 90s startup admission may repeat only a read-only probe after that
observed help-read failure, reconfirming live owned/frontmost window each time.
Action failures, other error codes, and other attributes still stop immediately.
No New Thread or clipboard action is retried and product verdicts are unchanged.

Run 41530040415 selected the Thread control and acknowledged opening its menu,
then stopped at AXChildren count cannotComplete before copying a key or creating
a thread. Pending-menu children reads may now return empty on cannotComplete;
the existing openMenu loop polls within its original monotonic 3s work budget.
The opening AXPress is never repeated. Other traversals retain strict errors.
Full proof now collects exact-head green/shared results before the baseline arm,
retiring the disposable green source to preserve runner disk space. The final
gate still requires both exact-source red and green verdicts.

Before any package build, a small independent SwiftUI toolbar-menu fixture now
qualifies actual one-press menu opening, fresh Copy Session Key, one New Thread,
and post-action copy using this exact AX binary. The fixture emits independent
key/action receipts. This is helper qualification only, never product proof;
final real-app red/green guards and immutable shared capture fixture are unchanged.

Cheap fixture run 41536886698 compiled and exercised menu/copy operations but
found no New Thread callback before the immediate subsequent copy. Qualification
now waits up to10s for the independent fixture new-action receipt before opening
another menu, matching the product driver's post-press correlation interval.
No menu action is retried and the fixture must still record exactly one new.

Run 41538014027 built the exact PR package successfully but failed the read-only
startup probe at AXChildren values cannotComplete after one root retry. No New
Thread ran. All AX value/count/children reads now handle cannotComplete at the
single read boundary, within the unchanged3s total operation budget. Fresh child
counts are bounded64 on every retry. Read-only startup probes exhausted on read
work may retry within the existing90s admission window after owned-window checks;
all effect operations remain single attempts and other errors remain fatal.

The uncached exact-head package build took72m in that run. The overall job budget
is now180m so both package builds and shared tests can finish without losing
evidence at the former120m job cap. Per-operation/UI/cleanup budgets are unchanged.
Action-name discovery uses the same bounded read retry, with live owned-app
validation moved after discovery immediately before the one AX action.

Run41563194807 reached the actual native New Thread action and one sessions.create
RPC with bounded memory, but the fresh fixture had no durable main conversation;
the Gateway rejected its parent with INVALID_REQUEST unknown parent session.
The linked issue186215 explicitly reports an existing configured installation.
Setup now creates agent:main:main via the real public Gateway API, requires no
model run and a matching durable inventory row, and retains setup-parent.json
before the native connection/observation starts. No runtime store is edited and
no native request is substituted. Both real-app arms use the same setup; the
native action must still create a genuinely new durable ID while preserving this
baseline. Empty-profile parent selection is unchanged and is not claimed fixed.

Run41707303411 timed out while creating the existing parent before native launch.
CLI startup consumed most of the20s process cap; cleanup then stopped the Gateway
while creation was active. Public setup RPCs now allow60s request time and90s
process time, including CLI startup. Native input, memory, stability, and cleanup
limits remain unchanged. Failed setup remains incomplete.
