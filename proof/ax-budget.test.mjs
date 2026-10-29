import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { operationBudgetMs, requireAXBudgetReceipt } from "./ax-budget.mjs";

for (const [action, expected] of [
  ["ping", 1000],
  ["fixture", 1000],
  ["probe", 3000],
  ["new", 3000],
  ["copy-key", 3000],
]) {
  test(action + " selects one budget and accepts its exact work boundary", () => {
    assert.equal(operationBudgetMs(action), expected);
    requireAXBudgetReceipt({ operationBudgetMs: expected, elapsedMs: expected }, action);
  });
}

test("unknown actions have no fallback work budget", () => {
  for (const action of [undefined, "", "other", "toString"]) {
    assert.throws(() => operationBudgetMs(action), /Unknown AX action/);
    assert.throws(() => requireAXBudgetReceipt({}, action), /Unknown AX action/);
  }
});

test("a complete receipt inside the process deadline cannot excuse overbudget helper work", () => {
  const virtualProcess = {
    startupMs: 800,
    totalMs: 3801,
    receipt: { complete: true, operationBudgetMs: 3000, elapsedMs: 3001 },
  };
  assert.equal(virtualProcess.totalMs, virtualProcess.startupMs + virtualProcess.receipt.elapsedMs);
  assert.ok(virtualProcess.totalMs < operationBudgetMs("new") + 1000);
  assert.throws(() => requireAXBudgetReceipt(virtualProcess.receipt, "new"), /exceeded/);
});

test("startup overhead is not misclassified as helper work", () => {
  const virtualProcess = {
    startupMs: 900,
    totalMs: 3900,
    receipt: { complete: true, operationBudgetMs: 3000, elapsedMs: 3000 },
  };
  assert.equal(virtualProcess.totalMs, virtualProcess.startupMs + virtualProcess.receipt.elapsedMs);
  assert.ok(virtualProcess.totalMs > operationBudgetMs("new"));
  assert.ok(virtualProcess.totalMs < operationBudgetMs("new") + 1000);
  requireAXBudgetReceipt(virtualProcess.receipt, "new");
});

test("declarations must match the requested action, not a wider helper ceiling", () => {
  for (const operationBudgetMs of [undefined, "1000", 3000, 4000]) {
    assert.throws(
      () => requireAXBudgetReceipt({ complete: true, operationBudgetMs, elapsedMs: 10 }, "fixture"),
      /declaration mismatch/,
    );
  }
});

test("invalid elapsed work never qualifies", () => {
  for (const elapsedMs of [undefined, "10", -1, NaN, Infinity, 1000.001]) {
    assert.throws(() => requireAXBudgetReceipt({ operationBudgetMs: 1000, elapsedMs }, "ping"));
  }
  requireAXBudgetReceipt({ operationBudgetMs: 1000, elapsedMs: 0 }, "ping");
});

test("Swift source contract: supplied bounded budget, pure final snapshot before either completion", async () => {
  // Static qualification only; this does not compile Swift or exercise native AX.
  const source = await readFile(new URL("./targeted-menu.swift", import.meta.url), "utf8");
  assert.match(source, /guard args\.count == 5/);
  assert.match(source, /let operationBudgetMs = Double\(args\[4\]\), operationBudgetMs\.isFinite,/);
  assert.match(source, /operationBudgetMs > 0, operationBudgetMs <= 3000,/);
  assert.match(source, /self\.budgetNs = UInt64\(operationBudgetMs \* 1_000_000\)/);
  assert.doesNotMatch(source, /ping: Bool|ping \? 1_000_000_000/);
  const finalBody = source.match(
    /func finalElapsedMs\(\) throws -> Double \{([\s\S]*?)\n    \}/,
  )?.[1];
  assert.equal(
    finalBody?.trim(),
    [
      "let elapsed = DispatchTime.now().uptimeNanoseconds - self.started",
      '        guard elapsed <= self.budgetNs else { throw self.fail("deadline") }',
      "        return Double(elapsed) / 1_000_000",
    ].join("\n"),
  );
  const fixtureTail = source.match(
    /let elapsedMs = try self\.finalElapsedMs\(\)([\s\S]*?)\n        \}/,
  )?.[1];
  assert.ok(fixtureTail, "Fixture completion must use the final snapshot");
  assert.match(fixtureTail, /"complete": true/);
  assert.match(fixtureTail, /"operationBudgetMs": self\.operationBudgetMs/);
  assert.match(fixtureTail, /"elapsedMs": elapsedMs/);
  assert.doesNotMatch(fixtureTail, /AX\w*\s*\(|self\.\w+\s*\(/);
  assert.match(
    source,
    /out\["operationBudgetMs"\] = self\.operationBudgetMs\n        out\["elapsedMs"\] = try self\.finalElapsedMs\(\)\n        out\["complete"\] = true\n        return out/,
  );
});
