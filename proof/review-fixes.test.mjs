import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import vm from "node:vm";
import { bounded, requireRecursiveRed } from "./new-thread.mjs";

const source = await readFile(new URL("./new-thread.mjs", import.meta.url), "utf8");
const workflow = await readFile(
  new URL("../.github/workflows/macos-periphery.yml", import.meta.url),
  "utf8",
);
const repository = "harjothkhara/openclaw";
const ref = "refs/heads/proof/mac-new-thread-186215-2026-10-27";
const env = {
  GITHUB_ACTIONS: "true",
  RUNNER_ENVIRONMENT: "github-hosted",
  GITHUB_REPOSITORY: repository,
  GITHUB_REF: ref,
  GITHUB_RUN_ID: "123",
  GITHUB_RUN_ATTEMPT: "1",
  GITHUB_SHA: "b".repeat(40),
  SERIAL_CONFIRMED: "true",
};
function section(text, start, end, last = false) {
  const a = last ? text.lastIndexOf(start) : text.indexOf(start);
  const b = text.indexOf(end, a);
  assert.ok(a >= 0 && b > a, "Missing real proof control boundary");
  return text.slice(a, b);
}
function relay(mode, guard, shuttingDown = false) {
  const client = new EventEmitter(),
    upstream = new EventEmitter();
  const context = vm.createContext({
    client,
    upstream,
    state: { closed: false, admitted: true },
    mode,
    guard,
    shuttingDown,
    fatal: null,
    records: [],
    conn: "native",
    proofConn: "native",
    identity: { client: "openclaw-macos", role: "operator" },
    Date: { now: () => 2000 },
  });
  const close = vm.runInContext(
    section(
      source,
      "      for (const socket of [client, upstream])",
      '      client.on("close", () => {',
    ) + "\nclosed",
    context,
  );
  return { context, client, upstream, close };
}

test("recognized native red stop tolerates ECONNRESET before shuttingDown without losing its red oracle", () => {
  const guard = { reason: "rss-growth", at: 2000 };
  const r = relay("red", guard);
  r.client.emit("error", Object.assign(Error("reset after app SIGKILL"), { code: "ECONNRESET" }));
  r.upstream.emit("error", Object.assign(Error("upstream reset"), { code: "ECONNRESET" }));
  r.close();
  assert.equal(r.context.fatal, null);
  assert.equal(r.context.records[0].expected, true);
  assert.equal(
    requireRecursiveRed({
      click: { clicked: true, pressedAt: 1000, returnedAt: 1010 },
      guard,
      stackCounts: [2, 3],
      baseline: { rssKiB: 1000, vszKiB: 1000 },
      metrics: [{ t: 1500, rssKiB: 1000 + 65 * 1024, vszKiB: 1000 }],
      rows: [],
      before: { sessions: [{ key: "main", sessionId: "old" }] },
      after: { sessions: [{ key: "main", sessionId: "old" }] },
    }).kind,
    "native-recursion-before-rpc",
  );
});
for (const [name, mode, guard, stopping] of [
  ["unguarded red", "red", null, false],
  ["green despite a guard", "green", { reason: "rss-growth" }, false],
  ["owned shutdown", "green", null, true],
]) {
  test("relay error predicate remains truthful for " + name, () => {
    const r = relay(mode, guard, stopping),
      error = Error("transport failed");
    r.client.emit("error", error);
    r.close();
    assert.equal(r.context.fatal === null, stopping);
    assert.equal(r.context.records[0].expected, stopping);
  });
}
function runtime(overrides) {
  const prefix = section(
    source,
    "async function main() {",
    "  const args = Object.fromEntries(",
  ).replace("async function main() {", "");
  return vm.runInNewContext(prefix, {
    assert,
    process: { platform: "darwin", env: { ...env, ...overrides } },
  });
}
test("driver first-attempt context permits the intended metadata", () =>
  assert.doesNotThrow(() => runtime({})));
test("driver refuses attempt two even if a partial rerun reused successful admission", () =>
  assert.throws(() => runtime({ GITHUB_RUN_ATTEMPT: "2" })));
test("driver refuses the wrong proof ref before creating output or child work", () =>
  assert.throws(() => runtime({ GITHUB_REF: "refs/heads/main" })));

const admission = section(workflow, "\n  admission:\n", "\n  mac-new-thread-real-app:\n");
const mac = workflow.slice(workflow.indexOf("\n  mac-new-thread-real-app:\n"));
function runBody(block) {
  const marker = "        run: |\n";
  const index = block.indexOf(marker);
  if (index < 0) return "";
  const lines = [];
  for (const line of block.slice(index + marker.length).split("\n")) {
    if (line && !line.startsWith("          ")) break;
    lines.push(line.slice(10));
  }
  return lines.join("\n");
}
function shell(script, overrides) {
  if (!script.trim()) return 0; // No first-step guard cannot refuse a partial rerun.
  const result = spawnSync("/bin/bash", ["-euo", "pipefail", "-c", script], {
    encoding: "utf8",
    env: { ...env, ...overrides },
    timeout: 2000,
  });
  assert.equal(result.error, undefined);
  assert.notEqual(result.status, null);
  return result.status;
}
test("Ubuntu admission accepts the intended first serial attempt", () =>
  assert.equal(shell(runBody(admission), {}), 0));
for (const [name, overrides] of [
  ["wrong ref", { GITHUB_REF: "refs/heads/main" }],
  ["wrong repository", { GITHUB_REPOSITORY: "other/openclaw" }],
  ["attempt two", { GITHUB_RUN_ATTEMPT: "2" }],
  ["no serial allocation", { SERIAL_CONFIRMED: "false" }],
]) {
  test("Ubuntu admission fails explicitly for " + name, () =>
    assert.notEqual(shell(runBody(admission), overrides), 0),
  );
}
test("the first Mac step rejects a partial rerun before checkout or packaging", () => {
  const firstStep = mac.split("      - name:")[1];
  // On the base the first step is checkout, hence no guard script and a no-op
  // control boundary succeeds. This models skipped admission, not a hosted run.
  assert.notEqual(shell(runBody(firstStep), { GITHUB_RUN_ATTEMPT: "2" }), 0);
});
const gateScript = runBody(
  workflow.slice(workflow.indexOf("      - name: Require exact-head red and green verdicts")),
);
const qualification = gateScript.match(
  /if \(r\.mode[\s\S]*?\n\s*throw new Error\([^\n]+\);\n\s*\}/,
)?.[0];
assert.ok(qualification, "Missing actual final proof qualification rule");
for (const arm of ["red", "green"])
  test(arm + " qualification still accepts a first-attempt control", () => {
    const r = {
      mode: arm,
      attempt: "1",
      workflowSha: env.GITHUB_SHA,
      status: arm === "red" ? "expected-red" : "green",
      sourceSha: "a".repeat(40),
      providerPosts: 0,
      cleanup: "owned-process-groups-retired",
      nativeUIProof: true,
      redBoundary: { kind: "native-recursion-before-rpc" },
      key: "agent:main:new",
      session: { oracle: "native-copy-session-key", key: "agent:main:new", sessionId: "new-id" },
    };
    assert.doesNotThrow(() =>
      vm.runInNewContext(qualification, {
        r,
        arm,
        status: r.status,
        sha: r.sourceSha,
        process: { env: { GITHUB_SHA: env.GITHUB_SHA, GITHUB_RUN_ATTEMPT: "1" } },
      }),
    );
  });
for (const arm of ["red", "green"])
  for (const [name, receiptAttempt, runAttempt] of [
    ["rerun receipt", "2", "1"],
    ["rerun context with old receipt", "1", "2"],
  ]) {
    test(arm + " qualification rejects " + name, () => {
      const r = {
        mode: arm,
        attempt: receiptAttempt,
        workflowSha: env.GITHUB_SHA,
        status: arm === "red" ? "expected-red" : "green",
        sourceSha: "a".repeat(40),
        providerPosts: 0,
        cleanup: "owned-process-groups-retired",
        nativeUIProof: true,
        redBoundary: { kind: "native-recursion-before-rpc" },
        key: "agent:main:new",
        session: { oracle: "native-copy-session-key", key: "agent:main:new", sessionId: "new-id" },
      };
      assert.throws(
        () =>
          vm.runInNewContext(qualification, {
            r,
            arm,
            status: r.status,
            sha: r.sourceSha,
            process: { env: { GITHUB_SHA: env.GITHUB_SHA, GITHUB_RUN_ATTEMPT: runAttempt } },
          }),
        /verdict did not meet required proof contract/,
      );
    });
  }

test("sampler leader exit cannot leave the red pipe settlement wait unbounded", async (t) => {
  const body = section(
    source,
    '      assert.ok(guard && !fatal, "Base did not reach a recognized watchdog stop");',
    "      sampleText = ",
  );
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let outcome;
  const waiting = vm.runInNewContext("(async()=>{" + body + "\n})()", {
    assert,
    guard: { reason: "rss-growth" },
    fatal: null,
    sample: { done: new Promise(() => {}) },
    bounded,
  });
  void waiting.then(
    () => {
      outcome = "unexpected-success";
    },
    (error) => {
      outcome = error.message;
    },
  );
  t.mock.timers.tick(16000);
  await nextTurn();
  assert.match(
    outcome ?? "unbounded sampler pipe wait",
    /Stack sampler settlement deadline exceeded/,
  );
});

test("successful high-frequency ps logs cannot crowd out final diagnostics", async () => {
  const processes = [
    { label: "startup", logPath: "/owned/1-startup.log", exit: { code: 0 } },
    ...Array.from({ length: 160 }, (_, i) => ({
      label: "memory",
      logPath: "/owned/" + i + "-memory.log",
      exit: { code: 0 },
    })),
    { label: "memory", logPath: "/owned/failed-memory.log", exit: { code: 1 } },
    { label: "ax-copy-key", logPath: "/owned/final-copy.log", exit: { code: 0 } },
  ];
  const metrics = [{ t: 1, rssKiB: 1000 }];
  let captured;
  const context = vm.createContext({
    report: { mode: "green", status: "green", cleanup: "owned-process-groups-retired" },
    guard: null,
    providerPosts: 0,
    records: [],
    metrics,
    commands: [],
    mode: "green",
    gateway: undefined,
    gatewayDiagnostics: () => ({}),
    processes,
    path,
    evidence: "/owned/evidence",
    evidenceWriter: {
      finish: async (report, options) => {
        captured = options;
        return report;
      },
    },
    process: { exitCode: null },
    console: { log() {} },
  });
  const body = section(source, "    report.guard = guard;", "\n  }\n}\n\nif (", true);
  await vm.runInContext("(async()=>{" + body + "\n})()", context);
  const names = captured.logs.map((log) => log.name);
  assert.ok(
    !names.some((name) => /^\d+-memory\.log$/.test(name)),
    "Successful ps logs consumed the export queue",
  );
  assert.ok(names.includes("failed-memory.log"));
  assert.ok(
    names.indexOf("final-copy.log") < names.indexOf("1-startup.log"),
    "Final logs must precede early verbose diagnostics",
  );
  assert.equal(captured.coreRecords["memory.json"], metrics);
});
