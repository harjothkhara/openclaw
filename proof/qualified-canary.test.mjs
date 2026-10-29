import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { qualify, requireFixtureReceipt } from "./qualified-canary.mjs";
const good = {
  schema: 1,
  kind: "targeted-native-ax-fixture",
  action: "fixture",
  pid: 42,
  complete: true,
  axTrusted: true,
  newThreadPresses: 0,
  windowCount: 1,
  operationBudgetMs: 1000,
  elapsedMs: 10,
};
test("exact helper fixture receipt is distinct from a product/menu verdict", () =>
  requireFixtureReceipt(good, 42));
for (const patch of [
  { pid: 1 },
  { axTrusted: false },
  { complete: false },
  { windowCount: 0 },
  { windowCount: 17 },
  { elapsedMs: 1001 },
  { operationBudgetMs: 3000 },
  { operationBudgetMs: undefined },
  { newThreadPresses: 1 },
  { kind: "runner-diagnostic-not-product-proof" },
])
  test("fixture qualification rejects " + JSON.stringify(patch), () =>
    assert.throws(() => requireFixtureReceipt({ ...good, ...patch }, 42)),
  );
for (const mode of ["pass", "helper-timeout", "fixture-exit"])
  test("owned subprocess boundary " + mode + " persists truthful receipt and cleanup", async () => {
    const work = await fs.mkdtemp(path.join(os.tmpdir(), "nt186215-fixture-contract-"));
    try {
      const script = path.join(work, "fixture.mjs");
      await fs.writeFile(
        script,
        [
          "import fs from 'node:fs/promises';",
          "if(process.env.FAKE_MODE==='fixture-exit')process.exit(3);",
          "const root=process.argv.at(-1);",
          "const phase=(await fs.readFile(root+'/phase.txt','utf8')).trim();",
          "if(phase!=='magenta')process.exit(4);",
          "await fs.writeFile(root+'/fixture.next',JSON.stringify({pid:process.pid,phase,windowID:7}));",
          "await fs.rename(root+'/fixture.next',root+'/fixture.json');",
          "setInterval(()=>{},1000);",
        ].join("\n"),
      );
      let helperCalled = false;
      const r = await qualify({
        fixture: [process.execPath, script],
        helper: script,
        root: path.join(work, "owned"),
        out: path.join(work, "out"),
        env: { FAKE_MODE: mode },
        runHelper: async (file, args, options) => {
          helperCalled = true;
          assert.equal(args.length, 4);
          assert.equal(args[2], "fixture");
          assert.equal(args[3], "1000");
          assert.equal(options.timeout, 2000);
          assert.equal(file, script);
          if (mode === "helper-timeout")
            throw Object.assign(Error("helper deadline"), {
              signal: "SIGKILL",
              stderr: "last-stage:AXWindows",
            });
          return { stdout: JSON.stringify({ ...good, pid: Number(args[0]) }) };
        },
      });
      assert.equal(r.status, mode === "pass" ? "passed" : "incomplete");
      assert.equal(helperCalled, mode !== "fixture-exit");
      assert.equal(r.cleanup, "owned-fixture-retired");
      assert.equal(
        JSON.parse(await fs.readFile(path.join(work, "out/exact-helper-verdict.json"), "utf8"))
          .status,
        r.status,
      );
      if (mode === "helper-timeout") assert.equal(r.helperFailure.stderr, "last-stage:AXWindows");
    } finally {
      await fs.rm(work, { recursive: true, force: true });
    }
  });
