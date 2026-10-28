import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { dominance, validImage } from "./oracle.mjs";

// execFile bounds each pipe while reading, rather than after buffering the whole child.
export async function runBoundedHelper(file, args, options = {}) {
  return promisify(execFile)(file, args, {
    encoding: "utf8",
    timeout: 120000,
    maxBuffer: 65536,
    killSignal: "SIGKILL",
    ...options,
  });
}
export function checkFixtures(f) {
  assert.deepEqual(Object.keys(f).sort(), [
    "black",
    "gray",
    "green",
    "magenta",
    "transparent",
    "white",
  ]);
  dominance(f.magenta, "magenta");
  dominance(f.green, "green");
  assert.throws(() => dominance(f.magenta, "green"));
  assert.throws(() => dominance(f.green, "magenta"));
  for (const name of ["black", "white", "transparent", "gray"])
    assert.throws(() => validImage(f[name]));
  assert.equal(f.magenta.button.magenta, 1024, "Fixture channel/coordinate mismatch");
  assert.equal(f.magenta.button.green, 0);
  assert.equal(f.green.button.green, 1024, "Fixture channel/coordinate mismatch");
  assert.equal(f.green.button.magenta, 0);
}
async function main() {
  const out = path.join(process.env.GITHUB_WORKSPACE, "accent-preflight/evidence");
  await fs.mkdir(out, { recursive: true });
  const redact = (value) =>
    ["HOME", "GITHUB_WORKSPACE", "RUNNER_TEMP"].reduce(
      (s, key) => (process.env[key] ? s.split(process.env[key]).join("[" + key + "]") : s),
      String(value),
    );
  const receipt = { status: "incomplete", synthetic: true, helperInvoked: false };
  let stdout = "",
    stderr = "";
  try {
    const helper = path.join(process.env.RUNNER_TEMP, "accent-window-helper");
    const fixtureDirectory = path.join(
      process.env.RUNNER_TEMP,
      "accent-fixtures-" + process.env.GITHUB_RUN_ID,
    );
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
    receipt.helperInvoked = true;
    ({ stdout, stderr } = await runBoundedHelper(helper, ["selftest", fixtureDirectory], { env }));
    receipt.stdoutBytes = Buffer.byteLength(stdout);
    receipt.stderrBytes = Buffer.byteLength(stderr);
    assert(receipt.stdoutBytes <= 8192, "Synthetic JSON output budget exceeded");
    assert.equal(stderr.length, 0, "Synthetic decoder emitted diagnostics");
    const fixtures = JSON.parse(stdout);
    checkFixtures(fixtures);
    await fs.writeFile(path.join(out, "fixtures.json"), JSON.stringify(fixtures, null, 2) + "\n");
    receipt.status = "passed";
  } catch (error) {
    receipt.error = redact(error.message);
    receipt.code = error.code ?? null;
    receipt.signal = error.signal ?? null;
    receipt.killed = error.killed ?? null;
    stdout = error.stdout ?? stdout;
    stderr = error.stderr ?? stderr;
    process.exitCode = 1;
  } finally {
    // Synthetic-only output; bounded retained prefixes cannot contain generated app credentials.
    receipt.stdoutRetainedBytes = Buffer.byteLength(stdout);
    receipt.stderrRetainedBytes = Buffer.byteLength(stderr);
    receipt.stderrPrefix = redact(stderr).slice(0, 1000);
    await fs.writeFile(path.join(out, "verdict.json"), JSON.stringify(receipt, null, 2) + "\n");
    console.log(JSON.stringify(receipt));
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error("Synthetic preflight evidence failure: " + error.code);
    process.exitCode = 1;
  });
}
