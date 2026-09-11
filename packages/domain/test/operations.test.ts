import test from 'node:test';
import assert from 'node:assert/strict';
import {dayBounds,dailyTime,classify,operationalStatus,targetStatus,type Rule} from '../src/operations.js';

test('local days handle DST and half-hour offsets',()=>{
  const spring=dayBounds('2026-03-08','America/New_York');
  const autumn=dayBounds('2026-11-01','America/New_York');
  assert.equal(spring.end-spring.start,23*3600000);
  assert.equal(autumn.end-autumn.start,25*3600000);
  assert.equal(new Date(dayBounds('2026-09-10','Asia/Kolkata').start).toISOString(),'2026-09-09T18:30:00.000Z');
});
test('daily totals clip midnight, merge duplicated sessions and idle, ignore orphan idle',()=>{
  const sessions=[{id:'a',deviceId:'d',status:'COMPLETED',startedAt:1000,stoppedAt:11000},{id:'b',deviceId:'d',status:'COMPLETED',startedAt:5000,stoppedAt:15000}];
  const idle=[{sessionId:'a',startedAt:3000,endedAt:7000},{sessionId:'b',startedAt:6000,endedAt:9000},{sessionId:'missing',startedAt:0,endedAt:99999}];
  assert.deepEqual(dailyTime(sessions,idle,2000,12000,20000),{timerSeconds:10,idleSeconds:6,effectiveSeconds:4});
});
test('running sessions and open idle use the same as-of time',()=>{
  assert.deepEqual(dailyTime([{id:'a',deviceId:'d',status:'ACTIVE',startedAt:1000}], [{sessionId:'a',startedAt:3000}],0,10000,6000),{timerSeconds:5,idleSeconds:3,effectiveSeconds:2});
});
test('employee overrides company overrides defaults; domains require exact normalized host',()=>{
  const rules:Rule[]=[{target:'DOMAIN',pattern:'example.com',classification:'PRODUCTIVE',enabled:true,scope:'DEFAULT'},{target:'DOMAIN',pattern:'example.com',classification:'NON_PRODUCTIVE',enabled:true},{target:'DOMAIN',pattern:'example.com',classification:'NEUTRAL',enabled:true,employeeId:'one'}];
  assert.equal(classify(rules,'one','chrome.exe','https://www.example.com/path'),'NEUTRAL');
  assert.equal(classify(rules,'two','chrome.exe','example.com'),'NON_PRODUCTIVE');
  assert.equal(classify(rules,'two','chrome.exe','evil-example.com'),'NEUTRAL');
});
test('offline device is not working even with a persisted running timer',()=>{
  assert.deepEqual(operationalStatus({status:'ACTIVE',lastHeartbeatAt:1000},true,false,500000,180),{deviceStatus:'OFFLINE',timerStatus:'RUNNING',workStatus:'OFFLINE'});
  assert.equal(targetStatus(3600,3000,3600,10000,11000),'MISSED');
  assert.equal(targetStatus(3600,3600,3600,10000,11000),'COMPLETED');
});
