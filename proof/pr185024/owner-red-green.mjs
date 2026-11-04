// Isolated source-level regression probe; not full-app, profile, or process proof.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

assert.equal(process.env.GITHUB_ACTIONS, "true");
assert.equal(process.env.RUNNER_OS, "macOS");
assert.equal(process.env.GITHUB_REPOSITORY, "harjothkhara/openclaw");
const evidence = path.resolve("evidence");
fs.mkdirSync(evidence, { recursive: true });
const fixture = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP, "owner-proof-"));
const proof = path.resolve("proof/pr185024");
const test = fs.readFileSync(path.join(proof, "OwnerProofTests.swift"));
const result = { testSha256: createHash("sha256").update(test).digest("hex"), cases: {} };
function swift(name, args) {
  const run = spawnSync("swift", args, { encoding: "utf8", timeout: 180_000, maxBuffer: 16_777_216 });
  fs.writeFileSync(path.join(evidence, `${name}.log`), `${run.stdout ?? ""}${run.stderr ?? ""}`);
  assert.equal(run.error, undefined, `${name} could not execute normally`);
  assert.equal(run.signal, null, `${name} terminated by signal`);
  return run;
}
try {
  for (const name of ["base", "candidate"]) {
    const root = path.join(fixture, name);
    const sources = path.join(root, "Sources/OwnerProof");
    const tests = path.join(root, "Tests/OwnerProofTests");
    fs.mkdirSync(sources, { recursive: true });
    fs.mkdirSync(tests, { recursive: true });
    fs.writeFileSync(path.join(root, "Package.swift"), `// swift-tools-version: 6.2\nimport PackageDescription\nlet package = Package(name: "OwnerProof", platforms: [.macOS(.v14)], targets: [.target(name: "OwnerProof"), .testTarget(name: "OwnerProofTests", dependencies: ["OwnerProof"])])\n`);
    fs.copyFileSync(path.resolve(`owner-sources/${name}.swift`), path.join(sources, "LaunchAgentManager.swift"));
    fs.copyFileSync(path.join(proof, "OwnerProofSupport.swift"), path.join(sources, "Support.swift"));
    fs.writeFileSync(path.join(tests, "OwnerProofTests.swift"), test);
    const build = swift(`${name}-owner-build`, ["build", "--package-path", root, "--build-tests"]);
    assert.equal(build.status, 0, `${name} must compile before a regression result is meaningful`);
    const run = swift(`${name}-owner-tests`, ["test", "--package-path", root, "--skip-build", "--filter", "OwnerProofTests"]);
    result.cases[name] = { buildExit: build.status, testExit: run.status };
    if (name === "base") {
      assert.equal(run.status, 1, "The same behavioral assertion must fail on the base owner");
      assert.match(run.stdout + run.stderr, /Expectation failed/);
      assert.match(run.stdout + run.stderr, /Test run with 2 tests[\s\S]*failed/);
    } else {
      assert.equal(run.status, 0, "The same behavioral assertion must pass on the candidate owner");
      assert.match(run.stdout + run.stderr, /Test run with 2 tests[\s\S]*passed/);
    }
  }
} finally {
  fs.writeFileSync(path.join(evidence, "owner-red-green.json"), JSON.stringify(result, null, 2));
  fs.rmSync(fixture, { recursive: true, force: true });
}
console.log(JSON.stringify(result));
