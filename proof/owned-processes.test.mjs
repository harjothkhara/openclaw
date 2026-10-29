import assert from "node:assert/strict";
import test from "node:test";
import { retireOwnedProcesses, signalOwnedGroup } from "./owned-processes.mjs";
const item = (leaderExited = false) => ({
  label: "helper",
  pgid: 4242,
  leaderExited,
  closed: leaderExited,
  child: { pid: 4242, exitCode: leaderExited ? 0 : null, signalCode: null },
  done: Promise.resolve(),
});
const wait = async (ms) => {
  if (ms === 5000) await new Promise(() => {});
};
const absent = () => {
  throw Object.assign(Error("absent"), { code: "ESRCH" });
};

test("closed helper leader with surviving or reused PGID is never signaled or certified retired", async () => {
  const calls = [];
  const result = await retireOwnedProcesses([item(true)], {
    wait,
    kill: (pid, signal) => calls.push([pid, signal]),
  });
  assert.deepEqual(calls, [[-4242, 0]]);
  assert.equal(result.status, "failed");
  assert.equal(result.groups[0].state, "unattributed-group-after-leader-exit");
});
test("leader exit between TERM and KILL revokes signaling authority, not group observation", async () => {
  const child = item();
  const calls = [];
  const result = await retireOwnedProcesses([child], {
    wait: async (ms) => {
      if (ms === 500) {
        child.leaderExited = true;
        child.child.exitCode = 0;
      } else await new Promise(() => {});
    },
    kill: (pid, signal) => calls.push([pid, signal]),
  });
  assert.deepEqual(calls, [
    [-4242, "SIGTERM"],
    [-4242, 0],
  ]);
  assert.equal(result.status, "failed");
});
test("actual absent group permits retirement after leader exit", async () => {
  const result = await retireOwnedProcesses([item(true)], { wait, kill: absent });
  assert.equal(result.status, "owned-process-groups-retired");
  assert.equal(result.groups[0].state, "group-absent");
});
test("unsettled pipes and failed probes remain explicit cleanup failures", async () => {
  const child = item(true);
  child.done = new Promise(() => {});
  const result = await retireOwnedProcesses([child], {
    wait: async () => {},
    kill: () => {
      throw Object.assign(Error("denied"), { code: "EPERM" });
    },
  });
  assert.equal(result.status, "failed");
  assert.equal(result.groups[0].state, "group-probe-failed");
  assert.match(result.errors.join(" "), /pipes did not settle/);
});
test("kernel exit state blocks a signal even before the separate close receipt", () => {
  const child = item();
  child.child.signalCode = "SIGTERM";
  signalOwnedGroup(child, "SIGKILL", () =>
    assert.fail("Retired leader must not authorize signaling"),
  );
});

test("a still-owned live group can receive bounded TERM then KILL and prove absence", async () => {
  const child = item();
  const calls = [];
  const result = await retireOwnedProcesses([child], {
    wait,
    kill: (pid, signal) => {
      calls.push([pid, signal]);
      if (signal === "SIGKILL") {
        child.leaderExited = true;
        child.child.signalCode = signal;
      }
      if (signal === 0) absent();
    },
  });
  assert.deepEqual(calls, [
    [-4242, "SIGTERM"],
    [-4242, "SIGKILL"],
    [-4242, 0],
  ]);
  assert.equal(result.status, "owned-process-groups-retired");
});
