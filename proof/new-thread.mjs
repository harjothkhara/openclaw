// Fork-only #186215 proof. Never add this file to the public implementation PR.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import * as fs from "node:fs/promises";
import http from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

export function observedResponse(request, frame) {
  return {
    method: request.method,
    key: request.method === "sessions.create" ? frame.payload?.key : request.key,
    ok: frame.ok,
    errorCode: frame.error?.code,
  };
}

export function correlate(rows, since) {
  const creates = rows.filter(
    (r) => r.t >= since && r.side === "req" && r.method === "sessions.create",
  );
  assert.equal(creates.length, 1, "Expected exactly one native creation request");
  const c = creates[0];
  assert.equal(c.client, "openclaw-macos");
  assert.equal(c.role, "operator");
  assert.ok(
    rows.some(
      (r, i) =>
        i < rows.indexOf(c) &&
        r.conn === c.conn &&
        r.method === "connect" &&
        r.side === "res" &&
        r.ok === true,
    ),
    "Creation connection was not admitted",
  );
  const response = (req) =>
    rows.find((r) => r.side === "res" && r.conn === req.conn && r.id === req.id);
  const res = response(c);
  assert.equal(res?.ok, true, "Native creation did not succeed");
  assert.ok(typeof res.key === "string" && res.key.length, "Missing canonical creation key");
  const responseIndex = rows.indexOf(res);
  for (const method of ["sessions.messages.subscribe", "chat.history"]) {
    const req = rows.find(
      (r, i) =>
        i > responseIndex &&
        r.side === "req" &&
        r.conn === c.conn &&
        r.method === method &&
        r.key === res.key,
    );
    assert.ok(req, "Missing post-create native selection request: " + method);
    assert.equal(response(req)?.ok, true, "Selection request did not succeed: " + method);
  }
  return res.key;
}

export function selectedSession(beforeKeys, after, key, ax, marker) {
  assert.ok(typeof marker === "string" && marker.startsWith("NT186215-") && marker.length >= 24);
  assert.ok(Array.isArray(after.sessions), "Missing persisted session list");
  const added = after.sessions.filter((r) => !beforeKeys.has(r.key));
  assert.equal(added.length, 1);
  assert.equal(added[0].key, key);
  assert.ok(added[0].sessionId);
  assert.equal(ax.complete, true);
  assert.equal(ax.buttonCount, 1);
  assert.equal(ax.enabled, true);
  assert.equal(ax.selection?.length, 1);
  assert.equal(added[0].label, marker, "Canonical new session lacks the observer label");
  assert.equal(
    after.sessions.filter((r) => r.label === marker).length,
    1,
    "Observer label is not unique",
  );
  assert.ok(
    ax.selection[0].some((s) => s === marker),
    "Selected native row is not the uniquely marked session",
  );
  return { key, sessionId: added[0].sessionId, label: marker };
}

export function requireLiveConnection(state) {
  assert.equal(state?.client, "openclaw-macos");
  assert.equal(state?.role, "operator");
  assert.equal(state?.admitted, true);
  assert.equal(state?.closed, false);
  assert.equal(state?.frontendState, 1);
  assert.equal(state?.upstreamState, 1);
}

export async function bounded(label, promise, ms) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error(label + " deadline exceeded")), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  assert.equal(process.platform, "darwin");
  assert.equal(process.env.GITHUB_ACTIONS, "true");
  assert.equal(process.env.GITHUB_REPOSITORY, "harjothkhara/openclaw");
  assert.equal(process.env.RUNNER_ENVIRONMENT, "github-hosted");
  assert.match(process.env.GITHUB_RUN_ID || "", /^[0-9]+$/);
  assert.match(process.env.GITHUB_RUN_ATTEMPT || "", /^[0-9]+$/);
  assert.match(process.env.GITHUB_SHA || "", /^[a-f0-9]{40}$/);
  const args = Object.fromEntries(
    Array.from({ length: (process.argv.length - 2) / 2 }, (_, i) => [
      process.argv[2 + i * 2],
      process.argv[3 + i * 2],
    ]),
  );
  const source = await fs.realpath(args["--source"]),
    app = await fs.realpath(args["--app"]);
  const sha = args["--sha"],
    mode = args["--mode"],
    out = path.resolve(args["--out"]);
  assert.match(sha, /^[a-f0-9]{40}$/);
  assert.ok(["red", "green"].includes(mode));
  if (mode === "red") assert.equal(sha, "1b50ce5a6835798634c4d98ac87891f4e5290120");
  const workspace = await fs.realpath(process.env.GITHUB_WORKSPACE);
  assert.ok(
    out.startsWith(workspace + path.sep) && !out.startsWith(source + path.sep),
    "Output must be a fresh sibling of the clean SUT checkout",
  );
  await fs.mkdir(out, { mode: 0o700 }); // Refuse reuse, including a prior incomplete run.
  const priv = path.join(out, "private"),
    evidence = path.join(out, "evidence");
  await fs.mkdir(priv, { mode: 0o700 });
  await fs.mkdir(evidence);
  const token = randomBytes(32).toString("hex"),
    providerKey = randomBytes(32).toString("hex");
  const id = "nt" + process.env.GITHUB_RUN_ID + "-" + randomBytes(4).toString("hex");
  const appProfile = id + "-app",
    gwProfile = id + "-gw";
  const domain = "ai.openclaw.mac.profile." + appProfile;
  const processes = [],
    records = [],
    metrics = [],
    commands = [],
    connections = new Map();
  let proofConn = null;
  const connectionState = (conn) => {
    const c = connections.get(conn);
    return (
      c && {
        conn,
        ...c.identity,
        admitted: c.admitted,
        closed: c.closed,
        frontendState: c.frontend.readyState,
        upstreamState: c.upstream.readyState,
      }
    );
  };
  let serial = 0,
    fatal = null,
    guard = null,
    watchdog = null,
    finished = false;
  let monitoring = false,
    monitorTask = null,
    shuttingDown = false;
  let relay,
    canary,
    sample,
    sampleText = "",
    appProc,
    gateway,
    appBaseline;
  let providerPosts = 0,
    serverPort,
    relayPort;
  const baseEnv = Object.fromEntries(
    ["PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "__CF_USER_TEXT_ENCODING"]
      .filter((k) => process.env[k])
      .map((k) => [k, process.env[k]]),
  );
  baseEnv.LANG = "en_US.UTF-8";
  baseEnv.CI = "1";
  baseEnv.NO_COLOR = "1";
  const redact = (text) =>
    [token, providerKey, source, app, priv, baseEnv.HOME]
      .filter(Boolean)
      .reduce((s, secret) => s.split(secret).join("[REDACTED]"), String(text));
  const save = (name, value) =>
    fs.writeFile(
      path.join(evidence, name),
      redact(typeof value === "string" ? value : JSON.stringify(value, null, 2) + "\n"),
    );
  const report = {
    schema: 1,
    mode,
    sourceSha: sha,
    workflowSha: process.env.GITHUB_SHA,
    runId: process.env.GITHUB_RUN_ID,
    attempt: process.env.GITHUB_RUN_ATTEMPT,
    os: os.release(),
    arch: os.arch(),
    node: process.version,
    status: "incomplete",
    cleanup: "pending",
    imagesRequireHumanInspection: true,
  };
  const hash = async (p) => {
    const h = createHash("sha256");
    for await (const b of createReadStream(p)) h.update(b);
    return h.digest("hex");
  };
  function start(label, argv, env, capture = false) {
    const child = spawn(argv[0], argv.slice(1), {
      cwd: source,
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const log = createWriteStream(path.join(priv, ++serial + "-" + label + ".log"), {
      mode: 0o600,
    });
    const item = { label, child, stdout: "", stderr: "", bytes: 0, closed: false };
    item.done = new Promise((resolve) => {
      child.on("error", (error) => {
        fatal = error;
      });
      child.on("close", (code, signal) => {
        item.closed = true;
        log.end(() => resolve({ code, signal }));
      });
      log.on("error", (error) => {
        fatal = error;
        kill(item);
        resolve({ code: null, signal: "log-error" });
      });
    });
    for (const key of ["stdout", "stderr"])
      child[key].on("data", (b) => {
        item.bytes += b.length;
        if (item.bytes > 32 * 1024 * 1024) {
          fatal = Error("Owned process output budget exceeded");
          kill(item);
          return;
        }
        log.write(b);
        if (capture) item[key] += b.toString();
      });
    processes.push(item);
    commands.push({ label, argv: argv.map(String) });
    return item;
  }
  function kill(item, signal = "SIGKILL") {
    if (item?.closed) return; // Never signal a retired PID; uncertain surviving groups fail cleanup.
    if (item?.child.pid)
      try {
        process.kill(-item.child.pid, signal);
      } catch (e) {
        if (e.code !== "ESRCH") throw e;
      }
  }
  async function run(label, argv, env = baseEnv, timeout = 15000) {
    const p = start(label, argv, env, true);
    const timer = setTimeout(() => kill(p), timeout);
    const result = await p.done;
    clearTimeout(timer);
    assert.equal(result.code, 0, label + " failed/timed out; inspect sanitized log");
    return p.stdout.trim();
  }
  async function ax(action) {
    const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "new-thread-ax.js");
    const value = JSON.parse(
      await run(
        "ax-" + action,
        ["/usr/bin/osascript", "-l", "JavaScript", script, String(appProc.child.pid), action],
        baseEnv,
        4000,
      ),
    );
    if (value.ready === false && action === "snapshot") return value;
    assert.equal(value.complete, true);
    assert.equal(value.buttonCount, 1);
    return value;
  }
  async function shot(name) {
    await run(name, ["/usr/sbin/screencapture", "-x", "-t", "png", path.join(evidence, name)]);
    const b = await fs.readFile(path.join(evidence, name));
    assert.equal(b.subarray(1, 4).toString(), "PNG");
    assert.ok(b.readUInt32BE(16) >= 640 && b.readUInt32BE(20) >= 400, "Invalid capture dimensions");
  }
  const listen = (server) =>
    new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve(server.address().port));
    });
  async function ps() {
    const text = await run(
      "memory",
      ["/bin/ps", "-p", String(appProc.child.pid), "-o", "rss=,vsz="],
      baseEnv,
      1000,
    );
    const values = text.split(/\s+/).map(Number);
    assert.equal(values.length, 2);
    assert.ok(values.every(Number.isFinite));
    return { t: Date.now(), rssKiB: values[0], vszKiB: values[1] };
  }
  async function monitor(started) {
    if (!monitoring) return;
    try {
      const m = await ps();
      if (!monitoring) return;
      metrics.push(m);
      const reason =
        m.rssKiB - appBaseline.rssKiB > 512 * 1024
          ? "rss-growth"
          : m.vszKiB - appBaseline.vszKiB > 1024 * 1024
            ? "vsz-growth"
            : m.rssKiB > 3 * 1024 * 1024
              ? "rss-ceiling"
              : !finished && Date.now() - started > 10000
                ? "action-deadline"
                : null;
      if (reason) {
        guard = { reason, at: Date.now(), ...m };
        kill(appProc);
        return;
      }
      if (monitoring)
        watchdog = setTimeout(() => {
          monitorTask = monitor(started);
        }, 100);
    } catch (error) {
      if (monitoring) {
        fatal = error;
        kill(appProc);
      }
    }
  }
  let gwEnv, appEnv;
  try {
    assert.ok(source.startsWith(workspace + path.sep), "SUT must be an owned workspace checkout");
    assert.ok(
      app.startsWith(path.join(source, "dist") + path.sep),
      "Use the task-built dist app, not an installed app",
    );
    assert.equal(await run("source-sha", ["git", "rev-parse", "HEAD"]), sha);
    assert.equal(
      await run("source-clean", ["git", "status", "--porcelain", "--untracked-files=no"]),
      "",
    );
    report.appSha = await run("bundle-source", [
      "/usr/libexec/PlistBuddy",
      "-c",
      "Print:OpenClawGitCommit",
      path.join(app, "Contents/Info.plist"),
    ]);
    assert.equal(report.appSha, sha);
    const exe = path.join(app, "Contents/MacOS/OpenClaw");
    report.appExecutableSha256 = await hash(exe);
    const buildInfoPath = path.join(source, "dist/build-info.json");
    const buildInfo = JSON.parse(await fs.readFile(buildInfoPath, "utf8"));
    assert.equal(buildInfo.commit, sha);
    assert.ok(buildInfo.buildId, "Gateway runtime build identity missing");
    report.gatewayBuildId = buildInfo.buildId;
    report.gatewayBuildInfoSha256 = await hash(buildInfoPath);
    report.driverSha256 = await hash(fileURLToPath(import.meta.url));
    report.axHelperSha256 = await hash(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "new-thread-ax.js"),
    );
    report.xcode = await run("xcode", ["/usr/bin/xcodebuild", "-version"]);
    report.binaryArchitectures = await run("arch", ["/usr/bin/lipo", "-archs", exe]);
    assert.ok(
      report.binaryArchitectures.split(" ").includes(os.arch() === "x64" ? "x86_64" : os.arch()),
    );
    await shot("capture-preflight.png");
    // A real source Gateway, not a mocked transport. The canary rejects inference.
    canary = http.createServer((req, res) => {
      if (req.method === "POST") providerPosts++;
      res.writeHead(503);
      res.end("No provider inference is permitted in New Thread proof");
    });
    const canaryPort = await listen(canary);
    const reserve = http.createServer();
    serverPort = await listen(reserve);
    await new Promise((resolve) => reserve.close(resolve));
    const gwState = path.join(priv, "gateway"),
      appState = path.join(priv, "app");
    await fs.mkdir(gwState);
    await fs.mkdir(appState);
    await fs.mkdir(path.join(priv, "workspace"));
    gwEnv = {
      ...baseEnv,
      OPENCLAW_PROFILE: gwProfile,
      OPENCLAW_CONFIG_PATH: path.join(gwState, "openclaw.json"),
      OPENCLAW_STATE_DIR: gwState,
      OPENCLAW_GATEWAY_PORT: String(serverPort),
      OPENCLAW_GATEWAY_TOKEN: token,
    };
    const cfg = {
      gateway: {
        mode: "local",
        bind: "loopback",
        port: serverPort,
        auth: { mode: "token", token },
        controlUi: { enabled: false },
      },
      logging: { file: path.join(priv, "gateway-file.log"), level: "debug" },
      models: {
        mode: "replace",
        providers: {
          openai: {
            baseUrl: "http://127.0.0.1:" + canaryPort + "/v1",
            apiKey: providerKey,
            api: "openai-completions",
            agentRuntime: { id: "openclaw" },
            models: [
              {
                id: "proof",
                name: "Proof model — never called",
                reasoning: false,
                input: ["text"],
                contextWindow: 32768,
                maxTokens: 128,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              },
            ],
          },
        },
      },
      agents: {
        entries: { main: { name: "New Thread proof" } },
        defaults: {
          workspace: path.join(priv, "workspace"),
          skipBootstrap: true,
          heartbeat: { every: "0m" },
          model: { primary: "openai/proof", fallbacks: [] },
          models: { "openai/proof": { agentRuntime: { id: "openclaw" } } },
        },
      },
      plugins: { enabled: true, allow: ["openai"], slots: { memory: "none" } },
      skills: { allowBundled: [] },
      tools: { allow: [] },
    };
    await fs.writeFile(gwEnv.OPENCLAW_CONFIG_PATH, JSON.stringify(cfg), { mode: 0o600 });
    const cli = (method) => [
      "pnpm",
      "openclaw",
      "--profile",
      gwProfile,
      "gateway",
      "call",
      method,
      "--json",
    ];
    const call = async (method, params) =>
      JSON.parse(
        await run(
          "rpc-" + method,
          [...cli(method), "--params", JSON.stringify(params || {})],
          gwEnv,
          20000,
        ),
      );
    gateway = start(
      "gateway",
      [
        "pnpm",
        "openclaw",
        "--profile",
        gwProfile,
        "gateway",
        "run",
        "--port",
        String(serverPort),
        "--bind",
        "loopback",
        "--auth",
        "token",
        "--verbose",
        "--ws-log",
        "full",
      ],
      gwEnv,
    );
    gateway.child.once("exit", (code, signal) => {
      report.gatewayExit = { code, signal, expected: shuttingDown };
      if (!shuttingDown) fatal = Error("Owned Gateway exited before proof completed");
    });
    let ready = false;
    for (let t = Date.now(); Date.now() - t < 120000;) {
      assert.ok(!gateway.closed && !fatal, "Gateway exited before readiness");
      try {
        const h = await call("health");
        if (h.ok === true) {
          ready = true;
          break;
        }
      } catch {}
      await sleep(500);
    }
    assert.ok(ready, "Gateway readiness missing");
    const { WebSocket, WebSocketServer } = createRequire(path.join(source, "package.json"))("ws");
    relay = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise((resolve, reject) => {
      relay.once("listening", resolve);
      relay.once("error", reject);
    });
    relayPort = relay.address().port;
    relay.on("connection", (client) => {
      const conn = randomBytes(8).toString("hex"),
        pending = new Map(),
        queue = [];
      let identity = {};
      const upstream = new WebSocket("ws://127.0.0.1:" + serverPort);
      const state = { frontend: client, upstream, identity, admitted: false, closed: false };
      connections.set(conn, state);
      function observe(side, bytes) {
        const f = JSON.parse(bytes.toString());
        if (side === "req" && f.type === "req") {
          if (f.method === "connect") {
            identity = { client: f.params?.client?.id, role: f.params?.role };
            state.identity = identity;
          }
          pending.set(f.id, { method: f.method, key: f.params?.key || f.params?.sessionKey });
          if (
            ["connect", "sessions.create", "sessions.messages.subscribe", "chat.history"].includes(
              f.method,
            )
          )
            records.push({
              t: Date.now(),
              side,
              conn,
              id: f.id,
              ...identity,
              ...pending.get(f.id),
            });
          if (["chat.send", "agent"].includes(f.method))
            fatal = Error("Unexpected inference request");
        } else if (side === "res" && f.type === "res" && pending.has(f.id)) {
          const request = pending.get(f.id);
          pending.delete(f.id);
          if (request.method === "connect") state.admitted = f.ok === true;
          if (
            ["connect", "sessions.create", "sessions.messages.subscribe", "chat.history"].includes(
              request.method,
            )
          )
            records.push({
              t: Date.now(),
              side,
              conn,
              id: f.id,
              ...identity,
              ...observedResponse(request, f),
            });
        }
        if (records.length > 10000 || pending.size > 1000)
          throw Error("RPC observation budget exceeded");
      }
      client.on("message", (data, binary) => {
        try {
          observe("req", data);
          if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary });
          else {
            assert.ok(queue.length < 32);
            queue.push([data, binary]);
          }
        } catch (e) {
          fatal = e;
          client.terminate();
          upstream.terminate();
        }
      });
      upstream.on("open", () => {
        for (const [data, binary] of queue) upstream.send(data, { binary });
        queue.length = 0;
      });
      upstream.on("message", (data, binary) => {
        try {
          observe("res", data);
          if (client.readyState === WebSocket.OPEN) client.send(data, { binary });
        } catch (e) {
          fatal = e;
          client.terminate();
        }
      });
      for (const socket of [client, upstream])
        socket.on("error", (e) => {
          if (!shuttingDown) fatal = e;
        });
      function closed() {
        if (state.closed) return;
        state.closed = true;
        state.admitted = false;
        const expected = shuttingDown || (mode === "red" && guard !== null);
        records.push({
          t: Date.now(),
          side: "lifecycle",
          conn,
          ...identity,
          method: "disconnect",
          expected,
        });
        if (conn === proofConn && !expected)
          fatal = Error("Proof native connection closed unexpectedly");
      }
      client.on("close", () => {
        closed();
        upstream.terminate();
      });
      upstream.on("close", () => {
        closed();
        client.terminate();
      });
    });
    appEnv = {
      ...baseEnv,
      OPENCLAW_PROFILE: appProfile,
      OPENCLAW_STATE_DIR: appState,
      OPENCLAW_CONFIG_PATH: path.join(appState, "openclaw.json"),
      OPENCLAW_GATEWAY_PORT: String(relayPort),
    };
    const tokenFile = path.join(priv, "token");
    await fs.writeFile(tokenFile, token, { mode: 0o600 });
    const mac = path.join(app, "Contents/MacOS/openclaw-mac");
    await run(
      "configure-app",
      [
        mac,
        "--profile",
        appProfile,
        "configure-remote",
        "--direct-url",
        "ws://127.0.0.1:" + relayPort,
        "--local-port",
        String(relayPort),
        "--remote-port",
        String(serverPort),
        "--token-file",
        tokenFile,
        "--json",
      ],
      appEnv,
    );
    for (const key of ["openclaw.nativeExperienceEnabled", "openclaw.chat.useNativeConversation"])
      await run(
        "native-preference",
        ["/usr/bin/defaults", "write", domain, key, "-bool", "true"],
        appEnv,
      );
    appProc = start("app", [exe, "--chat", "--attach-only"], appEnv);
    let beforeAX;
    for (let t = Date.now(); Date.now() - t < 90000;) {
      assert.ok(!appProc.closed && !fatal, "App/relay exited during setup");
      let status;
      try {
        status = JSON.parse(
          await run(
            "app-status",
            [mac, "--profile", appProfile, "status", "--no-launch", "--json"],
            appEnv,
            5000,
          ),
        );
      } catch {
        await sleep(500);
        continue;
      }
      if (status.primary.connection.state === "connected") {
        const a = await ax("snapshot"); // Permission/unreadable/timeout failures are not readiness retries.
        if (a.ready && a.enabled === true && a.selection.length === 1) {
          beforeAX = a;
          break;
        }
      }
      await sleep(500);
    }
    assert.ok(beforeAX, "Authenticated app/native AX readiness missing");
    assert.ok(
      records.some(
        (r) =>
          r.method === "connect" &&
          r.side === "res" &&
          r.ok === true &&
          r.client === "openclaw-macos" &&
          r.role === "operator",
      ),
      "No admitted native operator connection",
    );
    const before = await call("sessions.list", { limit: 200 });
    assert.ok(Array.isArray(before.sessions));
    const beforeKeys = new Set(before.sessions.map((r) => r.key));
    await save("before-ax.json", beforeAX);
    await shot("before.png");
    await sleep(1000);
    appBaseline = await ps();
    report.baseline = appBaseline;
    const clickedAt = Date.now();
    report.clickedAt = clickedAt;
    monitoring = true;
    monitorTask = monitor(clickedAt);
    await monitorTask;
    report.sampleStartedAt = Date.now();
    // Cover the entire bounded AX traversal and action window, not only pre-click idle time.
    sample = start(
      "sample",
      [
        "/usr/bin/sample",
        String(appProc.child.pid),
        "12",
        "1",
        "-file",
        path.join(priv, "stack.txt"),
      ],
      baseEnv,
    );
    const sampleDeadline = setTimeout(() => kill(sample), 14000);
    void sample.done.finally(() => clearTimeout(sampleDeadline));
    const click = await ax("click");
    assert.equal(click.clicked, true);
    await save("click.json", click);
    assert.ok(
      click.pressedAt >= report.sampleStartedAt && click.pressedAt - report.sampleStartedAt < 12000,
      "Stack sampler did not cover the acknowledged AXPress",
    );
    if (mode === "red") {
      while (!guard && !fatal && !appProc.closed) await sleep(50);
      assert.ok(guard && !fatal, "Base did not reach a recognized watchdog stop");
      await sample.done;
      sampleText = await fs.readFile(path.join(priv, "stack.txt"), "utf8");
      report.redStackCounts = [
        "OpenClawChatGatewayTransport.createSession",
        "OpenClawChatTransport.createSession",
      ].map((symbol) => sampleText.split(symbol).length - 1);
      assert.ok(
        report.redStackCounts.every((count) => count >= 2),
        "Missing repeated original recursive stack",
      );
      assert.ok(
        metrics.some(
          (m) =>
            m.rssKiB - appBaseline.rssKiB > 64 * 1024 || m.vszKiB - appBaseline.vszKiB > 128 * 1024,
        ),
        "No allocating growth observed",
      );
      assert.equal(
        records.filter(
          (r) => r.t >= clickedAt && r.method === "sessions.create" && r.side === "req",
        ).length,
        0,
      );
      report.status = "expected-red";
      report.guard = guard;
    } else {
      let key;
      for (let t = Date.now(); Date.now() - t < 10000 && !guard && !fatal;) {
        try {
          key = correlate(records, clickedAt);
          break;
        } catch {}
        await sleep(100);
      }
      assert.ok(key && !guard && !fatal, "No qualifying native creation/selection correlation");
      proofConn = records.find(
        (r) => r.t >= clickedAt && r.side === "req" && r.method === "sessions.create",
      ).conn;
      requireLiveConnection(connectionState(proofConn));
      finished = true;
      report.correlatedAt = Date.now(); // Stop only the action deadline; keep the memory guard.
      const created = await call("sessions.list", { limit: 200 });
      const added = created.sessions.filter((r) => !beforeKeys.has(r.key));
      assert.equal(added.length, 1);
      assert.equal(added[0].key, key);
      assert.ok(added[0].sessionId);
      const marker = "NT186215-" + randomBytes(16).toString("hex");
      // Rename through the real owner, without selecting or reopening any UI row.
      await call("sessions.patch", { key, expectedSessionId: added[0].sessionId, label: marker });
      const after = await call("sessions.list", { limit: 200 });
      let selected, session;
      for (let t = Date.now(); Date.now() - t < 10000 && !guard && !fatal;) {
        selected = await ax("snapshot");
        try {
          session = selectedSession(beforeKeys, after, key, selected, marker);
          break;
        } catch {}
        await sleep(100);
      }
      assert.ok(session, "Newly created canonical session is not selected in the native sidebar");
      await save("after-ax.json", selected);
      await save("session.json", session);
      await shot("after.png");
      await sleep(10000);
      assert.ok(!guard && !fatal && !appProc.closed, "Guard fired during stability observation");
      correlate(records, clickedAt);
      const stable = await ax("snapshot");
      selectedSession(beforeKeys, after, key, stable, marker);
      await save("stable-ax.json", stable);
      assert.equal((await call("health")).ok, true, "Gateway not healthy after stability interval");
      const finalStatus = JSON.parse(
        await run(
          "final-app-status",
          [mac, "--profile", appProfile, "status", "--no-launch", "--json"],
          appEnv,
          5000,
        ),
      );
      assert.equal(finalStatus.primary.connection.state, "connected");
      assert.equal(gateway.child.exitCode, null);
      assert.equal(gateway.child.signalCode, null);
      assert.ok(!gateway.closed && !guard && !fatal && !appProc.closed);
      report.liveNativeConnection = connectionState(proofConn);
      requireLiveConnection(report.liveNativeConnection);
      report.status = "green";
      report.key = key;
    }
    assert.equal(providerPosts, 0, "Provider inference occurred");
  } catch (error) {
    report.status = "incomplete";
    report.failure = error.stack || String(error);
  } finally {
    monitoring = false;
    shuttingDown = true;
    clearTimeout(watchdog);
    finished = true;
    const cleanupErrors = [];
    try {
      if (monitorTask) await bounded("watchdog settlement", monitorTask, 1500);
    } catch (e) {
      cleanupErrors.push(String(e));
    }
    for (const p of processes) kill(p, "SIGTERM");
    await sleep(500);
    for (const p of processes) kill(p);
    try {
      await bounded("owned process pipes", Promise.all(processes.map((p) => p.done)), 5000);
    } catch (e) {
      cleanupErrors.push(String(e));
    }
    if (relay) {
      for (const c of relay.clients) c.terminate();
      try {
        await bounded("relay shutdown", new Promise((r) => relay.close(r)), 2000);
      } catch (e) {
        cleanupErrors.push(String(e));
      }
    }
    if (canary) {
      canary.closeAllConnections();
      try {
        await bounded("canary shutdown", new Promise((r) => canary.close(r)), 2000);
      } catch (e) {
        cleanupErrors.push(String(e));
      }
    }
    const survivors = processes.filter((p) => {
      if (!p.child.pid || (p.closed && !["app", "gateway"].includes(p.label))) return false;
      try {
        process.kill(-p.child.pid, 0);
        return true;
      } catch (e) {
        if (e.code !== "ESRCH") throw e;
        return false;
      }
    });
    report.cleanupErrors = cleanupErrors;
    report.cleanup =
      survivors.length || cleanupErrors.length ? "failed" : "owned-process-groups-retired";
    if (
      survivors.length ||
      cleanupErrors.length ||
      fatal ||
      providerPosts ||
      (mode === "green" && guard)
    )
      report.status = "incomplete";
    report.guard = guard;
    report.providerPosts = providerPosts;
    await save("rpc.json", records);
    await save("memory.json", metrics);
    await save("commands.json", commands);
    for (const name of await fs.readdir(priv))
      if (name.endsWith(".log") || name === "stack.txt")
        await save(name, await fs.readFile(path.join(priv, name), "utf8"));
    await save("verdict.json", report);
    const manifest = {};
    for (const name of await fs.readdir(evidence))
      manifest[name] = await hash(path.join(evidence, name));
    await save("SHA256.json", manifest);
    console.log(JSON.stringify({ mode, status: report.status, cleanup: report.cleanup, evidence }));
    process.exitCode = report.status === (mode === "red" ? "expected-red" : "green") ? 0 : 1;
    if (report.cleanup === "failed") process.exit(1); // Verdict is flushed; the disposable job owns OS teardown.
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => {
    console.error(String(error));
    process.exitCode = 1;
  });
