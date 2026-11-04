// Real packaged app, real loopback Gateway, real native bridge and launchctl.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

assert.equal(process.env.GITHUB_ACTIONS, "true", "Disposable hosted runner only");
assert.equal(process.env.RUNNER_OS, "macOS");
assert.equal(process.env.RUNNER_ENVIRONMENT, "github-hosted");
assert.equal(process.env.GITHUB_REPOSITORY, "harjothkhara/openclaw");
const mode = process.env.LOGIN_PROOF_MODE;
assert.ok(["fresh", "upgrade"].includes(mode));
const appPath = "/Applications/OpenClaw.app";
const target = path.resolve("candidate/OpenClaw.app");
const helper = path.resolve(process.env.LOGIN_AX_HELPER);
assert.ok(helper.startsWith(path.resolve(process.env.RUNNER_TEMP) + path.sep));
const evidence = path.resolve("evidence");
fs.mkdirSync(evidence, { recursive: true });
const priv = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP, "login-proof-private-"));
fs.chmodSync(priv, 0o700);
const token = randomBytes(32).toString("hex");
const tokenFile = path.join(priv, "gateway-token");
fs.writeFileSync(tokenFile, token, { mode: 0o600 });
const plist = path.join(os.homedir(), "Library/LaunchAgents/ai.openclaw.mac.plist");
const service = `gui/${process.getuid()}/ai.openclaw.mac`;
const domain = `gui/${process.getuid()}`;
const env = { ...process.env, OPENCLAW_PROFILE: "default" };
const appEnv = { ...env, OPENCLAW_CONFIG_PATH: path.join(priv, "app.json"), OPENCLAW_STATE_DIR: path.join(priv, "app-state") };
const gatewayEnv = { ...env, OPENCLAW_CONFIG_PATH: path.join(priv, "gateway.json"), OPENCLAW_STATE_DIR: path.join(priv, "gateway-state") };
const children = [];
let app;
let acquiredLabel = false;
let installedApp = false;
const report = { mode, targetSha: "511d29078844175382e98b7fa3701b96e10ad75f", steps: [], success: false };
const save = (name, data) => fs.writeFileSync(path.join(evidence, name), JSON.stringify(data, null, 2));
const hash = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
function run(exe, args, options = {}) {
  return execFileSync(exe, args, { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000, maxBuffer: 1_048_576, ...options });
}
function start(exe, args, childEnv, role) {
  const fd = fs.openSync(path.join(priv, `${role}.log`), "w", 0o600);
  const child = spawn(exe, args, { env: childEnv, stdio: ["ignore", fd, fd] });
  fs.closeSync(fd);
  child.on("error", (error) => { child.launchError = error.message; });
  children.push(child);
  return child;
}
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const until = Date.now() + 10_000;
  while (child.exitCode === null && child.signalCode === null && Date.now() < until) await delay(100);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await Promise.race([new Promise(resolve => child.once("exit", resolve)), delay(5_000)]);
  }
  assert.ok(child.exitCode !== null || child.signalCode !== null, "Owned process did not settle");
}
const ax = (command, label = "", role = "", fixture) => JSON.parse(run(helper,
  [command, String(fixture?.pid ?? app.pid), label, role, ...(fixture ? ["--fixture"] : [])]));
const snapshot = () => ax("snapshot");
const loginRow = (state) => {
  const matches = state.rows.filter(r => ["AXCheckBox", "AXSwitch"].includes(r.role) &&
    (r.title === "Launch at login" || r.description === "Launch at login"));
  assert.equal(matches.length, 1, "Expected one real Launch at login switch");
  return matches[0];
};
const stateText = (state) => state.rows.map(r => [r.title, r.description, r.text].filter(Boolean).join(" ")).join("\n");
async function waitFor(name, predicate) {
  const until = Date.now() + 60_000;
  let state, lastTransientError;
  do {
    assert.equal(app?.exitCode ?? null, null, "Actual app exited");
    try {
      state = snapshot();
      if (predicate(state)) { save(`${name}.json`, state); report.steps.push(name); return state; }
    } catch (error) {
      // A document can retire an AX element mid-sample. Retry only those native
      // transient statuses, within the same deadline; budget/identity failures stop.
      const staleElement = /AX read failed: .*?,\s*-2520[24]/.test(String(error.stderr));
      const changingSwitch = error.code === "ERR_ASSERTION" &&
        error.message.startsWith("Expected one real Launch at login switch");
      const openingWindow = /Owned app has no windows error 1/.test(String(error.stderr));
      if (!staleElement && !changingSwitch && !openingWindow) throw error;
      lastTransientError = String(error.stderr ?? error.message);
    }
    await delay(500);
  } while (Date.now() < until);
  save(`${name}-failed.json`, { state, lastTransientError });
  throw Error(`Timed out: ${name}`);
}
function capture(name, state) {
  assert.ok(Number.isInteger(state.captureWindowId) && state.captureWindowId > 0);
  run("/usr/sbin/screencapture", ["-x", "-l", String(state.captureWindowId), path.join(evidence, `${name}.png`)]);
}
async function configureAndLaunch(stage) {
  const mac = path.join(appPath, "Contents/MacOS/openclaw-mac");
  run(mac, ["configure-remote", "--direct-url", "ws://127.0.0.1:28154", "--local-port", "28154", "--remote-port", "28154", "--token-file", tokenFile, "--json"], { env: appEnv });
  app = start(path.join(appPath, "Contents/MacOS/OpenClaw"), ["--dashboard", "--attach-only"], appEnv, `app-${report.steps.length}`);
  const until = Date.now() + 90_000;
  let connected = false;
  do {
    assert.equal(app.exitCode, null);
    assert.equal(app.signalCode, null);
    assert.equal(app.launchError, undefined);
    try {
      const s = JSON.parse(run(mac, ["status", "--no-launch", "--json"], { env: appEnv, timeout: 5_000 }));
      connected = s.primary.connection.state === "connected";
    } catch {}
    if (!connected) await delay(500);
  } while (!connected && Date.now() < until);
  assert.ok(connected, "Actual app did not connect to its real loopback Gateway");
  await waitFor(`${stage}-app-window`, s => s.windowIds.length > 0);
  ax("settings");
  await waitFor(`${stage}-settings-navigation`, s => s.rows.some(r => r.role === "AXLink" && (r.title === "This Mac" || r.description === "This Mac")));
  ax("press", "This Mac", "AXLink");
  return waitFor(`${stage}-native-login-switch`, s => {
    try { return loginRow(s).enabled === true; } catch { return false; }
  });
}
function pressLogin(state) {
  return ax("press", "Launch at login", loginRow(state).role);
}
function launchdLoaded() {
  try { run("/bin/launchctl", ["print", service], { timeout: 6000 }); return true; }
  catch (error) {
    if ([3, 113].includes(error.status)) return false;
    throw error;
  }
}
async function settledEnable(name) {
  await waitFor(`${name}-loaded`, s => Number(loginRow(s).value) === 1 &&
    !/Login Items/.test(stateText(s)) && fs.existsSync(plist) && launchdLoaded());
  // Bootstrap makes the job visible before kickstart/final print complete.
  // Each remaining owner command has a five-second bound; observe again after both.
  await delay(12_000);
  const state = snapshot();
  save(`${name}-settled-observation.json`, state);
  capture(`${name}-settled-observation`, state);
  assert.equal(Number(loginRow(state).value), 1);
  assert.ok(!/Login Items/.test(stateText(state)));
  assert.ok(fs.existsSync(plist) && launchdLoaded());
  save(`${name}.json`, state);
  report.steps.push(name);
  return state;
}
try {
  assert.ok(!fs.existsSync(appPath), "Do not replace a pre-existing app");
  assert.ok(!fs.existsSync(plist), "Do not touch a pre-existing login plist");
  let initialStatus;
  try { run("/bin/launchctl", ["print", service]); initialStatus = 0; } catch (e) { initialStatus = e.status; }
  assert.ok([3, 113].includes(initialStatus), "Product launchd label must initially be absent");
  acquiredLabel = true;
  const fixture = start(helper, ["fixture"], env, "ax-fixture");
  await delay(1000);
  const before = ax("snapshot", "", "", fixture);
  const match = before.rows.filter(r => r.role === "AXCheckBox" && (r.title === "Proof checkbox" || r.description === "Proof checkbox"));
  assert.equal(match.length, 1);
  assert.equal(Number(match[0].value), 0);
  ax("press", "Proof checkbox", "AXCheckBox", fixture);
  await delay(250);
  const after = ax("snapshot", "", "", fixture);
  assert.equal(Number(after.rows.find(r => r.role === "AXCheckBox").value), 1);
  save("input-qualification.json", { before, after });
  await stop(fixture);
  const runtime = path.join(target, "Contents/Resources/runtime");
  const bun = path.join(runtime, "bin/bun");
  const cli = path.join(runtime, "lib/node_modules/openclaw/openclaw.mjs");
  gatewayEnv.OPENCLAW_SQLITE_LIBRARY = path.join(runtime, "lib/libsqlite3.dylib");
  fs.writeFileSync(gatewayEnv.OPENCLAW_CONFIG_PATH, JSON.stringify({ gateway: { mode: "local", bind: "loopback", port: 28154, auth: { mode: "token", token }, controlUi: { enabled: true } }, plugins: { enabled: false } }), { mode: 0o600 });
  const config = JSON.parse(run(bun, [cli, "config", "validate", "--json"], { env: gatewayEnv }));
  assert.equal(config.valid, true);
  start(bun, [cli, "gateway", "run", "--bind", "loopback", "--port", "28154"], gatewayEnv, "gateway");
  // Installation and input use the same stable path as a normal app installation.
  installedApp = true;
  run("/usr/bin/ditto", [mode === "upgrade" ? path.resolve("released/OpenClaw.app") : target, appPath], { timeout: 180_000 });
  let state = await configureAndLaunch(mode === "upgrade" ? "released" : "fresh");
  assert.equal(Number(loginRow(state).value), 0);
  if (mode === "upgrade") {
    pressLogin(state);
    state = await settledEnable("released-login-enabled");
    report.releasedPlistSha256 = hash(plist);
    capture("released-login-enabled", state);
    await stop(app);
    fs.rmSync(appPath, { recursive: true });
    run("/usr/bin/ditto", [target, appPath], { timeout: 180_000 });
    state = await configureAndLaunch("upgraded");
    state = await waitFor("upgrade-existing-login-hydrated", s => Number(loginRow(s).value) === 1);
    await delay(1500);
    state = snapshot();
    assert.equal(hash(plist), report.releasedPlistSha256, "Upgrade/startup rewrote the existing login plist");
    assert.equal(Number(loginRow(state).value), 1, "Upgraded app did not hydrate the existing login choice");
    report.upgradedPlistSha256 = hash(plist);
    capture("upgrade-existing-login-preserved", state);
    pressLogin(state);
    state = await waitFor("upgrade-disabled", s => Number(loginRow(s).value) === 0 && !fs.existsSync(plist));
    capture("upgrade-disabled", state);
  } else {
    capture("fresh-login-off", state);
    run("/bin/launchctl", ["disable", service]);
    pressLogin(state);
    state = await waitFor("real-bootstrap-failure-reconciled", s => Number(loginRow(s).value) === 0 && /Login Items/.test(stateText(s)) && !fs.existsSync(plist));
    capture("real-bootstrap-failure-reconciled", state);
    run("/bin/launchctl", ["enable", service]);
    pressLogin(state);
    state = await settledEnable("real-retry-enabled");
    capture("real-retry-enabled", state);
    pressLogin(state);
    state = await waitFor("real-ui-disabled", s => Number(loginRow(s).value) === 0 && !fs.existsSync(plist));
    assert.equal(app.exitCode, null);
    // This process was launched directly. Do not claim launchd-owned keep-running
    // or held-operation supersession proof from its survival or an Off end state.
    capture("real-ui-disabled", state);
  }
  report.success = true;
} catch (error) {
  report.error = String(error.message).replaceAll(token, "[redacted]");
  process.exitCode = 1;
} finally {
  if (acquiredLabel) {
    try { run("/bin/launchctl", ["bootout", service]); } catch {}
    try { run("/bin/launchctl", ["enable", service]); } catch {}
    if (fs.existsSync(plist)) fs.rmSync(plist);
  }
  for (const child of children.toReversed()) {
    try { await stop(child); } catch (error) { report.cleanupError = error.message; process.exitCode = 1; report.success = false; }
  }
  if (installedApp) fs.rmSync(appPath, { recursive: true, force: true });
  save("result.json", report);
  // Only task-created, redacted logs leave the disposable runner; config/token
  // files remain private and are removed after all owned processes settle.
  for (const file of fs.readdirSync(priv).filter(f => f.endsWith(".log"))) {
    const source = path.join(priv, file);
    const size = fs.statSync(source).size;
    if (size <= 4_194_304) fs.writeFileSync(path.join(evidence, file), fs.readFileSync(source, "utf8").replaceAll(token, "[redacted]"));
  }
  fs.rmSync(priv, { recursive: true });
}
console.log(JSON.stringify(report));
