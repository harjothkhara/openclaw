import assert from "node:assert/strict";
import test from "node:test";
import { requireActiveKey, requireCopyReceipt } from "./active-key.mjs";
const key = "agent:main:ios-synthetic-new";
function copy(key, counter) {
  return {
    schema: 1,
    kind: "targeted-native-ax",
    action: "copy-key",
    pid: 42,
    complete: true,
    frontmost: true,
    appRole: "AXApplication",
    windowRole: "AXWindow",
    operationBudgetMs: 3000,
    elapsedMs: 25,
    threadMenuCount: 1,
    threadEnabled: true,
    menuItemRouteVerified: true,
    newThreadPresses: 0,
    sentinel: "NT186215-" + counter,
    changeCountBefore: counter,
    changeCountAfter: counter + 1,
    key,
    sampledUptimeMs: counter === 10 ? 100 : counter === 20 ? 300 : 10300,
  };
}
function fixture() {
  const r = copy(key, 20);
  return {
    canonicalKey: key,
    before: { sessions: [{ key: "main", sessionId: "old" }] },
    after: {
      sessions: [
        { key: "main", sessionId: "old" },
        { key, sessionId: "created" },
      ],
    },
    initial: copy("main", 10),
    selected: r,
    stable: copy(key, 30),
    pid: 42,
    click: {
      ...r,
      action: "new",
      newThreadPresses: 1,
      clicked: true,
      pressedAt: 100,
      returnedAt: 110,
      pressedUptimeMs: 200,
      returnedUptimeMs: 210,
    },
    ping: {
      ...r,
      action: "ping",
      operationBudgetMs: 1000,
      newThreadPresses: 0,
      sampledUptimeMs: 10301,
    },
  };
}
test("fresh existing-menu copy receipts identify the selected canonical durable session", () => {
  assert.deepEqual(requireActiveKey(fixture()), {
    key,
    sessionId: "created",
    oracle: "native-copy-session-key",
  });
});
test("an empty isolated baseline permits a genuinely first durable session", () => {
  const r = fixture();
  r.before.sessions = [];
  r.after.sessions = r.after.sessions.filter((row) => row.key === key);
  assert.equal(requireActiveKey(r).sessionId, "created");
});
for (const [name, mutate] of [
  [
    "wrong owned PID",
    (r) => {
      r.selected.pid = 99;
    },
  ],
  [
    "missing stability interval",
    (r) => {
      r.stable.sampledUptimeMs = 301;
    },
  ],
  [
    "pre-action selected receipt",
    (r) => {
      r.selected.sampledUptimeMs = 199;
    },
  ],
  [
    "stale pre-stability AX ping",
    (r) => {
      r.ping.sampledUptimeMs = 300;
    },
  ],
  [
    "incomplete native query",
    (r) => {
      r.selected.complete = false;
    },
  ],
  [
    "unfocused app",
    (r) => {
      r.selected.frontmost = false;
    },
  ],
  [
    "mismatched budget declaration",
    (r) => {
      r.selected.operationBudgetMs = 4000;
    },
  ],
  [
    "missing budget declaration",
    (r) => {
      delete r.ping.operationBudgetMs;
    },
  ],
  [
    "slow cheap ping",
    (r) => {
      r.ping.elapsedMs = 1001;
    },
  ],
  [
    "wrong native role",
    (r) => {
      r.ping.windowRole = "AXWebArea";
    },
  ],
  [
    "stale clipboard",
    (r) => {
      r.selected.changeCountAfter = r.selected.changeCountBefore;
    },
  ],
  [
    "sentinel instead of key",
    (r) => {
      r.selected.key = r.selected.sentinel;
    },
  ],
  [
    "another active session despite a successful RPC",
    (r) => {
      r.selected.key = "agent:main:other";
    },
  ],
  [
    "selection regressed during stability",
    (r) => {
      r.stable.key = "main";
    },
  ],
  [
    "receipt reused across stability",
    (r) => {
      r.stable = r.selected;
    },
  ],
  [
    "unchanged initial key",
    (r) => {
      r.initial.key = key;
    },
  ],
  [
    "ambiguous native menu",
    (r) => {
      r.selected.threadMenuCount = 2;
    },
  ],
  [
    "menu item not qualified",
    (r) => {
      r.click.menuItemRouteVerified = false;
    },
  ],
  [
    "unacknowledged New Thread",
    (r) => {
      r.click.clicked = false;
    },
  ],
  [
    "duplicate New Thread actions",
    (r) => {
      r.click.newThreadPresses = 2;
    },
  ],
  [
    "copy command performed another New Thread",
    (r) => {
      r.selected.newThreadPresses = 1;
    },
  ],
  [
    "zero durable sessions",
    (r) => {
      r.after.sessions = [];
    },
  ],
  [
    "existing session removed during creation",
    (r) => {
      r.after.sessions = r.after.sessions.filter((x) => x.key !== "main");
    },
  ],
  [
    "two new durable sessions",
    (r) => {
      r.after.sessions.push({ key: "extra", sessionId: "extra" });
    },
  ],
  [
    "missing baseline snapshot",
    (r) => {
      delete r.before;
    },
  ],
  [
    "baseline identity omitted",
    (r) => {
      delete r.before.sessions[0].sessionId;
    },
  ],
  [
    "existing durable identity replaced",
    (r) => {
      r.after.sessions[0].sessionId = "replacement";
    },
  ],
  [
    "alias of another baseline conversation",
    (r) => {
      r.before.sessions.push({ key: "other", sessionId: "other-old" });
      r.after.sessions.push({ key: "other", sessionId: "other-old" });
      r.after.sessions[1].sessionId = "other-old";
    },
  ],
  [
    "existing durable ID alias",
    (r) => {
      r.after.sessions[1].sessionId = "old";
    },
  ],
  [
    "missing durable ID",
    (r) => {
      delete r.after.sessions[1].sessionId;
    },
  ],
])
  test("active-key contract rejects " + name, () => {
    const r = fixture();
    mutate(r);
    if (name === "existing durable ID alias" || name === "alias of another baseline conversation") {
      assert.throws(() => requireActiveKey(r), /aliases an existing durable session ID/);
    } else {
      assert.throws(() => requireActiveKey(r));
    }
  });
test("copy receipt alone never supplies a product green verdict", () => {
  const r = copy(key, 20);
  assert.equal(requireCopyReceipt(r, 42), key);
  assert.equal("status" in r, false);
});
