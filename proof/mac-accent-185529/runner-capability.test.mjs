import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  diagnose,
  fixtureIdentity,
  fixtureGeometry,
  runnerObservationsPass,
} from "./runner-capability.mjs";
const here = path.dirname(fileURLToPath(import.meta.url));
const owner = { pid: 123, windowID: 42, phase: "magenta" };
const observation = () => ({
  ownerPid: 123,
  windowID: 42,
  observerPid: 456,
  axTrusted: true,
  axQuery: { error: 0, windowCount: 1 },
  console: { state: "unlocked" },
  display: { queryResult: 0, activeCount: 1, mainAsleep: false },
  window: {
    ownerMatches: true,
    onScreen: true,
    bounds: { x: 100, y: 100, width: 640, height: 400 },
  },
});
test("identity rejects wrong PID, stale phase, changed window and self-observation", () => {
  fixtureIdentity(owner, 123, "magenta");
  for (const o of [
    { ...owner, pid: 999 },
    { ...owner, phase: "green" },
    { ...owner, windowID: 0 },
  ])
    assert.throws(() => fixtureIdentity(o, 123, "magenta"));
  assert.throws(() => fixtureIdentity(owner, 123, "magenta", { windowID: 43 }));
  const good = observation();
  assert.equal(fixtureGeometry(good, owner).button.x, 680);
  for (const o of [
    { ...good, observerPid: 123 },
    { ...good, ownerPid: 999 },
    { ...good, windowID: 43 },
    { ...good, window: { ...good.window, onScreen: false } },
    { ...good, window: { ownerMatches: false } },
  ])
    assert.throws(() => fixtureGeometry(o, owner));
});
test("capture preflight is not capture; AX and console eligibility are separate", () => {
  const good = observation();
  assert(runnerObservationsPass([good, { ...good, capturePreflight: false }]));
  for (const bad of [
    { ...good, axTrusted: false },
    { ...good, axQuery: { error: -25211, windowCount: 0 } },
    { ...good, console: { state: "unknown" } },
    { ...good, console: { state: "locked" } },
    { ...good, display: { ...good.display, mainAsleep: true } },
    { ...good, display: { ...good.display, activeCount: 0 } },
  ])
    assert.equal(runnerObservationsPass([good, bad]), false);
  assert.equal(runnerObservationsPass([good]), false);
});
for (const mode of [
  "pass",
  "black",
  "stale",
  "capture-fail",
  "ax-denied",
  "flood",
  "missing-fixture",
  "green-ack-timeout",
])
  test("child boundary " + mode + " records truthful outcome and cleans fixture", async () => {
    const directory = await fs.mkdtemp(path.join(here, ".runner-test-"));
    const make = async (name, body) => {
      const file = path.join(directory, name + ".cjs");
      await fs.writeFile(file, "#!" + process.execPath + "\n" + body, { mode: 0o700 });
      return file;
    };
    try {
      const fixture = await make(
        "fixture",
        String.raw`
        const fs=require('node:fs'),p=process.argv[2];
        if(process.env.MODE==='flood')setInterval(()=>process.stderr.write(Buffer.alloc(65536,120)),1);
        let prior='';setInterval(()=>{const phase=fs.readFileSync(p+'/phase.txt','utf8').trim();
          if(phase!==prior && !(process.env.MODE==='green-ack-timeout' && phase==='green')){fs.writeFileSync(p+'/next',JSON.stringify({pid:process.pid,windowID:42,phase}));
            fs.renameSync(p+'/next',p+'/fixture.json');prior=phase;}},20);
      `,
      );
      const probe = await make(
        "probe",
        "const r=" +
          JSON.stringify(observation()) +
          ";r.ownerPid=Number(process.argv[2]);r.observerPid=process.pid;" +
          "if(process.env.MODE==='ax-denied'){r.axTrusted=false;r.axQuery.error=-25211;}process.stdout.write(JSON.stringify(r));",
      );
      const capture = await make(
        "capture",
        String.raw`
        const fs=require('node:fs'),p=process.argv.at(-1);
        if(process.env.MODE==='capture-fail')process.exit(3);
        if(process.argv.slice(2,6).join(' ')!=='-x -o -l 42')process.exit(4);
        fs.writeFileSync(p,'fake-screenshot-boundary');
      `,
      );
      const helper = await make(
        "helper",
        String.raw`
        const phase=process.argv[3].endsWith('green.png')?'green':'magenta', mode=process.env.MODE;
        const color=mode==='stale'?'magenta':phase;
        const pixels={width:640,height:400,content:{total:115000,opaque:115000,nonBlack:115000,nonWhite:111000,dark:111000,light:4000},
          button:{total:1024,opaque:1024,magenta:color==='magenta'?1024:0,green:color==='green'?1024:0}};
        if(mode==='black')pixels.content.nonBlack=0;
        process.stdout.write(JSON.stringify(pixels));
      `,
      );
      const out = path.join(directory, "evidence");
      const result = await diagnose({
        root: path.join(directory, "protocol"),
        out,
        fixture: mode === "missing-fixture" ? fixture + "-absent" : fixture,
        probe,
        capture,
        helper,
        env: { ...process.env, MODE: mode },
      });
      assert.equal(result.kind, "runner-diagnostic-not-product-proof");
      assert.equal(result.appBuilds, 0);
      assert.equal(
        result.status,
        mode === "pass"
          ? "passed"
          : mode === "ax-denied"
            ? "capture-passed-observations-blocked"
            : "incomplete",
        JSON.stringify(result),
      );
      assert.equal(result.capturePassed, ["pass", "ax-denied"].includes(mode));
      assert.equal(result.runnerObservationsPassed, mode === "pass");
      assert(result.fixtureExit);
      assert(result.fixtureStderrBytes <= 65536);
      const files = await fs.readdir(out);
      assert(files.includes("runner-verdict.json"));
      assert(files.includes("runner-environment.json"));
      if (mode === "black" || mode === "capture-fail" || mode === "flood")
        assert(!files.includes("magenta-fixture.png"));
      if (mode === "stale") {
        assert.equal(result.captures[1].pixels.button.magenta, 1024);
        assert(!files.includes("green-fixture.png"));
      }
      if (mode === "flood") assert.equal(result.fixtureOutputOverflow, true);
      if (mode === "black") assert.match(result.error, /Black\/blank\/protected/);
      if (mode === "stale") assert.match(result.error, /No clear green dominance/);
      if (mode === "capture-fail") assert.equal(result.code, 3);
      if (mode === "missing-fixture") {
        assert.equal(result.fixtureExit.error, "ENOENT");
      }
      if (mode === "green-ack-timeout") {
        assert.equal(result.stage, "green-ack");
        assert.match(result.error, /acknowledgment timed out/);
        assert.equal(result.captures.length, 1);
      }
      for (const row of result.captures) {
        if (row.capturePid) assert.notEqual(row.ownerPid, row.capturePid);
      }
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

test("runner fixture cannot displace or weaken the compiled selftest step", async () => {
  const workflow = await fs.readFile(path.join(here, "../../.github/workflows/ci.yml"), "utf8");
  const selftest = workflow.indexOf("node pixel-preflight.mjs");
  const diagnostic = workflow.indexOf("- name: Compile and diagnose the owned runner window");
  assert(selftest >= 0 && diagnostic > selftest);
  assert(!workflow.includes("continue-on-error"));
  assert(workflow.includes("node runner-capability.mjs"));
});
