import test from "node:test";
import assert from "node:assert/strict";
import { calculateTimeTotals, classifyActivity, monitoringAllowed } from "../src/index.js";

test("effective time subtracts merged idle time only", () => {
  const totals = calculateTimeTotals(
    { startedAt: new Date("2026-01-01T09:00:00Z"), endedAt: new Date("2026-01-01T17:00:00Z") },
    [{ startedAt: new Date("2026-01-01T10:00:00Z"), endedAt: new Date("2026-01-01T10:02:00Z") }, { startedAt: new Date("2026-01-01T10:01:00Z"), endedAt: new Date("2026-01-01T10:04:00Z") }]
  );
  assert.deepEqual(totals, { timerSeconds: 28800, idleSeconds: 240, effectiveSeconds: 28560 });
});
test("unknown activities are neutral and monitoring has two gates", () => {
  assert.equal(classifyActivity("www.unknown.test", []), "NEUTRAL");
  assert.equal(monitoringAllowed(true, "ACTIVE_MONITORING"), true);
  assert.equal(monitoringAllowed(false, "ACTIVE_MONITORING"), false);
});
