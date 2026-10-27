// Fork-only proof on a disposable GitHub-hosted Mac. This file never ships in the PR.
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";

const execute = promisify(execFile);
const [repoArg, driverArg, outputArg, expected] = process.argv.slice(2);
assert(["red", "green"].includes(expected), "Expected red or green proof arm");
assert.equal(process.platform, "darwin");
assert.equal(process.env.GITHUB_ACTIONS, "true");
assert.equal(process.env.RUNNER_ENVIRONMENT, "github-hosted");
assert.equal(process.env.GITHUB_REPOSITORY, "harjothkhara/openclaw");
const repo = path.resolve(repoArg);
const driver = path.resolve(driverArg);
const output = path.resolve(outputArg);
await fs.mkdir(output, { recursive: true });
const root = await fs.mkdtemp(path.join(process.env.RUNNER_TEMP, "mac-accent-proof-"));
const home = path.join(root, "home");
const state = path.join(root, "state");
const tmp = path.join(root, "tmp");
for (const dir of [home, state, tmp]) await fs.mkdir(dir, { recursive: true });
const token = "proof-only-" + randomUUID();
const env = {
  PATH: process.env.PATH,
  HOME: home,
  CFFIXED_USER_HOME: home,
  TMPDIR: tmp + "/",
  LANG: "en_US.UTF-8",
  LC_ALL: "en_US.UTF-8",
  CI: "true",
  GITHUB_ACTIONS: "true",
  GITHUB_REPOSITORY: process.env.GITHUB_REPOSITORY,
  RUNNER_ENVIRONMENT: process.env.RUNNER_ENVIRONMENT,
  OPENCLAW_PROFILE: "default",
  OPENCLAW_STATE_DIR: state,
  OPENCLAW_CONFIG_PATH: path.join(state, "openclaw.json"),
  OPENCLAW_GATEWAY_TOKEN: token,
  OPENCLAW_SKIP_CHANNELS: "1",
};
const owned = [];
const transcript = [];
let outcome = { status: "failed" };
let keychain;
let unifiedLog;

function redact(value) {
  return value.replaceAll(token, "<ephemeral-token>").replaceAll(root, "<proof-root>");
}
function record(kind, extra = {}) {
  transcript.push({ ts: Date.now(), kind, ...extra });
}
function start(command, args, name) {
  const child = spawn(command, args, {
    cwd: repo,
    env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  let error;
  child.on("error", (value) => {
    error = value;
  });
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (chunk) => {
      logs += chunk.toString();
    });
  }
  const ended = new Promise((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
    child.once("error", () => resolve({ code: -1 }));
  });
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
  return execute(command, args, { cwd: repo, env, timeout, maxBuffer: 16 * 1024 * 1024 });
}
async function rpc(method, params = {}) {
  const { stdout } = await run(
    "pnpm",
    [
      "--silent",
      "exec",
      "tsx",
      path.join(driver, "rpc-admin.ts"),
      repo,
      method,
      JSON.stringify(params),
      "15000",
    ],
    30000,
  );
  const parsed = JSON.parse(stdout.trim());
  record("rpc", { method, result: parsed.result, scopes: parsed.receipt.scopes });
  return parsed.result;
}
function alive() {
  for (const entry of owned) {
    if (entry.error || entry.child.exitCode !== null || entry.child.signalCode !== null) {
      throw new Error(entry.name + " exited unexpectedly");
    }
  }
}
async function waitFor(label, test, timeout = 45000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    alive();
    if (await test()) return;
    await sleep(750);
  }
  throw new Error("Timed out: " + label);
}
async function ui(mode, pid) {
  const { stdout } = await run("/usr/bin/osascript", [
    "-l",
    "JavaScript",
    path.join(driver, "NativeUI.js"),
    mode,
    String(pid),
  ]);
  return stdout.trim();
}
async function screenshot(name) {
  const file = path.join(output, name + ".png");
  const { stdout } = await run("swift", [path.join(driver, "window.swift"), String(appPid)]);
  const window = JSON.parse(stdout.trim());
  assert.equal(window.title, "OpenClaw Chat");
  assert(window.width >= 300 && window.height >= 250, "Chat window bounds are implausible");
  await run("/usr/sbin/screencapture", ["-x", "-l", String(window.id), file]);
  assert((await fs.stat(file)).size > 1000);
  record("screenshot", { name, window });
  return file;
}

let appPid;
try {
  await ui("preflight", 0);
  const listener = createServer();
  await new Promise((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  env.OPENCLAW_GATEWAY_PORT = String(port);
  await fs.writeFile(
    env.OPENCLAW_CONFIG_PATH,
    JSON.stringify({
      gateway: { mode: "local", bind: "loopback", port, auth: { mode: "token", token } },
      ui: { seamColor: "#e00070", prefs: { accent: "#e00070" } },
      plugins: { enabled: false },
    }),
    { mode: 0o600 },
  );

  keychain = path.join(home, "accent-proof.keychain-db");
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
  await waitFor(
    "isolated Gateway ready",
    async () => {
      try {
        return (await rpc("health")) !== undefined;
      } catch {
        return false;
      }
    },
    60000,
  );

  const app = start(
    path.join(repo, "apps/macos/.build/debug/OpenClaw"),
    [
      "--attach-only",
      "--chat",
      "-openclaw.connectionMode",
      "local",
      "-openclaw.onboardingSeen",
      "YES",
      "-openclaw.nativeExperienceEnabled",
      "YES",
      "-openclaw.chat.useNativeConversation",
      "YES",
      "-AppleLanguages",
      "(en)",
    ],
    "app",
  );
  appPid = app.child.pid;
  unifiedLog = start(
    "/usr/bin/log",
    ["stream", "--style", "compact", "--predicate", `processID == ${appPid}`],
    "app-unified-log",
  );
  // A logging process may exit independently of the app and Gateway.
  owned.pop();
  await waitFor(
    "Mac app connected to real Gateway",
    () =>
      gateway.logs
        .split("\n")
        .some(
          (line) =>
            line.includes("[ws] client connected") &&
            line.includes("client=openclaw-macos") &&
            line.includes("mode=ui"),
        ),
    90000,
  );
  await waitFor("native chat window", async () => {
    try {
      return JSON.parse(await ui("inspect", app.child.pid)).title === "OpenClaw Chat";
    } catch {
      return false;
    }
  });
  const draft = JSON.parse(await ui("draft", app.child.pid));
  assert(draft.draftVisible, "Native chat draft was not visible to accessibility");
  await waitFor(
    "native send control enabled by the unsent draft",
    async () => {
      try {
        const state = JSON.parse(await ui("inspect", app.child.pid));
        return state.draftVisible && state.sendEnabled;
      } catch {
        return false;
      }
    },
    30000,
  );
  await sleep(1000);
  const accentSamples = () =>
    (app.logs.includes("MAC_ACCENT_PROOF accent=") ? app.logs : (unifiedLog?.logs ?? ""))
      .split("\n")
      .filter((line) => line.includes("MAC_ACCENT_PROOF accent="))
      .map((line) => ({
        accent: /MAC_ACCENT_PROOF accent=([^\s]+)/.exec(line)?.[1],
        native: /native=(true|false)/.exec(line)?.[1] === "true",
      }));
  await waitFor("instrumented native chat initial render", () =>
    accentSamples().some((s) => s.native),
  );
  const beforeSamples = accentSamples();
  record("chat-consumer-before", { samples: beforeSamples });
  const latestAccent = (samples) => samples.filter((sample) => sample.native).at(-1)?.accent;
  if (expected === "green") {
    assert(
      latestAccent(beforeSamples) === "#e00070",
      "PR app did not consume the initial saved magenta accent",
    );
  }
  const before = await screenshot("01-before-chat");

  const snapshot = await rpc("config.get");
  assert.equal(snapshot.config.ui.seamColor, "#e00070");
  assert.equal(snapshot.config.ui.prefs.accent, "#e00070");
  await rpc("config.patch", {
    raw: JSON.stringify({ ui: { prefs: { accent: "#00d070" } } }),
    note: "fork-hosted Mac accent proof",
  });
  await waitFor("Gateway Appearance preference changed", async () => {
    const ui = (await rpc("config.get")).config.ui;
    return ui.seamColor === "#e00070" && ui.prefs.accent === "#00d070";
  });
  if (expected === "green") {
    await waitFor(
      "native chat consumed green on the same app",
      () => accentSamples().some((s) => s.native && s.accent === "#00d070"),
      30000,
    );
  } else {
    await sleep(3000);
  }
  const afterSamples = accentSamples();
  record("chat-consumer-after", { samples: afterSamples });
  const consumedGreen = latestAccent(afterSamples) === "#00d070";
  const afterState = JSON.parse(await ui("inspect", app.child.pid));
  assert(
    afterState.draftVisible && afterState.sendEnabled,
    "Native chat composer was not ready after config patch",
  );
  const after = await screenshot("02-after-chat");
  const pixels = await run("swift", [path.join(driver, "pixels.swift"), before, after], 120000);
  const verdict = JSON.parse(pixels.stdout.trim());
  record("pixel-contrast", verdict);
  const macConnections = gateway.logs
    .split("\n")
    .filter(
      (line) =>
        line.includes("[ws] client connected") &&
        line.includes("client=openclaw-macos") &&
        line.includes("mode=ui"),
    );
  assert.equal(
    macConnections.length,
    1,
    "Mac chat reconnected; live push versus reconnect is unproven",
  );
  if (expected === "green") {
    assert(consumedGreen, "Native chat did not consume the saved green accent");
    assert(
      verdict.changed || !verdict.validImages,
      "Visible chat pixels did not change from magenta to green",
    );
  } else {
    assert.equal(verdict.changed, false, "Base unexpectedly passed the positive accent proof");
    assert(!consumedGreen, "Base chat unexpectedly consumed the new green accent");
    if (verdict.validImages) {
      assert(
        verdict.after.green <= verdict.before.green + 30,
        "Base chat gained green-dominant pixels after the patch",
      );
    }
  }
  const head = (await execute("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();
  const noChatSent = !gateway.logs.split("\n").some((line) => /\bchat\.send\b/.test(line));
  assert(noChatSent, "Unexpected chat.send request during an unsent-draft proof");
  outcome = {
    status:
      expected === "green"
        ? verdict.changed
          ? "passed"
          : "passed-instrumented"
        : "expected-failure",
    head,
    port: "<ephemeral>",
    pixelContrast: verdict,
    consumerSamples: { before: beforeSamples, after: afterSamples },
    visualLimitation:
      expected === "green" && !verdict.changed
        ? "Protected or blank chat-window captures; the instrumented real-app chat consumer changed, but visible pixels were not proved"
        : undefined,
    noChatSent,
  };
  record("proof-verdict", outcome);
} catch (error) {
  outcome.error = redact(String(error));
  record("proof-failed", { error: outcome.error });
} finally {
  for (const entry of [...owned, ...(unifiedLog ? [unifiedLog] : [])].reverse()) {
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
    await fs.writeFile(path.join(output, entry.name + ".log"), redact(entry.logs));
  }
  if (keychain) {
    try {
      await run("/usr/bin/security", ["delete-keychain", keychain]);
    } catch (error) {
      outcome.status = "failed";
      outcome.cleanupError = redact(String(error));
    }
  }
  await fs.writeFile(
    path.join(output, "transcript.jsonl"),
    redact(transcript.map((item) => JSON.stringify(item)).join("\n") + "\n"),
  );
  await fs.writeFile(path.join(output, "result.json"), JSON.stringify(outcome, null, 2) + "\n");
  if (!outcome.cleanupError) await fs.rm(root, { recursive: true, force: true });
}
console.log(JSON.stringify(outcome, null, 2));
if (!["passed", "passed-instrumented", "expected-failure"].includes(outcome.status))
  process.exitCode = 1;
