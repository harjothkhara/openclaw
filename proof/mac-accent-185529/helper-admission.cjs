const assert = require("node:assert/strict");
const REPO = { owner: "harjothkhara", repo: "openclaw" };
const REF = "refs/heads/proof/mac-accent-helper-185529-2026-10-28";
const PARENT = "d4531bad565588a14c9f046186b8f14ecf51eeb0";
const HEAD = "b34033c907786da68f99e5006d0feb2bf8793b7f";
const OTHER_BRANCH = "proof/mac-new-thread-186215-2026-10-27";
const OTHER_SHA = "e9030d57da25d6fcfdfbd44a4a7bb14240abd1a5";
const GROUP = "mac-new-thread-186215-real-app";
async function admit({ github, context }) {
  assert.equal(context.repo.owner, REPO.owner);
  assert.equal(context.repo.repo, REPO.repo);
  assert.equal(context.eventName, "workflow_dispatch");
  assert.equal(context.ref, REF);
  const input = context.payload.inputs;
  assert.equal(String(input.helper_only), "true", "This workflow cannot run an app proof");
  assert.equal(
    String(input.serial_confirmed),
    "true",
    "Coordinator must reserve the Mac proof lane",
  );
  assert.match(input.proof_sha || "", /^[a-f0-9]{40}$/);
  assert.equal(input.proof_sha, context.sha, "Dispatched snapshot differs from approved proof SHA");
  const run = (await github.rest.actions.getWorkflowRun({ ...REPO, run_id: context.runId })).data;
  assert.equal(run.run_attempt, 1, "No job reruns");
  const commit = (await github.rest.repos.getCommit({ ...REPO, ref: context.sha })).data;
  assert.deepEqual(
    commit.parents.map((p) => p.sha),
    [PARENT],
    "Use one proof-only commit on the pinned fork source",
  );
  const pr = (
    await github.rest.pulls.get({ owner: "openclaw", repo: "openclaw", pull_number: 185529 })
  ).data;
  assert.equal(pr.head.sha, HEAD, "Product head changed");
  assert.equal(pr.draft, true, "Product PR must remain draft");
  // Fail closed if the independently owned lane changed since this lock group was verified.
  const otherRef = (await github.rest.git.getRef({ ...REPO, ref: "heads/" + OTHER_BRANCH })).data;
  assert.equal(
    otherRef.object.sha,
    OTHER_SHA,
    "Recheck #186259 concurrency after its proof branch changes",
  );
  for (const id of [40598236532, 40612718806]) {
    assert.equal(
      (await github.rest.actions.getWorkflowRun({ ...REPO, run_id: id })).data.status,
      "completed",
      "Prior Mac proof is not terminal: " + id,
    );
  }
  const observed = [];
  for (const status of ["queued", "in_progress", "waiting", "requested", "pending"]) {
    const page = (
      await github.rest.actions.listWorkflowRunsForRepo({ ...REPO, status, per_page: 100 })
    ).data;
    assert(page.total_count <= 100, "Active run inventory truncated");
    for (const candidate of page.workflow_runs) {
      if (candidate.id === context.runId) continue;
      const otherLane =
        candidate.head_branch === OTHER_BRANCH || /186259|186215/.test(candidate.name || "");
      // Reject every other manual run, even before GitHub has allocated its jobs.
      assert(
        !otherLane && candidate.event !== "workflow_dispatch",
        "Another manual/native lane is nonterminal: " + candidate.id,
      );
      const jobs = (
        await github.rest.actions.listJobsForWorkflowRun({
          ...REPO,
          run_id: candidate.id,
          per_page: 100,
        })
      ).data;
      assert(jobs.total_count <= 100, "Job inventory truncated");
      assert(
        !jobs.jobs.some(
          (j) =>
            j.status !== "completed" &&
            (!j.labels?.length || j.labels.some((l) => /macos|mac-/i.test(l))),
        ),
        "Another possible Mac allocation exists: " + candidate.id,
      );
      observed.push({ id: candidate.id, event: candidate.event, jobs: jobs.total_count });
      // Jobless scheduled runs have no current allocation. The coordinator reservation and
      // matching #186259 concurrency group serialize proof dispatches; this is not a global CI lock.
    }
  }
  const history = (
    await github.rest.actions.listWorkflowRuns({
      ...REPO,
      workflow_id: run.workflow_id,
      branch: REF.slice("refs/heads/".length),
      event: "workflow_dispatch",
      per_page: 100,
    })
  ).data;
  assert(history.total_count <= 100, "Helper dispatch history truncated");
  assert.equal(
    history.workflow_runs.filter((r) => r.id !== context.runId).length,
    0,
    "Do not dispatch this helper ref twice; reconcile the existing result",
  );
  return {
    kind: "compiled-helper-only",
    appBuilds: 0,
    productSha: HEAD,
    proofSha: context.sha,
    concurrencyGroup: GROUP,
    priorRunIds: [40591157706, 40591846606, 40605690557, 40612718806],
    historicalAppAttemptLedgerUnchanged: true,
    observed,
  };
}
module.exports = { admit, REF, PARENT, HEAD, OTHER_BRANCH, OTHER_SHA, GROUP };
