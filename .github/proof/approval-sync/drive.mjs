// Disposable GitHub-hosted macOS only. Uses the real app and normal CLI RPCs.
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";

const execute = promisify(execFile);
const [repoArg, uiArg, outputArg, variant] = process.argv.slice(2);

assert(
  ["before", "after"].includes(variant),
  "Expected repo, NativeUI.js script, output directory, before|after",
);
assert.equal(process.platform, "darwin");
assert.equal(process.env.GITHUB_ACTIONS, "true");
assert.equal(
  process.env.RUNNER_ENVIRONMENT,
  "github-hosted",
  "Only a disposable hosted account is allowed",
);
assert.equal(process.env.GITHUB_REPOSITORY, "harjothkhara/openclaw");

const repo = path.resolve(repoArg);
const ui = path.resolve(uiArg);
const output = path.resolve(outputArg);
await fs.mkdir(output, { recursive: true });

const root = await fs.mkdtemp(path.join(process.env.RUNNER_TEMP, "approval-proof-"));
const home = path.join(root, "home");
const state = path.join(root, "state");
const tmp = path.join(root, "tmp");
for (const dir of [home, state, tmp]) {
  await fs.mkdir(dir, { recursive: true });
}

const token = "proof-only-" + randomUUID();
const profile = "default";
const env = {
  PATH: process.env.PATH,
  HOME: home,
  CFFIXED_USER_HOME: home,
  TMPDIR: tmp + "/",
  LANG: "en_US.UTF-8",
  LC_ALL: "en_US.UTF-8",
  CI: "true",
  GITHUB_ACTIONS: "true",
  RUNNER_OS: "macOS",
  OPENCLAW_PROFILE: profile,
  OPENCLAW_STATE_DIR: state,
  OPENCLAW_CONFIG_PATH: path.join(state, "openclaw.json"),
  OPENCLAW_GATEWAY_TOKEN: token,
  OPENCLAW_SKIP_CHANNELS: "1",
};

const owned = [];
const pendingWrites = [];
const nativeEvents = [];
const transcript = [];
let currentMarkers = [];
let currentApprovalWindows = 0;
let lastNativeEvent = 0;
let outcome = { status: "failed", variant, checks: {} };
let appLog = "";

function redact(value) {
  return value
    .replaceAll(token, "<ephemeral-token>")
    .replaceAll(root, "<proof-root>")
    .replaceAll("127.0.0.1", "<loopback>");
}

function record(kind, data = {}) {
  transcript.push({ ts: Date.now(), kind, ...data });
}

function start(command, args, name, childEnv = env) {
  const child = spawn(command, args, {
    cwd: repo,
    env: childEnv,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  let error;
  child.on("error", (value) => {
    error = value;
  });
  const ended = new Promise((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
    child.once("error", () => resolve({ code: -1 }));
  });
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (chunk) => {
      logs += chunk.toString();
    });
  }
  const entry = {
    child,
    ended,
    name,
    get logs() {
      return logs;
    },
    get error() {
      return error;
    },
  };
  owned.push(entry);
  record("process-start", { name, pid: child.pid });
  return entry;
}

async function run(command, args, timeout = 30000) {
  return execute(command, args, {
    cwd: repo,
    env,
    timeout,
    maxBuffer: 16 * 1024 * 1024,
  });
}

async function rpc(method, params = {}, timeout = 15000) {
  const { stdout } = await run(
    "pnpm",
    [
      "--silent",
      "openclaw",
      "gateway",
      "call",
      method,
      "--json",
      "--timeout",
      String(timeout),
      "--params",
      JSON.stringify(params),
    ],
    timeout + 15000,
  );
  const result = JSON.parse(stdout.trim());
  record("cli-rpc", { method, params, result });
  return result;
}

function ensureAlive() {
  for (const entry of owned) {
    if (entry.error || entry.child.exitCode !== null || entry.child.signalCode !== null) {
      throw new Error(entry.name + " exited during proof");
    }
  }
  if (lastNativeEvent && Date.now() - lastNativeEvent > 3000) {
    throw new Error("Native observer heartbeat stopped");
  }
}

async function waitFor(label, test, timeout = 12000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    ensureAlive();
    if (await test()) return;
    await sleep(50);
  }
  throw new Error("Timed out: " + label);
}

function visible(marker) {
  return currentMarkers.includes("approval-proof-" + marker);
}

async function image(name) {
  ensureAlive();
  const file = path.join(output, name + ".png");
  await run("/usr/sbin/screencapture", ["-x", file]);
  assert((await fs.stat(file)).size > 1000, "Missing screenshot");
  ensureAlive();
  record("screenshot", {
    file: path.basename(file),
    markers: currentMarkers,
  });
}

async function request(marker) {
  const id = "approval-proof-" + marker;
  const result = await rpc("exec.approval.request", {
    id,
    command: "/usr/bin/printf " + id,
    host: "gateway",
    ask: "always",
    timeoutMs: 120000,
    twoPhase: true,
    deliverToApprovalClientsOnly: true,
  });
  assert.equal(result.id, id);
  assert.equal(result.status, "accepted");
  assert.equal(result.deliveryRoute, "approval-client");
  return result;
}

async function decision(marker, expected) {
  const result = await rpc("exec.approval.waitDecision", {
    id: "approval-proof-" + marker,
  });
  assert.equal(result.decision, expected, "Gateway must retain the actual decision");
  return result;
}

async function external(marker) {
  await rpc("exec.approval.resolve", {
    id: "approval-proof-" + marker,
    decision: "deny",
  });
  await decision(marker, "deny");
}

async function press(marker, button) {
  const result = await run("/usr/bin/osascript", [
    "-l",
    "JavaScript",
    ui,
    "press",
    String(app.child.pid),
    "approval-proof-" + marker,
    button,
  ]);
  record("native-press", {
    marker,
    button,
    output: result.stdout.trim(),
  });
}

let app;
let logStream;
let keychain;

try {
  await run("/usr/bin/osascript", ["-l", "JavaScript", ui, "preflight"]);

  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  env.OPENCLAW_GATEWAY_PORT = String(port);

  await fs.writeFile(
    env.OPENCLAW_CONFIG_PATH,
    JSON.stringify({
      gateway: {
        mode: "local",
        bind: "loopback",
        port,
        auth: { mode: "token", token },
      },
      plugins: { enabled: false },
    }),
    { mode: 0o600 },
  );

  // The runner account is disposable. Default-profile preferences and a fresh
  // Keychain are not claimed to sandbox an operator desktop; the hosted
  // account is the boundary.
  keychain = path.join(home, "approval-proof.keychain-db");
  await run("/usr/bin/security", ["create-keychain", "-p", "", keychain]);
  await run("/usr/bin/security", ["unlock-keychain", "-p", "", keychain]);
  await run("/usr/bin/security", ["set-keychain-settings", keychain]);
  await run("/usr/bin/security", ["default-keychain", "-d", "user", "-s", keychain]);
  await run("/usr/bin/security", ["list-keychains", "-d", "user", "-s", keychain]);

  const gateway = start(
    "pnpm",
    [
      "--silent",
      "openclaw",
      "gateway",
      "run",
      "--bind",
      "loopback",
      "--port",
      String(port),
      "--ws-log",
      "full",
      "--verbose",
    ],
    "gateway",
  );

  let ready = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      await rpc("health", {}, 3000);
      ready = true;
      break;
    } catch {
      if (gateway.child.exitCode !== null || gateway.error) break;
      await sleep(1000);
    }
  }
  assert(ready, "Isolated real Gateway did not become ready");

  // Unmodified SwiftPM application executable, not a test presenter or an
  // injected delivery. Background-only suppresses onboarding while retaining
  // interactive services, including the Gateway approval prompter.
  app = start(
    path.join(repo, "apps/macos/.build/debug/OpenClaw"),
    [
      "--attach-only",
      "--background-only",
      "-openclaw.connectionMode",
      "local",
      "-openclaw.onboardingSeen",
      "YES",
      "-AppleLanguages",
      "(en)",
    ],
    "app",
  );

  logStream = start(
    "/usr/bin/log",
    [
      "stream",
      "--style",
      "ndjson",
      "--level",
      "debug",
      "--predicate",
      "processID == " + app.child.pid,
    ],
    "app-unified",
    { PATH: process.env.PATH, HOME: home },
  );

  const watcher = start(
    "/usr/bin/osascript",
    ["-l", "JavaScript", ui, "watch", String(app.child.pid)],
    "native-ui",
  );

  let remainder = "";
  watcher.child.stdout.on("data", (chunk) => {
    remainder += chunk.toString();
    let index;
    while ((index = remainder.indexOf("\n")) >= 0) {
      const line = remainder.slice(0, index);
      remainder = remainder.slice(index + 1);
      try {
        const event = JSON.parse(line);
        nativeEvents.push(event);
        currentMarkers = event.markers;
        currentApprovalWindows = event.approvalWindows;
        lastNativeEvent = Date.now();
      } catch {
        record("invalid-observer-output");
      }
    }
  });

  await waitFor("native observer ready", () => nativeEvents.length > 0);

  await waitFor(
    "app connected to the selected real Gateway",
    async () => {
      const connected = gateway.logs
        .split("\n")
        .some(
          (line) =>
            line.includes("[ws] client connected") &&
            line.includes("client=openclaw-macos") &&
            line.includes("mode=ui"),
        );
      if (connected) record("app-gateway-connected", { port });
      return connected;
    },
    45000,
  );

  // A visible panel establishes that the app subscribed before later
  // requests. The same socket carries the queued request and FIFO sentinel.
  await request("active");
  await waitFor("active panel visible", () => visible("active"), 30000);
  await image("01-active-before-external");

  const resolvedAt = Date.now();
  await external("active");
  const pending = await rpc("exec.approval.list");
  assert(Array.isArray(pending), "Expected the live pending approval list");
  assert(!pending.some((entry) => entry.id === "approval-proof-active"));

  if (variant === "before") {
    for (let i = 0; i < 40; i++) {
      ensureAlive();
      assert(visible("active"), "Baseline no longer reproduces stale panel");
      await sleep(50);
    }
    await image("02-active-after-external-stale");
    outcome.checks.baselineStalePanel = true;
  } else {
    await waitFor(
      "external resolution dismisses active panel",
      () => !visible("active") && currentApprovalWindows === 0,
    );
    assert(Date.now() - resolvedAt < 30000, "Dismissal must precede 120-second expiry");
    await image("02-active-after-external-dismissed");
    outcome.checks.activeDismissal = true;

    await request("blocker");
    await waitFor("blocker displayed", () => visible("blocker"));
    await request("queued");
    const queuedList = await rpc("exec.approval.list");
    assert(queuedList.some((entry) => entry.id === "approval-proof-queued"));
    assert(visible("blocker") && !visible("queued"));

    await external("queued");
    await request("sentinel");

    // Let B's resolution settle while A remains visible. Queue drainage is
    // positively established by the sentinel, not by this delay.
    await sleep(1000);
    assert(visible("blocker"));
    await image("03-blocker-after-queued-resolution");

    await external("blocker");
    await waitFor("FIFO sentinel replaces blocker without queued panel", () => visible("sentinel"));
    assert(
      !nativeEvents.some((event) => event.markers.includes("approval-proof-queued")),
      "Resolved queued approval was presented",
    );
    await image("04-sentinel-no-queued-panel");
    outcome.checks.queuedSuppression = true;

    await press("sentinel", "Allow Once");
    await decision("sentinel", "allow-once");
    await waitFor(
      "locally resolved panel closes",
      () => !visible("sentinel") && currentApprovalWindows === 0,
    );
    await image("05-local-decision-complete");

    await sleep(1500);
    appLog = app.logs + logStream.logs;
    assert(
      !/exec approval handling failed|decision discarded after/.test(appLog),
      "The app logged a failed or discarded decision",
    );
    const remaining = await rpc("exec.approval.list");
    assert.equal(remaining.length, 0, "All synthetic approvals must be settled");
    outcome.checks.localResolution = true;
  }

  ensureAlive();
  const head = (await execute("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();
  outcome = {
    ...outcome,
    status: "passed",
    head,
    variant,
    noCommandsExecuted: true,
  };
  record("proof-passed", outcome);
} catch (error) {
  outcome.error = redact(String(error));
  record("proof-failed", { error: outcome.error });
} finally {
  // Retire only task-owned process groups. Never kill by app name or port.
  for (const entry of [...owned].reverse()) {
    if (entry.child.pid && entry.child.exitCode === null && entry.child.signalCode === null) {
      try {
        process.kill(-entry.child.pid, "SIGTERM");
      } catch {}
      const closed = await Promise.race([
        entry.ended.then(() => true),
        sleep(5000).then(() => false),
      ]);
      if (!closed) {
        try {
          process.kill(-entry.child.pid, "SIGKILL");
        } catch {}
      }
      await entry.ended;
    }
    pendingWrites.push(fs.writeFile(path.join(output, entry.name + ".log"), redact(entry.logs)));
  }

  if (keychain) {
    try {
      await run("/usr/bin/security", ["delete-keychain", keychain]);
    } catch (error) {
      outcome.status = "failed";
      outcome.cleanupError = redact(String(error));
    }
  }

  await Promise.all(pendingWrites);
  await fs.writeFile(
    path.join(output, "transcript.jsonl"),
    redact(transcript.map((event) => JSON.stringify(event)).join("\n") + "\n"),
  );
  await fs.writeFile(path.join(output, "result.json"), JSON.stringify(outcome, null, 2) + "\n");

  // Never upload config, state, or Keychain material.
  if (!outcome.cleanupError) {
    await fs.rm(root, { recursive: true, force: true });
  }
}

console.log(JSON.stringify(outcome, null, 2));
if (outcome.status !== "passed") process.exitCode = 1;
