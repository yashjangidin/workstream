import test from "node:test";
import assert from "node:assert/strict";
import {defaultEmployeeAlerts,defaultEmployerAlerts,employeeReportTypes,employerReportTypes,normaliseAlerts,sanitiseAlertSettings} from "../src/schemas.js";

test("only daily and weekly employee reports remain",()=>{
  assert.deepEqual(employeeReportTypes,["DAILY_EMPLOYEE_REPORT","WEEKLY_EMPLOYEE_REPORT"]);
  assert.deepEqual(employerReportTypes,["DAILY_EMPLOYEE_REPORT","WEEKLY_EMPLOYEE_REPORT"]);
});

test("all report delivery defaults on and uses email only",()=>{
  for(const rule of [...Object.values(defaultEmployeeAlerts),...Object.values(defaultEmployerAlerts)]){
    assert.equal(rule.enabled,true);
    assert.deepEqual(rule.channels,["EMAIL"]);
  }
});

test("legacy report settings adopt the new enabled email-report default",()=>{
  const result=normaliseAlerts({DAILY_EMPLOYEE_REPORT:{...defaultEmployeeAlerts.DAILY_EMPLOYEE_REPORT,enabled:true,activationVersion:3}},defaultEmployeeAlerts,employeeReportTypes);
  assert.equal((result.DAILY_EMPLOYEE_REPORT as {enabled:boolean}).enabled,true);
});

test("backend accepts only Resend email report delivery",()=>{
  assert.throws(()=>sanitiseAlertSettings({DAILY_EMPLOYEE_REPORT:{...defaultEmployeeAlerts.DAILY_EMPLOYEE_REPORT,channels:["DASHBOARD"]}} as unknown,"EMPLOYER"));
  const result=sanitiseAlertSettings(defaultEmployeeAlerts,"EMPLOYEE");
  assert.deepEqual(Object.keys(result),[...employeeReportTypes]);
  assert.deepEqual((result.DAILY_EMPLOYEE_REPORT as {channels:string[]}).channels,["EMAIL"]);
});
