import assert from "node:assert/strict";

// Only these projections leave the passive relay. Never retain talk.config secrets.
export const observed = (method) =>
  ["connect", "config.get", "users.prefs.get", "talk.config", "talk.mode"].includes(method);
export function talkRequest(method, params) {
  return method === "talk.mode" ? { enabled: params?.enabled, phase: params?.phase } : {};
}
export function talkResponse(method, payload) {
  return method === "talk.config"
    ? { effectiveAccent: payload?.config?.ui?.seamColor ?? null }
    : {};
}
export const forbidden = (method) =>
  ["chat.send", "agent", "sessions.create"].includes(method) ||
  (method.startsWith("talk.") && !["talk.config", "talk.mode"].includes(method));

function one(rows, predicate, label) {
  const found = rows.filter(predicate);
  assert.equal(found.length, 1, label + " must have exactly one receipt");
  return found[0];
}
function pair(rows, conn, method, after, predicate = () => true) {
  const req = one(
    rows,
    (r) =>
      r.seq > after && r.conn === conn && r.side === "req" && r.method === method && predicate(r),
    method + " request",
  );
  const res = one(
    rows,
    (r) => r.conn === conn && r.side === "res" && r.method === method && r.id === req.id,
    method + " response",
  );
  assert(
    res.ok === true && res.seq > req.seq && res.requestSeq === req.seq,
    method + " unsuccessful/misordered response",
  );
  return { req, res };
}
// Both arms use this exact production Talk lifecycle before the measured mutation.
export function primedOn(rows, conn, expectedAccent) {
  const on = one(
    rows,
    (r) => r.side === "action" && r.method === "talk-on" && r.conn === conn,
    "Talk on action",
  );
  const cfg = pair(rows, conn, "talk.config", on.seq);
  assert.equal(
    cfg.res.effectiveAccent,
    expectedAccent,
    "Native Talk did not read effective magenta",
  );
  const enabled = pair(
    rows,
    conn,
    "talk.mode",
    cfg.res.seq,
    (r) => r.enabled === true && r.phase === "enabled",
  );
  return { on, cfg, enabled };
}
export function primedOff(rows, conn, expectedAccent) {
  const p = primedOn(rows, conn, expectedAccent);
  const off = one(
    rows,
    (r) => r.side === "action" && r.method === "talk-off" && r.conn === conn,
    "Talk off action",
  );
  assert(off.seq > p.enabled.res.seq, "Talk was disabled before startup completed");
  const disabled = pair(
    rows,
    conn,
    "talk.mode",
    off.seq,
    (r) => r.enabled === false && r.phase === "disabled",
  );
  return { ...p, off, disabled };
}
export function primingVerdict(rows, conn, expectedAccent) {
  const p = primedOff(rows, conn, expectedAccent);
  const settled = one(
    rows,
    (r) => r.side === "barrier" && r.method === "chat-only" && r.conn === conn,
    "Chat-only barrier",
  );
  assert(
    settled.seq > p.disabled.res.seq &&
      settled.onlyChat === true &&
      settled.talkActive === false &&
      settled.talkLabel === "Start realtime chat",
    "Talk overlay/resources not retired before measurement",
  );
  const mutation = one(
    rows,
    (r) => r.side === "action" && r.method === "config.patch" && r.conn === conn,
    "Mutation action",
  );
  assert(mutation.seq > settled.seq, "Mutation before Talk teardown");
  assert(
    !rows.some(
      (r) =>
        r.conn === conn &&
        r.seq > p.disabled.res.seq &&
        r.side === "req" &&
        (r.method === "talk.config" ||
          (r.method === "talk.mode" && r.enabled !== false) ||
          forbidden(r.method)),
    ),
    "Talk restarted/read config during chat-only measurement",
  );
  return {
    configResponseSeq: p.cfg.res.seq,
    enabledResponseSeq: p.enabled.res.seq,
    disabledResponseSeq: p.disabled.res.seq,
    chatOnlySeq: settled.seq,
    mutationSeq: mutation.seq,
  };
}
