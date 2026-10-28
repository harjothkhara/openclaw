import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { requireInventory, requirePreflightSnapshot } from "./new-thread.mjs";
const page = {
  sessions: [{ key: "main", sessionId: "old" }],
  count: 1,
  totalCount: 1,
  hasMore: false,
  nextOffset: null,
};
test("full isolated inventory admits one complete page and empty baseline", () => {
  requireInventory(page);
  requireInventory({ ...page, sessions: [], count: 0, totalCount: 0 });
});
for (const [name, patch] of [
  ["more rows", { hasMore: true }],
  ["unknown pagination", { hasMore: undefined }],
  ["next page", { nextOffset: 1 }],
  ["count mismatch", { count: 0 }],
  ["total mismatch", { totalCount: 2 }],
  ["omitted ID", { sessions: [{ key: "main" }] }],
  ["duplicate key", { sessions: [...page.sessions, ...page.sessions], count: 2, totalCount: 2 }],
])
  test("complete inventory rejects " + name, () =>
    assert.throws(() => requireInventory({ ...page, ...patch })),
  );
const probe = {
  schema: 1,
  kind: "targeted-native-ax",
  action: "probe",
  complete: true,
  frontmost: true,
  threadEnabled: true,
  appRole: "AXApplication",
  windowRole: "AXWindow",
  threadMenuCount: 1,
  newThreadPresses: 0,
  menuItemRouteVerified: false,
  elapsedMs: 20,
};
test("read-only targeted probe is explicitly not menu-item/action proof", () =>
  requirePreflightSnapshot(probe, []));
for (const patch of [
  { complete: false },
  { frontmost: false },
  { threadMenuCount: 2 },
  { threadEnabled: false },
  { newThreadPresses: 1 },
  { clicked: true },
  { action: "new" },
  { menuItemRouteVerified: true },
  { elapsedMs: 3001 },
])
  test("targeted preflight refuses " + JSON.stringify(patch), () =>
    assert.throws(() => requirePreflightSnapshot({ ...probe, ...patch }, [])),
  );
for (const method of ["sessions.create", "chat.send", "agent"])
  test("preflight refuses " + method, () =>
    assert.throws(() => requirePreflightSnapshot(probe, [{ side: "req", method }])),
  );
const workflow = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
test("serial first-attempt admission precedes Mac allocation and shared canary precedes app packaging", () => {
  assert.match(workflow, /SERIAL_CONFIRMED.*inputs.serial_confirmed/);
  assert.match(workflow, /test "\$SERIAL_CONFIRMED" = true/);
  assert.match(workflow, /test "\$GITHUB_RUN_ATTEMPT" = 1/);
  assert.match(workflow, /mac-new-thread-real-app:\n    needs: admission/);
  assert.ok(
    workflow.indexOf("node proof-runner/proof/qualified-canary.mjs") <
      workflow.indexOf("/bin/bash scripts/package-mac-app.sh"),
  );
  assert.ok(workflow.includes("13cde4984372bef34402ae61ff7891379626f260"));
  assert.ok(workflow.includes("new-thread-runner/evidence/"));
});
