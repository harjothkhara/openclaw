# #186259 targeted-menu proof assessment

Status: fork-only preparation, not a dispatched run or native-UI result.
The targeted menu action is NOT adopted yet. Do not run the older startup-only
packet as an automatic next build: the preferred sequence below supersedes it,
subject to obtaining the shared canary source and passing receipt.

## Verified source, not a duplicate-request hypothesis

Current upstream main inspected at14526249956c67b45143b44a459ec0da3f228b7b;
true base1b50ce5a6835798634c4d98ac87891f4e5290120 and exact PR head
2b916adf3896eb18fb11d7702c9dd203fa1aaecf remain the behavior-proof pins.
The relevant shared transport/menu modules match across the proof pins.

- ChatTransport.swift:1156 six-argument default, with nil explicit agent/base ref,
  awaits the four-argument createSession.
- ChatGatewayTransport.swift:141 four-argument default awaits that six-argument
  overload again. Base/current-main Mac transport has no concrete six-argument
  implementation. This is an async native protocol-dispatch cycle, NOT repeated
  Gateway business requests. It never reaches the lease RPC builder.
- The PR's concrete six-argument method acquires the existing Mac route lease;
  only its createSession closure builds and dispatches the real Gateway request
  (MacGatewayChatTransport+SessionActions.swift).

Therefore base red cannot require duplicate Gateway requests. Zero requests alone
also cannot prove recursion. Red retains an acknowledged native action plus the
original positive recursive-stack signature and post-press allocating growth,
a recognized bounded watchdog stop, zero create RPCs and unchanged durable keys.
Timeout, silence, missing GUI or a failed canary alone is always incomplete.

## Source-correct native menu route

Do NOT press File > New Thread: MenuBar.swift:105 installs that command only when
nativeExperienceEnabled is false, where it calls the Dashboard web command.

The native window's toolbar Thread menu is different:
ChatWindowShell.swift:362 New Thread calls viewModel.startNewSession(), which
reaches performStartNewSession and the same six-argument transport as the sidebar.
The menu is labeled Thread with help Thread actions (:523-535), and its item is
New Thread. The production source has no stable menu accessibilityIdentifier,
so do not guess a global menu selector or fall back to an unrelated item.

After the shared canary qualifies targeted AX, use a bounded query confined to
the owned native window's toolbar and its opened Thread menu. Require one enabled
Thread menu, then one enabled exact New Thread AXMenuItem; perform AXPress once.
Never traverse the SwiftUI content/sidebar tree, silently use coordinates, or
route through File's web-only command. The actual AX role/path still requires
native qualification; this source assessment does not claim its runtime shape.

## Authoritative green selection without sidebar recursion

Thread > Copy Session Key is an existing production UI action (:477-479) that
copies viewModel.sessionKey. adoptCreatedSession (:1257 in ChatViewModel.swift)
sets that field after successful creation and bootstraps the selected session.

Use a fresh clipboard sentinel/change-count receipt in the disposable runner,
AXPress Copy Session Key in that same owned native Thread menu, and require the
new clipboard value equal the successful Gateway create response's canonical key.
Pair it with exactly one native create request, correlated same-connection success
and subsequent subscribe/history receipts, and one new durable Gateway session ID.
Repeat active-key equality, a cheap bounded AX app/window ping, live native
connection and app memory/liveness after the stability interval. Copying a stale
clipboard string, transport traffic alone, or a current-main helper test is not
an active-selection proof. This replaces the expensive selected-row/rename oracle
only once the targeted path is proven; no observer-driven selection/reopen is allowed.

## Canary and build sequencing

Reuse the exact known-good AppKit fixture owned by #185529; do not create a competing
fixture or edit that lane. Its helper-only result is diagnostic, not #186259 proof.
A separate hosted run uses a fresh VM: its successful receipt qualifies the approach,
not another job's live AX/capture permission. Pin and run the same cheap fixture
at the start of the actual #186259 Mac job, before app packaging, to verify an
unlocked/display-capable session, cross-process nonblank capture, AX trust and
fast targeted queries on THAT runner. Native window/route gates still apply to
the real app after packaging and before the action.

Once qualified, fold startup gates into one serial true-base red / exact-head green
real-app run. This avoids packaging the same base just to run startup-only and
then packaging it again for behavior. Retain startup-only only as an explicit
fallback diagnostic; it is not the recommended extra build after a good canary.
If the fixture or actual window/menu gate fails, stop before the action, preserve
sanitized diagnostics, and do not infer a product red/green verdict.

The verified public #185529 proof head d4531bad565 does not yet contain the new
helper-only cross-process fixture canary; only its old pixel selftest is present.
Need its immutable source SHA/interface and passing receipt before wiring that
external contract or adopting an AX selector. No fabricated canary pass/input.

The coordinator remains the single owner of cross-lane Mac allocation and must
prioritize #185529 and check queued/running jobs immediately before dispatch. This
revision does not change scheduling: merely joining a workflow concurrency group
can replace another pending run in GitHub, even with cancel-in-progress=false.
Do not treat a per-lane concurrency group as cross-lane exclusion. No Mac job is
dispatched by this change.
