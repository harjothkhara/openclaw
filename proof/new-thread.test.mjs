import assert from "node:assert/strict";
import test from "node:test";
import { bounded, correlate, observedResponse, requireLiveConnection } from "./new-thread.mjs";

const key = "agent:main:dashboard:created";
const request = (method, id, extra = {}) => ({
  side: "req",
  t: 1,
  conn: "native",
  id,
  client: "openclaw-macos",
  role: "operator",
  method,
  key,
  ...extra,
});
const response = (method, id, extra = {}) => ({
  ...request(method, id),
  side: "res",
  ok: true,
  ...extra,
});
const fixture = () => [
  response("connect", "connect", { t: 0 }),
  request("sessions.create", "create"),
  response("sessions.create", "create"),
  request("sessions.messages.subscribe", "sub"),
  response("sessions.messages.subscribe", "sub"),
  request("chat.history", "history"),
  response("chat.history", "history"),
];

test("RPC verdict accepts causal order within one wall-clock millisecond", () =>
  assert.equal(correlate(fixture(), 1), key));
for (const [name, mutate] of [
  ["zero requests", (r) => []],
  ["duplicate create", (r) => [...r, { ...r[1], id: "duplicate" }]],
  ["no connection admission", (r) => r.slice(1)],
  [
    "another connection admission",
    (r) => r.map((x) => (x.id === "connect" ? { ...x, conn: "other" } : x)),
  ],
  [
    "failed create",
    (r) => r.map((x) => (x.id === "create" && x.side === "res" ? { ...x, ok: false } : x)),
  ],
  ["wrong client", (r) => r.map((x) => ({ ...x, client: "browser" }))],
  ["wrong role", (r) => r.map((x) => ({ ...x, role: "node" }))],
  ["other connection", (r) => r.map((x) => (x.id === "sub" ? { ...x, conn: "other" } : x))],
  [
    "other selected session",
    (r) => r.map((x) => (x.id === "sub" ? { ...x, key: "agent:main:other" } : x)),
  ],
  ["selection before creation response", (r) => [...r.slice(0, 2), ...r.slice(3), r[2]]],
  ["missing selection receipt", (r) => r.filter((x) => !(x.id === "sub" && x.side === "res"))],
])
  test("RPC verdict rejects " + name, () => assert.throws(() => correlate(mutate(fixture()), 1)));

test("observer never substitutes a requested key for a missing canonical response", () => {
  const rows = fixture();
  rows[2] = {
    ...rows[2],
    ...observedResponse({ method: "sessions.create", key }, { ok: true, payload: {} }),
  };
  assert.throws(() => correlate(rows, 1), /canonical creation key/);
});

const live = {
  client: "openclaw-macos",
  role: "operator",
  admitted: true,
  closed: false,
  frontendState: 1,
  upstreamState: 1,
};
test("live native admission is required independently of cached row/RPC history", () =>
  requireLiveConnection(live));
for (const patch of [
  { client: "browser" },
  { role: "node" },
  { admitted: false },
  { closed: true },
  { frontendState: 3 },
  { upstreamState: 3 },
])
  test("native liveness rejects " + JSON.stringify(patch), () => {
    assert.throws(() => requireLiveConnection({ ...live, ...patch }));
  });
test("missing current native connection cannot pass", () =>
  assert.throws(() => requireLiveConnection()));

test("cleanup settlement is bounded", async () => {
  assert.equal(await bounded("ready", Promise.resolve(7), 100), 7);
  await assert.rejects(bounded("stuck", new Promise(() => {}), 10), /deadline exceeded/);
});
