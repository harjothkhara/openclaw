import assert from "node:assert/strict";
import { primingVerdict } from "./priming.mjs";
export const RED = "1299676aacb6230a0960bd4f2178fb7ddd103849";
export const GREEN = "b34033c907786da68f99e5006d0feb2bf8793b7f";
export const MAGENTA = "#e00070",
  GREEN_COLOR = "#00d070";
export function live(c) {
  assert(
    c &&
      c.client === "openclaw-macos" &&
      c.role === "operator" &&
      c.admitted &&
      !c.closed &&
      c.frontendState === 1 &&
      c.upstreamState === 1,
    "Native connection is not live",
  );
}
export function validImage(s) {
  assert(s && s.width >= 640 && s.height >= 400, "Missing/undersized chat capture");
  const p = s.content;
  assert(
    p &&
      p.total > 10000 &&
      p.opaque === p.total &&
      p.nonBlack > p.total * 0.05 &&
      p.nonWhite > p.total * 0.05 &&
      p.dark > 40 &&
      p.light > 40,
    "Black/blank/protected chat content; no visual verdict",
  );
  assert(
    s.button && s.button.total >= 100 && s.button.opaque === s.button.total,
    "Missing/transparent send-button crop",
  );
}
export function dominance(s, color) {
  validImage(s);
  const p = s.button,
    other = color === "magenta" ? "green" : "magenta";
  assert(
    p[color] >= 40 && p[color] / p.total >= 0.12 && p[color] > p[other] * 3,
    "No clear " + color + " dominance in native send control",
  );
}
export async function observeRedBaseline({ capture, healthy, sleep, now = Date.now }) {
  const started = now(),
    until = started + 45_000;
  let after;
  for (let i = 0; now() < until; i++) {
    healthy();
    after = await capture("red-hold-" + i);
    dominance(after, "magenta");
    await sleep(Math.min(5_000, Math.max(0, until - now())));
  }
  healthy();
  after = await capture("red-final");
  dominance(after, "magenta");
  const elapsedMs = now() - started;
  assert(elapsedMs >= 45_000, "Base observation window was too short");
  return { after, elapsedMs };
}
export function countRelevantMacConnections(connections, openAtSelection, selectedOrdinal) {
  return [...connections].filter(
    ([id, c]) =>
      c.identity.client === "openclaw-macos" &&
      c.identity.role === "operator" &&
      (openAtSelection.has(id) || c.ordinal > selectedOrdinal),
  ).length;
}
export function verdict(mode, before, after, receipt) {
  assert(["red", "green"].includes(mode));
  live(receipt.beforeConnection);
  live(receipt.afterConnection);
  assert.equal(
    receipt.beforeConnection.conn,
    receipt.afterConnection.conn,
    "Native reconnect invalidates live-change proof",
  );
  primingVerdict(receipt.primingRows, receipt.beforeConnection.conn, MAGENTA);
  assert.equal(receipt.macConnections, 1, "Ambiguous native operator connections");
  assert(
    receipt.patchOk &&
      receipt.patchAccent === GREEN_COLOR &&
      receipt.persistedAccent === GREEN_COLOR &&
      receipt.operatorColor === MAGENTA,
    "Gateway mutation/readback did not match",
  );
  assert(receipt.configEventOnProofConnection, "Native connection did not receive config.changed");
  assert.equal(receipt.personalAccent, null, "Personal accent would mask Gateway fallback");
  assert.equal(receipt.inferenceRequests, 0);
  assert.equal(receipt.providerPosts, 0);
  assert.equal(before.width, after.width);
  assert.equal(before.height, after.height);
  dominance(before, "magenta");
  dominance(after, mode === "red" ? "magenta" : "green");
  if (mode === "green")
    assert(receipt.nativeConfigReadGreen, "No post-change native config.get green response");
  return mode === "red" ? "expected-red" : "green";
}
