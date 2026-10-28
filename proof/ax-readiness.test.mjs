import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { requirePreflightSnapshot } from "./new-thread.mjs";
const helper = await readFile(
  new URL(
    process.env.AX_BASE_CONTROL === "1"
      ? "./fixtures/new-thread-ax-e9030d57.js"
      : "./new-thread-ax.js",
    import.meta.url,
  ),
  "utf8",
);
const baseline = await readFile(
  new URL("./fixtures/new-thread-ax-e9030d57.js", import.meta.url),
  "utf8",
);
function fixture(
  source,
  {
    missingProcess = false,
    noWindow = false,
    stalled = false,
    unreadable = false,
    duplicate = false,
    enabled = true,
  } = {},
) {
  const logs = [];
  let presses = 0,
    front = false;
  function element(values, children = []) {
    values = { ...values, AXChildren: children };
    const attributes = () => Object.keys(values).map((name) => ({ name: () => name }));
    attributes.byName = (name) => ({
      value: () => {
        if (unreadable && name === "AXRole") throw Error("AX read denied");
        return values[name];
      },
    });
    const actions = () => [{ name: () => "AXPress" }];
    actions.byName = () => ({
      perform: () => {
        presses++;
      },
    });
    return { attributes, actions };
  }
  const button = () =>
    element({ AXRole: "AXButton", AXIdentifier: "chat-new-thread", AXEnabled: enabled });
  const row = element({ AXRole: "AXRow", AXSelected: true }, [
    element({ AXRole: "AXStaticText", AXValue: "synthetic-label" }),
  ]);
  const window = element(
    { AXRole: "AXWindow" },
    duplicate ? [button(), button(), row] : [button(), row],
  );
  const proc = {
    windows: () => {
      if (stalled) while (true) {}
      return noWindow ? [] : [window];
    },
  };
  Object.defineProperty(proc, "frontmost", {
    get: () => () => front,
    set: (value) => {
      front = value;
    },
  });
  const context = vm.createContext({
    Application: () => ({ processes: { whose: () => () => (missingProcess ? [] : [proc]) } }),
    console: { log: (text) => logs.push(JSON.parse(text)) },
  });
  vm.runInContext(source, context);
  return {
    logs,
    presses: () => presses,
    invoke: (action = "snapshot", diagnostic = true) =>
      JSON.parse(
        vm.runInContext(
          "run(" + JSON.stringify(["42", action, ...(diagnostic ? ["diagnostic"] : [])]) + ")",
          context,
          { timeout: 40 },
        ),
      ),
  };
}
test("base does not distinguish process absence from an absent window", () => {
  for (const options of [{ missingProcess: true }, { noWindow: true }]) {
    assert.deepEqual(fixture(baseline, options).invoke("snapshot", false), { ready: false });
  }
});
test("new helper names both initial not-ready branches without pressing", () => {
  for (const [options, reason] of [
    [{ missingProcess: true }, "process-not-found"],
    [{ noWindow: true }, "no-owned-window"],
  ]) {
    const f = fixture(helper, options);
    const value = f.invoke();
    assert.equal(value.ready, false);
    assert.equal(value.reason, reason);
    assert.equal(f.presses(), 0);
  }
});
test("a blocked window Apple event leaves the exact last stage and cannot return ready", () => {
  const f = fixture(helper, { stalled: true });
  assert.throws(() => f.invoke(), /timed out/);
  assert.equal(f.logs.at(-1).stage, "window-list");
  assert.equal(f.presses(), 0);
  assert.equal(
    f.logs.some((r) => r.stage === "complete"),
    false,
  );
});
test("base blocked snapshot has no progress receipt at all", () => {
  const f = fixture(baseline, { stalled: true });
  assert.throws(() => f.invoke("snapshot", false), /timed out/);
  assert.deepEqual(f.logs, []);
});
test("snapshot emits structural stages, not selected text or inference", () => {
  const f = fixture(helper);
  const a = f.invoke();
  requirePreflightSnapshot(a, []);
  assert.equal(f.logs.at(-1).stage, "complete");
  assert.equal(f.presses(), 0);
  assert.ok(!JSON.stringify(f.logs).includes("synthetic-label"));
});
test("advertised unreadable AX attributes are fatal, not readiness retries", () => {
  const f = fixture(helper, { unreadable: true });
  assert.throws(() => f.invoke(), /AX read denied/);
  assert.equal(f.logs.at(-1).stage, "failed");
  assert.equal(f.logs.at(-1).detail, "attribute-value");
  assert.equal(f.presses(), 0);
});
for (const options of [{ duplicate: true }, { enabled: false }])
  test("strict control retained " + JSON.stringify(options), () => {
    const f = fixture(helper, options);
    assert.throws(() => requirePreflightSnapshot(f.invoke(), []));
    assert.equal(f.presses(), 0);
  });
test("diagnostic invocation cannot issue AXPress", () => {
  const f = fixture(helper);
  assert.throws(() => f.invoke("click", true), /Invalid AX invocation/);
  assert.equal(f.presses(), 0);
});
test("ordinary complete traversal still performs exactly one unique AXPress", () => {
  const f = fixture(helper);
  const a = f.invoke("click", false);
  assert.equal(a.clicked, true);
  assert.equal(f.presses(), 1);
});
const ready = {
  complete: true,
  ready: true,
  buttonCount: 1,
  enabled: true,
  selection: [["synthetic"]],
};
for (const patch of [
  { complete: false },
  { ready: false },
  { buttonCount: 0 },
  { buttonCount: 2 },
  { enabled: false },
  { selection: [] },
  { selection: [[], []] },
  { clicked: true },
])
  test("preflight oracle rejects " + JSON.stringify(patch), () =>
    assert.throws(() => requirePreflightSnapshot({ ...ready, ...patch }, [])),
  );
for (const method of ["sessions.create", "chat.send", "agent"])
  test("preflight rejects action RPC " + method, () =>
    assert.throws(() => requirePreflightSnapshot(ready, [{ side: "req", method }])),
  );
