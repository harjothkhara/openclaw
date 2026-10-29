// Own controller reuses the immutable shared fixture/capture oracle; never product proof.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { operationBudgetMs, requireAXBudgetReceipt } from "./ax-budget.mjs";
export const sharedSha = "13cde4984372bef34402ae61ff7891379626f260";
export function requireFixtureReceipt(r, pid) {
  assert.equal(r?.schema, 1);
  assert.equal(r.kind, "targeted-native-ax-fixture");
  assert.equal(r.action, "fixture");
  assert.equal(r.pid, pid);
  assert.equal(r.complete, true);
  assert.equal(r.axTrusted, true);
  assert.equal(r.newThreadPresses, 0);
  assert.ok(Number.isInteger(r.windowCount) && r.windowCount > 0 && r.windowCount <= 16);
  requireAXBudgetReceipt(r, "fixture");
}
export async function qualify({ fixture, helper, root, out, env, runHelper }) {
  await fs.mkdir(root, { recursive: false });
  await fs.mkdir(out, { recursive: true });
  const redact = (s) =>
    ["HOME", "GITHUB_WORKSPACE", "RUNNER_TEMP"].reduce(
      (s, k) => (env[k] ? s.split(env[k]).join("[" + k + "]") : s),
      String(s),
    );
  const receipt = {
    kind: "exact-helper-fixture-diagnostic-not-product-proof",
    status: "incomplete",
    sharedSourceSha: sharedSha,
  };
  let child,
    closed,
    outcome,
    overflow = false;
  let stderr = "";
  let bytes = 0;
  try {
    await fs.writeFile(path.join(root, "phase.txt"), "magenta\n");
    child = spawn(fixture[0], [...fixture.slice(1), root], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    closed = new Promise((resolve) => {
      child.once("error", (e) => {
        outcome = { error: e.code };
        resolve(outcome);
      });
      child.once("close", (code, signal) => {
        outcome = { code, signal };
        resolve(outcome);
      });
    });
    for (const stream of ["stdout", "stderr"])
      child[stream].on("data", (b) => {
        bytes += b.length;
        if (bytes > 65536) {
          overflow = true;
          child.kill("SIGKILL");
          return;
        }
        if (stream === "stderr") stderr += b.toString();
      });
    const deadline = Date.now() + 8000;
    let owner;
    while (Date.now() < deadline) {
      assert.ok(!outcome && !overflow, "Fixture stopped before exact-helper query");
      try {
        const f = path.join(root, "fixture.json"),
          size = (await fs.stat(f)).size;
        assert.ok(size > 0 && size <= 16384);
        const r = JSON.parse(await fs.readFile(f, "utf8"));
        assert.equal(r.pid, child.pid);
        assert.equal(r.phase, "magenta");
        assert.ok(Number.isInteger(r.windowID) && r.windowID > 0);
        owner = r;
        break;
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
      await sleep(100);
    }
    assert.ok(owner, "Fixture acknowledgment deadline exceeded");
    const executable = await fs.realpath(fixture[0]);
    const budget = operationBudgetMs("fixture");
    const result = await runHelper(
      helper,
      [String(child.pid), executable, "fixture", String(budget)],
      {
        env,
        timeout: budget + 1000,
      },
    );
    assert.ok(Buffer.byteLength(result.stdout) <= 16384);
    receipt.helper = JSON.parse(result.stdout);
    requireFixtureReceipt(receipt.helper, child.pid);
    receipt.helperExecutableSha256 = createHash("sha256")
      .update(await fs.readFile(helper))
      .digest("hex");
    assert.ok(!outcome && !overflow, "Fixture exited during helper qualification");
    receipt.status = "passed";
  } catch (e) {
    receipt.failure = redact(e.message).slice(0, 1500);
    receipt.helperFailure = {
      code: e.code ?? null,
      signal: e.signal ?? null,
      killed: e.killed ?? null,
      stdout: redact(e.stdout ?? "").slice(0, 4000),
      stderr: redact(e.stderr ?? "").slice(0, 4000),
    };
  } finally {
    if (child && !outcome) child.kill("SIGKILL");
    const settled = closed ? await Promise.race([closed, sleep(2000).then(() => null)]) : null;
    receipt.fixtureExit = settled;
    receipt.outputBytes = bytes;
    receipt.fixtureStderr = redact(stderr).slice(0, 1500);
    receipt.cleanup = (!child || settled) && !overflow ? "owned-fixture-retired" : "incomplete";
    if (receipt.cleanup !== "owned-fixture-retired") receipt.status = "incomplete";
    await fs.writeFile(
      path.join(out, "exact-helper-verdict.json"),
      JSON.stringify(receipt, null, 2) + "\n",
    );
  }
  return receipt;
}
async function main() {
  assert.equal(process.platform, "darwin");
  assert.equal(process.env.GITHUB_ACTIONS, "true");
  assert.equal(process.env.GITHUB_REPOSITORY, "harjothkhara/openclaw");
  assert.equal(process.env.RUNNER_ENVIRONMENT, "github-hosted");
  const shared = await fs.realpath(process.env.OPENCLAW_SHARED_CANARY_DIR);
  const { diagnose } = await import(pathToFileURL(path.join(shared, "runner-capability.mjs")));
  const { runBoundedHelper } = await import(
    pathToFileURL(path.join(shared, "pixel-preflight.mjs"))
  );
  const temp = await fs.realpath(process.env.RUNNER_TEMP),
    out = path.join(process.env.GITHUB_WORKSPACE, "new-thread-runner/evidence");
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
      .filter((k) => process.env[k])
      .map((k) => [k, process.env[k]]),
  );
  Object.assign(env, { LANG: "en_US.UTF-8", CI: "true", NO_COLOR: "1", NSUnbufferedIO: "YES" });
  const sharedReceipt = await diagnose({
    root: path.join(temp, "new-thread-shared-canary"),
    out,
    fixture: path.join(temp, "accent-runner-fixture"),
    probe: path.join(temp, "accent-runner-probe"),
    helper: path.join(temp, "accent-window-helper"),
    env,
  });
  assert.equal(
    sharedReceipt.status,
    "passed",
    "Shared runner capability gate failed before app packaging",
  );
  const helper = await fs.realpath(process.env.OPENCLAW_NEW_THREAD_AX_HELPER);
  assert.ok(helper.startsWith(temp + path.sep));
  const result = await qualify({
    fixture: [path.join(temp, "accent-runner-fixture")],
    helper,
    root: path.join(temp, "new-thread-exact-helper"),
    out,
    env,
    runHelper: runBoundedHelper,
  });
  console.log(JSON.stringify(result));
  assert.equal(result.status, "passed", "Exact compiled helper AX qualification failed");
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
