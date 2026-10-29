import assert from "node:assert/strict";

// One policy owner for the caller's declared helper-work budget, not process startup.
export function operationBudgetMs(action) {
  switch (action) {
    case "ping":
    case "fixture":
      return 1000;
    case "probe":
    case "new":
    case "copy-key":
      return 3000;
    default:
      assert.fail("Unknown AX action: " + action);
  }
}

export function requireAXBudgetReceipt(receipt, action) {
  const budget = operationBudgetMs(action);
  assert.equal(receipt?.operationBudgetMs, budget, "AX operation budget declaration mismatch");
  assert.ok(
    Number.isFinite(receipt.elapsedMs) && receipt.elapsedMs >= 0 && receipt.elapsedMs <= budget,
    "AX helper work exceeded its declared operation budget",
  );
}
