// Explicit opt-in live Firebase integration test. Creates isolated fixtures and cleans only its own records.
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {buildApp} from '../src/app.js';
import {auth,db} from '../src/firebase.js';
import {localDate,dailyTime,dayBounds} from '@workstream/domain';
if(process.env.WORKSTREAM_LIVE_TEST!=='1')throw new Error('Set WORKSTREAM_LIVE_TEST=1 to run isolated live fixtures.');
const app=await buildApp(),prefix='ws-smoke-'+randomUUID(),email=prefix+'@example.com',password=randomBytes(24).toString('base64url');
let companyId='',otherUid='';let checks=0;
const ids:string[]=[];
async function call(method:any,url:string,body?:unknown,authorization?:string,expected=200){const response=await app.inject({method,url,payload:body as any,headers:authorization?{authorization}:{}});assert.equal(response.statusCode,expected,`${method} ${url}: ${response.body}`);checks++;return response.body?response.json():null;}
try{
  await call('GET','/v1/app/overview',undefined,undefined,401);
  await call('POST','/v1/signup',{companyName:'Isolated smoke fixture',ownerName:'Test owner',email,password,timezone:'Asia/Kolkata'},undefined,201);
  companyId=(await auth.getUserByEmail(email)).uid;
  await call('POST','/v1/signup',{companyName:'Duplicate fixture',ownerName:'Test owner',email,password,timezone:'Asia/Kolkata'},undefined,409);
  const env=readFileSync('../../apps/employer-web/.env','utf8'),apiKey=env.match(/^VITE_FIREBASE_API_KEY\s*=\s*["']?([^\r\n"']+)/m)?.[1];
  assert.ok(apiKey,'Browser API key is configured');
  const signed=await fetch('https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key='+apiKey,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,password,returnSecureToken:true})});
  assert.equal(signed.status,200,'Firebase password sign-in');
  const bearer='Bearer '+(await signed.json() as {idToken:string}).idToken;
  const profile={fullName:'Smoke employee',email:prefix+'-employee@example.com',timezone:'Asia/Kolkata',requiredDailySeconds:28800,workdays:[0,1,2,3,4,5,6],idleThresholdSeconds:30,monitoringMode:'SIMPLE_TIMER',department:'QA'};
  const created=await call('POST','/v1/employees',profile,bearer,201);ids.push(created.employeeId);
  await call('POST','/v1/employees',profile,bearer,409);
  const settings=await call('GET','/v1/settings',undefined,bearer);assert.equal(settings.company.timezone,'Asia/Kolkata');
  await call('PATCH','/v1/settings/company',{name:'Persisted smoke company',timezone:'Asia/Kolkata'},bearer);
  assert.equal((await call('GET','/v1/settings',undefined,bearer)).company.name,'Persisted smoke company');
  const credential=randomBytes(32).toString('base64url'),enrollment={setupCode:created.setupCode,installationId:randomUUID(),credential,name:'Test device',agentVersion:'test'};
  const paired=await call('POST','/v1/device/enroll',enrollment);
  assert.equal((await call('POST','/v1/device/enroll',enrollment)).deviceId,paired.deviceId);
  const device='Device '+paired.deviceId+'.'+credential;
  assert.equal((await call('GET','/v1/device/config',undefined,device)).monitoringMode,'SIMPLE_TIMER');
  await call('PATCH','/v1/employees/'+created.employeeId,{...profile,monitoringMode:'ACTIVE_MONITORING',requiredDailySeconds:21600},bearer);
  assert.equal((await call('GET','/v1/device/config',undefined,device)).requiredDailySeconds,21600);
  const t=Date.now()-600000,sessionId=randomUUID(),start={operationId:randomUUID(),sessionId,at:t};
  await call('POST','/v1/device/sessions/start',start,device);await call('POST','/v1/device/sessions/start',start,device);
  const idle={operationId:randomUUID(),sessionId,idleId:randomUUID(),at:t+60000,endedAt:t+120000};
  await call('POST','/v1/device/idle',idle,device);await call('POST','/v1/device/idle',idle,device);
  const rule=await call('POST','/v1/rules',{target:'APPLICATION',pattern:'test.exe',classification:'PRODUCTIVE',enabled:true,employeeId:created.employeeId},bearer);
  const activity={operationId:randomUUID(),sessionId,at:t,endedAt:t+60000,application:'test.exe'};
  await call('POST','/v1/device/activity',activity,device);await call('POST','/v1/device/activity',activity,device);
  const stop={operationId:randomUUID(),sessionId,at:t+300000};await call('POST','/v1/device/sessions/stop',stop,device);await call('POST','/v1/device/sessions/stop',stop,device);
  const date=localDate(t,'Asia/Kolkata'),bounds=dayBounds(date,'Asia/Kolkata');
  const expected=dailyTime([{id:sessionId,deviceId:paired.deviceId,status:'COMPLETED',startedAt:t,stoppedAt:stop.at}],[{sessionId,startedAt:idle.at,endedAt:idle.endedAt}],bounds.start,bounds.end,Date.now());
  const overview=await call('GET','/v1/app/overview?date='+date,undefined,bearer),employee=overview.employees.find((e:any)=>e.id===created.employeeId);
  assert.equal(employee.timerSeconds,expected.timerSeconds);assert.equal(employee.idleSeconds,expected.idleSeconds);assert.equal(employee.effectiveSeconds,expected.effectiveSeconds);
  const report=await call('GET','/v1/reports?date='+date,undefined,bearer);assert.equal(report.rows[0].effectiveSeconds,employee.effectiveSeconds);
  const records=await call('GET',`/v1/employees/${created.employeeId}/records?date=${date}&kind=activity`,undefined,bearer);assert.equal(records.total,1);assert.equal(records.records[0].classification,'PRODUCTIVE');
  // A record owned by another company cannot be read, changed or revoked.
  const foreign=db.collection('employees').doc(prefix+'-foreign');await foreign.create({...profile,companyId:prefix,status:'ACTIVE'});ids.push(foreign.id);
  await call('GET','/v1/employees/'+foreign.id,undefined,bearer,404);
  await call('PATCH','/v1/employees/'+foreign.id,profile,bearer,404);
  await call('POST','/v1/devices/'+paired.deviceId+'/revoke',{},bearer);
  await call('POST','/v1/device/heartbeat',{agentVersion:'test',timerState:'STOPPED'},device,401);
  await call('POST','/v1/employees/'+created.employeeId+'/setup-code',{},bearer);
  await call('POST','/v1/device/enroll',{...enrollment,installationId:randomUUID()},undefined,401);
  await call('DELETE','/v1/rules/'+rule.id,undefined,bearer);
  await call('DELETE','/v1/employees/'+created.employeeId,undefined,bearer,204);
  await call('GET','/v1/employees/'+created.employeeId,undefined,bearer,404);
  console.log(`PASS: ${checks} live API responses plus persisted time/config/classification/isolation assertions.`);
}finally{
  if(!companyId){try{companyId=(await auth.getUserByEmail(email)).uid;}catch{}}
  if(companyId){
    for(const collection of ['employees','email_claims','setup_codes','devices','work_sessions','idle_intervals','activity_events','screenshots','invitations','notification_jobs','monitoring_rules','alerts','alert_cooldowns','report_runs','audit_logs']){
      const docs=await db.collection(collection).where('companyId','==',companyId).get();for(const doc of docs.docs)await doc.ref.delete();
    }
    const company=db.collection('companies').doc(companyId);const settings=await company.collection('settings').get();for(const d of settings.docs)await d.ref.delete();await company.delete();await db.collection('memberships').doc(companyId).delete();await auth.deleteUser(companyId);
  }
  for(const id of ids)await db.collection('employees').doc(id).delete();
  await app.close();console.log('Removed only this smoke test’s isolated Firebase fixtures.');
}
