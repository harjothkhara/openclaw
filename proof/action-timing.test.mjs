import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { correlate, requireLiveConnection } from "./new-thread.mjs";

const source = await readFile(new URL("./new-thread.mjs", import.meta.url), "utf8");
function section(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, "Missing production driver timing boundary");
  return source.slice(from, to);
}

// Execute the actual driver owners/action composition with a virtual clock and
// synthetic external I/O. This qualifies timing, not native AX or app behavior.
function harness() {
  let now = 1000;
  let nextTimer = 0;
  const timers = new Map();
  const saved = new Map();
  const state = vm.createContext({
    assert,
    path,
    correlate,
    requireLiveConnection,
    Date: { now: () => now },
    setTimeout(fn, ms) {
      const id = ++nextTimer;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    mode: "green",
    report: {},
    records: [],
    metrics: [],
    commands: [],
    guard: null,
    fatal: null,
    finished: false,
    actionDeadlineAt: null,
    monitoring: false,
    monitorTask: null,
    watchdog: null,
    sample: null,
    appBaseline: { rssKiB: 1000, vszKiB: 1000 },
    appProc: { child: { pid: 42 }, closed: false },
    app: "/owned/OpenClaw.app",
    axHelper: "/owned/ax-helper",
    priv: "/owned/private",
    baseEnv: {},
    proofConn: "native",
    connectionState: () => ({
      client: "openclaw-macos",
      role: "operator",
      admitted: true,
      closed: false,
      frontendState: 1,
      upstreamState: 1,
    }),
    ps: async () => ({ t: now, rssKiB: 1000, vszKiB: 1000 }),
    save: async (name, value) => saved.set(name, value),
    start: () => ({ done: Promise.resolve({ code: 0 }) }),
    kill(item) {
      item.closed = true;
    },
  });
  state.monitor = vm.runInContext(
    "(" + section("  async function monitor(", "  let gwEnv,") + ")",
    state,
  );
  state.bounded = vm.runInContext(
    "(" +
      section("export async function bounded(", "export function requireOwnedWindow(").replace(
        "export ",
        "",
      ) +
      ")",
    state,
  );
  async function advance(ms) {
    const target = now + ms;
    for (;;) {
      const next = [...timers]
        .filter(([, t]) => t.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      now = next[1].at;
      timers.delete(next[0]);
      next[1].fn();
      await state.monitorTask;
      await Promise.resolve();
    }
    now = target;
  }
  state.sleep = advance;
  return { state, advance, saved, now: () => now };
}

test("slow valid native press and correlation do not share a ten-second watchdog budget", async () => {
  const h = harness();
  const { state } = h;
  state.records.push({
    t: 1000,
    side: "res",
    method: "connect",
    id: "connect",
    conn: "native",
    ok: true,
  });
  state.ax = async () => {
    await h.advance(3900);
    return { clicked: true, pressedAt: 4500, returnedAt: h.now() };
  };
  const sleep = state.sleep;
  state.sleep = async (ms) => {
    await sleep(ms);
    if (h.now() >= 14800 && state.records.length === 1) {
      for (const [method, id, t] of [
        ["sessions.create", "create", 4500],
        ["sessions.messages.subscribe", "subscribe", 14800],
        ["chat.history", "history", 14800],
      ]) {
        state.records.push({
          t,
          side: "req",
          method,
          id,
          conn: "native",
          client: "openclaw-macos",
          role: "operator",
          key: "agent:main:new",
        });
        state.records.push({
          t: 14800,
          side: "res",
          method,
          id,
          conn: "native",
          ok: true,
          key: "agent:main:new",
        });
      }
    }
  };
  const action = section(
    "    const clickedAt = Date.now();",
    '      const selected = await ax("copy-key");',
  );
  await vm.runInContext("(async () => {" + action + "\n} })()", state);
  assert.equal(state.report.correlatedAt, 14800); // 3.9s press + 9.9s correlation.
  assert.equal(state.guard, null);
  assert.equal(state.appProc.closed, false);
  state.ps = async () => ({ t: h.now(), rssKiB: 1000 + 513 * 1024, vszKiB: 1000 });
  await state.monitor();
  assert.equal(state.guard.reason, "rss-growth", "Memory protection must survive correlation");
});

for (const closesOnKill of [true, false])
  test(
    "hung native press fails closed with " + (closesOnKill ? "settled" : "stuck") + " pipes",
    async () => {
      const h = harness();
      let settle;
      const child = {
        child: { pid: 99 },
        closed: false,
        stdout: "",
        stderr: "",
        done: new Promise((resolve) => {
          settle = resolve;
        }),
      };
      h.state.start = () => child;
      let kills = 0;
      h.state.kill = (item) => {
        kills++;
        if (closesOnKill) {
          item.closed = true;
          item.exit = { code: null, signal: "SIGKILL" };
          settle(item.exit);
        }
      };
      const ax = vm.runInContext(
        "(" + section("  async function ax(", "  async function ownedWindow(") + ")",
        h.state,
      );
      const rejected = assert.rejects(
        ax("new"),
        closesOnKill ? /ax-new failed\/timed out/ : /AX process settlement deadline exceeded/,
      );
      const elapsed = closesOnKill ? 4000 : 6000;
      await h.advance(elapsed);
      await rejected;
      assert.equal(kills, 1);
      assert.equal(child.closed, closesOnKill);
      assert.equal(h.saved.get("ax-last.json").timedOut, true);
      assert.equal(h.saved.get("ax-last.json").elapsedMs, elapsed);
      assert.equal(h.saved.get("ax-last.json").value, null);
    },
  );
