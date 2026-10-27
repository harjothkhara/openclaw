import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { verdict, RED, GREEN_COLOR, MAGENTA } from "./oracle.mjs";
import { primingVerdict, talkRequest, talkResponse, forbidden } from "./priming.mjs";
test("required baseline is true PR merge-base", () =>
  assert.equal(RED, "1299676aacb6230a0960bd4f2178fb7ddd103849"));
test("failed-job reruns cannot allocate another Mac", () => {
  const workflow = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
  assert.match(
    workflow,
    /  accent:\n    needs: admission\n    if: github\.run_attempt == 1\n    runs-on: macos/,
  );
  assert(workflow.includes("current.run_attempt !== 1"));
});
test("missing reviewed-workflow marker refuses before setup", () => {
  const r = spawnSync(process.execPath, [new URL("./accent.mjs", import.meta.url).pathname], {
    encoding: "utf8",
    env: { ...process.env, ACCENT_PROOF_REVIEW: "" },
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /DISPATCH REFUSED: reviewed fork workflow required/);
  const workflow = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
  assert(
    workflow.includes(
      "if: github.event_name == 'workflow_dispatch' && github.repository == 'harjothkhara/openclaw'",
    ),
  );
  assert(workflow.includes("    needs: admission"));
  assert(workflow.includes("BASE_SHA: " + RED));
});
const primingRows = () =>
  [
    { side: "action", method: "talk-on" },
    { side: "req", method: "talk.config", id: "cfg" },
    {
      side: "res",
      method: "talk.config",
      id: "cfg",
      requestSeq: 1,
      ok: true,
      effectiveAccent: MAGENTA,
    },
    { side: "req", method: "talk.mode", id: "on", enabled: true, phase: "enabled" },
    {
      side: "res",
      method: "talk.mode",
      id: "on",
      requestSeq: 3,
      ok: true,
      enabled: true,
      phase: "enabled",
    },
    { side: "action", method: "talk-off" },
    { side: "req", method: "talk.mode", id: "off", enabled: false, phase: "disabled" },
    {
      side: "res",
      method: "talk.mode",
      id: "off",
      requestSeq: 6,
      ok: true,
      enabled: false,
      phase: "disabled",
    },
    {
      side: "barrier",
      method: "chat-only",
      onlyChat: true,
      talkActive: false,
      talkLabel: "Start realtime chat",
    },
    { side: "action", method: "config.patch" },
  ].map((r, seq) => ({ conn: "native-1", seq, ...r }));
const image = (color) => ({
  width: 960,
  height: 700,
  content: {
    total: 200000,
    opaque: 200000,
    nonBlack: 180000,
    nonWhite: 200000,
    dark: 140000,
    light: 1000,
  },
  button: {
    total: 1024,
    opaque: 1024,
    magenta: color === "magenta" ? 600 : 0,
    green: color === "green" ? 600 : 0,
  },
});
const connection = {
  conn: "native-1",
  client: "openclaw-macos",
  role: "operator",
  admitted: true,
  closed: false,
  frontendState: 1,
  upstreamState: 1,
};
const receipt = () => ({
  primingRows: primingRows(),
  beforeConnection: { ...connection },
  afterConnection: { ...connection },
  macConnections: 1,
  patchOk: true,
  patchAccent: GREEN_COLOR,
  persistedAccent: GREEN_COLOR,
  operatorColor: MAGENTA,
  configEventOnProofConnection: true,
  personalAccent: null,
  inferenceRequests: 0,
  providerPosts: 0,
  nativeConfigReadGreen: true,
});
test("independent known red and green cases", () => {
  assert.equal(verdict("red", image("magenta"), image("magenta"), receipt()), "expected-red");
  assert.equal(verdict("green", image("magenta"), image("green"), receipt()), "green");
});
for (const [name, mode, b, a, r] of [
  ["unchanged cannot pass green", "green", image("magenta"), image("magenta"), receipt()],
  ["green cannot pass red", "red", image("magenta"), image("green"), receipt()],
  ["reversed colors", "green", image("green"), image("magenta"), receipt()],
  ["missing image", "green", null, image("green"), receipt()],
  [
    "black content with valid colored chrome",
    "green",
    { ...image("magenta"), content: { ...image("magenta").content, nonBlack: 0, light: 0 } },
    image("green"),
    receipt(),
  ],
  [
    "white blank",
    "green",
    image("magenta"),
    { ...image("green"), content: { ...image("green").content, nonWhite: 0, dark: 0 } },
    receipt(),
  ],
  [
    "transparent",
    "green",
    image("magenta"),
    { ...image("green"), button: { ...image("green").button, opaque: 0 } },
    receipt(),
  ],
  [
    "weak dominance",
    "green",
    image("magenta"),
    { ...image("green"), button: { total: 1024, opaque: 1024, green: 20, magenta: 0 } },
    receipt(),
  ],
  [
    "reconnect",
    "green",
    image("magenta"),
    image("green"),
    { ...receipt(), afterConnection: { ...connection, conn: "native-2" } },
  ],
  [
    "disconnected",
    "green",
    image("magenta"),
    image("green"),
    { ...receipt(), afterConnection: { ...connection, closed: true } },
  ],
  [
    "no config event",
    "green",
    image("magenta"),
    image("green"),
    { ...receipt(), configEventOnProofConnection: false },
  ],
  [
    "no native read",
    "green",
    image("magenta"),
    image("green"),
    { ...receipt(), nativeConfigReadGreen: false },
  ],
  [
    "personal color",
    "green",
    image("magenta"),
    image("green"),
    { ...receipt(), personalAccent: MAGENTA },
  ],
  [
    "wrong operator color",
    "green",
    image("magenta"),
    image("green"),
    { ...receipt(), operatorColor: GREEN_COLOR },
  ],
  ["failed mutation", "green", image("magenta"), image("green"), { ...receipt(), patchOk: false }],
  ["inference", "green", image("magenta"), image("green"), { ...receipt(), inferenceRequests: 1 }],
])
  test("reject " + name, () => assert.throws(() => verdict(mode, b, a, r)));

test("priming oracle accepts only ordered native lifecycle", () =>
  assert.deepEqual(primingVerdict(primingRows(), "native-1", MAGENTA), {
    configResponseSeq: 2,
    enabledResponseSeq: 4,
    disabledResponseSeq: 7,
    chatOnlySeq: 8,
    mutationSeq: 9,
  }));
for (const [name, change] of [
  ["missing config", (r) => r.splice(2, 1)],
  [
    "wrong connection config",
    (r) => {
      r[2].conn = "admin-cli";
    },
  ],
  [
    "old response",
    (r) => {
      r[2].seq = -1;
    },
  ],
  [
    "wrong request correlation",
    (r) => {
      r[2].requestSeq = 99;
    },
  ],
  [
    "failed config",
    (r) => {
      r[2].ok = false;
    },
  ],
  [
    "wrong magenta",
    (r) => {
      r[2].effectiveAccent = GREEN_COLOR;
    },
  ],
  ["missing enabled completion", (r) => r.splice(4, 1)],
  [
    "disabled too early",
    (r) => {
      r[5].seq = 1;
    },
  ],
  [
    "generic idle is not disabled",
    (r) => {
      r[6].phase = "idle";
      r[7].phase = "idle";
    },
  ],
  [
    "permission denied",
    (r) => {
      r[6].phase = "denied";
      r[7].phase = "denied";
    },
  ],
  [
    "failed teardown",
    (r) => {
      r[7].ok = false;
    },
  ],
  [
    "wrong teardown connection",
    (r) => {
      r[7].conn = "another-native";
    },
  ],
  ["no teardown response", (r) => r.splice(7, 1)],
  [
    "overlay still visible",
    (r) => {
      r[8].onlyChat = false;
    },
  ],
  [
    "Talk activity remains",
    (r) => {
      r[8].talkActive = true;
    },
  ],
  [
    "stop button remains",
    (r) => {
      r[8].talkLabel = "Stop realtime chat";
    },
  ],
  [
    "mutation before teardown",
    (r) => {
      r[9].seq = 6;
    },
  ],
  [
    "Talk refetch during measurement",
    (r) => r.push({ conn: "native-1", seq: 10, side: "req", method: "talk.config", id: "late" }),
  ],
  [
    "Talk reenable during measurement",
    (r) =>
      r.push({
        conn: "native-1",
        seq: 10,
        side: "req",
        method: "talk.mode",
        enabled: true,
        phase: "listening",
        id: "late",
      }),
  ],
])
  test("reject priming " + name, () => {
    const rows = primingRows();
    change(rows);
    assert.throws(() => primingVerdict(rows, "native-1", MAGENTA));
    for (const mode of ["red", "green"])
      assert.throws(() =>
        verdict(mode, image("magenta"), image(mode === "red" ? "magenta" : "green"), {
          ...receipt(),
          primingRows: rows,
        }),
      );
  });
test("passive Talk projection omits private config and speech content", () => {
  assert.deepEqual(talkRequest("talk.config", { includeSecrets: true, token: "private" }), {});
  assert.deepEqual(
    talkResponse("talk.config", {
      config: { ui: { seamColor: MAGENTA }, talk: { apiKey: "private" } },
    }),
    { effectiveAccent: MAGENTA },
  );
  assert.deepEqual(
    talkRequest("talk.mode", { enabled: false, phase: "disabled", token: "private" }),
    { enabled: false, phase: "disabled" },
  );
  for (const method of [
    "talk.speak",
    "talk.realtime.start",
    "chat.send",
    "agent",
    "sessions.create",
  ])
    assert(forbidden(method));
  for (const method of ["talk.config", "talk.mode", "config.get"]) assert(!forbidden(method));
});
