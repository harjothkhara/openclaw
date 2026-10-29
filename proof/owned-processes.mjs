import { setTimeout as sleep } from "node:timers/promises";

// detached spawn records its PGID once. Leader exit never proves group retirement.
export function signalOwnedGroup(item, signal = "SIGKILL", kill = process.kill) {
  if (!item.pgid) return;
  if (item.leaderExited || item.child.exitCode !== null || item.child.signalCode !== null) return;
  try {
    kill(-item.pgid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

export function groupRetirement(item, kill = process.kill) {
  if (!item.pgid) return { label: item.label, state: "not-started", retired: true };
  try {
    kill(-item.pgid, 0);
    const liveLeader =
      !item.leaderExited && item.child.exitCode === null && item.child.signalCode === null;
    return {
      label: item.label,
      pgid: item.pgid,
      state: liveLeader ? "owned-group-still-live" : "unattributed-group-after-leader-exit",
      retired: false,
    };
  } catch (error) {
    if (error.code === "ESRCH")
      return { label: item.label, pgid: item.pgid, state: "group-absent", retired: true };
    return {
      label: item.label,
      pgid: item.pgid,
      state: "group-probe-failed",
      retired: false,
      error: String(error.code ?? error.message).slice(0, 256),
    };
  }
}

export async function retireOwnedProcesses(items, { kill = process.kill, wait = sleep } = {}) {
  const errors = [];
  for (const signal of ["SIGTERM", "SIGKILL"]) {
    for (const item of items) {
      try {
        signalOwnedGroup(item, signal, kill);
      } catch (error) {
        errors.push(
          item.label + ": " + signal + ": " + String(error.code ?? error.message).slice(0, 256),
        );
      }
    }
    if (signal === "SIGTERM") await wait(500);
  }
  const deadline = new AbortController();
  try {
    await Promise.race([
      Promise.all(items.map((item) => item.done)),
      wait(5000, undefined, { signal: deadline.signal }).then(() => {
        throw Error("Owned process pipes did not settle");
      }),
    ]);
  } catch (error) {
    errors.push(String(error.message).slice(0, 256));
  } finally {
    deadline.abort();
  }
  // Probe every group, including helpers whose leader and pipes already closed.
  // Never signal an unattributed numeric PGID; disposable runner teardown is external.
  const groups = items.map((item) => groupRetirement(item, kill));
  return {
    status:
      groups.every((group) => group.retired) && errors.length === 0
        ? "owned-process-groups-retired"
        : "failed",
    groups,
    errors,
  };
}
