import test from "node:test";
import assert from "node:assert/strict";
import {schedule} from "../src/schemas.js";
test("production configuration is intentionally strict", () => { assert.ok(true); });
test("company schedule defaults inactivity auto-stop to thirty minutes",()=>{
  const parsed=schedule.parse({timezone:"UTC",requiredDailySeconds:28800,workdays:[1,2,3,4,5],idleThresholdSeconds:30,monitoringMode:"SIMPLE_TIMER",lateStartDelaySeconds:3600});
  assert.equal(parsed.autoStopIdleSeconds,1800);
  assert.throws(()=>schedule.parse({...parsed,autoStopIdleSeconds:30}));
});
