// Fork-only #185529 proof. Adapted from #186259 driver 82ed4d9a2d4; no production edits.
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import * as fs from "node:fs/promises";
import http from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  RED,
  GREEN,
  MAGENTA,
  GREEN_COLOR,
  live,
  validImage,
  dominance,
  verdict,
} from "./oracle.mjs";
import {
  observed,
  forbidden,
  talkRequest,
  talkResponse,
  primedOn,
  primedOff,
  primingVerdict,
} from "./priming.mjs";
import { createProcessGuard } from "./process-guard.mjs";
const execute = promisify(execFile),
  here = path.dirname(fileURLToPath(import.meta.url));
const bounded = async (label, promise, ms) => {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error(label + " timed out")), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};
const hash = async (p) => {
  const h = createHash("sha256");
  for await (const b of createReadStream(p)) h.update(b);
  return h.digest("hex");
};
async function main() {
  assert.equal(
    process.env.ACCENT_PROOF_REVIEW,
    "talk-priming-v1",
    "DISPATCH REFUSED: reviewed fork workflow required",
  );
  assert.equal(process.platform, "darwin");
  assert.equal(process.env.GITHUB_ACTIONS, "true");
  assert.equal(process.env.RUNNER_ENVIRONMENT, "github-hosted");
  assert.equal(process.env.GITHUB_REPOSITORY, "harjothkhara/openclaw");
  assert.equal(process.env.GITHUB_REF, "refs/heads/proof/mac-accent-128922-2026-10-27");
  for (const key of ["GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT"])
    assert.match(process.env[key] || "", /^[0-9]+$/);
  assert.match(process.env.GITHUB_SHA || "", /^[a-f0-9]{40}$/);
  assert.equal((process.argv.length - 2) % 2, 0);
  const args = Object.fromEntries(
    Array.from({ length: (process.argv.length - 2) / 2 }, (_, i) => [
      process.argv[2 + i * 2],
      process.argv[3 + i * 2],
    ]),
  );
  assert.deepEqual(Object.keys(args).sort(), ["--app", "--mode", "--out", "--source"]);
  const mode = args["--mode"];
  assert(["red", "green"].includes(mode));
  const sha = mode === "red" ? RED : GREEN,
    source = await fs.realpath(args["--source"]),
    app = await fs.realpath(args["--app"]);
  const workspace = await fs.realpath(process.env.GITHUB_WORKSPACE),
    out = path.resolve(args["--out"]);
  assert(source.startsWith(workspace + path.sep));
  assert(app.startsWith(path.join(source, "dist") + path.sep));
  assert(out.startsWith(workspace + path.sep) && !out.startsWith(source + path.sep));
  await fs.mkdir(out, { mode: 0o700 }); // Fresh arm only; interrupted results must not be reused.
  const priv = path.join(out, "private"),
    evidence = path.join(out, "evidence");
  await fs.mkdir(priv, { mode: 0o700 });
  await fs.mkdir(evidence);
  const token = randomBytes(32).toString("hex"),
    providerKey = randomBytes(32).toString("hex");
  const id = "accent" + process.env.GITHUB_RUN_ID + "-" + randomBytes(4).toString("hex"),
    appProfile = id + "-app",
    gwProfile = id + "-gw";
  const domain = "ai.openclaw.mac.profile." + appProfile;
  // Preserve real GUI HOME/TMPDIR; isolate app defaults, control socket and credentials by unique profile.
  const baseEnv = Object.fromEntries(
    [
      "PATH",
      "HOME",
      "USER",
      "LOGNAME",
      "TMPDIR",
      "LANG",
      "__CF_USER_TEXT_ENCODING",
      "RUNNER_TRACKING_ID",
    ]
      .filter((k) => process.env[k])
      .map((k) => [k, process.env[k]]),
  );
  Object.assign(baseEnv, { LANG: "en_US.UTF-8", CI: "true", NO_COLOR: "1", NSUnbufferedIO: "YES" });
  const secrets = [token, providerKey, source, app, priv, baseEnv.HOME];
  const redact = (s) =>
    secrets.filter(Boolean).reduce((v, k) => v.split(k).join("[REDACTED]"), String(s));
  const save = (name, v) =>
    fs.writeFile(
      path.join(evidence, name),
      redact(typeof v === "string" ? v : JSON.stringify(v, null, 2) + "\n"),
    );
  const report = {
    schema: 1,
    mode,
    sourceSha: sha,
    workflowSha: process.env.GITHUB_SHA,
    runId: process.env.GITHUB_RUN_ID,
    attempt: process.env.GITHUB_RUN_ATTEMPT,
    status: "incomplete",
    cleanup: "pending",
    scope: "Gateway-wide fallback on owner profile without personal accent",
    baseline: "Original PR merge-base; no substitute baseline allowed",
  };
  const processes = [],
    records = [],
    commands = [],
    metrics = [],
    connections = new Map();
  let fatal = null,
    shuttingDown = false,
    gateway,
    appProc,
    relay,
    canary,
    proofConn,
    monitorTimer,
    monitorBusy = false,
    stoppingApp = false;
  let serial = 0,
    providerPosts = 0,
    inferenceRequests = 0,
    disabledSeq = null;
  const deadline = Date.now() + 8 * 60 * 1000;
  const guard = createProcessGuard({
    onFailure: (e) => {
      fatal ??= e;
    },
    onOverflow: (e) => fail(e),
  });
  const kill = guard.signal;
  const groupAlive = guard.alive;
  function fail(e) {
    fatal ??= e;
    if (appProc && !stoppingApp) {
      stoppingApp = true;
      kill(appProc);
    }
  }
  function start(label, argv, env = baseEnv, capture = false) {
    assert(processes.length < 600, "Process budget");
    const child = spawn(argv[0], argv.slice(1), {
      cwd: source,
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const file = path.join(priv, ++serial + "-" + label + ".log"),
      log = createWriteStream(file, { mode: 0o600 });
    const p = {
      label,
      child,
      file,
      stdout: "",
      bytes: 0,
      closed: false,
      failed: false,
      groupRetired: false,
    };
    p.done = new Promise((resolve) => {
      child.on("error", fail);
      child.on("close", (code, signal) => {
        p.closed = true;
        p.result = { code, signal };
        if (code !== 0) p.failed = true;
        groupAlive(p);
        log.end(() => resolve({ code, signal }));
      });
      log.on("error", (e) => {
        fail(e);
        kill(p);
        resolve({ code: -1 });
      });
    });
    for (const key of ["stdout", "stderr"])
      child[key].on("data", (b) => {
        if (!guard.account(p, b.length)) return;
        if (!log.write(b)) {
          child[key].pause();
          log.once("drain", () => child[key].resume());
        }
        if (capture && key === "stdout") {
          p.stdout += b.toString();
          if (p.stdout.length > 1024 * 1024) {
            fail(Error("Capture budget exceeded"));
            kill(p);
          }
        }
      });
    processes.push(p);
    commands.push({ label, argv });
    return p;
  }
  async function run(label, argv, env = baseEnv, ms = 15000) {
    const p = start(label, argv, env, true),
      timer = setTimeout(() => {
        p.failed = true;
        kill(p);
      }, ms);
    try {
      const r = await bounded(label, p.done, ms + 5000);
      assert.equal(r.code, 0, label + " failed; inspect sanitized log");
      return p.stdout.trim();
    } catch (e) {
      p.failed = true;
      throw e;
    } finally {
      clearTimeout(timer);
      kill(p);
      if (groupAlive(p)) {
        await sleep(100);
        assert(!groupAlive(p), label + " group did not retire");
      }
    }
  }
  function healthy() {
    if (fatal) throw fatal;
    assert(Date.now() < deadline, "Arm time budget");
    assert(!gateway?.closed, "Gateway exited");
    assert(!appProc?.closed, "App exited");
  }
  async function waitFor(label, predicate, ms = 30000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      healthy();
      if (await predicate()) return;
      await sleep(300);
    }
    throw Error(label + " timed out");
  }
  const listen = (server) =>
    new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve(server.address().port));
    });
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
  function record(row) {
    assert(records.length < 5000, "RPC receipt budget");
    const r = { t: Date.now(), seq: records.length, ...row };
    records.push(r);
    return r;
  }
  const helper = await fs.realpath(process.env.ACCENT_CAPTURE_HELPER || "");
  assert(
    helper.startsWith((await fs.realpath(process.env.RUNNER_TEMP)) + path.sep),
    "Helper must be workflow-owned",
  );
  assert.match(process.env.ACCENT_CAPTURE_HELPER_SHA256 || "", /^[a-f0-9]{64}$/);
  assert.equal(
    await hash(helper),
    process.env.ACCENT_CAPTURE_HELPER_SHA256,
    "Capture helper changed since workflow preflight",
  );
  let gwEnv, appEnv, mac, relayUrl;
  async function status(label) {
    const s = JSON.parse(
      await run(
        label,
        [mac, "--profile", appProfile, "status", "--no-launch", "--json"],
        appEnv,
        7000,
      ),
    );
    await save("latest-app-status.json", s);
    assert.equal(s.app.profile, appProfile);
    assert.equal(s.primary.mode, "remote");
    assert.equal(s.primary.transport, "direct");
    assert.equal(s.primary.url, relayUrl);
    return s;
  }
  const talkInspect = async () =>
    JSON.parse(
      await run("talk-inspect", [helper, "talk-inspect", String(appProc.child.pid)], baseEnv, 7000),
    );
  const inspect = async () =>
    JSON.parse(
      await run("ax-inspect", [helper, "inspect", String(appProc.child.pid)], baseEnv, 7000),
    );
  async function capture(name) {
    const g = await inspect();
    assert(g.complete && g.native && g.draftVisible && g.sendEnabled, "Native Chat not ready");
    const geometry = path.join(evidence, name + "-geometry.json"),
      png = path.join(evidence, name + ".png");
    await save(name + "-geometry.json", g);
    await run(
      "capture-" + name,
      ["/usr/sbin/screencapture", "-x", "-o", "-l", String(g.windowId), png],
      baseEnv,
      15000,
    );
    assert((await fs.stat(png)).size > 1000, "Capture absent/empty");
    const again = await inspect();
    assert.equal(again.windowId, g.windowId);
    assert.deepEqual(again.bounds, g.bounds);
    assert.deepEqual(again.button, g.button);
    const s = JSON.parse(
      await run("pixels-" + name, [helper, "pixels", png, geometry], baseEnv, 20000),
    );
    await save(name + "-pixels.json", s);
    validImage(s);
    return s;
  }
  async function memory() {
    if (monitorBusy || shuttingDown) return;
    monitorBusy = true;
    try {
      for (const p of [appProc, gateway].filter(Boolean)) {
        const { stdout } = await execute("/bin/ps", ["-p", String(p.child.pid), "-o", "rss="], {
          timeout: 2000,
          maxBuffer: 4096,
          env: baseEnv,
        });
        const rssKiB = Number(stdout.trim());
        assert(Number.isFinite(rssKiB) && rssKiB > 0, "RSS unreadable");
        assert(rssKiB < 2 * 1024 * 1024, "Owned process exceeded 2 GiB RSS");
        metrics.push({ t: Date.now(), process: p.label, rssKiB });
        assert(metrics.length <= 1000, "Memory receipt budget");
      }
    } catch (e) {
      if (!shuttingDown) fail(e);
    } finally {
      monitorBusy = false;
    }
  }
  const armTimer = setTimeout(() => fail(Error("Arm watchdog expired")), 8 * 60 * 1000);
  try {
    assert.equal(await run("head", ["git", "rev-parse", "HEAD"]), sha);
    assert.equal(
      await run("clean", ["git", "status", "--porcelain", "--untracked-files=normal"]),
      "",
    );
    const exe = path.join(app, "Contents/MacOS/OpenClaw");
    mac = path.join(app, "Contents/MacOS/openclaw-mac");
    assert.equal(
      await run("bundle-sha", [
        "/usr/libexec/PlistBuddy",
        "-c",
        "Print:OpenClawGitCommit",
        path.join(app, "Contents/Info.plist"),
      ]),
      sha,
    );
    const build = JSON.parse(await fs.readFile(path.join(source, "dist/build-info.json"), "utf8"));
    assert.equal(build.commit, sha);
    assert(build.buildId);
    report.appExecutableSha256 = await hash(exe);
    report.gatewayBuildInfoSha256 = await hash(path.join(source, "dist/build-info.json"));
    report.driverSha256 = await hash(fileURLToPath(import.meta.url));
    report.captureHelperSha256 = await hash(path.join(here, "window.swift"));
    await run("codesign", ["/usr/bin/codesign", "--verify", "--deep", "--strict", app]);
    // The capture helper's AX and Screen Recording preflight below checks the GUI
    // needed by this proof. Dumping the whole launchd GUI domain can exceed the
    // bounded child log budget without testing additional app behavior.
    report.captureHelperExecutableSha256 = await hash(helper); // Reuse exact workflow-preflight binary/path.
    const fixtures = JSON.parse(
      await run(
        "pixel-negative-controls",
        [helper, "selftest", path.join(priv, "pixel-fixtures")],
        baseEnv,
        120000,
      ),
    );
    dominance(fixtures.magenta, "magenta");
    dominance(fixtures.green, "green");
    assert.throws(() => dominance(fixtures.magenta, "green"));
    assert.throws(() => dominance(fixtures.green, "magenta"));
    assert.throws(() => validImage(fixtures.black));
    assert.throws(() => validImage(fixtures.white));
    await save("negative-controls.json", { synthetic: true, decoderChecks: 6, passed: true });
    await save("tcc-preflight.json", JSON.parse(await run("tcc", [helper, "preflight"])));
    canary = http.createServer((req, res) => {
      if (req.method === "POST") {
        providerPosts++;
        fail(Error("Inference reached canary"));
      }
      res.writeHead(503);
      res.end("No inference in accent proof");
    });
    const canaryPort = await listen(canary),
      reserve = http.createServer(),
      port = await listen(reserve);
    await new Promise((r) => reserve.close(r));
    const gwState = path.join(priv, "gateway"),
      appState = path.join(priv, "app");
    await fs.mkdir(gwState);
    await fs.mkdir(appState);
    await fs.mkdir(path.join(priv, "workspace"));
    gwEnv = {
      ...baseEnv,
      OPENCLAW_PROFILE: gwProfile,
      OPENCLAW_STATE_DIR: gwState,
      OPENCLAW_CONFIG_PATH: path.join(gwState, "openclaw.json"),
      OPENCLAW_GATEWAY_PORT: String(port),
      OPENCLAW_GATEWAY_TOKEN: token,
    };
    const cfg = {
      gateway: {
        mode: "local",
        bind: "loopback",
        port,
        auth: { mode: "token", token },
        controlUi: { enabled: false },
      },
      cron: { enabled: false },
      ui: { seamColor: MAGENTA, prefs: { accent: MAGENTA } },
      logging: { file: path.join(priv, "gateway-file.log"), level: "info" },
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
                name: "Accent proof - never called",
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
        entries: { main: { name: "Accent proof" } },
        defaults: {
          workspace: path.join(priv, "workspace"),
          skipBootstrap: true,
          model: { primary: "openai/proof", fallbacks: [] },
          models: { "openai/proof": { agentRuntime: { id: "openclaw" } } },
        },
      },
      plugins: { enabled: true, allow: ["openai"], slots: { memory: "none" } },
      skills: { allowBundled: [] },
      tools: { allow: [] },
    };
    await fs.writeFile(gwEnv.OPENCLAW_CONFIG_PATH, JSON.stringify(cfg), { mode: 0o600 });
    const configCheck = JSON.parse(
      await run(
        "config-validate",
        ["pnpm", "--silent", "openclaw", "--profile", gwProfile, "config", "validate", "--json"],
        gwEnv,
        30000,
      ),
    );
    assert.equal(configCheck.valid, true, "Generated Gateway config must validate");
    const call = async (method, params = {}) =>
      JSON.parse(
        await run(
          "rpc-" + method,
          [
            "pnpm",
            "--silent",
            "openclaw",
            "--profile",
            gwProfile,
            "gateway",
            "call",
            method,
            "--json",
            "--params",
            JSON.stringify(params),
          ],
          gwEnv,
          20000,
        ),
      );
    gateway = start(
      "gateway",
      [
        "pnpm",
        "--silent",
        "openclaw",
        "--profile",
        gwProfile,
        "gateway",
        "run",
        "--port",
        String(port),
        "--bind",
        "loopback",
        "--auth",
        "token",
      ],
      gwEnv,
    );
    monitorTimer = setInterval(() => void memory(), 1000);
    await waitFor(
      "Gateway health",
      async () => {
        try {
          return (await call("health")).ok === true;
        } catch {
          healthy();
          return false;
        }
      },
      120000,
    );
    const { WebSocket, WebSocketServer } = createRequire(path.join(source, "package.json"))("ws");
    relay = new WebSocketServer({ host: "127.0.0.1", port: 0, maxPayload: 2 * 1024 * 1024 });
    await bounded(
      "relay listen",
      new Promise((r, j) => {
        relay.once("listening", r);
        relay.once("error", j);
      }),
      10000,
    );
    relayUrl = "ws://127.0.0.1:" + relay.address().port;
    relay.on("connection", (front) => {
      if (connections.size >= 16) {
        front.terminate();
        fail(Error("Connection budget"));
        return;
      }
      const conn = randomBytes(8).toString("hex"),
        up = new WebSocket("ws://127.0.0.1:" + port, { maxPayload: 2 * 1024 * 1024 }),
        pending = new Map(),
        queue = [];
      let queued = 0;
      const c = { frontend: front, upstream: up, identity: {}, admitted: false, closed: false };
      connections.set(conn, c);
      function observe(side, bytes) {
        assert(bytes.length <= 2 * 1024 * 1024, "Frame budget");
        const f = JSON.parse(bytes.toString());
        if (side === "req" && f.type === "req") {
          if (f.method === "connect")
            c.identity = { client: f.params?.client?.id, role: f.params?.role };
          if (forbidden(f.method)) {
            inferenceRequests++;
            throw Error("Unexpected send/create request");
          }
          const projection = talkRequest(f.method, f.params);
          if (
            conn === proofConn &&
            disabledSeq !== null &&
            (f.method === "talk.config" ||
              (f.method === "talk.mode" && projection.enabled !== false))
          )
            throw Error("Talk restarted or reread config after teardown");
          const r = observed(f.method)
            ? record({ side, conn, id: f.id, method: f.method, ...c.identity, ...projection })
            : null;
          pending.set(f.id, { method: f.method, t: Date.now(), requestSeq: r?.seq, ...projection });
          assert(pending.size <= 128, "Pending request budget");
        } else if (side === "res" && f.type === "res" && pending.has(f.id)) {
          const req = pending.get(f.id);
          pending.delete(f.id);
          const row = {
            side,
            conn,
            id: f.id,
            method: req.method,
            requestedAt: req.t,
            requestSeq: req.requestSeq,
            ...c.identity,
            ...talkRequest(req.method, req),
            ...talkResponse(req.method, f.payload),
            ok: f.ok === true,
          };
          if (req.method === "connect") {
            c.admitted = f.ok === true;
            row.scopes = f.payload?.auth?.scopes;
          }
          if (req.method === "config.get") {
            row.accent = f.payload?.config?.ui?.prefs?.accent ?? null;
            row.operatorColor = f.payload?.config?.ui?.seamColor ?? null;
          }
          if (req.method === "users.prefs.get") {
            row.identityStatus = f.payload?.status;
            row.personalAccent = f.payload?.entries?.["ui.accent"] ?? null;
          }
          if (observed(req.method)) record(row);
          if (
            conn === proofConn &&
            req.method.startsWith("talk.") &&
            (!row.ok || row.phase === "denied")
          )
            throw Error("Native Talk permission/config request failed");
        } else if (side === "res" && f.type === "event" && f.event === "config.changed")
          record({ side: "event", conn, method: f.event, ...c.identity });
      }
      front.on("message", (data, binary) => {
        try {
          observe("req", data);
          if (up.readyState === 1) {
            assert(up.bufferedAmount < 4 * 1024 * 1024, "Relay backpressure");
            up.send(data, { binary });
          } else {
            queued += data.length;
            assert(queue.length < 16 && queued <= 2 * 1024 * 1024, "Relay queue budget");
            queue.push([data, binary]);
          }
        } catch (e) {
          fail(e);
          front.terminate();
          up.terminate();
        }
      });
      up.on("open", () => {
        for (const [data, binary] of queue) up.send(data, { binary });
        queue.length = 0;
        queued = 0;
      });
      up.on("message", (data, binary) => {
        try {
          observe("res", data);
          assert(front.bufferedAmount < 4 * 1024 * 1024, "Relay backpressure");
          if (front.readyState === 1) front.send(data, { binary });
        } catch (e) {
          fail(e);
          front.terminate();
          up.terminate();
        }
      });
      for (const s of [front, up])
        s.on("error", (e) => {
          if (!shuttingDown) fail(e);
        });
      const closed = () => {
        if (c.closed) return;
        c.closed = true;
        record({ side: "lifecycle", conn, method: "disconnect", ...c.identity });
        if (conn === proofConn && !shuttingDown) fail(Error("Proof native connection closed"));
      };
      front.on("close", () => {
        closed();
        up.terminate();
      });
      up.on("close", () => {
        closed();
        front.terminate();
      });
    });
    appEnv = {
      ...baseEnv,
      OPENCLAW_PROFILE: appProfile,
      OPENCLAW_STATE_DIR: appState,
      OPENCLAW_CONFIG_PATH: path.join(appState, "openclaw.json"),
      OPENCLAW_GATEWAY_PORT: String(relay.address().port),
    };
    const tokenFile = path.join(priv, "token");
    await fs.writeFile(tokenFile, token, { mode: 0o600 });
    const configured = JSON.parse(
      await run(
        "configure",
        [
          mac,
          "--profile",
          appProfile,
          "configure-remote",
          "--direct-url",
          relayUrl,
          "--token-file",
          tokenFile,
          "--json",
        ],
        appEnv,
      ),
    );
    assert.equal(configured.status, "ok");
    assert.equal(configured.remoteUrl, relayUrl);
    assert.equal(configured.configPath, appEnv.OPENCLAW_CONFIG_PATH);
    const written = JSON.parse(await fs.readFile(appEnv.OPENCLAW_CONFIG_PATH, "utf8"));
    assert.equal(written.gateway.mode, "remote");
    assert.equal(written.gateway.remote.url, relayUrl);
    await save("configured-endpoint.json", {
      mode: configured.mode,
      transport: configured.transport,
      url: relayUrl,
      profile: appProfile,
    });
    for (const key of ["openclaw.nativeExperienceEnabled", "openclaw.chat.useNativeConversation"])
      await run("defaults", ["/usr/bin/defaults", "write", domain, key, "-bool", "true"], appEnv);
    // Use native speech priming, not realtime provider bootstrap. Never fabricate an accent default.
    for (const key of [
      "openclaw.talkRealtimeRelayEnabled",
      "openclaw.talkEnabled",
      "openclaw.swabbleEnabled",
      "openclaw.voicePushToTalkEnabled",
      "openclaw.talkPhaseSoundsEnabled",
    ])
      await run("defaults", ["/usr/bin/defaults", "write", domain, key, "-bool", "false"], appEnv);
    appProc = start("app", [exe, "--chat", "--attach-only"], appEnv);
    let lastStatus;
    await waitFor(
      "app control status and exact isolated endpoint",
      async () => {
        try {
          lastStatus = await status("status");
          return lastStatus.primary.connection.state === "connected";
        } catch (e) {
          if (fatal) throw fatal;
          report.startupDiagnostic = redact(String(e));
          return false;
        }
      },
      90000,
    );
    await waitFor("unique admitted native operator", () => {
      const cs = [...connections].filter(
        ([, c]) =>
          c.identity.client === "openclaw-macos" &&
          c.identity.role === "operator" &&
          c.admitted &&
          !c.closed,
      );
      assert(cs.length <= 1, "More than one native operator");
      if (!cs.length) return false;
      proofConn = cs[0][0];
      return true;
    });
    live(connectionState(proofConn));
    await waitFor("native personal preference read", () =>
      records.some(
        (r) => r.conn === proofConn && r.method === "users.prefs.get" && r.side === "res" && r.ok,
      ),
    );
    const personal = records
      .filter((r) => r.conn === proofConn && r.method === "users.prefs.get" && r.side === "res")
      .at(-1);
    assert.equal(personal.identityStatus, "ok", "Expected supported owner-profile route");
    assert.equal(personal.personalAccent, null, "Personal accent must be absent");
    await waitFor(
      "empty native Chat with Talk off",
      async () => {
        try {
          const a = await talkInspect();
          return (
            a.complete &&
            a.onlyChat &&
            a.draftEmpty &&
            a.talkEnabled &&
            !a.talkActive &&
            a.talkLabel === "Start realtime chat"
          );
        } catch (e) {
          report.lastAXDiagnostic = redact(String(e));
          healthy();
          return false;
        }
      },
      30000,
    );
    report.primingConnection = connectionState(proofConn);
    live(report.primingConnection);
    record({ side: "action", conn: proofConn, method: "talk-on" });
    const on = JSON.parse(
      await run("talk-on", [helper, "talk-on", String(appProc.child.pid)], baseEnv, 7000),
    );
    assert.equal(on.pressed, "talk-on");
    await save("talk-on-ax.json", on);
    // These receipts come from the app's production startup, never an administrative substitute.
    await waitFor(
      "native Talk magenta config and enabled completion",
      () => {
        try {
          report.talkOn = primedOn(records, proofConn, MAGENTA);
          return true;
        } catch (e) {
          report.primingDiagnostic = redact(String(e));
          return false;
        }
      },
      30000,
    );
    live(connectionState(proofConn));
    record({ side: "action", conn: proofConn, method: "talk-off" });
    const off = JSON.parse(
      await run("talk-off", [helper, "talk-off", String(appProc.child.pid)], baseEnv, 7000),
    );
    assert.equal(off.pressed, "talk-off");
    await save("talk-off-ax.json", off);
    await waitFor(
      "native disabled-phase teardown acknowledgment",
      () => {
        try {
          report.talkOff = primedOff(records, proofConn, MAGENTA);
          return true;
        } catch (e) {
          report.primingDiagnostic = redact(String(e));
          return false;
        }
      },
      15000,
    );
    disabledSeq = report.talkOff.disabled.res.seq;
    let settled;
    await waitFor(
      "Talk overlay retired, only native Chat remains",
      async () => {
        settled = await talkInspect();
        return (
          settled.onlyChat &&
          settled.draftEmpty &&
          !settled.talkActive &&
          settled.talkEnabled &&
          settled.talkLabel === "Start realtime chat"
        );
      },
      10000,
    );
    live(connectionState(proofConn));
    await save("talk-disabled-ax.json", settled);
    record({
      side: "barrier",
      conn: proofConn,
      method: "chat-only",
      onlyChat: settled.onlyChat,
      talkActive: settled.talkActive,
      talkLabel: settled.talkLabel,
    });
    await run("draft", [helper, "draft", String(appProc.child.pid)], baseEnv, 7000);
    await waitFor("enabled native composer", async () => {
      const a = await inspect();
      return a.draftVisible && a.sendEnabled;
    });
    let before;
    for (let i = 0; i < 5; i++) {
      before = await capture("before-" + i);
      try {
        dominance(before, "magenta");
        break;
      } catch (e) {
        if (i === 4) throw e;
        await sleep(500);
      }
    }
    dominance(before, "magenta");
    report.beforePixels = before;
    report.beforeConnection = connectionState(proofConn);
    live(report.beforeConnection);
    const initial = await call("config.get");
    assert.equal(initial.config.ui.prefs.accent, MAGENTA);
    assert.equal(initial.config.ui.seamColor, MAGENTA);
    const mutation = record({ side: "action", conn: proofConn, method: "config.patch" });
    report.priming = primingVerdict(records, proofConn, MAGENTA);
    const mutationAt = mutation.t,
      patch = await call("config.patch", {
        raw: JSON.stringify({ ui: { prefs: { accent: GREEN_COLOR } } }),
        note: "fork-only native accent proof",
      });
    assert.equal(patch.ok, true, "Config patch was not acknowledged");
    record({ side: "mutation", method: "config.patch", ok: patch.ok, accent: GREEN_COLOR });
    const persisted = await call("config.get");
    assert.equal(persisted.config.ui.prefs.accent, GREEN_COLOR);
    assert.equal(persisted.config.ui.seamColor, MAGENTA);
    await waitFor("config.changed delivered to native connection", () =>
      records.some(
        (r) =>
          r.t >= mutationAt &&
          r.conn === proofConn &&
          r.side === "event" &&
          r.method === "config.changed",
      ),
    );
    // The true base lacks this reader; require its response only on the fixed head.
    if (mode === "green")
      await waitFor("native config.get consumed saved green response", () =>
        records.some(
          (r) =>
            r.requestedAt >= mutationAt &&
            r.conn === proofConn &&
            r.method === "config.get" &&
            r.side === "res" &&
            r.ok &&
            r.accent === GREEN_COLOR,
        ),
      );
    let after;
    const limit = Date.now() + 15000;
    for (let i = 0; Date.now() < limit; i++) {
      healthy();
      after = await capture("after-" + i);
      // Invalid capture fails immediately; a color transition can settle within the bounded window.
      try {
        dominance(after, mode === "red" ? "magenta" : "green");
        break;
      } catch (e) {
        if (i >= 4) throw e;
        await sleep(500);
      }
    }
    // Two further observed frames prevent a single transient color from being the verdict.
    for (let i = 0; i < 2; i++) {
      await sleep(750);
      healthy();
      after = await capture("stable-" + i);
      dominance(after, mode === "red" ? "magenta" : "green");
    }
    const finalStatus = await status("final-status");
    assert.equal(finalStatus.primary.connection.state, "connected");
    report.receipt = {
      primingRows: records,
      beforeConnection: report.beforeConnection,
      afterConnection: connectionState(proofConn),
      macConnections: [...connections.values()].filter(
        (c) => c.identity.client === "openclaw-macos" && c.identity.role === "operator",
      ).length,
      patchOk: patch.ok === true,
      patchAccent: GREEN_COLOR,
      persistedAccent: persisted.config.ui.prefs.accent,
      operatorColor: persisted.config.ui.seamColor,
      configEventOnProofConnection: records.some(
        (r) =>
          r.t >= mutationAt &&
          r.conn === proofConn &&
          r.side === "event" &&
          r.method === "config.changed",
      ),
      personalAccent: personal.personalAccent,
      inferenceRequests,
      providerPosts,
      nativeConfigReadGreen: records.some(
        (r) =>
          r.requestedAt >= mutationAt &&
          r.conn === proofConn &&
          r.side === "res" &&
          r.method === "config.get" &&
          r.ok &&
          r.accent === GREEN_COLOR,
      ),
    };
    healthy();
    assert.equal(report.primingConnection.conn, report.beforeConnection.conn);
    report.status = verdict(mode, before, after, report.receipt);
    report.afterPixels = after;
  } catch (e) {
    report.status = "incomplete";
    report.failure = redact(e.stack || String(e));
  } finally {
    shuttingDown = true;
    clearInterval(monitorTimer);
    clearTimeout(armTimer);
    const errors = [];
    for (const p of processes) kill(p, "SIGTERM");
    await sleep(500);
    for (const p of processes) kill(p);
    try {
      await bounded("owned processes", Promise.all(processes.map((p) => p.done)), 6000);
    } catch (e) {
      errors.push(String(e));
    }
    if (relay) {
      for (const c of connections.values()) {
        c.frontend.terminate();
        c.upstream.terminate();
      }
      try {
        await bounded("relay close", new Promise((r) => relay.close(r)), 2000);
      } catch (e) {
        errors.push(String(e));
      }
    }
    if (canary) {
      canary.closeAllConnections();
      try {
        await bounded("canary close", new Promise((r) => canary.close(r)), 2000);
      } catch (e) {
        errors.push(String(e));
      }
    }
    for (const p of processes) {
      try {
        if (groupAlive(p)) errors.push("Owned process group survived: " + p.label);
      } catch (e) {
        errors.push(String(e));
      }
    }
    errors.push(
      ...guard.signalErrors.map(
        (item) => `${item.label} ${item.operation} ${item.signal}: ${item.code}`,
      ),
    );
    report.cleanup = errors.length ? "failed" : "owned-process-groups-retired";
    report.cleanupErrors = errors;
    report.outputOverflows = processes.flatMap((p) => (p.outputOverflow ? [p.outputOverflow] : []));
    report.providerPosts = providerPosts;
    report.inferenceRequests = inferenceRequests;
    if (errors.length || fatal || providerPosts || inferenceRequests) {
      report.status = "incomplete";
      report.guard = fatal ? redact(String(fatal)) : null;
    }
    report.processes = processes.map((p) => ({
      label: p.label,
      failed: p.failed,
      closed: p.closed,
      groupRetired: p.groupRetired,
      bytes: p.bytes,
      result: p.result,
    }));
    // Preserve a fail-closed receipt before optional logs or manifests can fail.
    await save("verdict.json", { ...report, status: "incomplete", evidenceFinalized: false });
    const evidenceErrors = [];
    const saveAncillary = async (name, value) => {
      try {
        await save(name, value);
      } catch (e) {
        evidenceErrors.push(`${name}: ${redact(String(e))}`);
      }
    };
    await saveAncillary("rpc.json", records);
    await saveAncillary("commands.json", commands);
    await saveAncillary("memory.json", metrics);
    for (const p of processes)
      if (
        p.failed ||
        [
          "app",
          "gateway",
          "configure",
          "status",
          "final-status",
          "tcc",
          "pixel-negative-controls",
        ].includes(p.label)
      ) {
        // A truncated private log could contain only a token prefix; export its
        // bounded byte receipt instead of any of that child's retained output.
        if (p.outputOverflow) continue;
        try {
          await saveAncillary(path.basename(p.file), await fs.readFile(p.file, "utf8"));
        } catch (e) {
          evidenceErrors.push(`${p.label} log: ${redact(String(e))}`);
        }
      }
    report.omittedOverflowLogs = report.outputOverflows.map((p) => p.label);
    report.evidenceErrors = evidenceErrors;
    if (evidenceErrors.length) report.status = "incomplete";
    report.evidenceFinalized = evidenceErrors.length === 0;
    await save("verdict.json", report);
    try {
      const manifest = {};
      for (const n of await fs.readdir(evidence)) manifest[n] = await hash(path.join(evidence, n));
      await save("SHA256.json", manifest);
    } catch (e) {
      report.status = "incomplete";
      report.evidenceFinalized = false;
      report.evidenceErrors.push(`manifest: ${redact(String(e))}`);
      await save("verdict.json", report);
    }
    // Do not publish private state or tokens. Leave only unique-profile residue on this disposable VM.
    if (!errors.length) await fs.rm(priv, { recursive: true, force: true });
    console.log(JSON.stringify({ mode, status: report.status, cleanup: report.cleanup, evidence }));
    process.exitCode = report.status === (mode === "red" ? "expected-red" : "green") ? 0 : 1;
    if (errors.length) process.exit(1);
  }
}
main().catch((e) => {
  console.error("Proof setup refused: " + e.message);
  process.exitCode = 1;
});
