import assert from "node:assert/strict";
import test from "node:test";
import { requireOwnedWindow, transientProbeRead } from "./new-thread.mjs";
const good = {
  pid: 42,
  ready: true,
  registered: true,
  executableMatches: true,
  hidden: false,
  frontmost: true,
  windows: [{ id: 7, width: 960, height: 700 }],
};
test("only a unique owned visible frontmost window admits AX startup", () =>
  assert.equal(requireOwnedWindow(good, 42), 7));
for (const [name, patch] of [
  ["Finder/foreign PID", { pid: 100 }],
  ["no process registration", { registered: false }],
  ["wrong/unavailable executable", { executableMatches: false }],
  ["hidden app", { hidden: true }],
  ["Finder remains frontmost", { frontmost: false }],
  ["no onscreen app window", { windows: [] }],
  ["ambiguous app windows", { windows: [...good.windows, ...good.windows] }],
  ["incomplete readiness", { ready: false }],
  ["missing window ID", { windows: [{ width: 960, height: 700 }] }],
  ["invalid window ID", { windows: [{ id: 0, width: 960, height: 700 }] }],
  ["too-small window", { windows: [{ id: 7, width: 100, height: 100 }] }],
  ["invalid geometry", { windows: [{ id: 7, width: NaN, height: 700 }] }],
])
  test("window gate rejects " + name, () =>
    assert.throws(() => requireOwnedWindow({ ...good, ...patch }, 42)),
  );
test("a desktop screenshot alone is not a window-state receipt", () =>
  assert.throws(() => requireOwnedWindow({ pngWidth: 1920, pngHeight: 1080 }, 42)));

const helpRead = { pid: 42, stage: "read:AXHelp", visited: 14 };
const helpFailure = { kind: "targeted-native-ax-error", domain: "TargetedMenu.read:AXHelp", code: -25204 };
const trace = (read, failure) => [read, failure].map(JSON.stringify).join("\n");
test("observed transient help read admits a fresh read-only startup probe", () => {
  assert.equal(transientProbeRead(trace(helpRead, helpFailure), 42), true);
  assert.equal(transientProbeRead(trace({ pid: 42, stage: "read:AXRole", visited: 0 },
    { ...helpFailure, domain: "TargetedMenu.read:AXRole" }), 42), true);
  for (const [read, failure] of [
    [{ ...helpRead, pid: 99 }, helpFailure],
    [helpRead, { ...helpFailure, code: -25205 }],
    [helpRead, { ...helpFailure, domain: "TargetedMenu.perform" }],
    [{ ...helpRead, stage: "perform:AXPress" }, helpFailure],
  ]) assert.equal(transientProbeRead(trace(read, failure), 42), false);
  assert.equal(transientProbeRead("not-json", 42), false);
});

test("read-only child traversal busy errors and exhausted read budget permit startup re-probe", () => {
  const read = { pid: 42, stage: "children-values", visited: 10 };
  for (const failure of [
    { ...helpFailure, domain: "TargetedMenu.children-values" },
    { ...helpFailure, domain: "TargetedMenu.deadline", code: 1 },
  ]) assert.equal(transientProbeRead(trace(read, failure), 42), true);
  assert.equal(transientProbeRead(trace(read, { ...helpFailure, domain: "TargetedMenu.node-budget", code: 1 }), 42), false);
});
