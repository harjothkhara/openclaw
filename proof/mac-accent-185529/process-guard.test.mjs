import assert from "node:assert/strict";
import test from "node:test";
import { createProcessGuard } from "./process-guard.mjs";

const denied = () => Object.assign(Error("denied"), { code: "EPERM" });
const missing = () => Object.assign(Error("gone"), { code: "ESRCH" });
const child = (label) => ({
  label,
  child: { pid: 123, kill: () => true },
  bytes: 0,
  failed: false,
  groupRetired: false,
});

test("log overflow plus denied group signal latches failure without throwing", () => {
  let firstFailure;
  let overflows = 0;
  const p = child("gateway");
  const guard = createProcessGuard({
    onFailure: (error) => {
      firstFailure ??= error;
    },
    onOverflow: (error) => {
      overflows++;
      firstFailure ??= error;
    },
    killProcess: () => {
      throw denied();
    },
    perChildLogBytes: 8,
    totalLogBytes: 64,
  });
  assert.equal(guard.account(p, 9), false);
  assert.equal(guard.account(p, 9), false);
  assert.equal(p.failed, true);
  assert.equal(overflows, 1);
  assert.deepEqual(p.outputOverflow, { label: "gateway", childBytes: 9, totalBytes: 9 });
  assert.match(firstFailure.message, /Log budget exceeded by gateway/);
  assert.deepEqual(guard.signalErrors, [
    { label: "gateway", operation: "signal", signal: "SIGKILL", code: "EPERM" },
  ]);
  assert.equal(guard.alive(p), true);
  assert.equal(guard.signalErrors[1].operation, "inspect");
});

test("aggregate output budget identifies the offending child", () => {
  let failure;
  const guard = createProcessGuard({
    onFailure: (error) => {
      failure ??= error;
    },
    onOverflow: (error) => {
      failure ??= error;
    },
    killProcess: () => {
      throw missing();
    },
    perChildLogBytes: 8,
    totalLogBytes: 10,
  });
  const first = child("first");
  const second = child("second");
  assert.equal(guard.account(first, 6), true);
  assert.equal(guard.account(second, 5), false);
  assert.equal(second.outputOverflow.totalBytes, 11);
  assert.match(failure.message, /second/);
  assert.equal(second.groupRetired, true);
  assert.deepEqual(guard.signalErrors, []);
});

test("overflow callback can stop the app even when both signal paths are denied", () => {
  const app = child("app");
  app.child.kill = () => false;
  const overflowing = child("configure");
  let firstFailure;
  let guard;
  guard = createProcessGuard({
    onFailure: (error) => {
      firstFailure ??= error;
    },
    onOverflow: (error) => {
      firstFailure ??= error;
      guard.signal(app);
    },
    killProcess: () => {
      throw denied();
    },
    perChildLogBytes: 8,
  });
  assert.equal(guard.account(overflowing, 9), false);
  assert.match(firstFailure.message, /Log budget exceeded by configure/);
  assert.deepEqual(
    guard.signalErrors.map((item) => [item.label, item.operation]),
    [
      ["app", "signal"],
      ["app", "child-signal"],
      ["configure", "signal"],
    ],
  );
  assert.equal(guard.alive(app), true); // Unknown process ownership blocks a green verdict.
});
