import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { configEventForwarded, forwardNativeFrame } from "./relay-forward.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const driverPath = process.env.ACCENT_RELAY_DRIVER || path.join(here, "accent.mjs");
const source = fs.readFileSync(driverPath, "utf8");
function region(start, end) {
  const a = source.indexOf(start),
    b = source.indexOf(end, a + start.length);
  assert(a >= 0 && b > a, "Cannot locate the actual driver callback boundary");
  assert.equal(source.indexOf(start, a + start.length), -1, "Ambiguous driver callback boundary");
  return source.slice(a, b);
}
const observeSource = region("      function observe(side, bytes) {", '      front.on("message",');
const upstreamSource = region('      up.on("message",', "      for (const s of [front, up])");

// Run the actual observer and registered upstream callback; only ws I/O is fixed.
// This proves the relay receipt boundary, not native delivery or app behavior.
function fixture({
  readyState = 1,
  bufferedAmount = 0,
  throwSend = false,
  throwReceipt = false,
  proofConn = "native-proof-conn",
} = {}) {
  const rows = [],
    failures = [],
    sends = [];
  let handler,
    terminated = 0;
  const front = {
    readyState,
    bufferedAmount,
    send(data, options, callback) {
      sends.push({ data, options, callback });
      if (throwSend) throw Object.assign(Error("synthetic write failure"), { code: "EPIPE" });
    },
    terminate() {
      this.readyState = 3;
      terminated++;
    },
  };
  const up = {
    on(event, callback) {
      assert.equal(event, "message");
      handler = callback;
    },
    terminate() {
      terminated++;
    },
  };
  let clock = 100;
  const context = {
    assert,
    JSON,
    Date,
    front,
    up,
    forwardNativeFrame,
    shuttingDown: false,
    proofConn,
    conn: "native-proof-conn",
    c: { identity: { client: "openclaw-macos", role: "operator" } },
    pending: new Map(),
    record(row) {
      if (throwReceipt && row.side === "event") throw Error("synthetic receipt budget");
      const result = { t: ++clock, seq: rows.length, ...row };
      rows.push(result);
      return result;
    },
    fail(error) {
      failures.push(error);
    },
  };
  vm.runInNewContext(observeSource + "\n" + upstreamSource, context, {
    timeout: 1000,
    filename: driverPath,
  });
  assert.equal(typeof handler, "function");
  return {
    rows,
    failures,
    sends,
    front,
    emit(packet = { type: "event", event: "config.changed" }, binary = false) {
      const data = Buffer.from(JSON.stringify(packet));
      handler(data, binary);
      return data;
    },
    complete(error) {
      assert.equal(typeof sends.at(-1)?.callback, "function");
      sends.at(-1).callback(error);
    },
    events() {
      return rows.filter((row) => row.side === "event");
    },
    forwarded() {
      return configEventForwarded(rows, "native-proof-conn", 100);
    },
    terminated() {
      return terminated;
    },
    shutdown() {
      context.shuttingDown = true;
    },
  };
}

test("actual relay records no native event before the write callback", () => {
  const f = fixture();
  const data = f.emit();
  assert.equal(f.events().length, 0, "Upstream arrival must not count as native forwarding");
  assert.equal(f.forwarded(), false);
  assert.equal(f.sends.length, 1);
  assert.equal(f.sends[0].data, data);
  assert.equal(f.sends[0].options.binary, false);
  f.complete();
  assert.equal(f.events().length, 1);
  assert.equal(f.forwarded(), true);
  const upstream = f.rows.find((row) => row.side === "upstream-event"),
    event = f.events()[0];
  assert(upstream);
  assert.equal(event.upstreamSeq, upstream.seq);
  assert(event.t > upstream.t);
  assert.equal(event.delivery, "native-write-complete");
  assert.equal(f.failures.length, 0);
});
test("closed native frontend cannot produce a forward receipt", () => {
  const f = fixture({ readyState: 3 });
  f.emit();
  assert.equal(f.events().length, 0);
  assert.equal(f.forwarded(), false);
  assert.equal(f.sends.length, 0);
  assert.match(f.failures[0].message, /not open/);
  assert.equal(f.terminated(), 2);
});
test("a closed secondary frontend does not abort the proof connection", () => {
  const f = fixture({ readyState: 3, proofConn: "another-native-conn" });
  f.emit();
  assert.equal(f.events().length, 0);
  assert.equal(f.sends.length, 0);
  assert.equal(f.failures.length, 0);
  assert.equal(f.terminated(), 2);
});
test("a secondary frontend closing before callback does not abort the proof connection", () => {
  const f = fixture({ proofConn: "another-native-conn" });
  f.emit();
  f.front.readyState = 3;
  f.complete();
  assert.equal(f.events().length, 0);
  assert.equal(f.failures.length, 0);
});
for (const mode of ["throw", "callback"])
  test(mode + " write failure cannot produce a forward receipt", () => {
    const f = fixture({ throwSend: mode === "throw" });
    f.emit();
    if (mode === "callback")
      f.complete(Object.assign(Error("synthetic callback failure"), { code: "EPIPE" }));
    assert.equal(f.events().length, 0);
    assert.equal(f.forwarded(), false);
    assert.equal(f.failures[0].code, "EPIPE");
    assert.equal(f.terminated(), 2);
  });
test("frontend closing before callback fails closed", () => {
  const f = fixture();
  f.emit();
  f.front.readyState = 3;
  f.complete();
  assert.equal(f.events().length, 0);
  assert.equal(f.forwarded(), false);
  assert.match(f.failures[0].message, /closed before write receipt/);
  assert.equal(f.terminated(), 2);
});
test("callback receipt failure is latched instead of escaping I/O", () => {
  const f = fixture({ throwReceipt: true });
  f.emit();
  assert.doesNotThrow(() => f.complete());
  assert.equal(f.events().length, 0);
  assert.equal(f.forwarded(), false);
  assert.match(f.failures[0].message, /receipt budget/);
  assert.equal(f.terminated(), 2);
});
for (const error of [
  undefined,
  Object.assign(Error("intentional teardown"), { code: "ECONNRESET" }),
])
  test(
    "late " + (error ? "failure" : "success") + " during intentional teardown cannot publish proof",
    () => {
      const f = fixture();
      f.emit();
      f.shutdown();
      assert.doesNotThrow(() => f.complete(error));
      assert.equal(f.events().length, 0);
      assert.equal(f.forwarded(), false);
      assert.equal(f.failures.length, 0);
    },
  );
test("existing relay backpressure budget is preserved", () => {
  const f = fixture({ bufferedAmount: 4 * 1024 * 1024 });
  f.emit();
  assert.equal(f.events().length, 0);
  assert.equal(f.sends.length, 0);
  assert.match(f.failures[0].message, /Relay backpressure/);
});
test("unrelated frames retain bytes and binary flag without a config receipt", () => {
  const f = fixture();
  const data = f.emit({ type: "event", event: "tick" }, true);
  f.complete();
  assert.equal(f.sends[0].data, data);
  assert.equal(f.sends[0].options.binary, true);
  assert.equal(f.events().length, 0);
  assert.equal(f.forwarded(), false);
  assert.equal(f.failures.length, 0);
});
test("forward predicate rejects upstream-only, wrong-connection and pre-mutation facts", () => {
  const good = {
    t: 101,
    conn: "native",
    side: "event",
    delivery: "native-write-complete",
    method: "config.changed",
  };
  assert.equal(configEventForwarded([good], "native", 100), true);
  for (const row of [
    { ...good, side: "upstream-event" },
    { ...good, delivery: undefined },
    { ...good, conn: "other" },
    { ...good, t: 99 },
    { ...good, method: "tick" },
  ])
    assert.equal(configEventForwarded([row], "native", 100), false);
});
test("both live wait and final app verdict use the shared forwarding predicate", () => {
  assert.equal(source.split("configEventForwarded(records, proofConn, mutationAt)").length - 1, 2);
});
