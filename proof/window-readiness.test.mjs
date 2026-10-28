import assert from "node:assert/strict";
import test from "node:test";
import { requireOwnedWindow } from "./new-thread.mjs";
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
