import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { dominance } from "./oracle.mjs";
import { runBoundedHelper } from "./pixel-preflight.mjs";

export function fixtureIdentity(receipt, pid, phase, prior) {
  assert.equal(receipt.pid, pid, "Fixture PID mismatch");
  assert.equal(receipt.phase, phase, "Stale fixture phase");
  assert(Number.isInteger(receipt.windowID) && receipt.windowID > 0, "Missing fixture window ID");
  if (prior) assert.equal(receipt.windowID, prior.windowID, "Fixture window changed");
}
export function fixtureGeometry(probe, owner) {
  assert.equal(probe.ownerPid, owner.pid);
  assert.equal(probe.windowID, owner.windowID);
  assert(
    Number.isInteger(probe.observerPid) && probe.observerPid > 1 && probe.observerPid !== owner.pid,
    "Not a separate observer process",
  );
  assert.equal(probe.window?.ownerMatches, true, "Window not owned by fixture");
  assert.equal(probe.window.onScreen, true, "Fixture is not on-screen");
  const b = probe.window.bounds;
  assert(
    b && Number.isFinite(b.x) && Number.isFinite(b.y) && b.width === 640 && b.height === 400,
    "Unexpected fixture window geometry",
  );
  return { bounds: b, button: { x: b.x + 580, y: b.y + 300, width: 32, height: 32 } };
}
export function runnerObservationsPass(probes) {
  return (
    probes.length === 2 &&
    probes.every(
      (p) =>
        p.axTrusted === true &&
        p.axQuery?.error === 0 &&
        p.axQuery.windowCount > 0 &&
        p.console?.state === "unlocked" &&
        p.display?.queryResult === 0 &&
        p.display.activeCount > 0 &&
        p.display.activeCount < 16 &&
        p.display.mainAsleep === false,
    )
  );
}
async function boundedJSON(file) {
  const size = (await fs.stat(file)).size;
  assert(size > 0 && size <= 16384, "Diagnostic JSON budget exceeded");
  return JSON.parse(await fs.readFile(file, "utf8"));
}
async function atomicPhase(root, phase) {
  await fs.writeFile(path.join(root, "phase.next"), phase + "\n");
  await fs.rename(path.join(root, "phase.next"), path.join(root, "phase.txt"));
}
export async function diagnose({
  root,
  out,
  fixture,
  probe,
  helper,
  capture = "/usr/sbin/screencapture",
  env,
}) {
  await fs.mkdir(root, { recursive: false }); // Fresh owned protocol/capture directory; no stale screenshots.
  await fs.mkdir(out, { recursive: true });
  const redact = (value) =>
    ["HOME", "GITHUB_WORKSPACE", "RUNNER_TEMP"].reduce(
      (s, key) => (process.env[key] ? s.split(process.env[key]).join("[" + key + "]") : s),
      String(value),
    );
  const receipt = {
    kind: "runner-diagnostic-not-product-proof",
    status: "incomplete",
    appBuilds: 0,
    captures: [],
    runnerObservationsPassed: false,
    capturePassed: false,
  };
  let child,
    closed,
    outcome,
    overflow = false;
  const output = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  const probes = [];
  try {
    receipt.stage = "initial-environment";
    const initial = await runBoundedHelper(probe, ["state"], { env, timeout: 8000 });
    assert(Buffer.byteLength(initial.stdout) <= 16384);
    await fs.writeFile(
      path.join(out, "runner-environment.json"),
      JSON.stringify(JSON.parse(initial.stdout), null, 2) + "\n",
    );
    receipt.stage = "fixture-startup";
    await atomicPhase(root, "magenta");
    child = spawn(fixture, [root], { env, stdio: ["ignore", "pipe", "pipe"] });
    closed = new Promise((resolve) => {
      child.once("error", (error) => {
        outcome = { error: error.code };
        resolve(outcome);
      });
      child.once("close", (code, signal) => {
        outcome = { code, signal };
        resolve(outcome);
      });
    });
    for (const stream of ["stdout", "stderr"])
      child[stream].on("data", (data) => {
        const remaining = 65536 - output[stream].length;
        output[stream] = Buffer.concat([output[stream], data.subarray(0, Math.max(0, remaining))]);
        if (data.length > remaining) {
          overflow = true;
          child.kill("SIGKILL");
        }
      });
    let prior;
    for (const phase of ["magenta", "green"]) {
      receipt.stage = phase + "-ack";
      await atomicPhase(root, phase);
      let owner;
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        assert(!outcome && !overflow, "Fixture stopped before capture");
        try {
          const candidate = await boundedJSON(path.join(root, "fixture.json"));
          if (candidate.phase === phase) {
            owner = candidate;
            break;
          }
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        await sleep(100);
      }
      assert(owner, "Fixture draw acknowledgment timed out");
      fixtureIdentity(owner, child.pid, phase, prior);
      prior = owner;
      // Fixed settle only, never a capture retry or a substituted synthetic image.
      await sleep(250);
      receipt.stage = phase + "-observe";
      const observation = await runBoundedHelper(
        probe,
        [String(owner.pid), String(owner.windowID)],
        { env, timeout: 8000 },
      );
      assert(Buffer.byteLength(observation.stdout) <= 16384);
      const state = JSON.parse(observation.stdout);
      await fs.writeFile(
        path.join(out, phase + "-runner.json"),
        JSON.stringify(state, null, 2) + "\n",
      );
      probes.push(state);
      const geometry = fixtureGeometry(state, owner);
      const geometryFile = path.join(root, phase + "-geometry.json");
      await fs.writeFile(geometryFile, JSON.stringify(geometry));
      const image = path.join(root, phase + ".png");
      const row = {
        phase,
        ownerPid: owner.pid,
        windowID: owner.windowID,
        observerPid: state.observerPid,
        captureExecutable: capture,
        status: "incomplete",
      };
      receipt.captures.push(row);
      // The capturer is a different OS process from the fixture. No desktop fallback.
      receipt.stage = phase + "-capture";
      const operation = promisify(execFile)(
        capture,
        ["-x", "-o", "-l", String(owner.windowID), image],
        { env, encoding: "utf8", timeout: 10000, maxBuffer: 65536, killSignal: "SIGKILL" },
      );
      row.capturePid = operation.child.pid;
      await operation;
      assert(row.capturePid > 1 && row.capturePid !== owner.pid, "Not a separate capturer process");
      assert(!outcome && !overflow, "Fixture stopped during capture");
      const size = (await fs.stat(image)).size;
      assert(size > 0 && size <= 20 * 1024 * 1024, "Missing/oversized captured PNG");
      receipt.stage = phase + "-pixels";
      const decoded = await runBoundedHelper(helper, ["pixels", image, geometryFile], {
        env,
        timeout: 10000,
      });
      assert(Buffer.byteLength(decoded.stdout) <= 16384);
      const pixels = JSON.parse(decoded.stdout);
      row.pixels = pixels; // Retain failed oracle counts without publishing unvalidated pixels.
      dominance(pixels, phase); // Rejects blank, black, transparent, flat and stale/reversed colors.
      row.status = "passed";
      await fs.copyFile(image, path.join(out, phase + "-fixture.png"));
    }
    receipt.stage = "complete";
    receipt.capturePassed = true;
    receipt.runnerObservationsPassed = runnerObservationsPass(probes);
    receipt.status = receipt.runnerObservationsPassed
      ? "passed"
      : "capture-passed-observations-blocked";
  } catch (error) {
    receipt.error = redact(error.message).slice(0, 1500);
    receipt.code = error.code ?? null;
    receipt.signal = error.signal ?? null;
    // Retain bounded diagnostics, never whole desktops or unrelated process logs.
    receipt.childStderrPrefix = redact(error.stderr ?? "").slice(0, 1000);
  } finally {
    if (child && !outcome) child.kill("SIGKILL");
    if (closed) {
      const cleanup = await Promise.race([closed, sleep(2000).then(() => null)]);
      receipt.fixtureExit = cleanup;
      if (!cleanup) {
        receipt.status = "incomplete";
        receipt.runnerObservationsPassed = false;
        receipt.error = "Fixture cleanup not confirmed";
      }
    }
    receipt.fixtureOutputOverflow = overflow;
    receipt.fixtureStdoutBytes = output.stdout.length;
    receipt.fixtureStderrBytes = output.stderr.length;
    receipt.fixtureStderrPrefix = redact(output.stderr.toString("utf8")).slice(0, 1000);
    if (overflow) {
      receipt.status = "incomplete";
      receipt.runnerObservationsPassed = false;
    }
    await fs.writeFile(
      path.join(out, "runner-verdict.json"),
      JSON.stringify(receipt, null, 2) + "\n",
    );
  }
  return receipt;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const temp = process.env.RUNNER_TEMP;
  const out = path.join(process.env.GITHUB_WORKSPACE, "accent-preflight/evidence");
  const env = Object.fromEntries(
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
      .filter((key) => process.env[key])
      .map((key) => [key, process.env[key]]),
  );
  Object.assign(env, { LANG: "en_US.UTF-8", CI: "true", NO_COLOR: "1", NSUnbufferedIO: "YES" });
  diagnose({
    root: path.join(temp, "accent-runner-" + process.env.GITHUB_RUN_ID),
    out,
    fixture: path.join(temp, "accent-runner-fixture"),
    probe: path.join(temp, "accent-runner-probe"),
    helper: path.join(temp, "accent-window-helper"),
    env,
  })
    .then((receipt) => {
      console.log(JSON.stringify(receipt));
      if (receipt.status !== "passed") process.exitCode = 1;
    })
    .catch((error) => {
      console.error("Runner diagnostic setup failure: " + error.code);
      process.exitCode = 1;
    });
}
