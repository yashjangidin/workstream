import test from "node:test";
import assert from "node:assert/strict";
import {defaultEmployeeAlerts,defaultEmployerAlerts,employeeAlertTypes,employerEventAlertTypes,employerReportTypes,normaliseAlerts,sanitiseAlertSettings} from "../src/schemas.js";

test("user-facing alert matrices stay intentionally small",()=>{
  assert.deepEqual(employeeAlertTypes,["EMPLOYEE_IDLE","LATE_START","DAILY_TARGET_MISSED"]);
  assert.deepEqual(employerEventAlertTypes,["EMPLOYEE_IDLE","LATE_START","AGENT_OFFLINE","AGENT_STOPPED_REPORTING","DAILY_TARGET_MISSED"]);
  assert.deepEqual(employerReportTypes,["DAILY_TEAM_REPORT","DAILY_EMPLOYEE_REPORT","WEEKLY_TEAM_REPORT","WEEKLY_EMPLOYEE_REPORT"]);
});

test("all supported alerts default off and employee defaults never use dashboard",()=>{
  assert.ok(Object.values(defaultEmployeeAlerts).every(rule=>!rule.enabled&&!rule.channels.includes("DASHBOARD")));
  assert.ok(Object.values(defaultEmployerAlerts).every(rule=>!rule.enabled));
});

test("legacy enabled alert settings fail closed",()=>{
  const result=normaliseAlerts({EMPLOYEE_IDLE:{...defaultEmployeeAlerts.EMPLOYEE_IDLE,enabled:true,activationVersion:2}},defaultEmployeeAlerts,employeeAlertTypes);
  assert.equal((result.EMPLOYEE_IDLE as {enabled:boolean}).enabled,false);
});

test("backend rejects dashboard-only employee delivery and accepts the Windows agent",()=>{
  assert.throws(()=>sanitiseAlertSettings({EMPLOYEE_IDLE:{...defaultEmployeeAlerts.EMPLOYEE_IDLE,channels:["DASHBOARD"]}},"EMPLOYEE"),/supported delivery channel/);
  const result=sanitiseAlertSettings(defaultEmployeeAlerts,"EMPLOYEE");
  assert.deepEqual(Object.keys(result),[...employeeAlertTypes]);
  assert.deepEqual((result.EMPLOYEE_IDLE as {channels:string[]}).channels,["WINDOWS_AGENT"]);
});
