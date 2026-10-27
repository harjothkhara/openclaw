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
const [repoArg, driverArg, outputArg] = process.argv.slice(2);
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
  await run("/usr/sbin/screencapture", ["-x", file]);
  assert((await fs.stat(file)).size > 1000);
  record("screenshot", { name });
  return file;
}

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
      ui: { seamColor: "#e00070" },
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
      "-AppleLanguages",
      "(en)",
    ],
    "app",
  );
  await waitFor("Mac app connected to real Gateway", () =>
    gateway.logs
      .split("\n")
      .some(
        (line) =>
          line.includes("[ws] client connected") &&
          line.includes("client=openclaw-macos") &&
          line.includes("mode=ui"),
      ),
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
  await sleep(1000);
  const before = await screenshot("01-magenta-chat");

  const snapshot = await rpc("config.get");
  assert.equal(snapshot.config.ui.seamColor, "#e00070");
  await rpc("config.patch", {
    raw: JSON.stringify({ ui: { seamColor: "#00d070" } }),
    baseHash: snapshot.hash,
  });
  await waitFor(
    "Gateway config changed",
    async () => (await rpc("config.get")).config.ui.seamColor === "#00d070",
  );
  await sleep(2000);
  const afterState = JSON.parse(await ui("inspect", app.child.pid));
  assert(afterState.draftVisible, "Chat draft disappeared after config patch");
  const after = await screenshot("02-green-chat");
  const pixels = await run("swift", [path.join(driver, "pixels.swift"), before, after], 120000);
  record("pixel-contrast", { output: pixels.stdout.trim() });
  const head = (await execute("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();
  outcome = {
    status: "passed",
    head,
    port: "<ephemeral>",
    pixelContrast: pixels.stdout.trim(),
    noChatSent: true,
  };
  record("proof-passed", outcome);
} catch (error) {
  outcome.error = redact(String(error));
  record("proof-failed", { error: outcome.error });
} finally {
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
if (outcome.status !== "passed") process.exitCode = 1;
