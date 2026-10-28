// Candidate composition only. The production driver still owns RPC, liveness,
// inference and cleanup gates; this module never returns a product verdict.
import assert from "node:assert/strict";
function common(r, action, pid) {
  assert.equal(r?.schema, 1);
  assert.equal(r.kind, "targeted-native-ax");
  assert.equal(r.action, action);
  assert.equal(r.pid, pid);
  assert.equal(r.complete, true);
  assert.equal(r.frontmost, true);
  assert.equal(r.appRole, "AXApplication");
  assert.equal(r.windowRole, "AXWindow");
  assert.ok(Number.isFinite(r.sampledUptimeMs) && r.sampledUptimeMs >= 0);
  assert.ok(
    Number.isFinite(r.elapsedMs) &&
      r.elapsedMs >= 0 &&
      r.elapsedMs <= (action === "ping" ? 1000 : 3000),
  );
  if (action !== "ping") {
    assert.equal(r.threadMenuCount, 1);
    assert.equal(r.threadEnabled, true);
  }
}
export function requireCopyReceipt(r, pid) {
  common(r, "copy-key", pid);
  assert.equal(r.menuItemRouteVerified, true);
  assert.equal(r.newThreadPresses, 0);
  assert.ok(typeof r.sentinel === "string" && r.sentinel.startsWith("NT186215-"));
  assert.ok(Number.isInteger(r.changeCountBefore) && Number.isInteger(r.changeCountAfter));
  assert.ok(
    r.changeCountAfter > r.changeCountBefore,
    "Copy did not advance clipboard after the sentinel",
  );
  assert.ok(typeof r.key === "string" && r.key.length > 0 && Buffer.byteLength(r.key) <= 512);
  assert.notEqual(r.key, r.sentinel);
  return r.key;
}
export function requireActiveKey({
  canonicalKey,
  before,
  after,
  initial,
  selected,
  stable,
  click,
  ping,
  pid,
}) {
  assert.ok(typeof canonicalKey === "string" && canonicalKey.length > 0);
  common(click, "new", pid);
  assert.equal(click.menuItemRouteVerified, true);
  assert.equal(click.newThreadPresses, 1);
  assert.equal(click.clicked, true);
  assert.ok(Number.isFinite(click.pressedAt) && click.returnedAt >= click.pressedAt);
  assert.ok(
    Number.isFinite(click.pressedUptimeMs) && click.returnedUptimeMs >= click.pressedUptimeMs,
  );
  common(ping, "ping", pid);
  assert.equal(ping.newThreadPresses, 0);
  const initialKey = requireCopyReceipt(initial, pid);
  assert.notEqual(initialKey, canonicalKey, "The active key did not change");
  assert.equal(requireCopyReceipt(selected, pid), canonicalKey);
  assert.equal(requireCopyReceipt(stable, pid), canonicalKey);
  assert.ok(
    initial.sampledUptimeMs <= click.pressedUptimeMs &&
      selected.sampledUptimeMs >= click.returnedUptimeMs,
    "Copy receipts are not ordered around the action",
  );
  assert.ok(
    stable.sampledUptimeMs - selected.sampledUptimeMs >= 10000,
    "Stability interval was not observed",
  );
  assert.ok(ping.sampledUptimeMs >= stable.sampledUptimeMs, "Reused pre-stability AX ping");
  assert.equal(
    new Set([initial.sentinel, selected.sentinel, stable.sentinel]).size,
    3,
    "Reused clipboard receipt",
  );
  assert.ok(
    selected.changeCountBefore > initial.changeCountAfter &&
      stable.changeCountBefore > selected.changeCountAfter,
    "Clipboard phase ordering missing",
  );
  assert.ok(Array.isArray(before?.sessions), "Missing authoritative baseline session snapshot");
  for (const row of before.sessions) {
    assert.ok(typeof row.key === "string" && row.key.length > 0);
    assert.ok(
      typeof row.sessionId === "string" && row.sessionId.length > 0,
      "Baseline durable identity missing; cannot prove session-ID freshness",
    );
  }
  const beforeKeys = new Set(before.sessions.map((row) => row.key));
  const beforeIds = new Set(before.sessions.map((row) => row.sessionId));
  assert.ok(Array.isArray(after.sessions));
  const durableByKey = new Map(after.sessions.map((row) => [row.key, row]));
  for (const row of before.sessions) {
    assert.equal(
      durableByKey.get(row.key)?.sessionId,
      row.sessionId,
      "Creation removed or replaced an existing durable session",
    );
  }
  const added = after.sessions.filter((r) => !beforeKeys.has(r.key));
  assert.equal(added.length, 1);
  assert.equal(added[0].key, canonicalKey);
  assert.ok(typeof added[0].sessionId === "string" && added[0].sessionId.length > 0);
  assert.ok(
    !beforeIds.has(added[0].sessionId),
    "Created key aliases an existing durable session ID",
  );
  return { key: canonicalKey, sessionId: added[0].sessionId, oracle: "native-copy-session-key" };
}
