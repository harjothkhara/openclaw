import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runBoundedHelper, checkFixtures } from "./pixel-preflight.mjs";
const here = path.dirname(fileURLToPath(import.meta.url));
const image = (color) => ({
  width: 640,
  height: 400,
  content: {
    total: 115000,
    opaque: 115000,
    nonBlack: 115000,
    nonWhite: 111000,
    dark: 111000,
    light: 4000,
  },
  button: {
    total: 1024,
    opaque: 1024,
    magenta: color === "magenta" ? 1024 : 0,
    green: color === "green" ? 1024 : 0,
  },
});
const fixtures = () => ({
  magenta: image("magenta"),
  green: image("green"),
  black: { ...image("magenta"), content: { total: 115000, opaque: 115000, nonBlack: 0 } },
  white: { ...image("green"), content: { total: 115000, opaque: 115000, nonWhite: 0 } },
  transparent: { ...image("green"), button: { ...image("green").button, opaque: 0 } },
  gray: { ...image("green"), content: { ...image("green").content, dark: 0, light: 0 } },
});
test("compiled-fixture contract accepts ordered colors and rejects swapped or missing controls", () => {
  const f = fixtures();
  checkFixtures(f);
  assert.throws(() => checkFixtures({ ...f, magenta: f.green, green: f.magenta }));
  const { gray, ...missing } = f;
  assert.throws(() => checkFixtures(missing));
  assert.throws(() => checkFixtures({ ...f, black: f.magenta }));
});
for (const stream of ["stdout", "stderr"])
  test(stream + " flood is bounded during reads", async () => {
    await assert.rejects(
      runBoundedHelper(
        process.execPath,
        ["-e", "setInterval(()=>process." + stream + ".write(Buffer.alloc(65536,120)),1)"],
        { timeout: 3000 },
      ),
      (error) => {
        assert.equal(error.code, "ERR_CHILD_PROCESS_STDIO_MAXBUFFER");
        assert(Buffer.byteLength(error.stdout) <= 65536);
        assert(Buffer.byteLength(error.stderr) <= 65536);
        return true;
      },
    );
  });
test("silent helper gets a real SIGKILL timeout", async () => {
  await assert.rejects(
    runBoundedHelper(process.execPath, ["-e", "setInterval(()=>{},1000)"], { timeout: 150 }),
    (error) => {
      assert.equal(error.killed, true);
      assert.equal(error.signal, "SIGKILL");
      return true;
    },
  );
});
for (const mode of ["missing", "flood", "pass"])
  test("preflight " + mode + " persists a truthful synthetic verdict", async () => {
    const directory = await fs.mkdtemp(path.join(here, ".preflight-test-"));
    try {
      if (mode !== "missing") {
        const body =
          mode === "flood"
            ? "setInterval(()=>process.stderr.write(Buffer.alloc(65536,120)),1);"
            : "process.stdout.write(" + JSON.stringify(JSON.stringify(fixtures())) + ");";
        await fs.writeFile(
          path.join(directory, "accent-window-helper"),
          "#!" + process.execPath + String.fromCharCode(10) + body,
          { mode: 0o700 },
        );
      }
      let result;
      try {
        result = await runBoundedHelper(
          process.execPath,
          [path.join(here, "pixel-preflight.mjs")],
          {
            env: {
              ...process.env,
              RUNNER_TEMP: directory,
              GITHUB_WORKSPACE: directory,
              GITHUB_RUN_ID: "unit",
            },
            timeout: 4000,
          },
        );
      } catch (error) {
        result = error;
        assert.notEqual(mode, "pass");
      }
      const receipt = JSON.parse(
        await fs.readFile(path.join(directory, "accent-preflight/evidence/verdict.json"), "utf8"),
      );
      assert.equal(receipt.synthetic, true);
      assert.equal(receipt.status, mode === "pass" ? "passed" : "incomplete");
      assert.equal(result.code ?? 0, mode === "pass" ? 0 : 1);
      assert(receipt.stderrRetainedBytes <= 65536);
      assert(receipt.stderrPrefix.length <= 1000);
      if (mode === "flood") assert.equal(receipt.code, "ERR_CHILD_PROCESS_STDIO_MAXBUFFER");
      if (mode === "missing") assert.equal(receipt.code, "ENOENT");
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
