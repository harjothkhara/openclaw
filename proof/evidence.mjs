import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";

export const PROCESS_OUTPUT_LIMIT = 8 * 1024 * 1024;
const RECEIPT_LIMIT = 2 * 1024 * 1024;
const IMAGE_LIMIT = 16 * 1024 * 1024;
const EXPORT_LIMIT = 32 * 1024 * 1024;
const EXPORT_TIME_LIMIT = 5000;
const ioDefault = { ...fs, createReadStream };
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const limitFor = (name) =>
  name === "stack.txt" || name.endsWith(".log")
    ? PROCESS_OUTPUT_LIMIT
    : name.endsWith(".png")
      ? IMAGE_LIMIT
      : RECEIPT_LIMIT;

export function requiredArtifacts(mode) {
  assert.ok(["red", "green", "preflight"].includes(mode));
  const common = [
    "verdict.json",
    "rpc.json",
    "memory.json",
    "commands.json",
    "gateway-startup.json",
    "gateway-config-validation.json",
    "window-before-ax.png",
    "window-last.json",
    "before-ax.json",
  ];
  if (mode === "preflight") return [...common, "startup-only.png"];
  const action = [
    ...common,
    "initial-key.json",
    "sessions-before.json",
    "before.png",
    "click.json",
    "sessions-after.json",
  ];
  return mode === "red"
    ? [...action, "stack.txt"]
    : [
        ...action,
        "selected-key.json",
        "after.png",
        "stable-key.json",
        "stable-ping.json",
        "session.json",
      ];
}

async function readBounded(file, maximum, io, timeout = 2000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  timer.unref();
  const chunks = [];
  let bytes = 0,
    stream;
  try {
    stream = io.createReadStream(file, { highWaterMark: 64 * 1024, signal: controller.signal });
    for await (const chunk of stream) {
      bytes += chunk.length;
      if (bytes > maximum)
        throw Object.assign(Error("Evidence byte limit exceeded"), { code: "EVIDENCE_LIMIT" });
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, bytes);
  } finally {
    clearTimeout(timer);
    stream?.destroy();
  }
}

export function createEvidenceWriter(directory, { redact = String, io = ioDefault } = {}) {
  const files = new Map();
  const describe = (error) => redact(String(error.code ?? error.message ?? error)).slice(0, 256);
  async function write(name, value, maximum = limitFor(name)) {
    const bytes = Buffer.from(
      redact(typeof value === "string" ? value : JSON.stringify(value, null, 2) + "\n"),
    );
    if (bytes.length > Math.min(maximum, limitFor(name)))
      throw Object.assign(Error("Receipt byte limit exceeded: " + name), {
        code: "EVIDENCE_LIMIT",
      });
    const target = path.join(directory, name),
      temporary = target + ".tmp";
    try {
      await io.writeFile(temporary, bytes, { mode: 0o600, flush: true });
      await io.rename(temporary, target);
    } catch (error) {
      await io.rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
    files.set(name, { sha256: digest(bytes), bytes: bytes.length });
  }
  async function registerFile(name) {
    const bytes = await readBounded(path.join(directory, name), limitFor(name), io);
    files.set(name, { sha256: digest(bytes), bytes: bytes.length });
    return bytes;
  }
  async function readText(file, timeout = 2000) {
    return (await readBounded(file, PROCESS_OUTPUT_LIMIT, io, timeout)).toString("utf8");
  }
  async function finish(report, { coreRecords, logs = [] }) {
    const required = requiredArtifacts(report.mode),
      requiredErrors = [];
    for (const [name, value] of Object.entries(coreRecords)) {
      try {
        await write(name, value);
      } catch (error) {
        requiredErrors.push({ name, error: describe(error) });
      }
    }
    const missing = required.filter((name) => !files.has(name));
    if (missing.length || requiredErrors.length) {
      report.status = "incomplete";
      report.nativeUIProof = false;
    }
    report.evidence = { required, missing, errors: requiredErrors };
    let verdictWritten = false;
    try {
      await write("verdict.json", report);
      verdictWritten = true;
    } catch (error) {
      requiredErrors.push({ name: "verdict.json", error: describe(error) });
    }
    // The retained start/final verdict precedes every optional read or copy below.
    const diagnosticErrors = [];
    let remaining = EXPORT_LIMIT;
    const exportDeadline = Date.now() + EXPORT_TIME_LIMIT;
    for (const [index, log] of logs.entries()) {
      try {
        const timeout = Math.min(2000, exportDeadline - Date.now());
        if (
          !log.name.endsWith(".log") ||
          index >= 128 ||
          remaining <= 0 ||
          timeout <= 0 ||
          log.overflow
        )
          throw Error("Diagnostic omitted by collection budget");
        const text = log.file ? await readText(log.file, timeout) : log.text;
        if (Buffer.byteLength(text) > PROCESS_OUTPUT_LIMIT || Buffer.byteLength(text) > remaining)
          throw Error("Diagnostic omitted by byte budget");
        await write(log.name, text, remaining);
        remaining -= files.get(log.name).bytes;
      } catch (error) {
        diagnosticErrors.push({ name: log.name, error: describe(error) });
      }
    }
    try {
      await write("export.json", {
        diagnosticErrors,
        retainedByteBudget: EXPORT_LIMIT - remaining,
      });
    } catch (error) {
      diagnosticErrors.push({ name: "export.json", error: describe(error) });
    }
    const complete = verdictWritten && missing.length === 0 && requiredErrors.length === 0;
    let manifestWritten = false;
    try {
      // Hashes are recorded only after committed writes/controlled captures, never
      // by rereading an unbounded directory during finalization.
      await write("SHA256.json", {
        schema: 2,
        complete,
        required,
        files: Object.fromEntries(files),
        diagnosticErrors,
      });
      manifestWritten = true;
    } catch (error) {
      requiredErrors.push({ name: "SHA256.json", error: describe(error) });
    }
    return {
      mode: report.mode,
      status: complete && manifestWritten ? report.status : "incomplete",
      cleanup: report.cleanup,
      verdictWritten,
      manifestWritten,
      requiredErrors,
      diagnosticErrorCount: diagnosticErrors.length,
    };
  }
  return { write, registerFile, readText, finish };
}

export async function verifyEvidenceDirectory(directory, mode) {
  const load = (name) => readBounded(path.join(directory, name), limitFor(name), ioDefault);
  const manifest = JSON.parse((await load("SHA256.json")).toString("utf8"));
  assert.equal(manifest.schema, 2);
  assert.equal(manifest.complete, true, "Required evidence collection is incomplete");
  assert.deepEqual(manifest.required, requiredArtifacts(mode));
  let verdict;
  for (const name of manifest.required) {
    const entry = manifest.files?.[name];
    assert.match(entry?.sha256 ?? "", /^[a-f0-9]{64}$/);
    const bytes = await load(name);
    assert.equal(bytes.length, entry.bytes, "Required artifact byte count changed: " + name);
    assert.equal(digest(bytes), entry.sha256, "Required artifact hash changed: " + name);
    if (name === "verdict.json") verdict = JSON.parse(bytes.toString("utf8"));
  }
  assert.equal(verdict.mode, mode);
  return verdict;
}
