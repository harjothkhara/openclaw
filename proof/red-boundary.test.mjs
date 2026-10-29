import assert from "node:assert/strict";
import test from "node:test";
import { requireRecursiveRed } from "./new-thread.mjs";
const fixture = () => ({
  click: { clicked: true, pressedAt: 1000, returnedAt: 1010 },
  guard: { at: 2000, reason: "action-deadline" },
  stackCounts: [2, 3],
  baseline: { rssKiB: 1000, vszKiB: 1000 },
  metrics: [{ t: 1500, rssKiB: 1000 + 65 * 1024, vszKiB: 1000 }],
  rows: [],
  before: { sessions: [{ key: "main", sessionId: "old" }] },
  after: { sessions: [{ key: "main", sessionId: "old" }] },
});
test("positive native recursion evidence may have zero Gateway requests", () => {
  assert.deepEqual(requireRecursiveRed(fixture()), {
    kind: "native-recursion-before-rpc",
    createRequests: 0,
    durableSessionsUnchanged: true,
  });
});
for (const [name, mutate] of [
  [
    "process crash without a recognized watchdog despite stack and allocation evidence",
    (r) => {
      r.guard = null;
    },
  ],
  [
    "zero RPCs and timeout alone",
    (r) => {
      r.stackCounts = [0, 0];
      r.metrics = [];
    },
  ],
  [
    "missing native action acknowledgement",
    (r) => {
      r.click.clicked = false;
    },
  ],
  [
    "watchdog before actual press",
    (r) => {
      r.guard.at = 999;
    },
  ],
  [
    "allocation only before actual press",
    (r) => {
      r.metrics[0].t = 999;
    },
  ],
  [
    "missing recursive stack",
    (r) => {
      r.stackCounts = [2, 0];
    },
  ],
  [
    "no allocating growth",
    (r) => {
      r.metrics[0].rssKiB = 1001;
    },
  ],
  [
    "duplicate RPCs are NOT expected base behavior",
    (r) => {
      r.rows = [
        { t: 1100, side: "req", method: "sessions.create" },
        { t: 1101, side: "req", method: "sessions.create" },
      ];
    },
  ],
  [
    "even one base create RPC invalidates this recursion oracle",
    (r) => {
      r.rows = [{ t: 1100, side: "req", method: "sessions.create" }];
    },
  ],
  [
    "new durable session despite no observed RPC",
    (r) => {
      r.after.sessions.push({ key: "other" });
    },
  ],
  [
    "existing durable ID replaced",
    (r) => {
      r.after.sessions[0].sessionId = "replacement";
    },
  ],
  [
    "missing authoritative Gateway result",
    (r) => {
      r.after = {};
    },
  ],
])
  test("red oracle rejects " + name, () => {
    const r = fixture();
    mutate(r);
    assert.throws(() => requireRecursiveRed(r));
  });
