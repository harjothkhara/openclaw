import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import vm from "node:vm";
import {
  createEvidenceWriter,
  PROCESS_OUTPUT_LIMIT,
  requiredArtifacts,
  verifyEvidenceDirectory,
} from "./evidence.mjs";

const defaults = { ...fs, createReadStream };
async function fixture(t, { mode = "green", io = defaults, stack = true } = {}) {
  const directory = await fs.mkdtemp(path.join(process.cwd(), ".proof-evidence-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const writer = createEvidenceWriter(directory, { io });
  const report = {
    mode,
    status: mode === "red" ? "expected-red" : "green",
    nativeUIProof: true,
    cleanup: "owned-process-groups-retired",
  };
  await writer.write("verdict.json", {
    ...report,
    status: "incomplete",
    nativeUIProof: false,
    phase: "start",
  });
  const coreRecords = {
    "rpc.json": [],
    "memory.json": [],
    "commands.json": [],
    "gateway-startup.json": {},
  };
  // Synthetic files prove collection/integrity, not native image or app behavior.
  for (const name of requiredArtifacts(mode)) {
    if (name === "verdict.json" || name in coreRecords || (name === "stack.txt" && !stack))
      continue;
    await writer.write(name, name === "stack.txt" ? "synthetic stack" : {});
  }
  return { directory, writer, report, coreRecords };
}

test("actual driver finalization retains a behavior verdict when an optional log read fails", async (t) => {
  const f = await fixture(t);
  const source = await fs.readFile(new URL("./new-thread.mjs", import.meta.url), "utf8");
  const start = source.lastIndexOf("    report.guard = guard;");
  const end = source.indexOf("\n  }\n}\n\nif (", start);
  assert.ok(start >= 0 && end > start);
  const fakeProcess = { exitCode: null, exit: () => assert.fail("Unexpected exit") };
  const context = vm.createContext({
    report: f.report,
    guard: null,
    providerPosts: 0,
    records: [],
    metrics: [],
    commands: [],
    mode: "green",
    evidenceWriter: f.writer,
    evidence: f.directory,
    priv: f.directory,
    gateway: undefined,
    gatewayDiagnostics: () => ({}),
    processes: [
      { label: "helper", logPath: path.join(f.directory, "missing.log"), overflow: false },
    ],
    path,
    save: f.writer.write,
    hash: async () => "unused",
    fs: {
      readdir: async () => ["missing.log"],
      readFile: async () => {
        throw Error("injected diagnostic read failure");
      },
    },
    process: fakeProcess,
    console: { log: () => {} },
  });
  await vm.runInContext("(async()=>{" + source.slice(start, end) + "\n})()", context);
  assert.equal(fakeProcess.exitCode, 0);
  assert.equal((await verifyEvidenceDirectory(f.directory, "green")).status, "green");
  assert.equal(
    JSON.parse(await fs.readFile(path.join(f.directory, "export.json"))).diagnosticErrors.length,
    1,
  );
});

test("optional copy failure cannot erase an already committed verdict", async (t) => {
  const io = {
    ...defaults,
    rename: async (from, to) => {
      if (to.endsWith("broken.log")) throw Object.assign(Error("copy error"), { code: "EIO" });
      return fs.rename(from, to);
    },
  };
  const f = await fixture(t, { io });
  const result = await f.writer.finish(f.report, {
    coreRecords: f.coreRecords,
    logs: [{ name: "broken.log", text: "diagnostic" }],
  });
  assert.equal(result.status, "green");
  assert.equal(result.diagnosticErrorCount, 1);
  assert.equal((await verifyEvidenceDirectory(f.directory, "green")).status, "green");
});

test("oversized required stack stays bounded and makes red evidence incomplete", async (t) => {
  const f = await fixture(t, { mode: "red", stack: false });
  const file = path.join(f.directory, "raw-stack");
  const handle = await fs.open(file, "w");
  await handle.truncate(PROCESS_OUTPUT_LIMIT + 1);
  await handle.close();
  await assert.rejects(f.writer.readText(file), /byte limit/);
  const result = await f.writer.finish(f.report, { coreRecords: f.coreRecords });
  assert.equal(result.status, "incomplete");
  const retained = JSON.parse(await fs.readFile(path.join(f.directory, "verdict.json")));
  assert.equal(retained.nativeUIProof, false);
  assert.ok(retained.evidence.missing.includes("stack.txt"));
  await assert.rejects(verifyEvidenceDirectory(f.directory, "red"), /incomplete/);
});

test("failed final verdict replacement preserves the durable incomplete start receipt", async (t) => {
  let verdicts = 0;
  const io = {
    ...defaults,
    rename: async (from, to) => {
      if (to.endsWith("verdict.json") && ++verdicts > 1)
        throw Object.assign(Error("rename failed"), { code: "EIO" });
      return fs.rename(from, to);
    },
  };
  const f = await fixture(t, { io });
  const result = await f.writer.finish(f.report, { coreRecords: f.coreRecords });
  assert.equal(result.status, "incomplete");
  const retained = JSON.parse(await fs.readFile(path.join(f.directory, "verdict.json")));
  assert.equal(retained.phase, "start");
  assert.equal(retained.status, "incomplete");
  await assert.rejects(verifyEvidenceDirectory(f.directory, "green"), /incomplete/);
});

test("manifest write failure leaves the behavior record but cannot qualify the run", async (t) => {
  const io = {
    ...defaults,
    rename: async (from, to) => {
      if (to.endsWith("SHA256.json"))
        throw Object.assign(Error("manifest failed"), { code: "EIO" });
      return fs.rename(from, to);
    },
  };
  const f = await fixture(t, { io });
  const result = await f.writer.finish(f.report, { coreRecords: f.coreRecords });
  assert.equal(result.status, "incomplete");
  assert.equal(
    JSON.parse(await fs.readFile(path.join(f.directory, "verdict.json"))).status,
    "green",
  );
  await assert.rejects(verifyEvidenceDirectory(f.directory, "green"));
});

test("required record failure is retained as incomplete rather than swallowed as a diagnostic", async (t) => {
  const io = {
    ...defaults,
    rename: async (from, to) => {
      if (to.endsWith("rpc.json")) throw Object.assign(Error("rpc failed"), { code: "EIO" });
      return fs.rename(from, to);
    },
  };
  const f = await fixture(t, { io });
  const result = await f.writer.finish(f.report, { coreRecords: f.coreRecords });
  assert.equal(result.status, "incomplete");
  const verdict = JSON.parse(await fs.readFile(path.join(f.directory, "verdict.json")));
  assert.deepEqual(verdict.evidence.errors, [{ name: "rpc.json", error: "EIO" }]);
  assert.equal(verdict.nativeUIProof, false);
});

test("missing or changed required bytes cannot pass a self-reported success manifest", async (t) => {
  const f = await fixture(t);
  await f.writer.finish(f.report, { coreRecords: f.coreRecords });
  await fs.writeFile(path.join(f.directory, "selected-key.json"), "changed");
  await assert.rejects(verifyEvidenceDirectory(f.directory, "green"), /changed/);
});

test("overflowed process diagnostics are omitted without rereading or exporting a secret prefix", async (t) => {
  const io = {
    ...defaults,
    createReadStream: () => assert.fail("Overflowed output must not be read"),
  };
  const f = await fixture(t, { io });
  const result = await f.writer.finish(f.report, {
    coreRecords: f.coreRecords,
    logs: [{ name: "overflow.log", file: "/not-read", overflow: true }],
  });
  assert.equal(result.status, "green");
  assert.equal(result.diagnosticErrorCount, 1);
  await assert.rejects(fs.stat(path.join(f.directory, "overflow.log")), { code: "ENOENT" });
});

test("startup persistence failure stops at the evidence admission boundary", async (t) => {
  const directory = await fs.mkdtemp(path.join(process.cwd(), ".proof-start-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const writer = createEvidenceWriter(directory, {
    io: {
      ...defaults,
      writeFile: async () => {
        throw Object.assign(Error("no storage"), { code: "ENOSPC" });
      },
    },
  });
  await assert.rejects(writer.write("verdict.json", { status: "incomplete" }), { code: "ENOSPC" });
  const source = await fs.readFile(new URL("./new-thread.mjs", import.meta.url), "utf8");
  assert.ok(source.indexOf('await save("verdict.json"') < source.indexOf('await run("source-sha"'));
});

test("a stalled optional read cannot hide the already retained result and is aborted", async (t) => {
  let reading;
  const started = new Promise((resolve) => {
    reading = resolve;
  });
  const io = {
    ...defaults,
    createReadStream: (_file, options) => {
      reading();
      return new Readable({ signal: options.signal, read() {} });
    },
  };
  const f = await fixture(t, { io });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const finished = f.writer.finish(f.report, {
    coreRecords: f.coreRecords,
    logs: [{ name: "stalled.log", file: "/synthetic/stall" }],
  });
  await started;
  assert.equal(
    JSON.parse(await fs.readFile(path.join(f.directory, "verdict.json"))).status,
    "green",
  );
  t.mock.timers.tick(2000);
  const result = await finished;
  assert.equal(result.status, "green");
  assert.equal(result.diagnosticErrorCount, 1);
  t.mock.timers.reset();
  assert.equal((await verifyEvidenceDirectory(f.directory, "green")).status, "green");
});

test("actual sampler output producer caps captured and written bytes before diagnostic export", async () => {
  const source = await fs.readFile(new URL("./new-thread.mjs", import.meta.url), "utf8");
  const from = source.indexOf("  function start(");
  const to = source.indexOf("  function kill(", from);
  assert.ok(from >= 0 && to > from);
  const child = new EventEmitter();
  Object.assign(child, {
    pid: 99,
    exitCode: null,
    signalCode: null,
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
  });
  const chunks = [];
  const log = new EventEmitter();
  log.write = (chunk) => chunks.push(chunk);
  log.end = (done) => done();
  let kills = 0;
  const context = vm.createContext({
    spawn: () => child,
    createWriteStream: () => log,
    path,
    priv: "/owned/private",
    source: "/owned/source",
    serial: 0,
    processes: [],
    commands: [],
    fatal: null,
    PROCESS_OUTPUT_LIMIT,
    kill: () => {
      kills++;
    },
  });
  const start = vm.runInContext("(" + source.slice(from, to) + ")", context);
  const item = start("sample", ["sample", "-file", "/dev/stdout"], {}, true, 16);
  child.stdout.emit("data", Buffer.from("1234567890"));
  child.stdout.emit("data", Buffer.from("abcdefghij"));
  child.stdout.emit("data", Buffer.from("must-not-be-retained"));
  assert.equal(Buffer.concat(chunks).length, 10);
  assert.equal(item.stdout, "1234567890");
  assert.equal(item.overflow, true);
  assert.equal(kills, 1);
  assert.match(context.fatal.message, /output budget/);
  child.emit("exit", 0);
  child.emit("close", 0);
  await item.done;
  assert.equal(item.leaderExited, true);
  const sampler = source.slice(
    source.indexOf("sample = start("),
    source.indexOf('const click = await ax("new")'),
  );
  assert.ok(
    sampler.includes('"/dev/stdout"'),
    "Stack sampling must not bypass the pipe cap with a private file",
  );
});
