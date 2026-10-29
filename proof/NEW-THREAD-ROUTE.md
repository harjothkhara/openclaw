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
  memory/watchdog, health/liveness, inference rejection and bounded owned cleanup.
- targeted-menu.swift owns bounded direct AX observation/action. Each message has
  <=200ms timeout, ping/fixture1s, other operations3s; parent kills at4s and bounds
  settlement at6s. Missing, ambiguous, untrusted or slow state stays incomplete.
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

Use registered workflow macos-periphery.yml (ID 332474845) on
proof/mac-new-thread-186215-2026-10-27, macos-26-intel. The proof-branch
workflow declares the proof inputs/jobs; its default-branch counterpart remains
normal Periphery. Registration and branch-source support are verified, not
authenticated dispatch acceptance or permission. Canonical ci.yml is restored
byte-for-byte from exact product head; no fork-main workflow is changed.
serial_confirmed defaults false; Ubuntu admission refuses false or a job rerun
before allocating Mac. The existing shared concurrency group remains unchanged;
it supplements, never replaces, coordinator admission. No run was dispatched here.

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
The AX helper retains its independent 4s kill/6s settlement bounds. Memory
monitoring starts before the press and continues through stability. Only red
arms the 10s action watchdog after acknowledgement; green instead gets its own
10s correlation budget after the bounded press returns. A slow valid press must
not consume that correlation budget.
Green requires exactly one native create RPC/canonical response and same admitted
connection subscribe/history, fresh active-key copies before/after action and
at least10s later, a genuinely new durable ID, cheap final AX ping, live app and
Gateway/connection, no guard/inference, then verified cleanup. No action retry.

Optional ax_preflight_only:true is startup/Thread-target diagnostics only. It
never opens/presses a menu or copies the clipboard, forbids creation/inference,
skips green packaging and ends preflight-ready/nativeUIProof=false, not product
proof. A full build solely for startup is not preferred after a passing cheap
canary; this input is an explicit diagnostic fallback.

## Evidence and limits

Artifact mac-new-thread-real-app-<run>-<attempt> contains the shared runner and
exact-helper receipts, compile logs, per-arm verdict/source/runtime hashes,
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
source review. Native Swift compilation/AX shape/menu/clipboard/latency and app
behavior remain UNVERIFIED until the coordinated hosted run. No real-app green,
review rating or ready-for-maintainer-look claim is made by this branch.
