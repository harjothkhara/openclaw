const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const { admit, REF, PARENT, HEAD, OTHER_SHA, GROUP } = require("./helper-admission.cjs");
function fixture(overrides = {}) {
  const sha = "a".repeat(40);
  const context = {
    repo: { owner: "harjothkhara", repo: "openclaw" },
    eventName: "workflow_dispatch",
    ref: REF,
    sha,
    runId: 999,
    payload: { inputs: { proof_sha: sha, helper_only: "true", serial_confirmed: "true" } },
  };
  const data = {
    attempt: 1,
    parent: PARENT,
    head: HEAD,
    draft: true,
    otherSha: OTHER_SHA,
    previousStatus: "completed",
    active: [],
    jobs: [],
    previousHelpers: [],
    ...overrides,
  };
  const github = {
    rest: {
      actions: {
        getWorkflowRun: async (p) => ({
          data:
            p.run_id === 999
              ? { run_attempt: data.attempt, workflow_id: 239627250 }
              : { status: data.previousStatus },
        }),
        listWorkflowRunsForRepo: async (p) => ({
          data: {
            total_count: data.active.length,
            workflow_runs: p.status === "in_progress" ? data.active : [],
          },
        }),
        listJobsForWorkflowRun: async () => ({
          data: { total_count: data.jobs.length, jobs: data.jobs },
        }),
        listWorkflowRuns: async () => ({
          data: { total_count: data.previousHelpers.length, workflow_runs: data.previousHelpers },
        }),
      },
      repos: { getCommit: async () => ({ data: { parents: [{ sha: data.parent }] } }) },
      pulls: { get: async () => ({ data: { head: { sha: data.head }, draft: data.draft } }) },
      git: { getRef: async () => ({ data: { object: { sha: data.otherSha } } }) },
    },
  };
  return { github, context };
}
test("helper admission preserves product head and historical app ledger", async () => {
  const r = await admit(fixture());
  assert.equal(r.appBuilds, 0);
  assert.equal(r.productSha, HEAD);
  assert.equal(r.concurrencyGroup, GROUP);
  assert.equal(r.historicalAppAttemptLedgerUnchanged, true);
});
for (const [name, change] of [
  ["job rerun", { attempt: 2 }],
  ["wrong parent", { parent: "b".repeat(40) }],
  ["changed product head", { head: "b".repeat(40) }],
  ["ready product PR", { draft: false }],
  ["changed other-lane lock contract", { otherSha: "b".repeat(40) }],
  ["prior Mac still active", { previousStatus: "in_progress" }],
  [
    "another manual run has no jobs",
    { active: [{ id: 88, name: "another proof", event: "workflow_dispatch" }] },
  ],
  [
    "another Mac allocation",
    {
      active: [{ id: 88, name: "scheduled", event: "schedule" }],
      jobs: [{ status: "in_progress", labels: ["macos-26"] }],
    },
  ],
  [
    "unknown active job labels",
    {
      active: [{ id: 88, name: "scheduled", event: "schedule" }],
      jobs: [{ status: "in_progress", labels: [] }],
    },
  ],
  ["duplicate helper dispatch", { previousHelpers: [{ id: 88 }] }],
])
  test("refuse " + name, async () => assert.rejects(admit(fixture(change))));
for (const key of ["proof_sha", "helper_only", "serial_confirmed"])
  test("refuse invalid input " + key, async () => {
    const f = fixture();
    f.context.payload.inputs[key] = "false";
    await assert.rejects(admit(f));
  });
test("workflow cannot package, install or launch the product", () => {
  const workflow = fs.readFileSync(path.join(__dirname, "../../.github/workflows/ci.yml"), "utf8");
  assert(!/package-mac-app|pnpm|gateway run|accent[.]mjs|sut-red|sut-green/.test(workflow));
  assert(workflow.includes("group: " + GROUP));
  assert(workflow.includes("cancel-in-progress: false"));
  assert(workflow.includes("if: github.run_attempt == 1 && inputs.helper_only"));
  assert(workflow.includes("node pixel-preflight.mjs"));
  assert(workflow.includes("if: always()"));
});
